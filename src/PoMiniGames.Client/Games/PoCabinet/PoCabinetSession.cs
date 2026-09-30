using Microsoft.AspNetCore.SignalR.Client;
using PoMiniGames.Shared.Games;
using PoMiniGamesClient.Services.Http;

namespace PoMiniGamesClient.Games.PoCabinet;

/// <summary>
/// Owns the two PoCabinet hub connections for the app's lifetime (scoped = one per tab in
/// WASM), so the lobby survives the hop into a race and back for a rematch.
/// <list type="number">
///   <item><b>Lobby hub</b> (<c>/pocabinet/lobby-hub</c>): join the one lobby (first in
///         hosts), receive <c>LobbyState</c> after every change, host controls (track, AI
///         officials), and <c>RaceStarting(raceId, trackId)</c>. A reconnect rejoins — seats
///         are keyed by claim identity server-side, so it is the same seat.</item>
///   <item><b>Race hub</b> (<c>/pocabinet/race-hub</c>): <see cref="JoinRaceAsync"/> returns
///         the static world and this client's car id (null = spectating); then one numbered
///         input per 30 Hz tick goes up and a <c>RaceSnapshot</c> per tick comes down, ending
///         with a typed <c>RaceFinished</c> result.</item>
/// </list>
/// <para>
/// Inputs use <c>SendAsync</c> (fire-and-forget): at 30 per second, awaiting a round trip
/// for each one — as <c>InvokeAsync</c> does — queued them behind the network latency.
/// </para>
/// </summary>
public sealed class PoCabinetSession : IAsyncDisposable
{
    private readonly HubConnection _lobby;
    private readonly HubConnection _race;
    private readonly CancellationTokenSource _lifetime = new();
    private bool _inLobby;
    private string _displayName = "Player";
    private string? _trackId;
    private string? _color;
    private string? _gameCode;
    private bool _raceJoined;
    private Task _pingLoop = Task.CompletedTask;

    public PoCabinetSession(ApiEndpoints endpoints)
    {
        _lobby = HubConnectionFactory.Create(endpoints.Hub("pocabinet/lobby-hub"));
        _race = HubConnectionFactory.Create(endpoints.Hub("pocabinet/race-hub"));

        _lobby.On<PoCabinetLobbyView>("LobbyState", async view =>
        {
            if (!_inLobby) return;
            Lobby = view;
            if (LobbyChanged is { } handler) await handler(view);
        });
        _lobby.On<string, string>("RaceStarting", async (code, trackId) =>
        {
            if (RaceStarting is { } handler) await handler(code, trackId);
        });
        _lobby.Reconnected += async _ =>
        {
            if (!_inLobby) return;
            try { await JoinLobbyAsync(_displayName, _trackId, _color); } catch { /* the view shows the stale state */ }
        };

        _race.On<PoCabinetRaceSnapshot>("RaceSnapshot", async snapshot =>
        {
            if (SnapshotReceived is { } handler) await handler(snapshot);
        });
        _race.On<PoCabinetFinalResult>("RaceFinished", async result =>
        {
            if (RaceFinished is { } handler) await handler(result);
        });
        _race.Reconnecting += async _ =>
        {
            if (StatusChanged is { } handler) await handler("Reconnecting…");
        };
        _race.Reconnected += async _ =>
        {
            try
            {
                if (_gameCode is not null) await _race.InvokeAsync<PoCabinetRaceSnapshot>("JoinRace", _gameCode);
                if (StatusChanged is { } handler) await handler(null);
            }
            catch
            {
                if (StatusChanged is { } handler) await handler("Could not rejoin the race.");
            }
        };
    }

    /// <summary>The lobby this client sits in (latest broadcast), or null.</summary>
    public PoCabinetLobbyView? Lobby { get; private set; }

    /// <summary>This client's seat in <see cref="Lobby"/>.</summary>
    public string? MySeatId { get; private set; }

    public event Func<PoCabinetLobbyView, Task>? LobbyChanged;
    public event Func<string, string, Task>? RaceStarting;
    public event Func<PoCabinetRaceSnapshot, Task>? SnapshotReceived;
    public event Func<PoCabinetFinalResult, Task>? RaceFinished;
    /// <summary>Non-null message while the race connection is unhealthy, null when restored.</summary>
    public event Func<string?, Task>? StatusChanged;
    public event Func<double, Task>? PingMeasured;

