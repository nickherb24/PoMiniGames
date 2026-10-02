namespace PoMiniGames.Shared.Games.PoJoker;

/// <summary>
/// Represents a joke with setup and punchline. Maps to JokeAPI response structure.
/// Ported from the standalone PoJoker app for the demo-only integration.
/// </summary>
public sealed record JokeDto
{
    /// <summary>Unique identifier for the joke from JokeAPI.</summary>
    public required int Id { get; init; }

    /// <summary>Category of the joke (e.g., "Programming", "Pun", "Dark").</summary>
    public string Category { get; init; } = "General";

    /// <summary>Type of joke: "twopart" (setup + punchline) or "single" (one-liner).</summary>
    public string Type { get; init; } = "single";

    /// <summary>The setup part of a two-part joke. Empty for single-type jokes.</summary>
    public string Setup { get; init; } = string.Empty;

    /// <summary>The punchline of a two-part joke. Empty for single-type jokes.</summary>
    public string Punchline { get; init; } = string.Empty;

    /// <summary>The complete joke text for single-type jokes. Empty for twopart jokes.</summary>
    public string Joke { get; init; } = string.Empty;

    /// <summary>Content flags indicating potentially sensitive content.</summary>
    public JokeFlags Flags { get; init; } = new();

    /// <summary>Whether safe mode was enabled when this joke was fetched.</summary>
    public bool SafeMode { get; init; }

    /// <summary>
    /// True when harsh vocabulary was swapped for cheerful stand-ins so the joke could
    /// be performed instead of skipped (see <c>JokeSanitizer</c>). This marks a
    /// <i>rewritten</i> joke, not a clean one — the substitution changes words, not
    /// the premise.
    /// </summary>
    public bool Sanitized { get; init; }

    /// <summary>Gets the display text - either the setup or the single joke text.</summary>
    public string DisplayText => Type == "twopart" ? Setup : Joke;

    /// <summary>Gets the full joke text for display.</summary>
    public string FullText => Type == "twopart" ? $"{Setup}\n{Punchline}" : Joke;
}

/// <summary>Content flags from JokeAPI.</summary>
public sealed record JokeFlags
{
    public bool Nsfw { get; init; }
    public bool Religious { get; init; }
    public bool Political { get; init; }
    public bool Racist { get; init; }
    public bool Sexist { get; init; }
    public bool Explicit { get; init; }
}

/// <summary>Represents an AI punchline analysis result.</summary>
public sealed record JokeAnalysisDto
{
    /// <summary>Unique identifier for this analysis.</summary>
    public Guid Id { get; init; } = Guid.NewGuid();

    /// <summary>The original joke that was analyzed.</summary>
    public required JokeDto OriginalJoke { get; init; }

    /// <summary>The AI's predicted punchline.</summary>
    public required string AiPunchline { get; init; }

    /// <summary>The AI's confidence level in its prediction (0.0 - 1.0).</summary>
    public double Confidence { get; init; }

    /// <summary>Whether the AI's prediction matched the actual punchline.</summary>
    public bool IsTriumph { get; init; }

    /// <summary>Similarity score between AI prediction and actual punchline (0.0 - 1.0).</summary>
    public double SimilarityScore { get; init; }

    /// <summary>Time taken for AI to generate the prediction in milliseconds.</summary>
    public long LatencyMs { get; init; }

    /// <summary>Timestamp when the analysis was performed.</summary>
    public DateTimeOffset AnalyzedAt { get; init; } = DateTimeOffset.UtcNow;

    /// <summary>AI rating across multiple dimensions (Cleverness, Rudeness, Complexity, Difficulty).</summary>
    public JokeRatingDto? Rating { get; init; }
}

/// <summary>AI rating of a joke across multiple dimensions.</summary>
public sealed record JokeRatingDto
{
    /// <summary>Cleverness score (1-10). How witty and ingenious is the wordplay or concept?</summary>
    public int Cleverness { get; init; }

    /// <summary>Rudeness score (1-10). How inappropriate or edgy is the humor?</summary>
    public int Rudeness { get; init; }

    /// <summary>Complexity score (1-10). How complex is the joke structure or concept?</summary>
    public int Complexity { get; init; }

