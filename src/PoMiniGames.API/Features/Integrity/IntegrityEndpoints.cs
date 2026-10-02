using Microsoft.Extensions.Options;
using PoMiniGames.Domain.Primitives;
using PoMiniGames.Features.Auth;

namespace PoMiniGames.Features.Integrity;

/// <summary>
/// Endpoints for the score-integrity slice: mint a play session.
/// </summary>
/// <remarks>
/// The mint endpoint sits in the authenticated group (see EndpointRouteExtensions) because a
/// session is bound to an identity and there is nothing to bind for an anonymous caller.
/// </remarks>
public static class IntegrityEndpoints
{
    /// <summary>Mint: authenticated, because the session is identity-bound.</summary>
    public static IEndpointRouteBuilder MapPlaySessionEndpoints(this IEndpointRouteBuilder app)
    {
        // Play sessions share /api/play.
        var play = app.MapGroup("/play").WithTags("Integrity");

        play.MapPost("/sessions/{game}",
            (string game, HttpContext http, PlaySessionService sessions, IOptionsMonitor<IntegrityOptions> options) =>
            {
                if (options.CurrentValue.Mode == IntegrityMode.Off)
                {
                    // Nothing to mint, and saying so lets the client stop asking rather than
                    // retrying a 404 on every navigation.
                    return Results.NoContent();
                }

                // Allow-list: only the well-known catalogue may hold a session, so a typo'd
                // key fails here rather than minting a token that can never be redeemed.
                if (GameKey.TryParse(game) is not { } key)
                {
                    return Results.BadRequest(new { error = $"Unknown game key '{game}'" });
                }

                var identity = RequestIdentity.Resolve(http.User);
                var identityKey = !string.IsNullOrEmpty(identity.UserId) ? identity.UserId
                    : !string.IsNullOrWhiteSpace(identity.DisplayName) ? identity.DisplayName
                    : "anon";

                return Results.Ok(sessions.Issue(key, identityKey));
            })
            .WithName("StartPlaySession")
            .WithSummary("Mint a signed play session for a game, redeemable on score submission")
            .Produces<PlaySessionTicket>(StatusCodes.Status200OK)
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .RequireRateLimiting("play-session");

        return app;
    }
}
