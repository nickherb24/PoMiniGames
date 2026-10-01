using Microsoft.AspNetCore.SignalR.Client;
using PoMiniGames.Shared.Games;
using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Play;

namespace PoMiniGamesClient.Games.PoRacer;

/// <summary>Owns one race connection, including rejoining and input after reconnect.</summary>
public sealed class PoRacerSession : IAsyncDisposable
{
    private readonly HubConnection _hub;
    private readonly CancellationTokenSource _lifetime = new();
    private readonly SemaphoreSlim _inputGate = new(1, 1);
    private PoRacerInput _input = new();
    private string _code = "";
    private string _trackId = PoRacerCatalog.DefaultTrackId;
    private PoRacerJoinOptions _options = new();
    private bool _asPlayer;
    private bool _ready;

    public PoRacerSession(ApiEndpoints endpoints)
    {
        _hub = HubConnectionFactory.Create(endpoints.Hub("poracer/race-hub"));
        _hub.On<PoRacerRaceSnapshot>("raceSnapshot", async snapshot =>
        {
            if (_ready && SnapshotReceived is { } handler) await handler(snapshot);
        });
        _hub.On<List<PoRacerCarInfo>>("raceRoster", async roster =>
        {
            if (_ready && RosterChanged is { } handler) await handler(roster);
        });
        _hub.On<PoRacerFinalResult>("raceFinished", async result =>
        {
            if (_ready && Finished is { } handler) await handler(result);
        });
        _hub.Reconnecting += async _ => { _ready = false; if (StatusChanged is { } handler) await handler("Reconnecting…"); };
        _hub.Reconnected += async _ =>
        {
            try
            {
                await JoinAsync(_lifetime.Token);
                await SendInputAsync(_input);
                if (StatusChanged is { } handler) await handler(null);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                if (StatusChanged is { } handler) await handler("Could not rejoin. Return to the start screen.");
            }
        };
        _hub.Closed += async _ => { _ready = false; if (!_lifetime.IsCancellationRequested && StatusChanged is { } handler) await handler("Connection lost. Return to the start screen."); };
    }

    public event Func<PoRacerRaceSnapshot, Task>? Joined;
    public event Func<PoRacerRaceSnapshot, Task>? SnapshotReceived;
    /// <summary>Another driver's paint arrived after this client's join.</summary>
    public event Func<IReadOnlyList<PoRacerCarInfo>, Task>? RosterChanged;
    public event Func<PoRacerFinalResult, Task>? Finished;
    public event Func<string?, Task>? StatusChanged;

    public async Task ConnectAsync(string code, bool asPlayer, string trackId, PoRacerJoinOptions options, CancellationToken cancellationToken)
    {
        _code = code;
        _asPlayer = asPlayer;
        _trackId = trackId;
        _options = options;
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, _lifetime.Token);
        await _hub.StartAsync(linked.Token);
        await JoinAsync(linked.Token);
    }

    private async Task JoinAsync(CancellationToken cancellationToken)
    {
        var snapshot = await _hub.InvokeAsync<PoRacerRaceSnapshot>("JoinRace", _code, _asPlayer, _trackId, _options, cancellationToken);
        if (Joined is { } joined) await joined(snapshot);
        _ready = true;
        if (snapshot.Result is { } result && Finished is { } finished) await finished(result);
    }

    public async Task SendInputAsync(PoRacerInput input)
    {
        _input = input;
        if (!_asPlayer || !_ready) return;
        try
        {
            await _inputGate.WaitAsync(_lifetime.Token);
            try
            {
                if (_ready) await _hub.InvokeAsync("SendInput", _input, _lifetime.Token);
            }
            finally { _inputGate.Release(); }
        }
        catch (OperationCanceledException) when (_lifetime.IsCancellationRequested) { }
        catch (Exception ex) when (ex is InvalidOperationException or HttpRequestException)
        {
            if (StatusChanged is { } handler) await handler("Input interrupted. Reconnecting…");
        }
    }

    /// <summary>Pause or resume the race clock. The server honours it for solo races only; best-effort.</summary>
    public async Task SetPausedAsync(bool paused)
    {
        if (!_asPlayer || !_ready) return;
        try { await _hub.InvokeAsync("SetPaused", paused, _lifetime.Token); }
        catch (Exception ex) when (ex is OperationCanceledException or InvalidOperationException or HttpRequestException) { }
    }

    public async ValueTask DisposeAsync()
    {
        _ready = false;
        await _lifetime.CancelAsync();
        await _hub.DisposeAsync();
        _lifetime.Dispose();
    }
}