    /// <summary>Difficulty score (1-10). How hard is it to predict the punchline?</summary>
    public int Difficulty { get; init; }

    /// <summary>AI Jester's personality-driven commentary on the joke.</summary>
    public string Commentary { get; init; } = string.Empty;

    /// <summary>
    /// The audience portrait this joke's subject matter calls for — a slug from
    /// <see cref="JokerEmotions.All"/>. The rating model picks it from the joke's topic, not from
    /// how the Jester performed, so a joke about death reads <c>dying</c> whether or not the
    /// punchline was guessed. Defaults to <see cref="JokerEmotions.Neutral"/> so a rating that
    /// predates this field (or came back unreadable) still renders a portrait.
    /// </summary>
    public string Emotion { get; init; } = JokerEmotions.Neutral;

    /// <summary>Average of all scores.</summary>
    public double Average => (Cleverness + Rudeness + Complexity + Difficulty) / 4.0;
}

/// <summary>Represents a complete joke performance (fetch + analysis cycle).</summary>
public sealed record JokePerformanceDto
{
    /// <summary>Unique identifier for this performance.</summary>
    public Guid Id { get; init; } = Guid.NewGuid();

    /// <summary>Session identifier grouping related performances.</summary>
    public required string SessionId { get; init; }

    /// <summary>The joke that was performed.</summary>
    public required JokeDto Joke { get; init; }

    /// <summary>The AI analysis of the joke.</summary>
    public required JokeAnalysisDto Analysis { get; init; }

    /// <summary>Sequence number within the session (1-based).</summary>
    public int SequenceNumber { get; init; }

    /// <summary>Whether this was a triumph (AI guessed correctly).</summary>
    public bool IsTriumph => Analysis.IsTriumph;

    /// <summary>Timestamp when the performance started.</summary>
    public DateTimeOffset StartedAt { get; init; }

    /// <summary>Timestamp when the performance completed.</summary>
    public DateTimeOffset CompletedAt { get; init; } = DateTimeOffset.UtcNow;

    /// <summary>Total duration of the performance in milliseconds.</summary>
    public long DurationMs => (long)(CompletedAt - StartedAt).TotalMilliseconds;

    /// <summary>State of the performance for UI display.</summary>
    public PerformanceState State { get; init; } = PerformanceState.Transitioning;
}

/// <summary>
/// One joke on the "best jokes" board, ranked by how the AI Jester scored it.
/// </summary>
/// <remarks>
/// One row per <see cref="JokeId"/>, carrying that joke's BEST performance: the same joke is
/// drawn for many sessions and rated slightly differently each time, and without the collapse a
/// single popular joke fills the whole board.
///
/// <para><b>What <see cref="Score"/> is.</b> The mean of the three dimensions the LLM is actually
/// asked for — humour, cleverness and originality — on the 1-10 scale the ratings are stored at.
/// It is deliberately NOT <c>JokeRatingDto.Average</c>: that divides by four to include
/// <c>Rudeness</c>, which <c>AiJesterService</c> hardcodes to 1 for every joke, so it only ever
/// drags every score toward the floor by a constant and contributes no ranking signal.</para>
///
/// <para><b>Field-name warning.</b> The rating prompt asks for originality/cleverness/humor, but
/// the results are stored under legacy names for row compatibility: humour lives in
/// <c>Difficulty</c> and originality in <c>Complexity</c> (see the mapping note in
/// <c>AiJesterService.RateJokeUncachedAsync</c>). Read that mapping before changing this score.</para>
/// </remarks>
public sealed record TopJokeDto
{
    /// <summary>JokeAPI id — the identity this board collapses on.</summary>
    public required int JokeId { get; init; }

    /// <summary>Setup line for a two-part joke, or the whole joke for a one-liner.</summary>
    public required string Setup { get; init; }

    /// <summary>Punchline for a two-part joke; empty for a one-liner.</summary>
    public string Punchline { get; init; } = string.Empty;

    /// <summary>Mean of humour, cleverness and originality (1-10).</summary>
    public required double Score { get; init; }

    /// <summary>Setup and punchline joined for the row's hover text.</summary>
    public string FullText => string.IsNullOrWhiteSpace(Punchline) ? Setup : $"{Setup} — {Punchline}";
}
