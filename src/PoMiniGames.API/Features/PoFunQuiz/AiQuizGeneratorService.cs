using System.Text.Json;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using static PoMiniGames.AI.AiText;

namespace PoMiniGames.Features.PoFunQuiz;

/// <summary>
/// Server-side Azure OpenAI question generator for PoFunQuiz. Backed by the shared
/// Azure AI Foundry hub in the <c>PoShared</c> resource group; the <c>funquiz</c>
/// deployment is resolved through <see cref="AIFoundryOptions"/>.
///
/// <para><b>Mock fallback</b>: gated on <c>IsDevelopment() || IsEnvironment("Test")</c>
/// AND the explicit <c>UseMockAI</c> flag. In Production, missing config causes an
/// <see cref="InvalidOperationException"/> on first call rather than silently serving
/// fabricated data.</para>
/// </summary>
/// <remarks>
/// <para>
/// <b>Chat client.</b> Resolved from the keyed <see cref="IChatClient"/> registration, not from
/// <c>AIFoundryChatClientCache</c>. Going to the cache handed back a bare SDK <c>ChatClient</c>,
/// which meant this game — like PoCoupleQuiz and PoJoker — ran with no resilience pipeline, no
/// circuit breaker, no concurrency limit, no token accounting and no health tracking. Every
/// cross-cutting guarantee the AI layer documents was, for this service, not in the call path at all.
/// </para>
/// <para>
/// <b>Output contract.</b> The reply is schema-constrained where the deployment supports it
/// (see <see cref="AiModelCapabilities"/>), so <c>correctOptionIndex</c> arrives as an integer in
/// range and <c>difficulty</c> as one of three known strings, rather than being hoped for from a
/// JSON-object-mode reply and silently dropped by the parser when it was not.
/// </para>
/// </remarks>
public sealed class AiQuizGeneratorService : IOpenAIService
{
    /// <summary>
    /// Output ceiling for a generation call, scaled by how many questions were asked for.
    /// </summary>
    /// <remarks>
    /// A fixed cap cannot work across a request range of 1–50 questions: sized for 50 it is a
    /// blank cheque for a request of 3, and sized for 3 it truncates a request for 50 into an
    /// unparseable reply. ~90 tokens per question plus headroom for the envelope, measured against
    /// four-option questions with a difficulty label.
    /// </remarks>
    private const int TokensPerQuestion = 90;
    private const int EnvelopeTokens = 200;

    /// <summary>Hard cap on questions per call, mirrored by the endpoint's own guard.</summary>
    public const int MaxQuestionsPerCall = 50;

    private readonly IConfiguration _configuration;
    private readonly IHostEnvironment _environment;
    private readonly ILogger<AiQuizGeneratorService> _logger;
    private readonly GameChatClientFactory _clients;
    private readonly IOptionsMonitor<AIFoundryOptions> _foundryOptions;
    private readonly AiDecisionOptionsCache _optionsCache;
    private readonly Microsoft.Extensions.Caching.Hybrid.HybridCache _hybridCache;

    public AiQuizGeneratorService(
        IConfiguration configuration,
        IHostEnvironment environment,
        ILogger<AiQuizGeneratorService> logger,
        GameChatClientFactory clients,
        IOptionsMonitor<AIFoundryOptions> foundryOptions,
        AiDecisionOptionsCache optionsCache,
        Microsoft.Extensions.Caching.Hybrid.HybridCache hybridCache)
    {
        _configuration = configuration;
        _environment = environment;
        _logger = logger;
        _clients = clients;
        _foundryOptions = foundryOptions;
        _optionsCache = optionsCache;
        _hybridCache = hybridCache;
    }

    private static readonly System.Collections.Concurrent.ConcurrentDictionary<QuestionCategory, List<QuizQuestion>> QuestionPoolCache = new();

