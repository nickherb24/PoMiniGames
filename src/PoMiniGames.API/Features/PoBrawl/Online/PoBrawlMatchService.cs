using System.Collections.Concurrent;
using PoMiniGames.Domain.Primitives;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoBrawl.Online;

/// <summary>
/// One in-process PoBrawl 1v1 match. Owns the per-tick combat simulation,
/// input aggregation, and final result. Lifecycle: created by
/// <see cref="PoBrawlMatchRegistry"/> when the host starts a match, and swept by the
/// pump once it has lingered past <see cref="PoBrawlMatchRegistry.FinishedLinger"/>.
/// </summary>
/// <remarks>
/// <para>
/// Determinism vs. fairness. The HP / damage model is server-authoritative:
/// the server is the only place HP totals are mutated, and the server only
/// listens to inputs from the side the connection was pinned to at JoinMatch.
/// A client cannot fabricate a hit because every damage event is resolved here,
/// with the server's RNG (a deterministic per-match seed, so a replay of the same
/// inputs gives the same fight).
/// </para>
/// <para>
/// <b>Spacing is server-authoritative too.</b> Resolving every attack as a hit unless the
/// defender was blocking would mean the server never knew where anyone stood, so a jab
/// thrown from across the ring would land. Holding each side's LAST action live on every
/// tick would also be wrong, since the client only sends key-downs — one tap of punch
/// would punch ten times a second until another key was pressed. So:
/// </para>
/// <list type="bullet">
///   <item>The ring is one dimension: each corner has an X on [-<see cref="RingHalf"/>,
///   <see cref="RingHalf"/>], P1 always left of P2, never closer than <see cref="MinGap"/>
///   (the local engine's MIN_SEPARATION). Walking and blocking are HELD states; the client
///   sends the new held state on every key-down and key-up.</item>
///   <item>Punch / kick / special are one-shot PRESSES, buffered one deep, fired when that
///   corner's cooldown allows, and they land only when the start-of-tick gap is inside
///   that attack's reach. Both corners' swings resolve against the same start-of-tick gap,
///   so neither side's knockback can move the other out of range first.</item>
///   <item>A landed hit shoves the defender back (half as far through a guard), which is
///   what makes spacing a fight rather than a formality.</item>
/// </list>
/// <para>
/// This is still not the local engine: no capsules, no charge, no personalities. Those
/// stay client-side for the local modes. What the server owns is exactly what the
/// result depends on — HP, energy, spacing — plus enough of the engine's numbers (walk
/// speeds, separation, ring size) that the two feel alike.
/// </para>
/// <para>
/// <b>The page plays this fight in the 3D arena.</b> The engine runs as a puppet
/// of the snapshots (game.js online mode): it walks each fighter to the server's X, throws the
/// swing the server fired, and lands the damage the server rolled at the moment the limb
/// connects. So each tick reports each corner's held state, swing, outcome and damage.
/// The fight opens on a <see cref="CountdownSeconds"/> pre-roll (negative elapsed; inputs held
/// but not applied) so both browsers finish loading and play the same "3, 2, 1, FIGHT!".
/// </para>
/// <para>
/// <b>Presence.</b> A corner is present while any match-hub connection is pinned to it. One
/// that drops (or never arrives) gets a grace window, and then forfeits — before this a
/// disconnect left the other player punching an empty corner until the bell.
/// </para>
/// </remarks>
public sealed class PoBrawlMatchService
{
    /// <summary>
    /// Tick rate. 10 Hz matches the client UI's interpolation cadence; faster would
    /// burn CPU on input aggregation for no visible benefit.
    /// </summary>
    public const int TickHz = 10;

    /// <summary>Round length, seconds. Matches the 2P local round.</summary>
    public const double MatchDurationSeconds = 60.0;

    /// <summary>
    /// Pre-roll before the bell: long enough for both pages to load the arena and play the
    /// engine's 3.7 s countdown in step with it. The lobby's matches use this; tests start at 0.
    /// </summary>
    public const double CountdownSeconds = 5.0;

