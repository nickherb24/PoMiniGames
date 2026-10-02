namespace PoMiniGames.Domain.Primitives;

/// <summary>
/// Strongly-typed wrapper around the game identifier used across leaderboards, stats,
/// and the AI Foundry deployment map. Replaces the raw-string convention
/// (<c>"couplequiz"</c>, <c>"funquiz"</c>, …) that was previously scattered through
/// endpoints, services, and clients — typos silently broke the leaderboard.
/// </summary>
/// <remarks>
/// <para>
/// Pattern: Value Object (Evans, 2003). Equality is by the underlying string; the
/// wrapper enforces a known catalogue at construction time and provides a single
/// source of truth for the on-the-wire form (<see cref="Value"/>).
/// </para>
/// <para>
/// <b>Allocation</b>: the cached well-known keys (<see cref="WellKnown"/>) are
/// zero-alloc when callers reference them directly. <see cref="Parse"/> only
/// allocates when the input is not in the catalogue, which is the bug case we
/// want to surface.
/// </para>
/// </remarks>
public readonly record struct GameKey(string Value) : IComparable<GameKey>
{
    /// <summary>The raw string form, e.g. <c>"couplequiz"</c>. Safe to use in URLs / keys.</summary>
    public string Value { get; } = Value ?? string.Empty;

    /// <summary>True when the underlying string is empty (the zero value).</summary>
    public bool IsEmpty => string.IsNullOrEmpty(Value);

    /// <summary>
    /// Case-insensitive equality. Game keys arrive from URLs, storage row keys and the
    /// client, none of which guarantee casing, so an ordinal comparison would make
    /// <c>"FunQuiz"</c> and <c>"funquiz"</c> different games.
    /// </summary>
    public bool Equals(GameKey other) =>
        string.Equals(Value, other.Value, StringComparison.OrdinalIgnoreCase);

    public override int GetHashCode() =>
        StringComparer.OrdinalIgnoreCase.GetHashCode(Value ?? string.Empty);

    // Implicit conversions so render sites (string interpolation, attribute binding)
    // read naturally while definition sites stay strongly typed. These moved here
    // from the client's duplicate copy of this type — see the remarks above.
    public static implicit operator string(GameKey key) => key.Value;
    public static implicit operator GameKey(string value) => new(value);

    /// <summary>Lexicographic comparison so callers can sort by canonical wire form.</summary>
    public int CompareTo(GameKey other) =>
        string.Compare(Value, other.Value, StringComparison.OrdinalIgnoreCase);

    public override string ToString() => Value;

    /// <summary>
    /// Parses a wire-format game key. Throws <see cref="ArgumentException"/> when the
    /// key is unknown so a caller typo surfaces as a 400, not a silent fallback to
    /// the all-leaderboards endpoint.
    /// </summary>
    public static GameKey Parse(string? input)
    {
        if (string.IsNullOrWhiteSpace(input))
        {
            throw new ArgumentException("Game key cannot be null or whitespace.", nameof(input));
        }
        var normalized = input.Trim().ToLowerInvariant();
        if (WellKnownLookup.TryGetValue(normalized, out var canonical))
        {
            return canonical;
        }
        throw new ArgumentException(
            $"Unknown game key '{input}'. Known keys: {string.Join(", ", WellKnownNames)}.",
            nameof(input));
    }

    /// <summary>Parses a wire-format game key. Returns <c>null</c> for empty input.</summary>
    public static GameKey? TryParse(string? input)
    {
        if (string.IsNullOrWhiteSpace(input)) return null;
        var normalized = input.Trim().ToLowerInvariant();
        // The null arm is cast explicitly: with an implicit string -> GameKey
        // conversion in scope, a bare `null` is ambiguous between "no key" and
        // "a GameKey built from a null string", and the compiler rejects it.
        return WellKnownLookup.TryGetValue(normalized, out var canonical)
            ? canonical
            : (GameKey?)null;
    }

    // ── Well-known keys (canonical wire form) ────────────────────────────

    public static readonly GameKey CoupleQuiz = new("couplequiz");
    public static readonly GameKey FunQuiz = new("funquiz");
    public static readonly GameKey Joker = new("joker");

    public static readonly GameKey ConnectFive = new("connectfive");
    public static readonly GameKey TicTacToe = new("tictactoe");
    public static readonly GameKey PoMarbleRace = new("pomarblerace");
    public static readonly GameKey PoRacer = new("poracer");
    public static readonly GameKey PoBrawl = new("pobrawl");
    public static readonly GameKey PoSports = new("posports");

    // PoBrawlDemo is a leaderboard-only key — it has no PlayerStats shadow (demo matches
    // are CPU-vs-CPU, so no player ever submits stats for it). It is in the catalogue
    // because the unified /api/leaderboards/{game} route runs every input through
    // TryParse, and the demo board would 404 without this entry. Mirroring PoBrawl so
    // "pobrawldemo" reads as a sibling of "pobrawl" on the /leaderboards page, even
    // though the fight rankings are independent of the presidents-ladder board.
    public static readonly GameKey PoBrawlDemo = new("pobrawldemo");

    // PoBrawlKo is the fastest-KO view of the same players' 1P runs, and exists for the
    // same mechanical reason as PoBrawlDemo above: /api/leaderboards/{game} runs every
    // input through TryParse, so a board without an entry here 404s no matter what the
    // unified endpoint's switch says. It IS a player board (unlike PoBrawlDemo), but it
    // carries no PlayerStats shadow of its own — PoBrawl already owns those stats; this
    // key only ever names a leaderboard view of them.
    public static readonly GameKey PoBrawlKo = new("pobrawlko");

    public static readonly GameKey PoVoxelStrike = new("povoxelstrike");
    public static readonly GameKey PoEcosystem = new("poecosystem");
    public static readonly GameKey SandPlayground = new("sandplayground");
    public static readonly GameKey PoCabinet = new("pocabinet");

    // PoJevArena keeps no PlayerStats, but the client mints a play session for every catalogue
    // game, and PlaySessionEndpoints validates the key against this list — without it every
    // visit to /pojevarena logged a 400.
    public static readonly GameKey PoJevArena = new("pojevarena");

    // This catalogue gates PlayerStats reads/writes (PlayerStatsEndpoints uses TryParse as
    // the allowlist), so it must cover every game the client can mirror stats for —
    // a game missing here gets its stats and leaderboard calls rejected with a 400.
    private static readonly GameKey[] All =
    {
        CoupleQuiz, FunQuiz, Joker,
        ConnectFive, TicTacToe, PoMarbleRace,
        PoRacer, PoBrawl, PoBrawlDemo, PoBrawlKo, PoSports,
        PoVoxelStrike, PoEcosystem, SandPlayground,
        PoCabinet, PoJevArena,
    };

    private static readonly string[] WellKnownNames = All.Select(k => k.Value).ToArray();

    /// <summary>
    /// Accepted non-canonical spellings, mapped to the canonical key.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The app never settled on whether the "Po" prefix belongs in an identifier. This
    /// catalogue says <c>funquiz</c>; the client's <c>GameKeys</c> list says
    /// <c>pofunquiz</c>; the routes say <c>/funquiz</c> but <c>/pobrawl</c>; the API
    /// groups say <c>/api/joker</c> but <c>/api/poracer</c>. Four games are affected.
    /// </para>
    /// <para>
    /// This table is the single place that reconciles them. It replaces an inline
    /// <c>"pofunquiz" or "funquiz" =&gt; …</c> switch in UnifiedLeaderboardEndpoints,
    /// which resolved the same ambiguity by hand at one call site and left every other
    /// call site to get it wrong.
    /// </para>
    /// <para>
    /// <b>Both spellings must keep resolving.</b> These strings are not cosmetic: they
    /// are leaderboard partition keys in Table Storage and cached stat keys in browser
    /// localStorage. Dropping an alias silently orphans live data, so the fix is to
    /// canonicalise on read — not to rename the wire format.
    /// </para>
    /// </remarks>
    private static readonly Dictionary<string, GameKey> Aliases = new(StringComparer.OrdinalIgnoreCase)
    {
        // "Po"-prefixed forms the client sends for keys this catalogue stores bare.
        ["pocouplequiz"] = CoupleQuiz,
        ["pofunquiz"] = FunQuiz,
        ["pojoker"] = Joker,
        // Bare forms for keys this catalogue stores prefixed — the drift runs both ways.
        ["marblerace"] = PoMarbleRace,
        ["sports"] = PoSports,
    };

    private static readonly Dictionary<string, GameKey> WellKnownLookup =
        All.ToDictionary(k => k.Value, StringComparer.OrdinalIgnoreCase)
           .Concat(Aliases)
           .ToDictionary(kv => kv.Key, kv => kv.Value, StringComparer.OrdinalIgnoreCase);

    public static IReadOnlyCollection<GameKey> WellKnown => All;
}