    public async Task<IReadOnlyList<QuizQuestion>> GenerateQuizQuestionsAsync(
        QuestionCategory category, int count, CancellationToken cancellationToken = default)
    {
        if (count <= 0) return Array.Empty<QuizQuestion>();
        count = Math.Min(count, MaxQuestionsPerCall); // hard cap

        // Fast path: check warm semantic question cache pool.
        //
        // This is the path most games actually take once the process is warm, so it
        // has to deal the same way the cold path does. Shuffling only WHICH questions
        // come back and handing out the pool's own QuizQuestion instances untouched would leave
        // each question's options in the order the model emitted them, correct answer included.
        // SelectVariedSet re-randomises the option order too, and copies, so the shared pool
        // is never mutated.
        if (QuestionPoolCache.TryGetValue(category, out var pool) && pool.Count >= count)
        {
            lock (pool)
            {
                if (pool.Count >= count)
                {
                    return SelectVariedSet(pool, count);
                }
            }
        }

        var useMock = _configuration.GetValue<bool>("PoFunQuiz:Features:UseMockAI");
        if (useMock && IsNonProduction())
        {
            _logger.MockEnabled(_environment.EnvironmentName);
            var mockQuestions = MockOpenAIService.GenerateQuestions(category, count);
            MergeIntoPool(category, mockQuestions);
            return mockQuestions;
        }

        var deployment = _clients.DeploymentFor(AIFoundryOptions.Games.FunQuiz);
        var chatClient = _foundryOptions.CurrentValue.IsConfigured
            ? _clients.ForDeployment(AIFoundryOptions.Games.FunQuiz, deployment)
            : null;

        if (chatClient is null)
        {
            if (IsNonProduction())
            {
                _logger.NotConfigured(_environment.EnvironmentName);
                return MockOpenAIService.GenerateQuestions(category, count);
            }
            throw new InvalidOperationException(
                $"PoFunQuiz: AIFoundry not configured. Set {AIFoundryOptions.SectionName} in Key Vault (kv-poshared).");
        }

        // Batch pre-generation to minimize total cloud calls.
        //
        // The batch is QuestionPoolSize, well above any game's count. The cache below is
        // keyed on (category, batchCount) with a 6 h TTL and a durable L2, and the caller
        // takes the FIRST `count` — so with a 10-question game and a 12-question batch, every
        // player in a six-hour window would get the same ten questions in the same order. The
        // first one would always be the same, which is what makes the game feel canned.
        //
        // A bigger pool fixes that WITHOUT spending more: it is still exactly one model
        // call per category per 6 h — only the output token count of that single call goes
        // up — and SelectVariedSet below deals a different random hand out of it for every
        // game. Pool 24 / deal 10 is over 1.9 million distinct combinations before ordering.
        var batchCount = Math.Max(count, QuestionPoolSize);

        // ── Durable batch cache (HybridCache) ─────────────────────────────
        // The prompt for a (category, batchCount) pair is IDENTICAL every time — the model is
        // being asked the same question, and paying generation rates for the same answer is the
        // exact waste this layer exists to prevent. HybridCache gives in-process hits plus an
        // optional distributed backplane, and its stampede protection collapses N concurrent
        // identical requests into ONE model call.
        //
        // Keyed on (category, batchCount) — the prompt fingerprint. NOT on the caller identity:
        // trivia questions are shared content, and one player's generation serves everyone.
        // TTL 6h: long enough to absorb a day's repeated requests for popular categories, short
        // enough that a deployment/model swap in configuration refreshes content within hours.
        var cacheKey = $"funquiz:questions:{category}:{batchCount}";
        var identity = PoMiniGames.AI.AiUsageScope.CurrentIdentity;

        var cached = await _hybridCache.GetOrCreateAsync(
            cacheKey,
            (Service: this, Category: category, BatchCount: batchCount, Deployment: deployment, Identity: identity),
            static async (state, ct) =>
            {
                using var scope = PoMiniGames.AI.AiUsageScope.Restore(state.Identity);
                return await state.Service.GenerateBatchUncachedAsync(state.Category, state.BatchCount, state.Deployment, ct);
            },
            new Microsoft.Extensions.Caching.Hybrid.HybridCacheEntryOptions
            {
                Expiration = TimeSpan.FromHours(6),
                LocalCacheExpiration = TimeSpan.FromMinutes(30),
            },
            cancellationToken: cancellationToken);

        if (cached.Count > 0)
        {
            MergeIntoPool(category, cached);
        }
        return SelectVariedSet(cached, count);
    }