    /// <summary>How long a corner that dropped mid-fight has to reconnect before it forfeits.</summary>
    public const double ReconnectGraceSeconds = 15.0;

    /// <summary>How long a corner has to arrive at all (page load included) before it forfeits.</summary>
    public const double ArrivalGraceSeconds = 25.0;

    /// <summary>Punch base damage. Varied per hit by ±20%.</summary>
    public const int PunchBaseDamage = 6;
    public const int KickBaseDamage = 10;
    public const int SpecialBaseDamage = 18;

    /// <summary>Energy gain per landed hit.</summary>
    public const int EnergyOnLandHit = 6;
    public const int EnergyRegenPerTick = 1;

    // ── Spacing (mirrors the local engine; see the remarks) ──────────────────
    /// <summary>Half-width of the ring, metres (arena.js RING_HALF).</summary>
    public const double RingHalf = PoBrawlOnlineRules.RingHalf;
    /// <summary>Spawn distance from centre (game.js SPAWN_X_BY_SIDE), so the fight opens 3.2 m apart.</summary>
    public const double SpawnX = 1.6;
    /// <summary>Closest the two corners can stand (game.js MIN_SEPARATION).</summary>
    public const double MinGap = 0.95;
    /// <summary>Walk speeds, m/s — forward is faster than back, as in the local engine.</summary>
    public const double WalkInPerSecond = 2.4;
    public const double WalkOutPerSecond = 1.9;

    /// <summary>Largest gap, metres, at which each attack still connects.</summary>
    public const double PunchReach = PoBrawlOnlineRules.PunchReach;
    public const double KickReach = PoBrawlOnlineRules.KickReach;
    public const double SpecialReach = PoBrawlOnlineRules.SpecialReach;

    /// <summary>Ticks after a swing before that corner can swing again.</summary>
    public const int PunchCooldownTicks = 3;
    public const int KickCooldownTicks = 5;
    public const int SpecialCooldownTicks = 8;

    /// <summary>How far a landed hit shoves the defender, metres (halved through a guard).</summary>
    public const double PunchKnockback = 0.15;
    public const double KickKnockback = 0.45;
    public const double SpecialKnockback = 0.9;

    /// <summary>Energy each swing costs when it fires (the special instead needs and spends a full bar).</summary>
    public const int PunchEnergyCost = 3;
    public const int KickEnergyCost = 6;

    public string MatchId { get; }
    public string GameCode { get; }
    public IReadOnlyList<PoBrawlLobbyPlayer> Roster { get; }

    private readonly PoBrawlLobbyPlayer _p1;
    private readonly PoBrawlLobbyPlayer _p2;
    private readonly object _stateLock = new();

    /// <summary>One side's mutable state. Guarded by <see cref="_stateLock"/>.</summary>
    private sealed class Corner(double x)
    {
        public int Hp = 100;
        public int Energy;
        public double X = x;
        /// <summary>Idle / MoveForward / MoveBack / Block — what the player is holding.</summary>
        public PoBrawlMatchAction Held = PoBrawlMatchAction.Idle;
        /// <summary>A pressed attack waiting for the cooldown, buffered one deep (latest press wins).</summary>
        public PoBrawlMatchAction? Pending;
        public int Cooldown;
        public long LastSequence = long.MinValue;
        // ── This tick's swing, for the 3D view (reset every tick) ──
        public PoBrawlMatchAction? Swing;
        public string Outcome = "";
        public int Damage;
        // ── Presence ──
        public bool EverConnected;
        /// <summary>Seconds this corner has had no connection (reset on arrival).</summary>
        public double AbsentFor;
        public bool WantsRematch;
    }

    private readonly Corner _c1 = new(-SpawnX);
    private readonly Corner _c2 = new(SpawnX);
    private double _elapsedSeconds;
    private long _tick;
    private bool _finished;
    private bool _forfeit;
    private string _lastEvent = "";
    private PoBrawlSide? _winner;

