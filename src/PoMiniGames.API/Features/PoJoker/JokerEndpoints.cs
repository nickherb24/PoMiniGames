using Microsoft.AspNetCore.Mvc;
using PoMiniGames.Features.PoJoker.Storage;
using PoMiniGames.Shared.Games.PoJoker;

namespace PoMiniGames.Features.PoJoker;

/// <summary>
/// Minimal-API surface for the PoJoker demo game: fetch a joke and analyze it with AI.
/// The original PoJoker app
/// routed these through MediatR; here the handler logic is inlined as direct service
/// calls to match the PoMiniGames per-game endpoint convention (no MediatR dependency).
/// </summary>
public static class JokerEndpoints
{
    private const int MaxFetchRetries = 5;

    public static IEndpointRouteBuilder MapPoJokerEndpoints(this IEndpointRouteBuilder app)
    {
        // Both routes can reach a model (fetch rewrites flagged jokes, analyze judges them).
        var group = app.MapGroup("/joker").WithTags("PoJoker").RequireRateLimiting("ai-generation");

        group.MapGet("/fetch", FetchJoke)
            .WithName("PoJokerFetchJoke")
            .WithSummary("Fetch a random two-part joke from JokeAPI")
            .Produces<JokeDto>()
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable);

        group.MapPost("/analyze", AnalyzeJoke)
            .WithName("PoJokerAnalyzeJoke")
            .WithSummary("Analyze a joke using AI to predict the punchline")
            .Produces<JokeAnalysisDto>()
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable);

        return app;
    }

    private static async Task<IResult> FetchJoke(
        [FromQuery] bool safeMode,
        [FromQuery] int[]? excludeIds,
        [FromQuery] string? category,
        IJokeApiClient jokeApiClient,
        JokeRewriteService rewriteService,
        ILoggerFactory loggerFactory,
        CancellationToken cancellationToken)
    {
        var logger = loggerFactory.CreateLogger("PoJoker.Fetch");
        var resolvedCategory = string.IsNullOrWhiteSpace(category) ? "Any" : category;
        var excludeSet = excludeIds?.ToHashSet() ?? [];

        for (var retry = 0; retry < MaxFetchRetries; retry++)
        {
            var joke = await jokeApiClient.FetchJokeAsync(safeMode, excludeSet, resolvedCategory, cancellationToken);

            if (!IsValidJoke(joke))
            {
                excludeSet.Add(joke.Id);
                continue;
            }

            if (excludeSet.Count == 0 || !excludeSet.Contains(joke.Id))
            {
                return Results.Ok(await CleanIfNeededAsync(joke, rewriteService, logger, cancellationToken));
            }
        }

        // After max retries, return whatever we get (may be a duplicate), or a minimal fallback.
        var fallback = await jokeApiClient.FetchJokeAsync(safeMode, null, resolvedCategory, cancellationToken);
        if (!IsValidJoke(fallback))
        {
            logger.LogWarning("PoJoker: fallback joke also invalid; returning a minimal canned joke.");
            fallback = new JokeDto
            {
                Id = 0,
                Category = "Programming",
                Type = "single",
                Setup = "The AI was silent.",
                Punchline = "It had nothing to add.",
                Flags = new JokeFlags()
            };
        }
        return Results.Ok(await CleanIfNeededAsync(fallback, rewriteService, logger, cancellationToken));
    }

    /// <summary>
    /// Makes a flagged joke performable instead of skipping it.
    /// </summary>
    /// <remarks>
    /// Fallback chain, best-effort at every step so the show never stalls:
    /// <list type="number">
    /// <item>AI rewrite — the only step that can change a joke's <i>premise</i>, which
    /// is where JokeAPI's racist/sexist flags actually live.</item>
    /// <item>Word substitution — catches profanity the rewrite step could not handle
    /// (model unavailable, timed out, refused).</item>
    /// <item>Play as fetched — nothing is ever dropped.</item>
    /// </list>
    /// Unflagged jokes skip all of this and play verbatim, so the common path costs
    /// no extra latency.
    /// </remarks>
    private static async Task<JokeDto> CleanIfNeededAsync(
        JokeDto joke,
        JokeRewriteService rewriteService,
        ILogger logger,
        CancellationToken cancellationToken)
    {
        if (!JokeSanitizer.NeedsSanitizing(joke.Flags)) return joke;

        var rewritten = await rewriteService.TryRewriteAsync(joke, cancellationToken);
        if (rewritten is not null)
        {
            logger.LogInformation("PoJoker: joke {JokeId} was rewritten before performing.", joke.Id);
            return rewritten;
        }

        var substituted = JokeSanitizer.SanitizeIfNeeded(joke);
        if (!substituted.Sanitized)
        {
            // Worth a log line: the joke is going out flagged and unaltered, which is
            // the case neither cleaning step could handle.
            logger.LogInformation(
                "PoJoker: joke {JokeId} is flagged but could not be rewritten or substituted; performing as fetched.",
                joke.Id);
        }
        return substituted;
    }

    private static async Task<IResult> AnalyzeJoke(
        [FromBody] JokeDto joke,
        [FromHeader(Name = "X-Session-Id")] string? sessionId,
        IAnalysisService analysisService,
        JokeStorageClient storageClient,
        ILoggerFactory loggerFactory,
        CancellationToken cancellationToken)
    {
        var logger = loggerFactory.CreateLogger("PoJoker.Analyze");
        sessionId ??= Guid.NewGuid().ToString("N")[..8];
        var startTime = DateTimeOffset.UtcNow;

        var (analysis, rating) = await analysisService.AnalyzeJokeAsync(joke, cancellationToken);
        var result = analysis with { Rating = rating };

        // Persist for the leaderboard (best-effort; never fail the analysis on a storage error).
        try
        {
            await storageClient.SavePerformanceAsync(new JokePerformanceDto
            {
                SessionId = sessionId,
                Joke = joke,
                Analysis = result,
                StartedAt = startTime,
                CompletedAt = DateTimeOffset.UtcNow
            }, cancellationToken);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "PoJoker: failed to persist performance; leaderboard may be incomplete.");
        }

        return Results.Ok(result);
    }

    private static bool IsValidJoke(JokeDto? joke) =>
        joke is not null
        && !string.IsNullOrWhiteSpace(joke.Setup)
        && !string.IsNullOrWhiteSpace(joke.Punchline);
}
