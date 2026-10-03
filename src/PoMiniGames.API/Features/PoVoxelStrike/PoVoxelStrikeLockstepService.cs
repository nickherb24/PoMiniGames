using System.Collections.Concurrent;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoVoxelStrike;

/// <summary>
/// In-memory runtime for an active co-op run. One session per game code (the lobby
/// allocates one at StartGame; the lobby hub broadcasts the code so clients can
/// switch to the lockstep hub).
/// <para><b>Wire model:</b> clients send one <see cref="PoVoxelStrikeInput"/> per tick.
/// The server collects inputs across a 50 ms window (20 Hz) and broadcasts a single
/// <see cref="PoVoxelStrikeLockstepFrame"/> with every peer's input batched in
/// PlayerNumber order. Clients apply the inputs to their local engine and emit
/// their own fingerprint; the server compares incoming fingerprints and flags
/// desync — the affected client is told to re-sync to the last ack frame.</para>
///
/// <para>The session is in-memory only; an F1 host restart drops the run. Runs are
/// ephemeral; only the score persists.</para>
/// </summary>
public sealed class PoVoxelStrikeLockstepService
{
    /// <summary>Hub tick rate. 20 Hz is the platform convention (matches PoRacer/PoFunQuiz hub pumps).</summary>
    public const int TickHz = 20;
    public const int TickIntervalMs = 1000 / TickHz;

    /// <summary>Hub group suffix. Real SignalR groups are namespaced; the lockstep hub joins "<c>{prefix}-{gameCode}</c>".</summary>
    public const string GroupPrefix = "povoxelstrike-run";

    private readonly ConcurrentDictionary<string, PoVoxelStrikeLockstepSession> _sessions = new();
    private readonly ConcurrentDictionary<string, string> _connectionToSession = new();
    private readonly ILogger<PoVoxelStrikeLockstepService> _log;

    public PoVoxelStrikeLockstepService(ILogger<PoVoxelStrikeLockstepService> log)
    {
        _log = log;
    }

    /// <summary>Spin up a session for the given code, capturing the current player list.</summary>
    public PoVoxelStrikeLockstepSession GetOrCreateSession(string gameCode, IReadOnlyList<PoVoxelStrikeLobbyPlayer> players)
    {
        return _sessions.GetOrAdd(gameCode, code => new PoVoxelStrikeLockstepSession(code, players, _log));
    }

    /// <summary>True while no lockstep session exists. The pump polls this to
    /// idle at a fraction of the tick rate instead of waking 20×/sec for the
    /// whole process lifetime. ConcurrentDictionary.IsEmpty
    /// is O(1) and allocation-free, unlike <see cref="Sessions"/>.</summary>
    public bool IsIdle => _sessions.IsEmpty;

    /// <summary>Look up the session a connection is currently in, or null if none.</summary>
    public PoVoxelStrikeLockstepSession? GetByConnection(string connectionId)
    {
        if (!_connectionToSession.TryGetValue(connectionId, out var code)) return null;
        return _sessions.TryGetValue(code, out var s) ? s : null;
    }

    /// <summary>Bind a connection to its session after the lockstep hub handshake.</summary>
    public void BindConnection(string connectionId, string gameCode)
    {
        // Joining a second run leaves the first, or that session never empties.
        RemoveConnection(connectionId);
        _connectionToSession[connectionId] = gameCode;
        if (_sessions.TryGetValue(gameCode, out var session)) session.AddMember(connectionId);
    }

    /// <summary>Drop a connection from any session it was in. Idempotent.</summary>
    public void RemoveConnection(string connectionId)
    {
        if (!_connectionToSession.TryRemove(connectionId, out var code)) return;
        if (!_sessions.TryGetValue(code, out var session)) return;
        session.MarkDropped(connectionId);
        if (session.IsEmpty)
        {
            _sessions.TryRemove(code, out _);
        }
    }

    /// <summary>End the run for the given code and tear down the session.</summary>
    public void EndRun(string gameCode)
    {
        if (!_sessions.TryRemove(gameCode, out var session)) return;
        foreach (var conn in session.ConnectionIds.ToList())
        {
            _connectionToSession.TryRemove(conn, out _);
        }
    }

    /// <summary>Snapshot of every active session. Used by the background frame pump to broadcast one frame per session per tick.</summary>
    public IReadOnlyCollection<PoVoxelStrikeLockstepSession> Sessions => _sessions.Values.ToList();
}

