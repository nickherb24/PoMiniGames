using System.Text.Json;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Caching.Hybrid;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;
using PoMiniGames.Shared.Games.PoJoker;
using static PoMiniGames.AI.AiText;

namespace PoMiniGames.Features.PoJoker;

/// <summary>
/// AI-powered joke analysis service backed by the centralized Azure AI Foundry hub
/// in the <c>PoShared</c> resource group. The <c>joker</c> deployment is resolved
/// through <see cref="AIFoundryOptions"/>.
///
/// <para><b>Mock fallback</b> follows the PoCoupleQuiz pattern: when the foundry is
/// not configured, the service falls back to <see cref="MockAnalysisService"/> in
/// non-Production environments and throws in Production (so a misconfigured deployment
/// never silently serves fabricated data).</para>
/// </summary>
/// <remarks>
/// <para>
/// <b>Chat client.</b> From <see cref="GameChatClientFactory"/>, not the bare
/// <c>AIFoundryChatClientCache</c>. The cache returns an undecorated SDK client, so until now this
/// service — the most call-hungry of the four, running an autonomous show loop — had no resilience
/// pipeline, no circuit breaker, no concurrency limiter, no spend ceiling and no telemetry. The
/// class comment claimed "the shared AzureOpenAIResilience options bound the per-attempt network
/// timeout and retry count", which was true only of the SDK-level options; the orchestrating
/// pipeline was not in the path.
/// </para>
/// <para>
/// <b>Two tasks, two models.</b> Predicting a punchline is a creative job; scoring three numbers
/// between 0 and 1 is not. They resolve separate deployments (<c>joker</c> and
/// <c>joker.rating</c>), so the cheap half can be moved to a cheap model in configuration alone.
/// </para>
/// </remarks>
public sealed class AiJesterService : IAnalysisService
{
    /// <summary>
    /// Output ceiling for one merged verdict: a one-line punchline, three numbers and a one-word
    /// emotion slug.
    /// </summary>
    /// <remarks>
    /// Not the sum of the two ceilings it replaces (120 + 110). The two calls each had to carry
    /// their own JSON envelope and their own preamble; one object carrying both costs less than
    /// either pair. Still generous rather than tight, because on a reasoning deployment a tight cap
    /// alone is starvation, not brevity -- see AiDecisionChatOptions.
    /// </remarks>
    private const int VerdictMaxTokens = 200;

    private readonly ILogger<AiJesterService> _logger;
    private readonly IHostEnvironment _environment;
    private readonly MockAnalysisService _mock;
    private readonly GameChatClientFactory _clients;
    private readonly IOptionsMonitor<AIFoundryOptions> _foundryOptions;
    private readonly HybridCache _cache;
    private readonly AiDecisionOptionsCache _optionsCache;
    private readonly int _timeoutSeconds;

    /// <summary>
    /// The one prompt for the one call: predict a punchline AND score the real joke.
    /// </summary>
    /// <remarks>
    /// The two halves are deliberately ordered "predict first, then score", and the prediction is
    /// told to ignore the real punchline it can see. A model asked to score first tends to let the
    /// score colour the guess; asked to guess first, it produces the guess it would have produced
    /// without the answer in front of it. The schema enforces the shape either way, but the order
    /// is what keeps the guess honest, which is the whole game.
    /// </remarks>
    private const string VerdictPrompt = """
        You are a Digital Jester - an AI that tries to predict punchlines to jokes, and also rates them.

        Do BOTH of these, in this order:
        1. 'punchline': read ONLY the setup and predict what the punchline will be. Be creative and
           funny, but try to guess the actual punchline. One short, punchy line - no explanation,
           no "I think", just the punchline. You can see the real punchline; do not copy it, and do
           not let it change what you would have guessed from the setup alone.
        2. Score the REAL joke from 0.0 to 1.0 on:
           - originality: how unique and creative the joke is
           - cleverness: how smart or witty the wordplay is
           - humor: how funny it is overall
           Also pick 'emotion': the face an audience member would pull at this joke's SUBJECT
           MATTER - what the joke is about, not how good it is. A joke about death is 'dying';
           about drinking, 'drunk'; a groan-worthy pun, 'eye-roll'; something crude, 'blushing' or
           'disgust'; a riddle, 'thinking'. Choose exactly one value from the schema's enum.

        Emit only the JSON object described by the schema.
        """ + "\n" + AiPrompt.FencingInstruction;