    /// <summary>
    /// Fold a freshly-dealt batch into the warm pool, keeping the pool a SET of distinct questions.
    /// </summary>
    /// <remarks>
    /// This must not be a plain <c>AddRange</c>. The batch it appends is almost always the SAME
    /// 24 questions every time — the HybridCache above holds them for six hours and hands back
    /// the identical list to every caller — so the pool would grow by 24 copies of itself per
    /// request, without bound, for the life of the process. The fast path at the top of
    /// GenerateQuizQuestionsAsync then deals a random subset of pool POSITIONS out of that, which
    /// is how a ten-question quiz can ask the same question twice: after N requests each question
    /// occupies N positions, so a "distinct positions" draw is not a distinct-questions draw.
    /// Deduplicating on question text keeps the pool the size of the distinct material actually
    /// generated, which is what both the fast path and SelectVariedSet already assume.
    /// </remarks>
    private static void MergeIntoPool(QuestionCategory category, IReadOnlyList<QuizQuestion> batch)
    {
        var pool = QuestionPoolCache.GetOrAdd(category, _ => new List<QuizQuestion>());
        lock (pool)
        {
            var seen = new HashSet<string>(pool.Select(q => q.Text), StringComparer.OrdinalIgnoreCase);
            foreach (var question in batch)
            {
                if (seen.Add(question.Text))
                {
                    pool.Add(question);
                }
            }
        }
    }

    /// <summary>How many questions one cached generation holds. See the note at its use site.</summary>
    private const int QuestionPoolSize = 24;

    /// <summary>
    /// Deal <paramref name="count"/> questions out of a cached pool so two games running off the
    /// same generation do not play the same quiz.
    ///
    /// <para>Three independent shuffles, each closing a different way the game became guessable:</para>
    /// <list type="number">
    /// <item>WHICH questions — a random subset, not <c>Take(count)</c>, which always dealt the
    /// same hand off the front of the pool.</item>
    /// <item>Their ORDER — so even a repeated question does not land in the same slot.</item>
    /// <item>The OPTION order within each question, with <c>CorrectOptionIndex</c> remapped to
    /// follow the answer. Models place the correct answer at a favourite index far more often
    /// than one-in-four; left alone that is a free point for anyone who notices, and it is the
    /// one bias no prompt wording reliably removes.</item>
    /// </list>
    ///
    /// <para>Returns NEW instances. The pool is the shared cache entry handed to every caller,
    /// so shuffling its questions' option lists in place would corrupt it for everyone and
    /// desynchronise <c>CorrectOptionIndex</c> from the options a later player is shown.</para>
    /// </summary>
    internal static List<QuizQuestion> SelectVariedSet(IReadOnlyList<QuizQuestion> pool, int count)
    {
        if (pool.Count == 0) return new List<QuizQuestion>();

        // Partial Fisher-Yates over an index array: a subset AND an order in one pass, without
        // copying the pool or risking the retry-until-unique pattern's worst case.
        var idx = Enumerable.Range(0, pool.Count).ToArray();
        var take = Math.Min(count, pool.Count);
        for (var i = 0; i < take; i++)
        {
            var j = Random.Shared.Next(i, idx.Length);
            (idx[i], idx[j]) = (idx[j], idx[i]);
        }

        var dealt = new List<QuizQuestion>(take);
        for (var i = 0; i < take; i++) dealt.Add(ShuffleOptions(pool[idx[i]]));
        return dealt;
    }

    /// <summary>Copy of <paramref name="q"/> with its options shuffled and the correct index moved
    /// to wherever the correct option ended up.</summary>
    private static QuizQuestion ShuffleOptions(QuizQuestion q)
    {
        var options = new List<string>(q.Options);
        // Track the answer by position rather than by string: duplicate option text would make
        // an IndexOf-based remap point at the wrong one.
        var answer = q.CorrectOptionIndex;
        for (var i = options.Count - 1; i > 0; i--)
        {
            var j = Random.Shared.Next(i + 1);
            (options[i], options[j]) = (options[j], options[i]);
            if (answer == i) answer = j;
            else if (answer == j) answer = i;
        }
        return new QuizQuestion
        {
            Text = q.Text,
            Options = options,
            // Clamp defensively: a malformed cached entry must not hand the client an index
            // outside its own options list.
            CorrectOptionIndex = answer >= 0 && answer < options.Count ? answer : 0,
            Category = q.Category,
            Difficulty = q.Difficulty,
        };
    }