    /// <summary>When the bell rang, or null while the fight is on. The registry drops a match a while after this.</summary>
    public DateTimeOffset? FinishedAtUtc { get; private set; }

    // RNG seeded deterministically from match id so a given input script always
    // produces the same damage rolls. Random.Shared would diverge between hosts in a
    // multi-instance deployment and even single-instance it has process-global state —
    // a per-match seed makes replays and dispute resolution reproducible.
    private readonly Random _rng;

    /// <summary>Connection-id keyed map. Set by the match hub at JoinMatch.</summary>
    private readonly ConcurrentDictionary<string, PoBrawlSide> _connections = new();

    /// <param name="countdownSeconds">Pre-roll before the bell (see <see cref="CountdownSeconds"/>); 0 starts the fight at once.</param>
    public PoBrawlMatchService(string matchId, string gameCode, IReadOnlyList<PoBrawlLobbyPlayer> roster, double countdownSeconds = 0)
    {
        MatchId = matchId;
        GameCode = gameCode;
        Roster = roster.ToList();
        // Roster is exactly two (lobby cap), but be defensive about ordering so the
        // host is always P1 regardless of who joined first at the SignalR level.
        _p1 = Roster[0];
        _p2 = Roster[1];
        _rng = new Random(StableSeed(matchId));
        _elapsedSeconds = -Math.Max(0, countdownSeconds);
    }

    private static int StableSeed(string matchId)
    {
        // Hash the match id to a 32-bit seed. matchId is a GUID so this gives uniform
        // coverage; Math.Abs on a hash code is risky for the FNV-style mix below
        // because the high bit can be set.
        unchecked
        {
            int hash = 17;
            foreach (var ch in matchId) hash = hash * 31 + ch;
            return hash == int.MinValue ? 0 : Math.Abs(hash);
        }
    }

    public PoBrawlSide SideFor(string connectionId) =>
        _connections.TryGetValue(connectionId, out var side) ? side : PoBrawlSide.Player1;

    public void RegisterConnection(string connectionId, PoBrawlSide side)
    {
        lock (_stateLock)
        {
            _connections[connectionId] = side;
            var corner = CornerOf(side);
            corner.EverConnected = true;
            corner.AbsentFor = 0;
        }
    }

    private Corner CornerOf(PoBrawlSide side) => side == PoBrawlSide.Player1 ? _c1 : _c2;

    private bool IsPresentLocked(PoBrawlSide side) => _connections.Values.Any(s => s == side);

    /// <summary>
    /// Every match-hub connection pinned to a side. The pump sends each its own result
    /// from this — NOT from <see cref="Roster"/>, whose connection ids belong to the lobby
    /// hub and do not exist on the match hub at all, so a result sent there reached nobody.
    /// </summary>
    public IReadOnlyCollection<string> ConnectionIds => _connections.Keys.ToArray();

    /// <summary>
    /// Pin a connection by the player's lobby-side principal id. The match hub
    /// and the lobby hub allocate separate connection ids, so we re-resolve the
    /// side by walking the roster instead of relying on the lobby connection id
    /// being passed through.
    /// </summary>
    public bool RegisterConnectionByPrincipal(string principalId, string connectionId)
    {
        if (string.IsNullOrEmpty(principalId)) return false;
        // Roster[0] is Player1, Roster[1] is Player2 (host-first, matches the lobby).
        for (var i = 0; i < Roster.Count; i++)
        {
            // Ignore-case: the lobby lower-cases the principal it seats (it doubles as a table
            // row key), while the claim id arrives as issued.
            if (string.Equals(Roster[i].PrincipalId, principalId, StringComparison.OrdinalIgnoreCase))
            {
                var side = i == 0 ? PoBrawlSide.Player1 : PoBrawlSide.Player2;
                RegisterConnection(connectionId, side);
                return true;
            }
        }
        return false;
    }