    public AiJesterService(
        IConfiguration configuration,
        IHostEnvironment environment,
        MockAnalysisService mock,
        ILogger<AiJesterService> logger,
        GameChatClientFactory clients,
        IOptionsMonitor<AIFoundryOptions> foundryOptions,
        HybridCache cache,
        AiDecisionOptionsCache optionsCache)
    {
        _logger = logger;
        _environment = environment;
        _mock = mock;
        _clients = clients;
        _foundryOptions = foundryOptions;
        _cache = cache;
        _optionsCache = optionsCache;
        _timeoutSeconds = configuration.GetValue("PoJoker:AzureOpenAI:TimeoutSeconds", 30);
    }

    private bool IsNonProduction() => Features.Shared.AiMockFallback.IsNonProduction(_environment);

    /// <summary>The decorated client for a key, or null when the foundry is unconfigured.</summary>
    private IChatClient? ResolveClient(string key)
        => _foundryOptions.CurrentValue.IsConfigured
            ? _clients.ForDeployment(key, _clients.DeploymentFor(key))
            : null;

    public async Task<(JokeAnalysisDto Analysis, JokeRatingDto Rating)> AnalyzeJokeAsync(
        JokeDto joke, CancellationToken cancellationToken = default)
    {
        if (ResolveClient(AIFoundryOptions.Games.Joker) is null)
        {
            if (IsNonProduction())
            {
                _logger.LogWarning("PoJoker: AIFoundry not configured; serving mock analysis in {Environment}.", _environment.EnvironmentName);
                return await _mock.AnalyzeJokeAsync(joke, cancellationToken);
            }
            throw new InvalidOperationException(
                $"PoJoker: AIFoundry not configured. Set {AIFoundryOptions.SectionName} in Key Vault (kv-poshared).");
        }

        // -- One call per joke, not two -----------------------------------
        // The punchline prediction and the rating used to be two concurrent calls. Against this
        // account that is the worst possible shape: the deployment reports
        // `x-ratelimit-limit-requests: 1` and completes ONE of three concurrent requests, so the
        // second call reliably paid a 429 plus a retry for an answer the first call could have
        // carried for the cost of a few more output tokens. Merging them also deletes one whole
        // copy of the system prompt from the wire, which on prompts this short is a real fraction
        // of the input bill.
        //
        // The cost of the merge is that the rating no longer gets its own cheap deployment (the
        // `joker.rating` task key). That trade is deliberate: round trips are the scarce resource
        // against this account, not tokens -- see AiConcurrencyGate for the measurements.
        var verdict = await ResolveVerdictAsync(joke, cancellationToken);
        return (BuildAnalysis(joke, verdict), BuildRating(verdict));
    }

    /// <summary>
    /// The model's whole verdict on a joke: its predicted punchline and its three scores.
    /// </summary>
    /// <remarks>
    /// Cached rather than recomputed, because every field is a pure function of the joke text. The
    /// rating half was already memoized for 24 h on exactly this key, so a repeat joke within a day
    /// already scored identically; the punchline now repeats with it. For a show loop that draws
    /// from a finite upstream catalogue that is the right behaviour -- the Jester having a settled
    /// opinion about a joke it has seen before is not a bug -- and it turns a repeat into no model
    /// call at all.
    /// </remarks>
    public sealed record JesterVerdict(
        string Punchline,
        bool Filtered,
        double Originality,
        double Cleverness,
        double Humor,
        string Emotion,
        bool Parsed);