    /// <summary>
    /// One model call for a batch of questions. Extracted from <see cref="GenerateQuizQuestionsAsync"/>
    /// so it can sit behind the HybridCache factory — the cache needs a pure (state, ct) → result
    /// function, and the identity scope is restored by the caller's state, not ambient flow.
    /// </summary>
    private async Task<IReadOnlyList<QuizQuestion>> GenerateBatchUncachedAsync(
        QuestionCategory category, int batchCount, string deployment, CancellationToken cancellationToken)
    {
        var chatClient = _foundryOptions.CurrentValue.IsConfigured
            ? _clients.ForDeployment(AIFoundryOptions.Games.FunQuiz, deployment)
            : null;

        if (chatClient is null)
        {
            if (IsNonProduction())
            {
                _logger.NotConfigured(_environment.EnvironmentName);
                return MockOpenAIService.GenerateQuestions(category, batchCount);
            }
            throw new InvalidOperationException(
                $"PoFunQuiz: AIFoundry not configured. Set {AIFoundryOptions.SectionName} in Key Vault (kv-poshared).");
        }

        // ── Distractor quality is the whole game ──────────────────────────
        // The choices must be close enough to be difficult to guess. A prompt asking only
        // for "4 options and exactly one correct answer" says nothing about what the other
        // three should be, so the model produces the laziest possible set — "What is the
        // capital of France?" with Berlin / Madrid / Paris / Rome, where three options are
        // eliminable by anyone who has heard of Europe. A four-option question whose
        // distractors are obvious is a one-option question.
        //
        // The rules below target the specific ways a distractor gives itself
        // away: wrong CATEGORY of thing, wrong order of magnitude, giveaway
        // length or specificity (the correct answer is famously the longest and
        // most qualified one), and the joke option. Asking for a plausible
        // wrong answer someone could actually hold is what makes the other
        // three cost the player something.
        var systemPrompt =
            "You generate multiple-choice trivia questions. Every question has exactly 4 options and " +
            "exactly one correct answer, identified by its zero-based index. Do not repeat a question " +
            "within one response.\n" +
            "The three wrong options are the hard part. They must be genuinely tempting:\n" +
            "1. Every option must be the same KIND of thing as the answer, at the same level of " +
            "specificity — if the answer is a year, all four are plausible nearby years; if it is a " +
            "person, all four are people who could credibly have done it.\n" +
            "2. A wrong option must be something a reasonably informed person might actually believe — " +
            "a common misconception, a close contemporary, an adjacent result — never a throwaway, a " +
            "joke, or something from an unrelated field.\n" +
            "3. Keep the options similar in length, phrasing and detail. Do not let the correct answer " +
            "be the longest, the most qualified or the most technical-sounding one.\n" +
            "4. Numeric options stay within the same order of magnitude and use a consistent format.\n" +
            "5. Never use 'All of the above', 'None of the above', or two options that mean the same thing.\n" +
            "6. Someone who does not know the fact must not be able to eliminate ANY option on surface " +
            "cues alone. If three options can be dismissed without knowing the answer, rewrite them.\n" +
            "Prefer specific, less-famous facts over textbook questions everyone already knows, and " +
            "spread the correct answer evenly across all four index positions.\n" +
            "Vary difficulty across Easy, Medium and Hard unless asked otherwise. Easy means a widely " +
            "known fact, NOT weak distractors — the wrong options are close at every difficulty.\n" +
            "No explanations, no commentary — emit only the JSON object described by the schema: " +
            "{\"questions\":[{\"text\":\"<q>\",\"options\":[\"a\",\"b\",\"c\",\"d\"]," +
            "\"correctOptionIndex\":<0-3>,\"difficulty\":\"Easy|Medium|Hard\"}]}.";

        // The category is one of our own enum values, not user text, so it needs no fencing.
        var userPrompt =
            $"Generate {batchCount} trivia questions in the category: {category}. " +
            "Remember: the three wrong options for each question must be close enough that the " +
            "question cannot be answered by elimination.";

        try
        {
            var messages = new List<ChatMessage>
            {
                new(ChatRole.System, systemPrompt),
                new(ChatRole.User, userPrompt),
            };

            var options = _optionsCache.GetOrBuild(
                gameKey: AIFoundryOptions.Games.FunQuiz,
                deployment: deployment,
                capabilityOverrides: _clients.CapabilityOverrides,
                schema: QuestionsSchema,
                schemaName: "quiz_questions",
                maxOutputTokens: EnvelopeTokens + (batchCount * TokensPerQuestion),
                schemaDescription: "A batch of four-option multiple-choice trivia questions.",
                factory: (d, ov) => AiDecisionChatOptions.ForStructuredJson(
                    QuestionsSchema,
                    schemaName: "quiz_questions",
                    maxOutputTokens: EnvelopeTokens + (batchCount * TokensPerQuestion),
                    deployment: d ?? string.Empty,
                    schemaDescription: "A batch of four-option multiple-choice trivia questions.",
                    capabilityOverrides: ov));

            var response = await chatClient.GetResponseAsync(messages, options, cancellationToken);
            var parsed = ParseQuestions(response.Text, category, batchCount, _logger);
            return parsed;
        }
        catch (Exception ex)
        {
            _logger.GenerationFailed(ex, category, batchCount);
            if (IsNonProduction()) return MockOpenAIService.GenerateQuestions(category, batchCount);
            throw;
        }
    }

