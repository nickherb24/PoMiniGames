using Microsoft.Extensions.AI;

namespace PoMiniGames.AI;

/// <summary>
/// Refuses a model call when the caller has spent their daily token allowance, and charges them
/// what the call actually cost.
/// </summary>
/// <remarks>
/// <para>
/// <see cref="AiTokenBudget"/> existed but was consulted in exactly one place —
/// the <c>POST /api/infer</c> relay — so it bounded one caller and nothing else. Every other AI
/// surface in the host was unmetered: PoFunQuiz will generate up to 50 questions per request,
/// PoCoupleQuiz scores
/// a model call per answer pair per round, and PoJoker runs an autonomous show loop issuing two to
/// three calls per joke. None of them charged a token.
/// </para>
/// <para>
/// Enforcing it in a decorator rather than in an endpoint filter is what makes the coverage total.
/// Half of these calls do not happen during an HTTP request: PoCoupleQuiz's generation and scoring
/// both run inside <c>CoupleQuizHub</c> invocations, which an endpoint filter never sees. Every AI
/// call, from anywhere, goes through this client.
/// </para>
/// <para>
/// GoF: Decorator. Placed OUTSIDE <see cref="InstrumentedChatClient"/> and inside
/// <see cref="ResilientChatClient"/>, which is the only position that behaves correctly:
/// </para>
/// <list type="bullet">
///   <item>Outside the instrumented client, so a refusal costs no network call and is not recorded
///   as a provider failure — the deployment is healthy; the caller is out of allowance.</item>
///   <item>Inside the resilience pipeline, so <see cref="AiTokenBudgetExceededException"/> travels
///   as an ordinary non-transient exception: <c>IsTransient</c> does not match it, so it is never
///   retried and never counts toward the circuit breaker.</item>
/// </list>
/// <para>
/// Charging happens here as well as in <c>InferEndpoints</c>' <see cref="AiUsageScope"/>: the scope
/// reports what a whole request spent (for the relay's own accounting), while this charges each
/// call as it completes, so a single request that makes twenty calls cannot overshoot the ceiling
/// by nineteen of them. Both read the provider's reported usage, so they agree.
/// </para>
/// </remarks>
public sealed class BudgetedChatClient : DelegatingChatClient
{
    private readonly AiTokenBudget _budget;
    private readonly ILogger _logger;
    private readonly string _game;

    public BudgetedChatClient(IChatClient innerClient, AiTokenBudget budget, string game, ILogger logger)
        : base(innerClient)
    {
        _budget = budget;
        _game = game;
        _logger = logger;
    }

    public override async Task<ChatResponse> GetResponseAsync(
        IEnumerable<ChatMessage> messages,
        ChatOptions? options = null,
        CancellationToken cancellationToken = default)
    {
        var identity = AiUsageScope.CurrentIdentity;

        // No identity in scope means nothing opened one — a background task, or a code path that
        // predates the middleware. Charging "unknown" would pool every such caller into one ledger
        // and let the first exhaust the rest; refusing would break them. Proceed, but say so, since
        // an unattributed call is spend nobody is accountable for.
        if (string.IsNullOrEmpty(identity))
        {
            _logger.AiCallUnattributed(_game);
            return await base.GetResponseAsync(messages, options, cancellationToken);
        }

        // CheckAsync, not Check: the first call from this identity today hydrates their spend from
        // the durable ledger, so an allowance already used up before the last host recycle is still
        // spent. Check() would see an empty in-process dictionary and wave them through.
        if (await _budget.CheckAsync(identity, cancellationToken) is { Allowed: false } verdict)
        {
            _logger.TokenBudgetExhausted(identity, verdict.Spent, verdict.Limit, verdict.ResetUtc);
            throw new AiTokenBudgetExceededException(verdict.Spent, verdict.Limit, verdict.ResetUtc);
        }

        var response = await base.GetResponseAsync(messages, options, cancellationToken);
        _budget.Record(identity, response.Usage?.TotalTokenCount ?? 0);
        return response;
    }

    /// <summary>
    /// Same gate for streamed calls. PoJoker streams its verdict and stops reading early, so the
    /// provider's usage update often never arrives; the charge then falls back to an estimate
    /// from the text that did, which under-counts the prompt but never charges nothing.
    /// </summary>
    public override async IAsyncEnumerable<ChatResponseUpdate> GetStreamingResponseAsync(
        IEnumerable<ChatMessage> messages,
        ChatOptions? options = null,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        var identity = AiUsageScope.CurrentIdentity;
        if (string.IsNullOrEmpty(identity))
        {
            _logger.AiCallUnattributed(_game);
        }
        else if (await _budget.CheckAsync(identity, cancellationToken) is { Allowed: false } verdict)
        {
            _logger.TokenBudgetExhausted(identity, verdict.Spent, verdict.Limit, verdict.ResetUtc);
            throw new AiTokenBudgetExceededException(verdict.Spent, verdict.Limit, verdict.ResetUtc);
        }

        long reported = 0;
        long chars = 0;
        try
        {
            await foreach (var update in base.GetStreamingResponseAsync(messages, options, cancellationToken))
            {
                chars += update.Text?.Length ?? 0;
                foreach (var usage in update.Contents.OfType<UsageContent>())
                    reported += usage.Details.TotalTokenCount ?? 0;
                yield return update;
            }
        }
        finally
        {
            if (!string.IsNullOrEmpty(identity))
            {
                // ponytail: ~4 chars per token when the provider reported nothing. Count the
                // prompt too if the under-charge ever matters.
                _budget.Record(identity, reported > 0 ? reported : (chars + 3) / 4);
            }
        }
    }
}

/// <summary>
/// Thrown when the caller has already spent their daily token allowance. Distinct from a provider
/// fault so a handler can answer 429 with a reset time rather than reporting the model as broken.
/// </summary>
public sealed class AiTokenBudgetExceededException : Exception
{
    public AiTokenBudgetExceededException(long spent, long limit, DateTimeOffset resetUtc)
        : base($"Daily AI token allowance spent ({spent}/{limit}). Resets at {resetUtc:O}.")
    {
        Spent = spent;
        Limit = limit;
        ResetUtc = resetUtc;
    }

    /// <summary>Tokens spent so far today.</summary>
    public long Spent { get; }

    /// <summary>The daily ceiling in force.</summary>
    public long Limit { get; }

    /// <summary>When the allowance returns.</summary>
    public DateTimeOffset ResetUtc { get; }

    /// <summary>Seconds until the allowance returns, for a <c>Retry-After</c> header.</summary>
    public int RetryAfterSeconds => Math.Max(1, (int)(ResetUtc - DateTimeOffset.UtcNow).TotalSeconds);
}
