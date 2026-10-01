using Microsoft.AspNetCore.SignalR.Client;
using PoMiniGames.Shared.Games;
using PoMiniGamesClient.Services.Auth;
using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGamesClient.Games.PoVoxelStrike.Services;

/// <summary>
/// Client-side wrapper around the two PoVoxelStrike multiplayer hubs:
/// <list type="bullet">
/// <item><c>/povoxelstrike/lobby-hub</c> — single global room; join/ready/start. Mirrors
/// PoRacer/PoFunQuiz/PoSports lobby hubs exactly.</item>
/// <item><c>/povoxelstrike/lockstep-hub</c> — active run; relays inputs from the local
/// player to the server, surfaces incoming frames from peers, and forwards heartbeats
/// so the server can flag desync.</item>
/// </list>
/// </summary>
/// <remarks>
/// <para>The lockstep runtime uses a strict ordering contract: every client observes
/// every input batch in PlayerNumber order, then applies them locally. There is no
/// authoritative sim — the server only relays inputs. Determinism is the client's
/// responsibility; the server-side validation is "did your fingerprint match the
/// aggregate the server stamped on this frame?".</para>
///
/// <para>The wrapper deliberately keeps the lobby and lockstep connections separate
/// (mirrors PoSports): the lobby closes before the lockstep opens, the lockstep
/// closes before the lobby reopens on game-over.</para>
/// </remarks>
public sealed class PoVoxelStrikeMultiplayerClient : IAsyncDisposable
{
    private readonly ApiEndpoints _endpoints;
    private HubConnection? _lockstep;
    private readonly List<IDisposable> _lockstepSubs = new();
    /// <summary>The game code this connection is bound to; surfaced for the lockstep reconnect handler.</summary>
    private string _gameCode = "";

    /// <summary>The lobby half: the shared ready/start client (2026-09-14). Pages subscribe to its events directly.</summary>
    public LobbyClient<PoVoxelStrikeLobbyPlayer> Lobby { get; }

    /// <summary>One tick of authoritative state; the engine applies each batch in order.</summary>
    public event Action<PoVoxelStrikeLockstepFrame>? FrameReceived;
    /// <summary>A peer dropped; payload is the connection id (informational only).</summary>
    public event Action<string>? PlayerDropped;
    /// <summary>The host ended the run; payload is empty.</summary>
    public event Action? RunEnded;
    /// <summary>A squadmate carved the arena: (playerNumber, kind, structure index, x, y, z).</summary>
    public event Action<int, int, int, float, float, float>? CarveReceived;
    /// <summary>A squadmate took the chalice; payload is their player number.</summary>
    public event Action<int>? SquadWon;

    public string LobbyConnectionId => Lobby.ConnectionId;

    public PoVoxelStrikeMultiplayerClient(ApiEndpoints endpoints)
    {
        _endpoints = endpoints;
        Lobby = new LobbyClient<PoVoxelStrikeLobbyPlayer>(endpoints, "povoxelstrike/lobby-hub");
    }

    // ── Lobby ─────────────────────────────────────────────────────────────

    public Task<LobbyState<PoVoxelStrikeLobbyPlayer>?> ConnectLobbyAsync(string displayName, bool isGuest) =>
        Lobby.ConnectAndJoinAsync(displayName, isGuest);

    public Task ToggleReadyAsync() => Lobby.ToggleReadyAsync();

    public Task StartGameAsync() => Lobby.StartGameAsync();

    public Task LeaveLobbyAsync() => Lobby.LeaveLobbyAsync();

    // ── Lockstep ──────────────────────────────────────────────────────────

    /// <summary>
    /// Join (or rejoin) the active run. Returns the session info (players, tick rate) so
    /// the engine can spin up its multiplayer branch with the correct player roster.
    /// </summary>
    public async Task<PoVoxelStrikeLockstepSessionInfo?> JoinLockstepAsync(string gameCode)
    {
        _gameCode = gameCode;
        if (_lockstep is null)
        {
            _lockstep = HubConnectionFactory.Create(_endpoints.Hub("povoxelstrike/lockstep-hub"));

            _lockstepSubs.Add(_lockstep.On<PoVoxelStrikeLockstepFrame>("frame", f => FrameReceived?.Invoke(f)));
            _lockstepSubs.Add(_lockstep.On<string>("playerDropped", c => PlayerDropped?.Invoke(c)));
            _lockstepSubs.Add(_lockstep.On("runEnded", () => RunEnded?.Invoke()));
            _lockstepSubs.Add(_lockstep.On<int, int, int, float, float, float>("carve",
                (n, kind, structure, x, y, z) => CarveReceived?.Invoke(n, kind, structure, x, y, z)));
            _lockstepSubs.Add(_lockstep.On<int>("squadWon", n => SquadWon?.Invoke(n)));

            await _lockstep.StartAsync();

            _lockstep.Reconnected += async _ =>
            {
                try { await _lockstep.InvokeAsync<PoVoxelStrikeLockstepSessionInfo?>("JoinLockstep", _gameCode); }
                catch { /* surfaced on next user action */ }
            };
        }
        return await _lockstep.InvokeAsync<PoVoxelStrikeLockstepSessionInfo?>("JoinLockstep", _gameCode);
    }

    /// <summary>Ship a batch of local inputs to the server for relay on the next frame.</summary>
    public Task SubmitInputsAsync(PoVoxelStrikeInputBatch batch)
    {
        // Stamp the connection id client-side; the hub overwrites it server-side too.
        batch.ConnectionId = _lockstep?.ConnectionId ?? "";
        return _lockstep?.InvokeAsync("SubmitInputs", batch) ?? Task.CompletedTask;
    }

    /// <summary>Tell the server the last tick we acked + the local fingerprint for desync detection.</summary>
    public Task HeartbeatAsync(PoVoxelStrikeClientHeartbeat heartbeat)
        => _lockstep?.InvokeAsync("Heartbeat", heartbeat) ?? Task.CompletedTask;

    /// <summary>Relay one carve to the squad. Sent, not invoked: nothing waits on a reply, and
    /// a hole must never queue behind the previous one's acknowledgement.</summary>
    public Task SendCarveAsync(int playerNumber, int kind, int structure, float x, float y, float z) =>
        _lockstep?.SendAsync("Carve", playerNumber, kind, structure, x, y, z) ?? Task.CompletedTask;

    /// <summary>Tell the squad the chalice is taken.</summary>
    public Task ClaimChaliceAsync(int playerNumber) =>
        _lockstep?.SendAsync("ClaimChalice", playerNumber) ?? Task.CompletedTask;

    /// <summary>Host-only: end the run and broadcast runEnded to every peer.</summary>
    public Task EndRunAsync() => _lockstep?.InvokeAsync("EndRun") ?? Task.CompletedTask;

    /// <summary>Close the lockstep connection when the run ends. Mirrors PoSports.StopRaceAsync.</summary>
    public async Task StopLockstepAsync()
    {
        var lockstep = _lockstep;
        _lockstep = null;
        _gameCode = "";
        foreach (var s in _lockstepSubs) s.Dispose();
        _lockstepSubs.Clear();
        if (lockstep is not null)
        {
            try { await lockstep.DisposeAsync(); } catch { /* socket may already be closed */ }
        }
    }

    public async ValueTask DisposeAsync()
    {
        await StopLockstepAsync();
        await Lobby.DisposeAsync();
    }
}
