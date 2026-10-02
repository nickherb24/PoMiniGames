using PoMiniGames.Domain.Primitives;

namespace PoMiniGames.Shared.Games;

// ─────────────────────────────  Match runtime  ──────────────────────────────
//
// What the server broadcasts and what the client sends during a live 1v1.
//
// Scope note: PoBrawl's existing JS engine owns all physics, hitbox math, and
// animation. Porting that whole pipeline to C# in one shot is out of scope, so
// the server-authoritative boundary is the *combat outcome*: HP totals, damage
// applied per landed hit, spacing, and the eventual winner. The
// server also owns a one-dimensional ring (each corner's X), because an outcome
// that ignores distance is not an outcome: attacks land only inside their reach.
// A client never reports a hit at all — it reports inputs, and the server decides.

/// <summary>
/// One input event a client sends to the server during a match, on every input change.
/// <see cref="PoBrawlMatchAction.Punch"/>, <see cref="PoBrawlMatchAction.Kick"/> and
/// <see cref="PoBrawlMatchAction.Special"/> are PRESSES (buffered one deep, fired once);
/// every other action is the new HELD state, so the client must send one on key-up too
/// (usually <see cref="PoBrawlMatchAction.Idle"/>) or the fighter keeps walking.
/// </summary>
/// <remarks>
/// <para>
/// Movement direction is encoded explicitly rather than as a key string so a
/// client cannot smuggle in something like <c>"fireball"</c> the engine has no
/// fighter for. The enum is closed.
/// </para>
/// <para>
/// The server validates <see cref="ActorSide"/> against the connection's known
/// side at JoinMatch; an honest client never supplies this — it is here so a
/// malicious client cannot claim to be the other side.
/// </para>
/// </remarks>
public sealed class PoBrawlMatchInput
{
    /// <summary>Which side this input is from. Server-overridden with the connection's pinned side.</summary>
    public PoBrawlSide ActorSide { get; set; }
    /// <summary>What the player is currently doing. Server applies the side effect.</summary>
    public PoBrawlMatchAction Action { get; set; }
    /// <summary>Sequence number for client→server ordering. Server ignores stale inputs.</summary>
    public long Sequence { get; set; }
}

/// <summary>
/// The online ring's geometry, shared so the server that resolves a swing and the page that
/// draws the range read the same numbers. The walk speeds, cooldowns and knockback live on
/// the server (PoBrawlMatchService) because nothing client-side needs them.
/// </summary>
public static class PoBrawlOnlineRules
{
    /// <summary>Half-width of the ring, metres (the local engine's arena.js RING_HALF).</summary>
    public const double RingHalf = 5.2;
    /// <summary>Largest gap, metres, at which each attack still connects.</summary>
    public const double PunchReach = 1.5;
    public const double KickReach = 1.75;
    public const double SpecialReach = 1.75;
}

public enum PoBrawlSide
{
    Player1 = 0,
    Player2 = 1,
}

public enum PoBrawlMatchAction
{
    Idle = 0,
    MoveForward = 1,
    MoveBack = 2,
    Block = 3,
    /// <summary>Punch (a press). Lands only if the gap is inside punch reach when it fires.</summary>
    Punch = 4,
    /// <summary>Kick. Higher damage, slower cadence.</summary>
    Kick = 5,
    /// <summary>Special. Costs energy and lands a heavy hit when energy is full.</summary>
    Special = 6,
}

/// <summary>
/// Server-authoritative snapshot of the match. Broadcast ~10 Hz on the match group.
/// </summary>
public sealed class PoBrawlMatchState
{
    /// <summary>Stable match id (lobby-stamped GUID), echoed back so retries dedupe.</summary>
    public string MatchId { get; set; } = "";
    /// <summary>Wall-clock elapsed since the match started, in seconds.</summary>
    public double ElapsedSeconds { get; set; }
    /// <summary>P1's current HP, 0..100.</summary>
    public int Player1Hp { get; set; } = 100;
    /// <summary>P2's current HP, 0..100.</summary>
    public int Player2Hp { get; set; } = 100;
    /// <summary>P1's energy meter, 0..100.</summary>
    public int Player1Energy { get; set; }
    /// <summary>P2's energy meter, 0..100.</summary>
    public int Player2Energy { get; set; }
    /// <summary>P1's position on the one-dimensional ring, metres from centre (negative = left).</summary>
    public double Player1X { get; set; } = -1.6;
    /// <summary>P2's position; always at least the minimum gap to the right of P1.</summary>
    public double Player2X { get; set; } = 1.6;
    /// <summary>
    /// Last event the server resolved this tick (or empty): <c>p1-hit</c>, <c>p1-special</c>,
    /// <c>p1-blocked</c>, <c>p1-whiff</c> (and the p2 forms), <c>ko</c>, <c>time-up</c>, <c>time-up-draw</c>.
    /// </summary>
    public string LastEvent { get; set; } = "";
    /// <summary>True when the match is over (a side at 0 HP, the timer ran out, or a forfeit).</summary>
    public bool Finished { get; set; }
    /// <summary>Winner side when <see cref="Finished"/> is true; otherwise null. Empty string on a draw.</summary>
    public PoBrawlSide? Winner { get; set; }

