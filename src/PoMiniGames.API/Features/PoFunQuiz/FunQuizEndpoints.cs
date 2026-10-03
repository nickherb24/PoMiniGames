using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Caching.Hybrid;
using PoMiniGames.Domain.Services;
using PoMiniGames.Features.Auth;
using PoMiniGames.Features.PoFunQuiz.Storage;

namespace PoMiniGames.Features.PoFunQuiz;

/// <summary>
/// Minimal-API endpoints for PoFunQuiz: question generation, leaderboard submit / fetch,
/// and per-game runtime status. Real-time multiplayer (lobby + score updates) is handled
/// by the SignalR hub (<see cref="FunQuizHub"/>) in a follow-up. This MVP serves the
/// Solo mode and the leaderboard.
/// </summary>
public static class FunQuizEndpoints
{
    public static IEndpointRouteBuilder MapFunQuizEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/funquiz").WithTags("PoFunQuiz");

        // ── Question generation ──────────────────────────────────────────
        // This call is deliberately not cached here. Memoizing the finished, already-dealt
        // list of questions would give every game started inside the same window a
        // byte-identical quiz — same questions, same order, same option order — defeating
        // the per-game shuffling in AiQuizGeneratorService.SelectVariedSet.
        //
        // That costs nothing upstream: the generator has its OWN HybridCache over the
        // question POOL (6 h, stampede-protected), so concurrent requests still collapse
        // into a single model call. The layer which is allowed to cache caches the raw
        // material, and the dealing — which subset, in which order, with options
        // shuffled — happens per request. Cache the pool, not the hand.

        group.MapGet("/quiz/questions", async (
            [FromQuery] int count,
            [FromQuery] string? category,
            IOpenAIService ai,
            CancellationToken cancellationToken) =>
        {
            if (count <= 0) count = 10;
            // A too-large count is a malformed request, not a rate-limit hit. Returning 429
            // would put a second, unrelated meaning on the one status code the rate limiter
            // owns — and the client surfaces 429 as "wait and retry", advice that would never
            // make count=500 succeed.
            if (count > 50) return Results.BadRequest(new { error = "count must be between 1 and 50." });
            if (string.Equals(category, "BrowserAI", StringComparison.OrdinalIgnoreCase))
            {
                return Results.BadRequest(new { error = "BrowserAI must be invoked client-side; this endpoint serves server-side AI only." });
            }

            var cat = Enum.TryParse<QuestionCategory>(category, ignoreCase: true, out var c)
                ? c
                : QuestionCategory.General;
            // Called directly. The AsyncLocal identity the request middleware set is still on
            // this flow here — the note that used to sit here explained why it had to be carried
            // in HybridCache factory state instead (the factory runs off-flow, so a generation
            // was billed to nobody: measured at 809 tokens against a 0-token budget entry). That
            // hazard belongs to the generator's internal cache now, which handles it there.
            var questions = await ai.GenerateQuizQuestionsAsync(cat, count, cancellationToken);
            return Results.Ok(questions);
        })
        .RequireRateLimiting("ai-generation")
        .WithName("FunQuiz_GetQuestions")
        .WithSummary("Generate PoFunQuiz questions (gpt-5-nano on the shared po-aiservices-shared account)");

        // ── Leaderboard ────────────────────────────────────────────────────────

        group.MapGet("/leaderboard", async (
            [FromQuery] string? category,
            [FromQuery] int? top,
            LeaderboardRepository repo,
            CancellationToken cancellationToken) =>
        {
            var cat = Enum.TryParse<QuestionCategory>(category, ignoreCase: true, out var c) ? c : QuestionCategory.General;
            var entries = await repo.GetTopAsync(cat, top ?? 10, cancellationToken);
            return Results.Ok(entries);
        })
        .WithName("FunQuiz_GetLeaderboard")
        .WithSummary("Top PoFunQuiz players for a category");

        group.MapPost("/leaderboard", async (
            [FromBody] LeaderboardEntry body,
            HttpContext ctx,
            LeaderboardRepository repo,
            CancellationToken cancellationToken) =>
        {
            // Anti-spoof: the stored name comes from the caller's claims, never the body.
            // The board is readable without signing in, so it must be a display name and
            // never an email: an address-shaped claim keeps only the part before the '@'.
            var claimed = RequestIdentity.Resolve(ctx.User).DisplayName;
            var at = claimed.IndexOf('@');
            body.PlayerName = DisplayNameSanitizer.Sanitize(at > 0 ? claimed[..at] : claimed, fallback: "Player").Value;
            body.Score = Math.Clamp(body.Score, 0, 10_000);
            // The row key is derived from the date, so a client-chosen one mints unlimited rows.
            body.DatePlayed = DateTime.UtcNow;
            await repo.SubmitAsync(body, cancellationToken);
            return Results.Created("/api/funquiz/leaderboard", body);
        })
        .RequireAuthorization()
        .RequireRateLimiting("highscores")
        .WithName("FunQuiz_SubmitLeaderboard");

        return app;
    }
}