    /// <summary>
    /// The reply contract as a schema the service enforces. <c>correctOptionIndex</c> is bounded
    /// and <c>difficulty</c> is an enum, which is what stops a malformed item from being silently
    /// dropped by the parser below and the caller quietly receiving fewer questions than it asked for.
    /// </summary>
    /// <remarks>
    /// <c>.Clone()</c> is load-bearing — a <see cref="JsonElement"/> is a view over its
    /// <see cref="JsonDocument"/>'s pooled buffer, and handing out the un-cloned root of a document
    /// nobody holds throws once that document is collected.
    /// </remarks>
    public static JsonElement QuestionsSchema { get; } = JsonDocument.Parse(
        """
        {
          "type": "object",
          "properties": {
            "questions": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "text": { "type": "string" },
                  "options": {
                    "type": "array",
                    "items": { "type": "string" },
                    "minItems": 4,
                    "maxItems": 4
                  },
                  "correctOptionIndex": { "type": "integer", "minimum": 0, "maximum": 3 },
                  "difficulty": { "type": "string", "enum": ["Easy", "Medium", "Hard"] }
                },
                "required": ["text", "options", "correctOptionIndex", "difficulty"],
                "additionalProperties": false
              }
            }
          },
          "required": ["questions"],
          "additionalProperties": false
        }
        """).RootElement.Clone();

    /// <summary>
    /// Parses the reply into questions. Throws <see cref="QuizGenerationUnusableException"/> when
    /// nothing usable came back.
    /// </summary>
    /// <remarks>
    /// <para>
    /// This used to end with <c>if (results.Count == 0) return MockOpenAIService.GenerateQuestions(...)</c>
    /// — unconditionally, in every environment. So a Production deployment that returned unparseable
    /// JSON served players a fixed pool of hardcoded questions that looked exactly like real output,
    /// which is precisely the failure the class's own "never silently serves fabricated data" contract
    /// was written to prevent. The mock decision belongs to the caller, which knows the environment;
    /// a parser's job is to report that it parsed nothing.
    /// </para>
    /// <para>
    /// The surrounding <c>catch</c> also swallowed the <see cref="JsonException"/> without logging,
    /// so the one signal that would have identified the cause was discarded too.
    /// </para>
    /// <para>
    /// Still tolerant of prose around the JSON: the schema makes that unnecessary for a compliant
    /// provider, but the JSON-object-mode fallback (used by deployments without schema support)
    /// can still produce it.
    /// </para>
    /// </remarks>
    private static IReadOnlyList<QuizQuestion> ParseQuestions(
        string? raw, QuestionCategory category, int expected, ILogger logger)
    {
        var start = raw?.IndexOf('{') ?? -1;
        var end = raw?.LastIndexOf('}') ?? -1;
        if (raw is null || start < 0 || end <= start)
        {
            logger.UnparseableReply("PoFunQuiz", "no JSON object in the reply", Truncate(raw, 300));
            throw new QuizGenerationUnusableException(raw?.Length ?? 0, expected);
        }

        var results = new List<QuizQuestion>();
        var rejected = 0;
        try
        {
            using var doc = JsonDocument.Parse(raw[start..(end + 1)]);

            var array = doc.RootElement.TryGetProperty("questions", out var q)
                ? q
                : doc.RootElement;

            if (array.ValueKind != JsonValueKind.Array)
            {
                logger.UnparseableReply("PoFunQuiz", "reply carried no questions array", Truncate(raw, 300));
                throw new QuizGenerationUnusableException(raw.Length, expected);
            }

            foreach (var item in array.EnumerateArray())
            {
                if (TryReadQuestion(item, category) is { } question)
                    results.Add(question);
                else
                    rejected++;
            }
        }
        catch (JsonException ex)
        {
            logger.UnparseableReply("PoFunQuiz", $"invalid JSON ({ex.Message})", Truncate(raw, 300));
            throw new QuizGenerationUnusableException(raw.Length, expected);
        }

        if (results.Count == 0)
        {
            logger.UnparseableReply(
                "PoFunQuiz", $"every one of {rejected} item(s) failed validation", Truncate(raw, 300));
            throw new QuizGenerationUnusableException(raw.Length, expected);
        }

        if (rejected > 0)
        {
            // A partial batch is served rather than failed — the game can run on fewer questions —
            // but silently returning less than was asked for is how a slow degradation goes unnoticed.
            logger.PartialQuestionBatch(results.Count, expected, rejected);
        }

        return results;
    }