    /// <summary>
    /// Forget a connection. When it was the corner's last one, the corner lets go of whatever it
    /// was holding — a player who dropped mid-walk must not march into the ropes for the whole
    /// grace window — and its absence clock starts.
    /// </summary>
    public void UnregisterConnection(string connectionId)
    {
        lock (_stateLock)
        {
            if (!_connections.TryRemove(connectionId, out var side) || IsPresentLocked(side)) return;
            var corner = CornerOf(side);
            corner.Held = PoBrawlMatchAction.Idle;
            corner.Pending = null;
        }
    }

    /// <summary>
    /// A seated corner asks for the rematch. True once both have asked — the caller then starts
    /// the next fight with the same roster and code. Spectators and a fight still running get false.
    /// </summary>
    public bool VoteRematch(string connectionId)
    {
        lock (_stateLock)
        {
            if (!_finished || !_connections.TryGetValue(connectionId, out var side)) return false;
            CornerOf(side).WantsRematch = true;
            return _c1.WantsRematch && _c2.WantsRematch;
        }
    }

    /// <summary>The current snapshot, for a caller who needs it outside the tick (a join, a rematch vote).</summary>
    public PoBrawlMatchState Snapshot()
    {
        lock (_stateLock) return SnapshotLocked();
    }

    private static bool IsAttack(PoBrawlMatchAction a) =>
        a is PoBrawlMatchAction.Punch or PoBrawlMatchAction.Kick or PoBrawlMatchAction.Special;

    /// <summary>
    /// Submit the caller's input. Server overrides the <see cref="PoBrawlMatchInput.ActorSide"/>
    /// with the connection's pinned side so a malicious client cannot claim to be the other
    /// side. An attack is buffered as a press; anything else replaces the held state. An input
    /// older than the newest one already seen from that side is ignored.
    /// </summary>
    public bool SubmitInput(string connectionId, PoBrawlMatchInput input)
    {
        if (!_connections.TryGetValue(connectionId, out var pinned)) return false;
        // Override actor with server-known side.
        input.ActorSide = pinned;
        lock (_stateLock)
        {
            if (_finished) return false;
            var corner = pinned == PoBrawlSide.Player1 ? _c1 : _c2;
            if (input.Sequence < corner.LastSequence) return true; // stale — reordered in flight
            corner.LastSequence = input.Sequence;
            if (!Enum.IsDefined(input.Action)) return true;
            if (IsAttack(input.Action)) corner.Pending = input.Action;
            else corner.Held = input.Action;
        }
        return true;
    }

    /// <summary>
    /// Run one simulation tick. Returns the broadcastable snapshot, or null when
    /// the match had already ended. The pump calls this every 100 ms.
    /// </summary>
    public PoBrawlMatchState? Tick()
    {
        PoBrawlMatchState snapshot;
        lock (_stateLock)
        {
            if (_finished) return null;
            _tick++;
            _elapsedSeconds += 1.0 / TickHz;
            foreach (var c in new[] { _c1, _c2 })
            {
                c.Swing = null;
                c.Outcome = "";
                c.Damage = 0;
            }
            // The pre-roll: held keys are remembered (so a player already holding forward walks
            // on the bell), but nothing moves and a press made during the count is dropped.
            if (_elapsedSeconds <= 0)
            {
                _c1.Pending = null;
                _c2.Pending = null;
            }
            else
            {
                ApplyTickLocked();
            }
            TickPresenceLocked();
            // Timer-end: tie goes to the higher-HP side; exact tie is a draw.
            if (_finished)
            {
                // A forfeit (TickPresenceLocked) — already decided.
            }
            else if (_c1.Hp <= 0)
            {
                _finished = true; _winner = PoBrawlSide.Player2; _lastEvent = "ko";
            }
            else if (_c2.Hp <= 0)
            {
                _finished = true; _winner = PoBrawlSide.Player1; _lastEvent = "ko";
            }
            else if (_elapsedSeconds >= MatchDurationSeconds)
            {
                _finished = true;
                _winner = _c1.Hp > _c2.Hp ? PoBrawlSide.Player1
                    : _c2.Hp > _c1.Hp ? PoBrawlSide.Player2
                    : (PoBrawlSide?)null;
                _lastEvent = _winner is null ? "time-up-draw" : "time-up";
            }
            if (_finished) FinishedAtUtc = DateTimeOffset.UtcNow;

            snapshot = SnapshotLocked();
            // Clear last-event after one tick so the sound / shake on the client
            // fires once per occurrence and not every frame.
            _lastEvent = "";
        }
        return snapshot;
    }

