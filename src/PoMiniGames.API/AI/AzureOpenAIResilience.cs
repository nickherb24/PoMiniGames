using System.ClientModel.Primitives;
using Azure.AI.OpenAI;
using Microsoft.Extensions.DependencyInjection;
using Polly;
using Polly.CircuitBreaker;
using Polly.RateLimiting;
using Polly.Retry;
using Polly.Timeout;

namespace PoMiniGames.AI;

/// <summary>
/// Centralises the resilience posture for every Azure OpenAI client in the solution so no
/// call path can be constructed that assumes the service is always up and infinitely fast.
/// </summary>
/// <remarks>
/// <para>
/// A per-attempt network timeout and a flat retry count are not enough: with no circuit
/// breaker, a single hung Azure region could saturate the request pipeline (30s × unbounded
/// concurrent callers) and starve the rest of the app. The pipeline therefore has three guards:
/// <list type="number">
///   <item><b>Outer timeout</b> (per call, including all retries) — the worst case the
///         caller ever observes.</item>
///   <item><b>Retry with exponential backoff + jitter</b> — transient-fault coverage on a
///         backoff that doesn't synchronise storm retries.</item>
///   <item><b>Circuit breaker</b> — after 30 % failures across 10 requests in 30 s, the
///         pipeline short-circuits for 15 s and returns <c>BrokenCircuitException</c>
///         immediately rather than queuing 30-second timeouts against a dead endpoint.</item>
/// </list>
/// </para>
/// <para>
/// The Azure OpenAI SDK (System.ClientModel) keeps its own <see cref="ClientRetryPolicy"/>
/// for the underlying transport, but the orchestrating <see cref="ResiliencePipeline"/>
/// is the source of truth for total-call budget and circuit state.
/// </para>
/// <para>
/// Every AI consumer compiles against a single <c>using PoMiniGames.AI;</c> (wired by the
/// host's <c>GlobalUsings.cs</c>).
/// </para>
/// </remarks>
public static class AzureOpenAIResilience
{
    /// <summary>Pipeline name registered with <see cref="ResiliencePipelineProvider{TKey}"/>.</summary>
    public const string PipelineName = "ai-foundry";

    /// <summary>Per-attempt network timeout (set on the SDK client options).</summary>
    public static readonly TimeSpan NetworkTimeout = TimeSpan.FromSeconds(15);

    /// <summary>Per-call outer timeout — includes all retries. Real-time games cannot wait longer than this.</summary>
    public static readonly TimeSpan TotalCallBudget = TimeSpan.FromSeconds(20);

    /// <summary>
    /// Transient-failure retry attempts at the SDK layer. Zero — deliberately.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The orchestrating <see cref="ResiliencePipeline"/> is the source of truth for total-call
    /// budget and circuit state, so the SDK's own <see cref="ClientRetryPolicy"/> must not retry
    /// underneath it; the two would fight:
    /// </para>
    /// <list type="bullet">
    ///   <item>Two SDK retries make 3 SDK attempts × the 15 s network timeout = 45 s or more —
    ///   the outer 20 s budget cannot see inside a single "attempt" to stop it.</item>
    ///   <item>Worse under throttling: the SDK honours <c>Retry-After</c> internally, so a 429
    ///   carrying <c>retry-after: 30</c> became a 30-second sleep inside one call. Measured, that
    ///   turned an <em>instant</em> 429 (0.2 s by curl) into a 9 s timeout in the app, and made
    ///   the outer policy's fail-fast decision unreachable — it never saw the 429 at all.</item>
    /// </list>
    /// <para>
    /// With SDK retries off, a throttle surfaces immediately, the Polly layer decides whether it
    /// is worth outwaiting, and the circuit breaker sees real failure counts.
    /// </para>
    /// </remarks>
    public const int MaxSdkRetries = 0;

    /// <summary>
    /// Model calls allowed in flight at once, across the whole host.
    /// </summary>
    /// <remarks>
    /// Measured against the shared foundry account, calling gpt-5.4-nano directly with
    /// an AAD token and bypassing this app entirely: one call at a time returns in 1.0–2.6 s; two
    /// concurrent return in 3.6 s and 9.0 s; three concurrent complete <b>one</b> and drop the
    /// other two; a burst is then followed by immediate <c>429</c> on every subsequent call. The
    /// account's quota simply does not serve a stampede, and one game was aiming three
    /// concurrent calls per heartbeat at it. Queueing behind a small permit count converts that
    /// into slightly slower answers instead of mostly-lost ones.
    /// </remarks>
    public const int MaxConcurrentCalls = 2;

    /// <summary>Calls allowed to wait for a permit before the limiter rejects outright.</summary>
    public const int ConcurrencyQueueLimit = 8;