    /// <summary>Reads one question, or null when it does not satisfy the game's invariants.</summary>
    private static QuizQuestion? TryReadQuestion(JsonElement item, QuestionCategory category)
    {
        if (item.ValueKind != JsonValueKind.Object
            || !item.TryGetProperty("text", out var textEl)
            || textEl.ValueKind != JsonValueKind.String
            || !item.TryGetProperty("options", out var optionsEl)
            || optionsEl.ValueKind != JsonValueKind.Array
            || !item.TryGetProperty("correctOptionIndex", out var correctEl)
            || !correctEl.TryGetInt32(out var correct))
        {
            return null;
        }

        var text = textEl.GetString();
        if (string.IsNullOrWhiteSpace(text)) return null;

        var options = new List<string>(4);
        foreach (var option in optionsEl.EnumerateArray())
        {
            if (option.ValueKind != JsonValueKind.String) return null;
            var value = option.GetString();
            if (string.IsNullOrWhiteSpace(value)) return null;
            options.Add(value);
        }

        if (options.Count != 4 || correct < 0 || correct > 3) return null;

        var difficulty =
            item.TryGetProperty("difficulty", out var d)
            && d.ValueKind == JsonValueKind.String
            && Enum.TryParse<DifficultyLevel>(d.GetString(), ignoreCase: true, out var parsed)
                ? parsed
                : DifficultyLevel.Medium;

        return new QuizQuestion
        {
            Text = text,
            Options = options,
            CorrectOptionIndex = correct,
            Category = category,
            Difficulty = difficulty,
        };
    }

    private bool IsNonProduction() => Features.Shared.AiMockFallback.IsNonProduction(_environment);
}

/// <summary>
/// Thrown when the model answered but the reply contained no usable question. Distinct from a
/// transport failure so the caller can decide what to do about it — which, in Production, is
/// surface the failure, not substitute fabricated questions.
/// </summary>
public sealed class QuizGenerationUnusableException : Exception
{
    public QuizGenerationUnusableException(int rawLength, int requested)
        : base($"The model returned no usable questions (rawLength={rawLength}, requested={requested}).")
    {
        RawLength = rawLength;
        Requested = requested;
    }

    /// <summary>Length of the reply. Zero means the output budget was spent before any text.</summary>
    public int RawLength { get; }

    /// <summary>How many questions were asked for.</summary>
    public int Requested { get; }
}

