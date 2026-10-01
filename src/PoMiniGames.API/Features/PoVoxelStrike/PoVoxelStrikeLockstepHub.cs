using Microsoft.AspNetCore.SignalR;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoVoxelStrike;

/// <summary>
/// Runtime hub for an active co-op run. The client connects after <see cref="PoVoxelStrikeLobbyHub.StartGame"/>
/// and calls <see cref="JoinLockstep"/> to bind its connection to the session. The
/// hub pumps a single <see cref="PoVoxelStrikeLockstepFrame"/> every <see cref="PoVoxelStrikeLockstepService.TickIntervalMs"/>
/// with every peer's input batched in order; clients apply them to their local engine
/// and emit heartbeats so the server can flag desync.
/// </summary>
public sealed class PoVoxelStrikeLockstepHub : Hub
{
    private readonly PoVoxelStrikeLobbyService _lobby;
    private readonly PoVoxelStrikeLockstepService _lockstep;
    private readonly ILogger<PoVoxelStrikeLockstepHub> _log;

    public PoVoxelStrikeLockstepHub(
        PoVoxelStrikeLobbyService lobby,
        PoVoxelStrikeLockstepService lockstep,
        ILogger<PoVoxelStrikeLockstepHub> log)
    {
        _lobby = lobby;
        _lockstep = lockstep;
        _log = log;
    }

    public override async Task OnConnectedAsync()
    {
        await base.OnConnectedAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? ex)
    {
        var session = _lockstep.GetByConnection(Context.ConnectionId);
        if (session is not null)
        {
            await Clients.Group(PoVoxelStrikeLockstepService.GroupPrefix + "-" + session.GameCode)
                .SendAsync("playerDropped", Context.ConnectionId);
        }
        _lockstep.RemoveConnection(Context.ConnectionId);
        await base.OnDisconnectedAsync(ex);
    }

    /// <summary>Bind the connection to the run session and add to the SignalR group.</summary>
    public async Task<PoVoxelStrikeLockstepSessionInfo> JoinLockstep(string gameCode)
    {
        var session = _lockstep.GetOrCreateSession(gameCode, _lobby.Players);
        _lockstep.BindConnection(Context.ConnectionId, gameCode);
        await Groups.AddToGroupAsync(Context.ConnectionId, PoVoxelStrikeLockstepService.GroupPrefix + "-" + gameCode);
        _log.LogInformation("PoVoxelStrike lockstep: conn={Conn} joined session={Game} players={Count}",
            Context.ConnectionId, gameCode, session.Players.Count);
        return new PoVoxelStrikeLockstepSessionInfo(
            GameCode: gameCode,
            TickHz: PoVoxelStrikeLockstepService.TickHz,
            Players: session.Players,
            StartedAtMs: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            Seed: session.Seed);
    }

    /// <summary>Submit a batch of inputs for the current tick. The next frame will broadcast them to all peers.</summary>
    public Task SubmitInputs(PoVoxelStrikeInputBatch batch)
    {
        batch.ConnectionId = Context.ConnectionId;
        var session = _lockstep.GetByConnection(Context.ConnectionId);
        session?.SubmitInput(batch);
        return Task.CompletedTask;
    }

    /// <summary>Heartbeat from the client. Server records the last ack tick + fingerprint for desync detection.</summary>
    public Task Heartbeat(PoVoxelStrikeClientHeartbeat heartbeat)
    {
        var session = _lockstep.GetByConnection(Context.ConnectionId);
        session?.Heartbeat(heartbeat, Context.ConnectionId);
        return Task.CompletedTask;
    }

    /// <summary>
    /// One carve (kind 0 = a dig shot, 1 = a blast) relayed to the rest of the squad, so the
    /// wall one player opens is open for everyone. It rides its own message rather than the
    /// input batch on purpose: batches are latest-wins (a newer one replaces an unsent older
    /// one, and the page drops a frame while the last is still applying), which is right for
    /// a position and wrong for a hole. <paramref name="structure"/> is the index into the
    /// arena's structure list — every client builds that list from the same seed — or -1 for
    /// the ground. The player number is the sender's word, like the batch's.
    /// </summary>
    public Task Carve(int playerNumber, int kind, int structure, float x, float y, float z)
    {
        var session = _lockstep.GetByConnection(Context.ConnectionId);
        if (session is null || kind is < 0 or > 1 || structure < -1) return Task.CompletedTask;
        if (!IsInArena(x) || !IsInArena(y) || !IsInArena(z)) return Task.CompletedTask;
        return Clients.OthersInGroup(PoVoxelStrikeLockstepService.GroupPrefix + "-" + session.GameCode)
            .SendAsync("carve", playerNumber, kind, structure, x, y, z);
    }

    /// <summary>Someone took the chalice: the whole squad wins, each on their own stats.</summary>
    public Task ClaimChalice(int playerNumber)
    {
        var session = _lockstep.GetByConnection(Context.ConnectionId);
        if (session is null) return Task.CompletedTask;
        return Clients.OthersInGroup(PoVoxelStrikeLockstepService.GroupPrefix + "-" + session.GameCode)
            .SendAsync("squadWon", playerNumber);
    }

    // The arena is 180 units across; anything outside this is not a carve in it (and NaN fails both).
    private static bool IsInArena(float v) => v is > -250f and < 250f;

    /// <summary>End the run and tear down the session. Only the host may call this.</summary>
    public async Task EndRun()
    {
        var session = _lockstep.GetByConnection(Context.ConnectionId);
        if (session is null) return;
        // Only the host can end the run — the host is whoever the lobby currently has as host.
        if (_lobby.HostConnectionId != Context.ConnectionId) return;
        await Clients.Group(PoVoxelStrikeLockstepService.GroupPrefix + "-" + session.GameCode)
            .SendAsync("runEnded");
        _lockstep.EndRun(session.GameCode);
        _lobby.End();
    }
}

/// <summary>One-shot payload the lockstep hub returns to a freshly-joined client.</summary>
// Defined in PoMiniGames.Shared.Games so the client wrapper can type it without an
// API-project reference. See PoMiniGames.Shared.Games.PoVoxelStrikeLockstepSessionInfo.