    /// <summary>
    /// Calls one game may have contending for the global gate at once.
    /// </summary>
    /// <remarks>
    /// This is a <b>fairness</b> cap, not a capacity one. <see cref="MaxConcurrentCalls"/> is the
    /// account's real ceiling and is enforced once, globally, by <see cref="AiConcurrencyGate"/>;
    /// this bounds how much of the global queue a single game may occupy so a real-time loop
    /// cannot crowd out an interactive request. Raising it does not buy throughput — the gate
    /// still admits <see cref="MaxConcurrentCalls"/> at a time — it only lets one game hold more
    /// queue slots.
    /// </remarks>
    public const int PerGameConcurrency = 2;

    /// <summary>
    /// Queue depth on the global gate. Computed, not chosen: it must hold every caller the
    /// per-game limiters can admit at once.
    /// </summary>
    /// <remarks>
    /// A caller that has already won its game's permit and is then rejected here surfaces as an
    /// exception the circuit breaker counts, so an undersized global queue would report a healthy
    /// account as a failing one. The <c>+1</c> is the unpartitioned fallback pipeline, which serves
    /// every game key without a partition of its own.
    /// </remarks>
    public static int GlobalQueueLimit => (PartitionedGames.Length + 1) * PerGameConcurrency;

    /// <summary>
    /// Games that get their own pipeline instance, and therefore their own concurrency permits and
    /// their own circuit state.
    /// </summary>
    /// <remarks>
    /// <para>
    /// A single shared pipeline was correct while there was only one consumer. It stops being
    /// correct the moment the other four services join it, for two reasons:
    /// </para>
    /// <list type="bullet">
    ///   <item><b>Concurrency.</b> <see cref="MaxConcurrentCalls"/> is 2 for the whole host. A busy game
    ///   issues a call per agent per heartbeat and would hold both permits essentially continuously,
    ///   so PoJoker's two-calls-per-joke would spend its life in the queue and then be rejected by
    ///   <see cref="ConcurrencyQueueLimit"/>. Sharing a global permit count between a real-time loop
    ///   and an interactive request is a starvation bug, not a safety property.</item>
    ///   <item><b>Circuit state.</b> One breaker across all games means one game failing 30% of a
    ///   30-second window opens the circuit for PoFunQuiz too — a game that may be on a different
    ///   deployment entirely, and is fine. Failures should isolate to the game that produced them.</item>
    /// </list>
    /// <para>
    /// The permit counts stay small per game on purpose: the measured ceiling in
    /// <see cref="MaxConcurrentCalls"/> is an account-wide quota, not a per-game one, so the sum
    /// across games is still meant to be modest. Partitioning buys isolation and fairness, not more
    /// total throughput.
    /// </para>
    /// </remarks>
    public static readonly string[] PartitionedGames =
    [
        AIFoundryOptions.Games.CoupleQuiz,
        AIFoundryOptions.Games.FunQuiz,
        AIFoundryOptions.Games.Joker,
        AIFoundryOptions.Games.Ecosystem,
        AIFoundryOptions.Games.PoBrawl,
    ];

    /// <summary>Pipeline name for one game's partition.</summary>
    public static string PipelineNameFor(string gameKey) => $"{PipelineName}:{gameKey}";

    /// <summary>Ceiling on a service-supplied <c>Retry-After</c> we are willing to honour.</summary>
    private static readonly TimeSpan MaxRetryAfter = TimeSpan.FromSeconds(5);

    /// <summary>
    /// Registers the resilience pipeline used by every AI Foundry call. Called once from
    /// <c>GameServicesExtensions.AddPoMiniGamesGameServices</c>; consumers retrieve it
    /// from <see cref="ResiliencePipelineProvider{TKey}"/>.
    /// </summary>
    public static IServiceCollection AddAzureOpenAIResilience(this IServiceCollection services)
    {
        // One gate for the whole container, resolved from the pipeline's own service provider so
        // this method stays idempotent: calling it twice re-registers the same named pipelines
        // against the same singleton gate rather than minting a second ceiling.
        Microsoft.Extensions.DependencyInjection.Extensions.ServiceCollectionDescriptorExtensions
            .TryAddSingleton<AiConcurrencyGate>(services);

        // The unpartitioned pipeline stays registered as the fallback for a game key that has no
        // partition of its own.
        services.AddResiliencePipeline(PipelineName, static (builder, context) =>
            ConfigurePipeline(builder, context.ServiceProvider.GetRequiredService<AiConcurrencyGate>()));

        foreach (var game in PartitionedGames)
        {
            services.AddResiliencePipeline(PipelineNameFor(game), static (builder, context) =>
                ConfigurePipeline(builder, context.ServiceProvider.GetRequiredService<AiConcurrencyGate>()));
        }

        return services;
    }