/// <summary>
/// Deterministic in-memory question generator used when <c>UseMockAI=true</c>
/// (Dev/Test only). Each category has a fixed pool of well-known facts.
/// </summary>
public static class MockOpenAIService
{
    private static readonly Dictionary<QuestionCategory, (string q, string[] opts, int correct, DifficultyLevel diff)[]> Pool = new()
    {
        [QuestionCategory.Science] = new[]
        {
            ( "What is H₂O?", new[] {"Salt", "Water", "Hydrogen peroxide", "Ammonia"}, 1, DifficultyLevel.Easy ),
            ( "What planet is known as the Red Planet?", new[] {"Venus", "Mars", "Jupiter", "Saturn"}, 1, DifficultyLevel.Easy ),
            ( "What gas do plants absorb for photosynthesis?", new[] {"Oxygen", "Nitrogen", "Carbon dioxide", "Helium"}, 2, DifficultyLevel.Easy ),
            ( "What is the speed of light in a vacuum (m/s, approx)?", new[] {"3×10⁵", "3×10⁶", "3×10⁸", "3×10¹⁰"}, 2, DifficultyLevel.Medium ),
            ( "Who proposed the theory of general relativity?", new[] {"Newton", "Einstein", "Bohr", "Hawking"}, 1, DifficultyLevel.Medium ),
            ( "What particle has no electric charge?", new[] {"Electron", "Proton", "Neutron", "Muon"}, 2, DifficultyLevel.Medium ),
        },
        [QuestionCategory.History] = new[]
        {
            ( "In which year did World War II end?", new[] {"1943", "1944", "1945", "1946"}, 2, DifficultyLevel.Easy ),
            ( "Who was the first President of the United States?", new[] {"Adams", "Jefferson", "Washington", "Madison"}, 2, DifficultyLevel.Easy ),
            ( "The Berlin Wall fell in which year?", new[] {"1987", "1989", "1991", "1993"}, 1, DifficultyLevel.Medium ),
            ( "Which empire was ruled by Julius Caesar?", new[] {"Greek", "Roman", "Ottoman", "Byzantine"}, 1, DifficultyLevel.Medium ),
        },
        [QuestionCategory.Geography] = new[]
        {
            ( "What is the capital of Australia?", new[] {"Sydney", "Melbourne", "Canberra", "Perth"}, 2, DifficultyLevel.Medium ),
            ( "Which is the longest river in the world?", new[] {"Amazon", "Nile", "Yangtze", "Mississippi"}, 1, DifficultyLevel.Medium ),
            ( "Mount Everest is on the border of Nepal and which other country?", new[] {"India", "China", "Bhutan", "Pakistan"}, 1, DifficultyLevel.Medium ),
        },
        [QuestionCategory.Sports] = new[]
        {
            ( "How many players are on a standard soccer team on the field?", new[] {"9", "10", "11", "12"}, 2, DifficultyLevel.Easy ),
            ( "In which sport is the term 'birdie' used?", new[] {"Tennis", "Golf", "Cricket", "Hockey"}, 1, DifficultyLevel.Easy ),
            ( "The Tour de France is held primarily in which country?", new[] {"Italy", "Spain", "France", "Belgium"}, 2, DifficultyLevel.Easy ),
        },
        [QuestionCategory.Entertainment] = new[]
        {
            ( "Who painted the Mona Lisa?", new[] {"Michelangelo", "Da Vinci", "Raphael", "Donatello"}, 1, DifficultyLevel.Easy ),
            ( "What is the highest-grossing film of all time (unadjusted)?", new[] {"Avatar", "Avengers: Endgame", "Titanic", "Star Wars"}, 0, DifficultyLevel.Medium ),
        },
        [QuestionCategory.Technology] = new[]
        {
            ( "What does CPU stand for?", new[] {"Computer Personal Unit", "Central Processing Unit", "Central Program Utility", "Core Processing Unit"}, 1, DifficultyLevel.Easy ),
            ( "Who is the co-founder of Microsoft alongside Bill Gates?", new[] {"Steve Jobs", "Paul Allen", "Larry Page", "Mark Zuckerberg"}, 1, DifficultyLevel.Medium ),
        },
        [QuestionCategory.ArtCulture] = new[]
        {
            ( "The 'Starry Night' was painted by whom?", new[] {"Monet", "Van Gogh", "Cézanne", "Renoir"}, 1, DifficultyLevel.Easy ),
            ( "Shakespeare wrote 'Romeo and Juliet'. What type of work is it?", new[] {"Novel", "Tragedy", "Comedy", "Sonnet"}, 1, DifficultyLevel.Medium ),
        },
        [QuestionCategory.General] = new[]
        {
            ( "How many continents are there?", new[] {"5", "6", "7", "8"}, 2, DifficultyLevel.Easy ),
            ( "What is the largest ocean?", new[] {"Atlantic", "Indian", "Arctic", "Pacific"}, 3, DifficultyLevel.Easy ),
        },
    };

    public static IReadOnlyList<QuizQuestion> GenerateQuestions(QuestionCategory category, int count)
    {
        var pool = Pool.TryGetValue(category, out var p) ? p : Pool[QuestionCategory.General];
        var list = new List<QuizQuestion>(count);
        for (var i = 0; i < count; i++)
        {
            var (text, opts, correct, diff) = pool[i % pool.Length];
            list.Add(new QuizQuestion
            {
                Text = text,
                Options = new List<string>(opts),
                CorrectOptionIndex = correct,
                Category = category,
                Difficulty = diff
            });
        }
        return list;
    }
}