    /// <summary>
    /// Advance each corner's absence clock and forfeit one that stayed away past its grace. Only
    /// the corner of a fight that has started to matter counts: both gone is an abandoned fight
    /// with no winner, which the registry simply drops.
    /// </summary>
    private void TickPresenceLocked()
    {
        foreach (var (corner, side) in new[] { (_c1, PoBrawlSide.Player1), (_c2, PoBrawlSide.Player2) })
        {
            if (IsPresentLocked(side)) corner.AbsentFor = 0;
            else corner.AbsentFor += 1.0 / TickHz;
        }
        var gone1 = _c1.AbsentFor >= GraceFor(_c1);
        var gone2 = _c2.AbsentFor >= GraceFor(_c2);
        if (!gone1 && !gone2) return;
        _finished = true;
        _forfeit = true;
        _winner = gone1 && gone2 ? null : gone1 ? PoBrawlSide.Player2 : PoBrawlSide.Player1;
        _lastEvent = _winner is null ? "abandoned" : "forfeit";
    }

    private static double GraceFor(Corner c) => c.EverConnected ? ReconnectGraceSeconds : ArrivalGraceSeconds;

    private double? ForfeitInLocked()
    {
        if (_finished) return null;
        var left = new[] { _c1, _c2 }
            .Where(c => c.AbsentFor > 0)
            .Select(c => GraceFor(c) - c.AbsentFor)
            .DefaultIfEmpty(double.NaN)
            .Min();
        return double.IsNaN(left) ? null : Math.Max(0, Math.Round(left, 1));
    }

    private PoBrawlMatchState SnapshotLocked() => new()
    {
        MatchId = MatchId,
        ElapsedSeconds = _elapsedSeconds,
        Player1Hp = _c1.Hp,
        Player2Hp = _c2.Hp,
        Player1Energy = _c1.Energy,
        Player2Energy = _c2.Energy,
        Player1X = Math.Round(_c1.X, 3),
        Player2X = Math.Round(_c2.X, 3),
        LastEvent = _lastEvent,
        Finished = _finished,
        Winner = _winner,
        Tick = _tick,
        Player1Held = _c1.Held,
        Player2Held = _c2.Held,
        Player1Swing = _c1.Swing,
        Player2Swing = _c2.Swing,
        Player1Outcome = _c1.Outcome,
        Player2Outcome = _c2.Outcome,
        Player1Damage = _c1.Damage,
        Player2Damage = _c2.Damage,
        Player1Connected = IsPresentLocked(PoBrawlSide.Player1),
        Player2Connected = IsPresentLocked(PoBrawlSide.Player2),
        // Only while a corner is actually away: an arriving corner's clock runs from the start
        // but is not news until someone else is waiting on it.
        ForfeitInSeconds = ForfeitInLocked() is { } left && (_c1.AbsentFor > 1 || _c2.AbsentFor > 1) ? left : null,
        RematchVotes = (_c1.WantsRematch ? 1 : 0) + (_c2.WantsRematch ? 1 : 0),
    };