    /// <summary>
    /// Join (or rejoin) the lobby; the first arrival hosts on <paramref name="trackId"/>. When
    /// no seat is free (race running, or eight seated) the view comes back with a null
    /// <see cref="MySeatId"/> and broadcasts keep arriving, so the caller can retry.
    /// </summary>
    public async Task<PoCabinetLobbyView?> JoinLobbyAsync(string displayName, string? trackId, string? color, CancellationToken ct = default)
    {
        await EnsureAsync(_lobby, ct);
        var view = await _lobby.InvokeAsync<PoCabinetLobbyView?>("Join", displayName, trackId, color, ct);
        _inLobby = true;
        _displayName = displayName;
        _trackId = trackId;
        _color = color;
        Lobby = view;
        MySeatId = view?.YourSeatId;
        return view;
    }

    public Task<bool> ToggleReadyAsync() => LobbyCallAsync("ToggleReady");

    public Task<bool> SetTrackAsync(string trackId) => LobbyCallAsync("SetTrack", trackId);

    public Task<bool> SetBotsAsync(int count) => LobbyCallAsync("SetBots", count);

    public Task<bool> TryStartAsync() => LobbyCallAsync("TryStart");

    public async Task LeaveLobbyAsync()
    {
        var wasIn = _inLobby;
        _inLobby = false;
        Lobby = null;
        MySeatId = null;
        if (!wasIn || _lobby.State != HubConnectionState.Connected) return;
        try { await _lobby.InvokeAsync("Leave"); } catch { /* best effort */ }
    }

    /// <summary>Join a running race. The reply carries the static world and, for a seated
    /// player, <c>LocalCarId</c> — null means this client spectates.</summary>
    public async Task<PoCabinetRaceSnapshot> JoinRaceAsync(string gameCode, CancellationToken ct = default)
    {
        _gameCode = gameCode;
        await EnsureAsync(_race, ct);
        var snapshot = await _race.InvokeAsync<PoCabinetRaceSnapshot>("JoinRace", gameCode, ct);
        _raceJoined = true;
        return snapshot;
    }

    /// <summary>Stop sending for the current race (the connection stays up for the next one).</summary>
    public void LeaveRace()
    {
        _raceJoined = false;
        _gameCode = null;
    }

    /// <summary>One tick of input, fire-and-forget. Dropped while not joined or reconnecting.</summary>
    public Task SendInputAsync(PoCabinetInput input)
    {
        if (!_raceJoined || _gameCode is null || _race.State != HubConnectionState.Connected) return Task.CompletedTask;
        return _race.SendAsync("SubmitInput", _gameCode, input);
    }

    /// <summary>Begin the 3-second latency probe (idempotent) feeding the HUD ping badge.</summary>
    public void StartPingLoop()
    {
        if (_pingLoop.IsCompleted) _pingLoop = PingLoopAsync(_lifetime.Token);
    }

    private async Task PingLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(3000, ct);
                if (_raceJoined && _race.State == HubConnectionState.Connected)
                {
                    var sw = System.Diagnostics.Stopwatch.StartNew();
                    await _race.InvokeAsync<long>("Ping", ct);
                    sw.Stop();
                    if (PingMeasured is { } handler) await handler(sw.Elapsed.TotalMilliseconds);
                }
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch
            {
                // A failed probe is what a bad connection looks like; StatusChanged covers it.
            }
        }
    }

    private async Task<bool> LobbyCallAsync(string method, params object?[] args)
    {
        if (!_inLobby) return false;
        await EnsureAsync(_lobby, default);
        return await _lobby.InvokeCoreAsync<bool>(method, args);
    }

    private static async Task EnsureAsync(HubConnection hub, CancellationToken ct)
    {
        if (hub.State == HubConnectionState.Disconnected) await hub.StartAsync(ct);
    }

    public async ValueTask DisposeAsync()
    {
        _lifetime.Cancel();
        try { await _lobby.DisposeAsync(); } catch { /* ignore */ }
        try { await _race.DisposeAsync(); } catch { /* ignore */ }
        _lifetime.Dispose();
    }
}