    // ── Per-corner detail for the 3D view ───────────────────────────────────
    // The arena engine plays the fight as a puppet of these snapshots, so it needs what each
    // corner is holding and what each swing did THIS tick — LastEvent carries one event,
    // and both corners can swing on the same tick.

    /// <summary>Monotonic tick number, so the client can drop a snapshot that arrived late.</summary>
    public long Tick { get; set; }
    /// <summary>What each corner is holding: Idle, MoveForward, MoveBack or Block.</summary>
    public PoBrawlMatchAction Player1Held { get; set; }
    public PoBrawlMatchAction Player2Held { get; set; }
    /// <summary>The attack each corner threw this tick, or null.</summary>
    public PoBrawlMatchAction? Player1Swing { get; set; }
    public PoBrawlMatchAction? Player2Swing { get; set; }
    /// <summary>What that swing did: <c>hit</c>, <c>blocked</c> or <c>whiff</c> ("" with no swing).</summary>
    public string Player1Outcome { get; set; } = "";
    public string Player2Outcome { get; set; } = "";
    /// <summary>Damage that swing dealt (0 for a block or whiff).</summary>
    public int Player1Damage { get; set; }
    public int Player2Damage { get; set; }
    /// <summary>Whether each corner has a live connection. A dropped corner has a grace window to come back.</summary>
    public bool Player1Connected { get; set; } = true;
    public bool Player2Connected { get; set; } = true;
    /// <summary>Seconds until a dropped corner forfeits, or null when both are here.</summary>
    public double? ForfeitInSeconds { get; set; }
    /// <summary>How many corners have asked for a rematch since the bell (0–2).</summary>
    public int RematchVotes { get; set; }
}

/// <summary>
/// Static per-match information returned once at JoinMatch. Carries the lobby-derived
/// player identities and the local side the connection was pinned to.
/// </summary>
public sealed class PoBrawlMatchSnapshot
{
    public string MatchId { get; set; } = "";
    /// <summary>The match code — the rematch and the reconnect both find the fight by it.</summary>
    public string GameCode { get; set; } = "";
    public PoBrawlMatchPlayerInfo Player1 { get; set; } = new("", "");
    public PoBrawlMatchPlayerInfo Player2 { get; set; } = new("", "");
    public PoBrawlSide LocalSide { get; set; }
    /// <summary>True for a caller with no seat on this fight: they watch, and their inputs are ignored.</summary>
    public bool IsSpectator { get; set; }
}

public sealed record PoBrawlMatchPlayerInfo(string DisplayName, string FighterId);

/// <summary>
/// Final result the server returns when the match ends. Clients POST this back
/// to /api/pobrawl/matches so the result lands in MatchHistory and the Elo table.
/// </summary>
public sealed class PoBrawlMatchResult
{
    public string MatchId { get; set; } = "";
    /// <summary>Side the local player was on. Used by the client to map outcome to Owner/Opponent.</summary>
    public PoBrawlSide LocalSide { get; set; }
    /// <summary>Outcome from the local player's perspective.</summary>
    public PoBrawlOutcome Outcome { get; set; }
    /// <summary>Wall-clock duration, server-stamped so a client cannot pad its own result.</summary>
    public double DurationSeconds { get; set; }
    /// <summary>Final HP totals so the result modal can show the fight score.</summary>
    public int Player1Hp { get; set; }
    public int Player2Hp { get; set; }
    /// <summary>The opponent's principal id (server-stamped from the lobby roster).
    /// Included so the client can POST a complete match-result payload without a
    /// second round-trip to /api/auth/handshake.</summary>
    public string OpponentId { get; set; } = "";
    public string OpponentDisplayName { get; set; } = "";
    /// <summary>True when the fight ended because one corner never came back from a disconnect.</summary>
    public bool Forfeit { get; set; }
}
