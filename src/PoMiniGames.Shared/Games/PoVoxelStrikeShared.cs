namespace PoMiniGames.Shared.Games;

// ──────────────────────────────  PoVoxelStrike Lobby  ──────────────────────────────

/// <summary>
/// One seat in the PoVoxelStrike multiplayer lobby. The lobby is the single global
/// room (mirrors PoRacer/PoFunQuiz): first arrival becomes host, subsequent callers
/// join until <see cref="PoVoxelStrikeLobbyState.MaxPlayers"/> is reached.
/// </summary>
// The lobby state and event records live in LobbyShared.cs (LobbyState<PoVoxelStrikeLobbyPlayer>,
// LobbyEvent) — one wire shape for every ready/start lobby.
public sealed record PoVoxelStrikeLobbyPlayer(
    string ConnectionId,
    string DisplayName,
    bool IsGuest,
    bool IsReady,
    /// <summary>1-based seat. Stable for the lifetime of the lobby; the lockstep hub uses it to map inputs to actor ids.</summary>
    int PlayerNumber) : ILobbyPlayer;

// ──────────────────────────────  PoVoxelStrike Lockstep  ──────────────────────────────

/// <summary>
/// One tick of a single player's input. The server ships it to all peers verbatim;
/// clients must NOT transform it (no smoothing, no re-prediction) — the whole
/// determinism story depends on every client observing the same input stream.
/// </summary>
public sealed class PoVoxelStrikeInput
{
    public bool Forward { get; set; }
    public bool Back { get; set; }
    public bool Left { get; set; }
    public bool Right { get; set; }
    public bool Fire { get; set; }
    public bool AltFire { get; set; }

    /// <summary>Yaw in degrees, [-180, 180]. Mouse-delta is integrated client-side; the hub relays the resulting absolute yaw.</summary>
    public float Yaw { get; set; }

    /// <summary>Pitch in degrees, [-89, 89]. Same source as Yaw.</summary>
    public float Pitch { get; set; }

    /// <summary>
    /// The player's world position at this tick, for co-presence: peers
    /// render each other from these rather than re-simulating each other's movement, which
    /// keeps the run playable without a deterministic engine (see game.js, "Online").
    /// </summary>
    public float X { get; set; }
    public float Y { get; set; }
    public float Z { get; set; }

    /// <summary>
    /// True while this player is down and waiting on a revive. Peers draw the
    /// avatar lying flat, and a downed player counts nobody who is also down as a rescuer.
    /// </summary>
    public bool Down { get; set; }
}

/// <summary>
/// Batched inputs from one player for one tick. Tick is a monotonic counter assigned
/// by the hub; clients never invent their own tick numbers.
/// </summary>
public sealed class PoVoxelStrikeInputBatch
{
    public string ConnectionId { get; set; } = "";
    public int PlayerNumber { get; set; }
    public int Tick { get; set; }
    public List<PoVoxelStrikeInput> Inputs { get; set; } = new();
}

/// <summary>
/// One tick of authoritative state stamped by the server. Clients apply the inputs
/// in their local engine and emit their own hash; mismatch is detected by the
/// desync watcher and the affected client must re-sync to the last ack frame.
/// </summary>
public sealed class PoVoxelStrikeLockstepFrame
{
    public int Tick { get; set; }
    public long ServerTimeMs { get; set; }
    /// <summary>One input batch per active player, in PlayerNumber order. Empty if a player dropped that frame.</summary>
    public List<PoVoxelStrikeInputBatch> Batches { get; set; } = new();
    /// <summary>Aggregate run-state fingerprint (player count + enemies alive + structures remaining). Used for late-join catch-up.</summary>
    public int Fingerprint { get; set; }
}

/// <summary>
/// Client → hub heartbeat. The server uses this to detect stalls and to bound
/// the reconnection grace before declaring a player dropped.
/// </summary>
public sealed class PoVoxelStrikeClientHeartbeat
{
    public int LastAckTick { get; set; }
    public int LocalFingerprint { get; set; }
    public double RttMs { get; set; }
}

/// <summary>One-shot payload the lockstep hub returns to a freshly-joined client. Lives in
/// Shared so the client wrapper can type its InvokeAsyncAsync return without an API-project
/// reference.</summary>
public sealed record PoVoxelStrikeLockstepSessionInfo(
    string GameCode,
    int TickHz,
    IReadOnlyList<PoVoxelStrikeLobbyPlayer> Players,
    long StartedAtMs,
    /// <summary>World seed shared by every client in the run, so the squad sees one arena.</summary>
    int Seed);