    private static void ConfigurePipeline(ResiliencePipelineBuilder builder, AiConcurrencyGate gate)
    {
        builder.AddTimeout(new TimeoutStrategyOptions
        {
            Timeout = TotalCallBudget,
        });
        // ── Two-level concurrency ────────────────────────────────────────
        // Outer, per pipeline: fairness. Bounds how many of ONE game's calls contend for the
        // account at once, so a real-time loop cannot occupy the whole global queue.
        builder.AddConcurrencyLimiter(PerGameConcurrency, ConcurrencyQueueLimit);
        // Inner, shared by every pipeline: the account's real ceiling. This used to be the same
        // AddConcurrencyLimiter call as the line above, which built a SEPARATE limiter per
        // pipeline — five pipelines × 2 permits = 10 concurrent calls against an account measured
        // to serve one or two. See AiConcurrencyGate for the measurements.
        //
        // Both sit inside the outer timeout, so a call cannot wait in either queue indefinitely,
        // and outside the retry, so a retried attempt keeps its permits rather than going to the
        // back of both queues.
        builder.AddRateLimiter(new RateLimiterStrategyOptions
        {
            RateLimiter = args => gate.AcquireAsync(args.Context.CancellationToken),
        });
        builder.AddRetry(new RetryStrategyOptions
        {
            MaxRetryAttempts = 3,
            Delay = TimeSpan.FromMilliseconds(200),
            MaxDelay = TimeSpan.FromSeconds(2),
            BackoffType = DelayBackoffType.Exponential,
            UseJitter = true,
            // A 429 is not a random transient fault — the service says when to come back. If
            // that is longer than we are willing to wait, retrying is pure waste: it converts
            // an instant, honest refusal into a full-budget timeout, and the game's fallback
            // fires either way. Measured on the shared account, whose gpt-5.4-nano deployment
            // reports `x-ratelimit-limit-requests: 1` and `retry-after: 30` — every retry
            // there was spending nine seconds of a player's turn to be told no again.
            ShouldHandle = args => new ValueTask<bool>(ShouldRetry(args.Outcome.Exception)),
            DelayGenerator = args => new ValueTask<TimeSpan?>(RetryAfterOf(args.Outcome.Exception)),
        });
        builder.AddCircuitBreaker(new CircuitBreakerStrategyOptions
        {
            FailureRatio = 0.3,
            MinimumThroughput = 10,
            SamplingDuration = TimeSpan.FromSeconds(30),
            BreakDuration = TimeSpan.FromSeconds(15),
            ShouldHandle = new PredicateBuilder().Handle<Exception>(IsTransient),
        });
    }

    /// <summary>Client options with a bounded per-attempt timeout and explicit retry count.</summary>
    public static AzureOpenAIClientOptions DefaultOptions() => new()
    {
        NetworkTimeout = NetworkTimeout,
        RetryPolicy = new ClientRetryPolicy(MaxSdkRetries),
    };

    /// <summary>
    /// True when the exception is one we should retry or trip the breaker on. Non-transient
    /// faults (validation, auth) bubble straight out so the caller sees the real reason.
    /// </summary>
    private static bool IsTransient(Exception ex) => ex switch
    {
        TimeoutRejectedException => true,
        BrokenCircuitException => true,
        Azure.RequestFailedException rfe => rfe.Status >= 500 || rfe.Status == 408 || rfe.Status == 429,
        // What the OpenAI SDK actually throws for a non-success status. Without this arm a 429
        // from the account was classified non-transient, so neither the retry nor the breaker
        // ever saw the one failure mode this deployment produces under load.
        System.ClientModel.ClientResultException cre =>
            cre.Status >= 500 || cre.Status == 408 || cre.Status == 429,
        HttpRequestException => true,
        TaskCanceledException => false, // user-initiated; not a transient fault
        _ => false,
    };

    /// <summary>
    /// Retry only a transient fault we can actually outwait. A service that asks for longer than
    /// <see cref="MaxRetryAfter"/> is refused immediately so the caller can fall back now instead
    /// of at the end of its budget. The circuit breaker still counts the failure, so a run of
    /// these opens the circuit and later calls short-circuit without touching the network.
    /// </summary>
    private static bool ShouldRetry(Exception? ex)
    {
        if (ex is null || !IsTransient(ex))
            return false;

        // No Retry-After: an ordinary transient fault, so back off and try again.
        return RawRetryAfter(ex) is not { } wait || wait <= MaxRetryAfter;
    }

    /// <summary>
    /// The service's own <c>Retry-After</c>, capped. Null lets Polly use its exponential backoff.
    /// </summary>
    private static TimeSpan? RetryAfterOf(Exception? ex)
    {
        if (RawRetryAfter(ex) is not { } delay)
            return null;

        return delay > MaxRetryAfter ? MaxRetryAfter : delay;
    }

    /// <summary>The uncapped <c>Retry-After</c> the service supplied, if any.</summary>
    private static TimeSpan? RawRetryAfter(Exception? ex)
    {
        var raw = ex switch
        {
            System.ClientModel.ClientResultException cre => HeaderOf(cre.GetRawResponse()),
            _ => null,
        };

        return raw is not null
            && double.TryParse(raw, System.Globalization.NumberStyles.Any,
                System.Globalization.CultureInfo.InvariantCulture, out var seconds)
            ? TimeSpan.FromSeconds(seconds)
            : null;

        static string? HeaderOf(System.ClientModel.Primitives.PipelineResponse? response)
            => response is not null && response.Headers.TryGetValue("retry-after", out var value)
                ? value
                : null;
    }
}
