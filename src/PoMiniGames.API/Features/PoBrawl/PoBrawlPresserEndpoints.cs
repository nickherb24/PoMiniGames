using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoBrawl;

/// <summary>
/// POST /api/pobrawl/presser — the post-fight press-conference line (see
/// <see cref="PoBrawlPresserService"/>).
/// </summary>
public static class PoBrawlPresserEndpoints
{
    /// <summary>
    /// Mapped on the authenticated <c>/api</c> group (EndpointRouteExtensions), so the route is
    /// signed-in only and inside the antiforgery scope like every other game-data POST. A model
    /// call sits behind it, hence the <c>ai-generation</c> limiter rather than <c>highscores</c>.
    /// </summary>
    public static IEndpointRouteBuilder MapPoBrawlPresserEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGroup("/pobrawl").WithTags("PoBrawl")
            .MapPost("/presser", async (PoBrawlPresserRequest request, IPoBrawlPresserService presser, CancellationToken ct) =>
            {
                var reply = await presser.AskAsync(request, ct);
                return reply is null
                    ? Results.BadRequest(new { error = "Both fighters must be on the PoBrawl roster." })
                    : Results.Ok(reply);
            })
            .WithName("PoBrawlPresser")
            .WithSummary("One post-fight press-conference line in the speaker's voice")
            .Produces<PoBrawlPresserReply>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .RequireRateLimiting("ai-generation");

        // The ring introduction the PA reads under the VS splash (2026-09-29). Same deployment,
        // budget, cache and canned fallback as the press line; one cached line per pairing.
        app.MapGroup("/pobrawl").WithTags("PoBrawl")
            .MapPost("/intro", async (PoBrawlIntroRequest request, IPoBrawlPresserService presser, CancellationToken ct) =>
            {
                var reply = await presser.IntroAsync(request, ct);
                return reply is null
                    ? Results.BadRequest(new { error = "Both fighters must be on the PoBrawl roster." })
                    : Results.Ok(reply);
            })
            .WithName("PoBrawlIntro")
            .WithSummary("The ring announcer's introduction for a pairing")
            .Produces<PoBrawlPresserReply>()
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .RequireRateLimiting("ai-generation");
        return app;
    }
}