    private void ApplyTickLocked()
    {
        // 1. Swings, both against the START-of-tick gap (see the remarks).
        var gap = _c2.X - _c1.X;
        var a1 = TakeSwing(_c1);
        var a2 = TakeSwing(_c2);
        // Swinging drops the guard for the tick: you cannot attack and block at once.
        var p1Guarding = a1 is null && _c1.Held == PoBrawlMatchAction.Block;
        var p2Guarding = a2 is null && _c2.Held == PoBrawlMatchAction.Block;
        if (a1 is { } s1) ResolveSwing(s1, _c1, _c2, p2Guarding, gap, isP1: true);
        if (a2 is { } s2) ResolveSwing(s2, _c2, _c1, p1Guarding, gap, isP1: false);

        // 2. Footwork. A guard plants you; a swing roots you for its tick.
        Walk(_c1, a1 is null, direction: +1);
        Walk(_c2, a2 is null, direction: -1);
        EnforceSpacing();

        // 3. Energy regen from what is held, and the cooldown clocks.
        foreach (var c in new[] { _c1, _c2 })
        {
            c.Energy = Math.Min(100, c.Energy + c.Held switch
            {
                PoBrawlMatchAction.Idle => EnergyRegenPerTick * 2,
                PoBrawlMatchAction.MoveForward or PoBrawlMatchAction.MoveBack => EnergyRegenPerTick,
                _ => 0,
            });
            if (c.Cooldown > 0) c.Cooldown--;
        }
    }

    /// <summary>The buffered press, if this corner may swing this tick; consumes it and starts the cooldown.</summary>
    private static PoBrawlMatchAction? TakeSwing(Corner c)
    {
        if (c.Pending is not { } swing || c.Cooldown > 0) return null;
        c.Pending = null;
        // A special without a full bar is simply refused; the press is spent.
        if (swing == PoBrawlMatchAction.Special && c.Energy < 100) return null;
        c.Cooldown = swing switch
        {
            PoBrawlMatchAction.Punch => PunchCooldownTicks,
            PoBrawlMatchAction.Kick => KickCooldownTicks,
            _ => SpecialCooldownTicks,
        };
        c.Energy = swing switch
        {
            PoBrawlMatchAction.Punch => Math.Max(0, c.Energy - PunchEnergyCost),
            PoBrawlMatchAction.Kick => Math.Max(0, c.Energy - KickEnergyCost),
            _ => 0,
        };
        return swing;
    }

    private void ResolveSwing(PoBrawlMatchAction swing, Corner attacker, Corner defender, bool guarded, double gap, bool isP1)
    {
        var (baseDmg, reach, knockback) = swing switch
        {
            PoBrawlMatchAction.Punch => (PunchBaseDamage, PunchReach, PunchKnockback),
            PoBrawlMatchAction.Kick => (KickBaseDamage, KickReach, KickKnockback),
            _ => (SpecialBaseDamage, SpecialReach, SpecialKnockback),
        };
        var tag = isP1 ? "p1" : "p2";
        attacker.Swing = swing;
        if (gap > reach)
        {
            _lastEvent = $"{tag}-whiff";
            attacker.Outcome = "whiff";
            return;
        }

        // ±20% damage variance, deterministic per match via _rng.
        var variance = 1.0 + (_rng.NextDouble() * 0.4 - 0.2);
        var damage = (int)Math.Round(baseDmg * variance, MidpointRounding.AwayFromZero);

        // Block cuts damage. Punch is negated entirely (defensive read on a jab),
        // kick chips 1/4 (you can still push them back), special is unblockable.
        if (guarded)
        {
            damage = swing switch
            {
                PoBrawlMatchAction.Punch => 0,
                PoBrawlMatchAction.Kick => Math.Max(1, damage / 4),
                _ => damage,
            };
            knockback *= 0.5;
        }

        // Shove the defender away from the attacker (P1 is always the left corner).
        defender.X += isP1 ? knockback : -knockback;
        EnforceSpacing();

        // A guarded kick still chips, but it reads as a block on screen — the guard held.
        attacker.Outcome = guarded ? "blocked" : "hit";
        if (damage <= 0)
        {
            _lastEvent = $"{tag}-blocked";
            return;
        }
        var dealt = Math.Min(defender.Hp, damage);
        defender.Hp -= dealt;
        attacker.Damage = dealt;
        attacker.Energy = Math.Min(100, attacker.Energy + EnergyOnLandHit);
        _lastEvent = swing == PoBrawlMatchAction.Special ? $"{tag}-special" : $"{tag}-hit";
    }

