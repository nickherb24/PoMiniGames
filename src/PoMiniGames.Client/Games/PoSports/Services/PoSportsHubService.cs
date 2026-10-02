using Microsoft.AspNetCore.SignalR.Client;
using PoMiniGamesClient.Services.Auth;
using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;
using PoMiniGames.Shared.Games;

namespace PoMiniGamesClient.Games.PoSports.Services;

/// <summary>
/// Client-side wrapper around the two PoSports hubs. The lobby connection
/// (<c>/posports/lobby-hub</c>) carries the global room — join, character pick,
/// ready, host start; the race connection (<c>/posports/race-hub</c>) carries the
/// meet itself — 15 Hz snapshots in, sequence keys out. Contracts are the
/// PoMiniGames.Shared.Games records, shared with the server.
/// </summary>
public sealed class PoSportsHubService : IAsyncDisposable
{
    private readonly ApiEndpoints _endpoints;
    private HubConnection? _race;
    private readonly List<IDisposable> _raceSubs = [];
    private string _displayName = "Player";
    private bool _isGuest = true;
    /// <summary>The race the connection is currently joined to — read by the reconnect handler.</summary>
    private string _raceCode = "";
    private bool _raceAsPlayer;

    public event Action<PoSportsSnapshot>? SnapshotReceived;
    public event Action<PoSportsSnapshot>? RaceFinished;

    /// <summary>The lobby half: the shared ready/start client. Pages subscribe to its events directly.</summary>
    public LobbyClient<PoSportsLobbyMember> Lobby { get; }

    public string LobbyConnectionId => Lobby.ConnectionId;

    public PoSportsHubService(ApiEndpoints endpoints)
    {
        _endpoints = endpoints;
        Lobby = new LobbyClient<PoSportsLobbyMember>(endpoints, "posports/lobby-hub");
    }

    // ── Lobby ─────────────────────────────────────────────────────────────

    public Task<LobbyState<PoSportsLobbyMember>?> ConnectLobbyAsync(string displayName, bool isGuest)
    {
        _displayName = string.IsNullOrWhiteSpace(displayName) ? "Player" : displayName;
        _isGuest = isGuest;
        return Lobby.ConnectAndJoinAsync(_displayName, _isGuest);
    }

    public Task<bool> PickCharacterAsync(string character) => Lobby.InvokeAsync<bool>("PickCharacter", character);

    public Task ToggleReadyAsync() => Lobby.ToggleReadyAsync();

    public Task StartGameAsync() => Lobby.StartGameAsync();

    public Task LeaveLobbyAsync() => Lobby.LeaveLobbyAsync();

    // ── Race ──────────────────────────────────────────────────────────────

    /// <summary>
    /// Join (or rejoin) a meet. Returns null when the server has no joinable meet for the
    /// code — the caller should send the player back to the lobby. The result carries the
    /// lane the server bound to this connection (-1 for a spectator).
    /// </summary>
    public async Task<PoSportsJoinResult?> JoinRaceAsync(string code, bool asPlayer)
    {
        // Fields, not captured locals: the Reconnected handler is registered once for the
        // connection's life, so a closure over this call's arguments would keep replaying
        // the FIRST race's code and role after any later join.
        _raceCode = code;
        _raceAsPlayer = asPlayer;

        if (_race is null)
        {
            _race = HubConnectionFactory.Create(_endpoints.Hub("posports/race-hub"));

            _raceSubs.Add(_race.On<PoSportsSnapshot>("raceSnapshot", s => SnapshotReceived?.Invoke(s)));
            _raceSubs.Add(_race.On<PoSportsSnapshot>("raceFinished", s => RaceFinished?.Invoke(s)));

            await _race.StartAsync();

            // Rejoin rebinds the lane (sequence progress resets server-side).
            _race.Reconnected += async _ =>
            {
                try { await _race.InvokeAsync<PoSportsJoinResult?>("JoinRace", _raceCode, _raceAsPlayer, _displayName, _isGuest); } catch { }
            };
        }
        return await _race.InvokeAsync<PoSportsJoinResult?>("JoinRace", code, asPlayer, _displayName, _isGuest);
    }

    /// <summary>
    /// Close the race connection when leaving the meet. Without this the socket stays open
    /// for the app's lifetime (the service is scoped, which in WASM means app-lifetime),
    /// still in the server's race group, deserializing 15 Hz snapshots into events nobody
    /// listens to — and SignalR only sheds group membership on disconnect, so a later meet
    /// would also keep receiving the old one's broadcasts.
    /// </summary>
    public async Task StopRaceAsync()
    {
        var race = _race;
        _race = null;
        _raceCode = "";
        _raceAsPlayer = false;
        foreach (var s in _raceSubs) s.Dispose();
        _raceSubs.Clear();
        if (race is not null)
        {
            try { await race.StopAsync(); } catch { }
            try { await race.DisposeAsync(); } catch { }
        }
    }

    /// <summary>Send one sequence key as its layout ordinal (0-3).</summary>
    public Task SendSequenceKeyAsync(string code, int step) =>
        _race?.InvokeAsync("SendSequenceKey", code, step) ?? Task.CompletedTask;

    public Task SendJumpAsync(string code) =>
        _race?.InvokeAsync("SendJump", code) ?? Task.CompletedTask;

    public async ValueTask DisposeAsync()
    {
        await StopRaceAsync();
        await Lobby.DisposeAsync();
    }
}
