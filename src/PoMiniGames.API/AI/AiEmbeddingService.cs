using System.Diagnostics;
using Microsoft.Extensions.Options;

namespace PoMiniGames.AI;

/// <summary>
/// Vector embeddings from the shared foundry account, for the jobs that are asking "how alike are
/// these two pieces of text?" rather than asking a model to write anything.
/// </summary>
/// <remarks>
/// <para>
/// <b>Why this exists.</b> PoCoupleQuiz scored answer similarity by spending a whole chat
/// completion to obtain a single float between 0 and 1 — a generative call, priced as one, doing a
/// job that is not generative. An embedding pair plus a cosine is cheaper by orders of magnitude,
/// and it is <em>deterministic</em>: the same two answers produce the same score forever, so the
/// result can be cached without an expiry and without worrying that the model drifted.
/// </para>
/// <para>
/// It also fixes a correctness problem the chat path had. When the model's reply carried no
/// <c>score</c> field, the scorer returned <c>0f</c> — a value indistinguishable from "these
/// answers are completely unrelated". A failed call and a confidently wrong answer scored the same.
/// Cosine either produces a number or throws.
/// </para>
/// <para>
/// <b>Optional by construction.</b> <see cref="IsConfigured"/> is false when no embedding
/// deployment is set, and callers fall back to their chat path. This is not defensive
/// over-engineering: the deployment inventory on the shared account contains no embedding model
/// at all, so this service is dormant and PoCoupleQuiz scores via chat. Deploying <c>text-embedding-3-small</c> and setting
/// <see cref="AIFoundryOptions.EmbeddingDeployment"/> switches the cheap path on with no code change.
/// </para>
/// </remarks>
public sealed class AiEmbeddingService
{
    private readonly AIFoundryClientFactory _factory;
    private readonly IOptionsMonitor<AIFoundryOptions> _options;
    private readonly ILogger<AiEmbeddingService> _logger;
    private readonly AiUsageAccumulator _usage;
    private readonly AiTokenBudget _budget;

    public AiEmbeddingService(
        AIFoundryClientFactory factory,
        IOptionsMonitor<AIFoundryOptions> options,
        ILogger<AiEmbeddingService> logger,
        AiUsageAccumulator usage,
        AiTokenBudget budget)
    {
        _factory = factory;
        _options = options;
        _logger = logger;
        _usage = usage;
        _budget = budget;
    }

    /// <summary>Deployment serving embeddings, or empty when none is configured.</summary>
    public string Deployment => _options.CurrentValue.EmbeddingDeployment;

    /// <summary>True when an embedding deployment is configured and the foundry client exists.</summary>
    public bool IsConfigured => !string.IsNullOrWhiteSpace(Deployment) && _factory.IsAvailable;

    /// <summary>
    /// Cosine similarity of two texts in [0, 1], or null when embeddings are unavailable or the
    /// call failed — the signal for the caller to use its own fallback rather than to report a score.
    /// </summary>
    /// <remarks>
    /// Returning null rather than 0 is the whole point: 0 is a legitimate similarity score, so a
    /// failure that returns 0 is a failure that lies. The caller must be able to tell them apart.
    /// </remarks>
    public async Task<float?> TryScoreSimilarityAsync(
        string first, string second, string purpose, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(first) || string.IsNullOrWhiteSpace(second))
            return 0f;

        var vectors = await TryEmbedAsync([first, second], purpose, cancellationToken);
        if (vectors is not { Count: 2 })
            return null;

        var cosine = Cosine(vectors[0], vectors[1]);

        // Cosine over embeddings is in [-1, 1] in principle; for these models it is in practice
        // non-negative, and the game's contract is [0, 1]. Clamp rather than rescale: rescaling
        // would map "unrelated" (~0) to 0.5 and make every wrong guess look half right.
        return Math.Clamp(cosine, 0f, 1f);
    }

    /// <summary>
    /// Embeds a batch, or returns null when embeddings are unavailable or the call failed. One
    /// request for the whole batch — an embedding endpoint accepts an array, and two round trips
    /// for a pair would give back most of the saving this path exists for.
    /// </summary>
    public async Task<IReadOnlyList<ReadOnlyMemory<float>>?> TryEmbedAsync(
        IReadOnlyList<string> inputs, string purpose, CancellationToken cancellationToken = default)
    {
        if (!IsConfigured || inputs.Count == 0)
            return null;

        var deployment = Deployment;
        var identity = AiUsageScope.CurrentIdentity;

        // Same ceiling as chat calls. Embeddings are cheap, not free, and an uncapped cheap call
        // in a loop is how an unbounded bill happens.
        if (!string.IsNullOrEmpty(identity)
            && await _budget.CheckAsync(identity, cancellationToken) is { Allowed: false } verdict)
        {
            _logger.TokenBudgetExhausted(identity, verdict.Spent, verdict.Limit, verdict.ResetUtc);
            throw new AiTokenBudgetExceededException(verdict.Spent, verdict.Limit, verdict.ResetUtc);
        }

        var started = Stopwatch.GetTimestamp();
        try
        {
            // Provider-neutral: an OpenAI-compatible backend (Ollama serves nomic-embed-text and
            // friends for free) satisfies this path exactly as the Azure account would.
            var client = _factory.GetEmbeddingClient(deployment);
            if (client is null) return null;
            var response = await client.GenerateEmbeddingsAsync(inputs, cancellationToken: cancellationToken);
            var elapsedMs = (long)Stopwatch.GetElapsedTime(started).TotalMilliseconds;

            var tokens = response.Value.Usage?.TotalTokenCount ?? 0;
            _logger.EmbeddingCallCompleted(purpose, deployment, inputs.Count, tokens, elapsedMs);
            _usage.Record($"embed:{purpose}", deployment, tokens, 0, elapsedMs);
            AiUsageScope.Report(tokens);
            if (!string.IsNullOrEmpty(identity))
                _budget.Record(identity, tokens);

            return response.Value.Select(e => e.ToFloats()).ToList();
        }
        catch (AiTokenBudgetExceededException)
        {
            throw;
        }
        catch (Exception ex)
        {
            var elapsedMs = (long)Stopwatch.GetElapsedTime(started).TotalMilliseconds;
            _logger.EmbeddingCallFailed(purpose, deployment, elapsedMs, ex.GetType().Name, ex);
            _usage.RecordFailure($"embed:{purpose}", deployment, elapsedMs);
            return null;
        }
    }

    /// <summary>Cosine similarity of two equal-length vectors; 0 when either has no magnitude.</summary>
    private static float Cosine(ReadOnlyMemory<float> a, ReadOnlyMemory<float> b)
    {
        var x = a.Span;
        var y = b.Span;
        if (x.Length == 0 || x.Length != y.Length)
            return 0f;

        double dot = 0, magX = 0, magY = 0;
        for (var i = 0; i < x.Length; i++)
        {
            dot += (double)x[i] * y[i];
            magX += (double)x[i] * x[i];
            magY += (double)y[i] * y[i];
        }

        var denominator = Math.Sqrt(magX) * Math.Sqrt(magY);
        return denominator == 0 ? 0f : (float)(dot / denominator);
    }
}