    private static void Walk(Corner c, bool free, int direction)
    {
        if (!free) return;
        var step = c.Held switch
        {
            PoBrawlMatchAction.MoveForward => WalkInPerSecond / TickHz,
            PoBrawlMatchAction.MoveBack => -WalkOutPerSecond / TickHz,
            _ => 0.0,
        };
        c.X += direction * step;
    }

    /// <summary>Ring clamp, then the minimum gap, split between the corners (a corner pinned on the rope yields nothing).</summary>
    private void EnforceSpacing()
    {
        _c1.X = Math.Clamp(_c1.X, -RingHalf, RingHalf - MinGap);
        _c2.X = Math.Clamp(_c2.X, -RingHalf + MinGap, RingHalf);
        var deficit = MinGap - (_c2.X - _c1.X);
        if (deficit <= 0) return;
        var p1Room = _c1.X + RingHalf;   // how far P1 can still back up
        var p2Room = RingHalf - _c2.X;
        var p1Share = Math.Min(p1Room, deficit / 2);
        var p2Share = Math.Min(p2Room, deficit - p1Share);
        p1Share = Math.Min(p1Room, deficit - p2Share);
        _c1.X -= p1Share;
        _c2.X += p2Share;
    }

    /// <summary>
    /// Build the final <see cref="PoBrawlMatchResult"/> from a connection's perspective.
    /// Both clients receive their own copy with their own local side set, so the
    /// outcome maps to "did the local player win?".
    /// </summary>
    public PoBrawlMatchResult BuildResultFor(string connectionId) => BuildResultForSide(SideFor(connectionId));

    /// <summary>
    /// The roster side a principal id owns, or null when they are not one of the two fighters.
    /// Same ignore-case walk as <see cref="RegisterConnectionByPrincipal"/>, minus the
    /// connection — the result ingest authenticates by cookie, not by a live hub connection.
    /// </summary>
    public PoBrawlSide? SideForPrincipal(string principalId)
    {
        if (string.IsNullOrWhiteSpace(principalId)) return null;
        for (var i = 0; i < Roster.Count; i++)
        {
            if (string.Equals(Roster[i].PrincipalId, principalId, StringComparison.OrdinalIgnoreCase))
            {
                return i == 0 ? PoBrawlSide.Player1 : PoBrawlSide.Player2;
            }
        }
        return null;
    }

    /// <summary>
    /// Server-canonical result for one of the two fighters, by principal id — the ingest's
    /// source of truth for outcome, opponent and duration. Null for anyone else (spectators,
    /// a fabricated caller): a match may only be reported by its own corners.
    /// </summary>
    public PoBrawlMatchResult? BuildResultForPrincipal(string principalId) =>
        SideForPrincipal(principalId) is { } side ? BuildResultForSide(side) : null;

    private PoBrawlMatchResult BuildResultForSide(PoBrawlSide localSide)
    {
        PoBrawlMatchState snapshot;
        lock (_stateLock)
        {
            snapshot = SnapshotLocked();
        }
        var opponent = localSide == PoBrawlSide.Player1 ? _p2 : _p1;
        var outcome = !snapshot.Finished ? PoBrawlOutcome.Draw
            : snapshot.Winner is null ? PoBrawlOutcome.Draw
            : snapshot.Winner == localSide ? PoBrawlOutcome.Win
            : PoBrawlOutcome.Loss;
        return new PoBrawlMatchResult
        {
            MatchId = MatchId,
            LocalSide = localSide,
            Outcome = outcome,
            DurationSeconds = snapshot.ElapsedSeconds,
            Player1Hp = snapshot.Player1Hp,
            Player2Hp = snapshot.Player2Hp,
            OpponentId = opponent.PrincipalId,
            OpponentDisplayName = opponent.DisplayName,
            Forfeit = _forfeit,
        };
    }

    public PoBrawlLobbyPlayer Player1 => _p1;
    public PoBrawlLobbyPlayer Player2 => _p2;
}