    private async Task<JesterVerdict> ResolveVerdictAsync(JokeDto joke, CancellationToken cancellationToken)
    {
        var cacheKey = $"pojoker:verdict:{Hash(joke.Setup, joke.Punchline)}";
        // Identity in the state: a HybridCache factory does not inherit the caller's
        // ExecutionContext, so an ambient scope is invisible inside it. See AiUsageScope.Restore.
        var identity = AiUsageScope.CurrentIdentity;
        try
        {
            return await _cache.GetOrCreateAsync(
                cacheKey,
                (Service: this, joke, Identity: identity),
                static async (state, ct) =>
                {
                    using var scope = AiUsageScope.Restore(state.Identity);
                    return await state.Service.AnalyzeUncachedAsync(state.joke, ct);
                },
                new HybridCacheEntryOptions { Expiration = TimeSpan.FromHours(24) },
                cancellationToken: cancellationToken);
        }
        catch (OperationCanceledException)
        {
            _logger.LogWarning(
                "PoJoker: analysis timed out or was cancelled for joke {JokeId} after {Timeout}s",
                joke.Id, _timeoutSeconds);
            return Unavailable("[The Jester took too long to respond.]");
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "PoJoker: analysis failed for joke {JokeId}", joke.Id);
            return Unavailable("[The Jester stumbled and cannot predict.]");
        }
    }

    /// <summary>A verdict the model did not supply: neutral scores and a stage-appropriate excuse.</summary>
    private static JesterVerdict Unavailable(string punchline)
        => new(punchline, Filtered: false, 0.5, 0.5, 0.5, JokerEmotions.Normalize(null), Parsed: false);

    private async ValueTask<JesterVerdict> AnalyzeUncachedAsync(JokeDto joke, CancellationToken cancellationToken)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        cts.CancelAfter(TimeSpan.FromSeconds(_timeoutSeconds));

        var deployment = _clients.DeploymentFor(AIFoundryOptions.Games.Joker);
        var chat = _clients.ForDeployment(AIFoundryOptions.Games.Joker, deployment)
            ?? throw new InvalidOperationException(
                $"PoJoker: AIFoundry not configured. Set {AIFoundryOptions.SectionName} in Key Vault (kv-poshared).");

        var messages = new List<ChatMessage>
        {
            new(ChatRole.System, VerdictPrompt),
            // Third-party text from jokeapi.dev: fenced so a joke body carrying an instruction is
            // read as the setup it claims to be.
            new(ChatRole.User, AiPrompt.FenceAll(("Setup", joke.Setup), ("Punchline", joke.Punchline))),
        };

        const string SchemaDescription =
            "A predicted punchline plus originality, cleverness and humour scores from 0.0 to 1.0.";

        var options = _optionsCache.GetOrBuild(
            gameKey: AIFoundryOptions.Games.Joker,
            deployment: deployment,
            capabilityOverrides: _clients.CapabilityOverrides,
            schema: VerdictSchema,
            schemaName: "joke_verdict",
            maxOutputTokens: VerdictMaxTokens,
            schemaDescription: SchemaDescription,
            factory: (d, ov) => AiDecisionChatOptions.ForStructuredJson(
                VerdictSchema,
                schemaName: "joke_verdict",
                maxOutputTokens: VerdictMaxTokens,
                deployment: d ?? string.Empty,
                schemaDescription: SchemaDescription,
                capabilityOverrides: ov));

        // Streamed with early commit: stop reading -- and
        // stop the provider generating -- the moment the object is complete. A schema-constrained
        // reply is frequently followed by trailing whitespace or a stray token that is billed as
        // output and read by nobody. Falls through to the buffered call when streaming yields
        // nothing usable.
        var streamed = await TryStreamVerdictAsync(chat, messages, options, joke.Id, cts.Token);
        if (streamed is not null)
            return streamed;

        var response = await chat.GetResponseAsync(messages, options, cts.Token);

        if (WasContentFiltered(response))
        {
            _logger.LogWarning(
                "Content filter triggered while analysing joke {JokeId}; returning neutral scores", joke.Id);
            return new JesterVerdict(
                "[The Jester shrugs and delivers a safe, court-approved punchline.]",
                Filtered: true, 0.5, 0.5, 0.5, JokerEmotions.Normalize(null), Parsed: false);
        }

        return ParseVerdict(response.Text, joke.Id, _logger);
    }

    /// <summary>
    /// Streams the verdict and stops as soon as the JSON object parses complete, or returns null
    /// when streaming produced nothing usable so the caller can fall back to a buffered call.
    /// </summary>
    private static async Task<JesterVerdict?> TryStreamVerdictAsync(
        IChatClient chat,
        List<ChatMessage> messages,
        ChatOptions options,
        int jokeId,
        CancellationToken cancellationToken)
    {
        var buffer = new System.Text.StringBuilder();

        try
        {
            await foreach (var update in chat.GetStreamingResponseAsync(messages, options, cancellationToken))
            {
                buffer.Append(update.Text);

                // Only attempt a parse once a closing brace has arrived; parsing every fragment
                // would run the extractor once per token for no benefit.
                if (update.Text?.Contains('}') != true)
                    continue;

                // Logger deliberately null: on this path a failed parse is a half-arrived object,
                // not a fault. The buffered fallback logs for real if it comes to that.
                var candidate = ParseVerdict(buffer.ToString(), jokeId, logger: null);
                if (candidate is { Parsed: true })
                {
                    // Returning out of the await-foreach disposes the enumerator, which cancels the
                    // underlying response: the provider stops generating -- and stops billing
                    // output tokens -- for a tail nobody will read.
                    return candidate;
                }
            }
        }
        catch (NotSupportedException)
        {
            // A chat client that does not implement streaming. The buffered path handles it.
            return null;
        }

        // The stream may have ended exactly on a complete object.
        var final = ParseVerdict(buffer.ToString(), jokeId, logger: null);
        return final is { Parsed: true } ? final : null;
    }

    private JokeAnalysisDto BuildAnalysis(JokeDto joke, JesterVerdict verdict)
    {
        var similarityScore = verdict.Filtered ? 0.0 : CalculateSimilarity(joke.Punchline, verdict.Punchline);
        var isTriumph = similarityScore >= 0.55 && !verdict.Filtered;

        _logger.LogInformation(
            "AI predicted punchline for joke {JokeId}: Similarity={Similarity:P1}, IsTriumph={IsTriumph}",
            joke.Id, similarityScore, isTriumph);

        return new JokeAnalysisDto
        {
            OriginalJoke = joke,
            AiPunchline = verdict.Punchline,
            Confidence = verdict.Filtered ? 0.5 : verdict.Parsed ? 0.9 : 0.1,
            IsTriumph = isTriumph,
            SimilarityScore = similarityScore,
            // Latency is no longer reported per call: the verdict may have been served from cache,
            // and reporting the original call's duration for a cache hit would be a number the
            // leaderboard could rank on and that never happened. The real per-call latency lives in
            // AiUsageAccumulator, which measures it at the one place it is true.
            LatencyMs = 0,
        };
    }

    private static JokeRatingDto BuildRating(JesterVerdict verdict)
    {
        if (!verdict.Parsed)
        {
            return NeutralRating(verdict.Filtered
                ? "Rated by the Digital Jester's discerning wit. (Filtered)"
                : "The Jester's scorecard came back blank.");
        }

        return new JokeRatingDto
        {
            // The DTO's fields do not line up with the prompt's dimensions by name; this mapping is
            // the one the game has always used (Complexity carries originality, Difficulty carries
            // humour) and is preserved deliberately so existing leaderboard rows stay comparable.
            Cleverness = ToTenPointScale(verdict.Cleverness),
            Complexity = ToTenPointScale(verdict.Originality),
            Difficulty = ToTenPointScale(verdict.Humor),
            Rudeness = 1,
            Commentary = "Rated by the Digital Jester's discerning wit.",
            Emotion = verdict.Emotion,
        };
    }

    /// <summary>
    /// Reads a verdict out of a model reply. <paramref name="logger"/> is null on the streaming
    /// path, where a failed parse is the expected state of a half-arrived object rather than a
    /// fault worth a log line.
    /// </summary>
    private static JesterVerdict ParseVerdict(string? raw, int jokeId, ILogger? logger)
    {
        using var doc = TryExtractJson(raw);
        if (doc is null)
        {
            logger?.UnparseableReply(
                "PoJoker", $"no JSON object in the verdict for joke {jokeId}", Truncate(raw, 300));
            return Unavailable("[The Jester opened his mouth and nothing came out.]");
        }

        var root = doc.RootElement;

        // Every dimension must actually be present. Defaulting a missing one to 0.5 silently
        // produced a confident-looking 5/10 from a reply that contained no rating at all -- measured
        // against Phi-4-mini-instruct, which answered this prompt with a verbatim echo of the joke
        // and was scored 5/5/5 with no warning anywhere. A rating that cannot be read has to say so.
        if (TryReadScore(root, "cleverness") is not { } cleverness
            || TryReadScore(root, "originality") is not { } originality
            || TryReadScore(root, "humor") is not { } humor)
        {
            logger?.UnparseableReply(
                "PoJoker",
                $"verdict for joke {jokeId} carried no originality/cleverness/humor scores",
                Truncate(raw, 300));
            return Unavailable("[The Jester's scorecard came back blank.]");
        }

        var punchline = root.TryGetProperty("punchline", out var punchlineEl)
            && punchlineEl.ValueKind == JsonValueKind.String
                ? (punchlineEl.GetString() ?? string.Empty).Trim()
                : string.Empty;

        if (string.IsNullOrWhiteSpace(punchline))
        {
            // An empty punchline is a provider problem (typically the output budget consumed by
            // reasoning tokens), not the Jester having nothing to say. Say which -- but keep the
            // scores, which did arrive.
            logger?.LogWarning("PoJoker: verdict for joke {JokeId} carried no punchline.", jokeId);
            punchline = "[The Jester opened his mouth and nothing came out.]";
        }

        return new JesterVerdict(
            punchline,
            Filtered: false,
            originality,
            cleverness,
            humor,
            JokerEmotions.Normalize(
                root.TryGetProperty("emotion", out var emotionEl) && emotionEl.ValueKind == JsonValueKind.String
                    ? emotionEl.GetString()
                    : null),
            Parsed: true);
    }

    /// <summary>
    /// Verdict reply shape: a predicted punchline, three bounded numbers and one audience reaction.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The emotion enum is projected from <see cref="JokerEmotions.All"/> rather than written out
    /// here, so the model can only name a portrait that exists on disk. Spelling the list twice is
    /// how it would eventually come back with a reaction the client has no image for.
    /// </para>
    /// <para>
    /// <c>punchline</c> is declared first on purpose. Models emit object properties in schema
    /// order, so the field the streaming parser cares about most arrives first, and the early-commit
    /// reader in <c>TryStreamVerdictAsync</c> has the guess in hand before the scores finish.
    /// </para>
    /// </remarks>
    public static JsonElement VerdictSchema { get; } = JsonDocument.Parse(
        $$"""
        {
          "type": "object",
          "properties": {
            "punchline":   { "type": "string" },
            "originality": { "type": "number", "minimum": 0, "maximum": 1 },
            "cleverness":  { "type": "number", "minimum": 0, "maximum": 1 },
            "humor":       { "type": "number", "minimum": 0, "maximum": 1 },
            "emotion":     { "type": "string", "enum": [{{EmotionEnumJson}}] }
          },
          "required": ["punchline", "originality", "cleverness", "humor", "emotion"],
          "additionalProperties": false
        }
        """).RootElement.Clone();

    /// <summary>
    /// The portrait vocabulary as a JSON string-array body (no brackets). Quoted by hand: every
    /// slug is lowercase ASCII with hyphens, so there is nothing for an escaper to do.
    /// </summary>
    private static string EmotionEnumJson =>
        string.Join(", ", JokerEmotions.All.Select(e => $"\"{e}\""));

    /// <summary>The named score in [0,1], or null when the reply does not carry it as a number.</summary>
    private static double? TryReadScore(JsonElement root, string property)
        => root.TryGetProperty(property, out var el) && el.ValueKind == JsonValueKind.Number && el.TryGetDouble(out var d)
            ? Math.Clamp(d, 0, 1)
            : null;

    private static int ToTenPointScale(double value) => (int)Math.Round(value * 10);

    private static JokeRatingDto NeutralRating(string commentary) => new()
    {
        Cleverness = 5,
        Complexity = 5,
        Difficulty = 5,
        Rudeness = 1,
        Commentary = commentary,
    };

    /// <summary>
    /// True when the provider stopped for its content filter.
    /// </summary>
    /// <remarks>
    /// <see cref="ChatFinishReason"/> is an extensible enum over the wire string, so this compares
    /// against the value rather than a member — the SDK-typed <c>ChatFinishReason.ContentFilter</c>
    /// check the previous implementation used is not reachable through the ME.AI abstraction.
    /// </remarks>
    private static bool WasContentFiltered(ChatResponse response)
        => response.FinishReason == ChatFinishReason.ContentFilter;

    /// <summary>Stable cache key component for a joke's content.</summary>
    private static string Hash(string? setup, string? punchline)
    {
        var bytes = System.Text.Encoding.UTF8.GetBytes($"{setup}{punchline}");
        return Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(bytes))[..32];
    }


    // ── Similarity scoring (Levenshtein + Jaccard blend) ─────────────────────
    private static double CalculateSimilarity(string actual, string predicted)
    {
        if (string.IsNullOrWhiteSpace(actual) || string.IsNullOrWhiteSpace(predicted))
            return 0;

        var actualLower = actual.ToLowerInvariant();
        var predictedLower = predicted.ToLowerInvariant();

        if (actualLower == predictedLower)
            return 1.0;

        var levenshteinSimilarity = LevenshteinSimilarity(actualLower, predictedLower);

        var separators = new[] { ' ', '.', '!', '?', ',' };
        var actualWords = actualLower.Split(separators, StringSplitOptions.RemoveEmptyEntries).ToHashSet();
        var predictedWords = predictedLower.Split(separators, StringSplitOptions.RemoveEmptyEntries).ToHashSet();

        double jaccardSimilarity = 0;
        if (actualWords.Count > 0 && predictedWords.Count > 0)
        {
            var intersection = actualWords.Intersect(predictedWords).Count();
            var union = actualWords.Union(predictedWords).Count();
            jaccardSimilarity = (double)intersection / union;
        }

        return (levenshteinSimilarity * 0.55) + (jaccardSimilarity * 0.45);
    }

    private static double LevenshteinSimilarity(string s1, string s2)
    {
        int maxLength = Math.Max(s1.Length, s2.Length);
        if (maxLength == 0)
            return 1.0;
        return 1.0 - ((double)LevenshteinDistance(s1, s2) / maxLength);
    }

    private static int LevenshteinDistance(string s1, string s2)
    {
        int[,] dp = new int[s1.Length + 1, s2.Length + 1];
        for (int i = 0; i <= s1.Length; i++) dp[i, 0] = i;
        for (int j = 0; j <= s2.Length; j++) dp[0, j] = j;

        for (int i = 1; i <= s1.Length; i++)
        {
            for (int j = 1; j <= s2.Length; j++)
            {
                if (s1[i - 1] == s2[j - 1])
                    dp[i, j] = dp[i - 1, j - 1];
                else
                    dp[i, j] = 1 + Math.Min(Math.Min(dp[i - 1, j], dp[i, j - 1]), dp[i - 1, j - 1]);
            }
        }
        return dp[s1.Length, s2.Length];
    }
}