/// <summary>
/// One in-memory run. Owns the per-tick input window, the last broadcast frame, and
/// the per-connection fingerprint table used to detect desync.
/// </summary>
public sealed class PoVoxelStrikeLockstepSession
{
    private readonly object _tickLock = new();
    private readonly ConcurrentDictionary<string, PoVoxelStrikeInputBatch> _pendingInputs = new();
    private readonly ConcurrentDictionary<string, int> _fingerprints = new();
    private readonly ConcurrentDictionary<string, int> _lastAckTick = new();
    private int _nextTick;
    private long _startedAtMs;

    public string GameCode { get; }
    public IReadOnlyList<PoVoxelStrikeLobbyPlayer> Players { get; private set; }
    public int Fingerprint { get; private set; }
    /// <summary>World seed for the run. Dealt once here so every client builds the same arena.</summary>
    public int Seed { get; } = Random.Shared.Next(1, int.MaxValue);

    public PoVoxelStrikeLockstepSession(string gameCode, IReadOnlyList<PoVoxelStrikeLobbyPlayer> players, ILogger log)
    {
        GameCode = gameCode;
        Players = players;
        _startedAtMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    }

    // Who is in the run. Not _pendingInputs: that is cleared on every drained frame, so
    // "no pending input" is true most of the time and one disconnect ended the run for all.
    private readonly ConcurrentDictionary<string, byte> _members = new();

    public ICollection<string> ConnectionIds => _members.Keys;

    public bool IsEmpty => _members.IsEmpty;

    public void AddMember(string connectionId) => _members[connectionId] = 0;

    /// <summary>Stash the latest input batch for this connection. The next <see cref="DrainFrame"/> picks it up.</summary>
    public void SubmitInput(PoVoxelStrikeInputBatch batch)
    {
        if (batch.PlayerNumber <= 0 || batch.PlayerNumber > Players.Count)
        {
            return; // not part of this session
        }
        _pendingInputs[batch.ConnectionId] = batch;
    }

    /// <summary>Mark a heartbeat from a client. Used to detect stalls and to bound the reconnection grace.</summary>
    public void Heartbeat(PoVoxelStrikeClientHeartbeat heartbeat, string connectionId)
    {
        _fingerprints[connectionId] = heartbeat.LocalFingerprint;
        _lastAckTick[connectionId] = heartbeat.LastAckTick;
    }

    /// <summary>Mark a connection as dropped (after a websocket disconnect). Its tick batches become empty.</summary>
    public void MarkDropped(string connectionId)
    {
        _members.TryRemove(connectionId, out _);
        _pendingInputs.TryRemove(connectionId, out _);
        _fingerprints.TryRemove(connectionId, out _);
        _lastAckTick.TryRemove(connectionId, out _);
    }

    /// <summary>
    /// Consume every pending input batch into a single <see cref="PoVoxelStrikeLockstepFrame"/>
    /// tagged with the next tick number. Returns null if no batches were submitted this
    /// window (the hub should not broadcast an empty frame).
    /// </summary>
    public PoVoxelStrikeLockstepFrame? DrainFrame()
    {
        lock (_tickLock)
        {
            if (_pendingInputs.IsEmpty) return null;
            _nextTick++;
            var ordered = new List<PoVoxelStrikeInputBatch>(Players.Count);
            // Always emit one ordered slot per player; absent players produce an empty batch
            // so every client sees the same PlayerNumber→batch mapping.
            for (var i = 0; i < Players.Count; i++)
            {
                var player = Players[i];
                PoVoxelStrikeInputBatch? batch = null;
                foreach (var kv in _pendingInputs)
                {
                    if (kv.Value.PlayerNumber == player.PlayerNumber)
                    {
                        batch = kv.Value;
                        break;
                    }
                }
                ordered.Add(batch ?? new PoVoxelStrikeInputBatch
                {
                    ConnectionId = player.ConnectionId,
                    PlayerNumber = player.PlayerNumber,
                    Tick = _nextTick,
                });
            }
            // Aggregate fingerprint: sum of per-player fingerprints mod int.MaxValue. Cheap to
            // compute and stable across clients because the inputs are deterministic.
            var fp = 0;
            foreach (var v in _fingerprints.Values) fp = unchecked((fp + v) & 0x7FFFFFFF);
            Fingerprint = fp;
            _pendingInputs.Clear();
            return new PoVoxelStrikeLockstepFrame
            {
                Tick = _nextTick,
                ServerTimeMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                Batches = ordered,
                Fingerprint = fp,
            };
        }
    }

    /// <summary>Stops the session and clears state. Idempotent.</summary>
    public void End()
    {
        _pendingInputs.Clear();
        _fingerprints.Clear();
        _lastAckTick.Clear();
    }
}
