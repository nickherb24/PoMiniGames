using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoCabinet;

/// <summary>
/// The two model-backed PoCabinet routes (see <see cref="PoCabinetAiService"/>). Mapped on the
/// authenticated <c>/api</c> group like every other game-data route, behind the
/// <c>ai-generation</c> limiter. Both always answer 200 — the scripted pool / rule-based debrief
/// when the model can't — so the page never has an error path to show.
/// </summary>
public static class PoCabinetAiEndpoints
{
    public static IEndpointRouteBuilder MapPoCabinetAiEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/pocabinet").WithTags("PoCabinet");

        group.MapGet("/banter", async (string? track, PoCabinetAiService ai, CancellationToken ct) =>
                Results.Ok(await ai.BanterAsync(track, ct)))
            .WithName("PoCabinetBanter")
            .WithSummary("The officials' radio lines for a track (cached per track per day)")
            .Produces<PoCabinetBanterPool>()
            .RequireRateLimiting("ai-generation");

        group.MapPost("/debrief", async (PoCabinetDebriefRequest request, PoCabinetAiService ai, CancellationToken ct) =>
                Results.Ok(await ai.DebriefAsync(request, ct)))
            .WithName("PoCabinetDebrief")
            .WithSummary("A post-race headline and up to three driving tips from the race numbers")
            .Produces<PoCabinetDebriefReply>()
            .RequireRateLimiting("ai-generation");
        return app;
    }
}
