using PoMiniGames.Features.Auth;
using PoMiniGames.Features.Integrity;

namespace PoMiniGames.Features.MatchHistory;

/// <summary>
/// Minimal API endpoints for recording and reading head-to-head match results.
/// The owner identity is server-authoritative for signed-in callers (forced to the
/// claim identity so nobody can read or forge another user's record); truly-anonymous
/// guests fall back to the client-supplied name, which is inherently low-trust.
/// </summary>
public static class MatchHistoryEndpoints
{
    public static IEndpointRouteBuilder MapMatchHistoryEndpoints(this IEndpointRouteBuilder app)
    {
        // §1 MapGroup() per slice: match history POST + GET share /api/matches.
        var matches = app.MapGroup("/matches").WithTags("MatchHistory");

        matches.MapPost("",
            async (MatchRecordRequest request, HttpContext http, MatchHistoryRepository repo,
                   IScoreIntegrityGuard integrity) =>
            {
                if (string.IsNullOrWhiteSpace(request.Game))
                    return Results.BadRequest(new { error = "Game is required" });
                if (string.IsNullOrWhiteSpace(request.OpponentName))
                    return Results.BadRequest(new { error = "OpponentName is required" });

                // §1: a signed-in caller may only write to their OWN partition — the client
                // Owner is overridden with the claim identity. Guests keep the supplied name.
                var identity = RequestIdentity.Resolve(http.User);
                var owner = ResolveOwner(identity, request.Owner, integrity);
                if (string.IsNullOrWhiteSpace(owner))
                    return Results.BadRequest(new { error = "Owner is required" });

                // The opponent name is chosen by whoever set up the local 2-player game and is
                // rendered back on the stats page, so it gets the same treatment as any other
                // player-supplied name. "Opponent" rather than "Guest" as the fallback: it is
                // the other seat, and calling them Guest reads as a sign-in state.
                var opponent = integrity.ResolveDisplayName(request.OpponentName, "Opponent");

                await repo.RecordAsync(request with { Owner = owner, OpponentName = opponent });
                return Results.Created("/api/matches", null);
            })
            .WithName("RecordMatch")
            .WithSummary("Record a finished head-to-head match result")
            .Produces(StatusCodes.Status201Created)
            .RequireRateLimiting("highscores");

        matches.MapGet("",
            async (HttpContext http, MatchHistoryRepository repo, IScoreIntegrityGuard integrity,
                   string? owner = null, int limit = 500) =>
            {
                // §1: a signed-in caller can only read their OWN history — the owner query
                // param is ignored and forced to the claim identity (closes the IDOR read).
                var identity = RequestIdentity.Resolve(http.User);
                // Resolved through the SAME helper the POST uses. If the read derived the
                // partition from the raw name while the write derived it from the sanitised
                // one, a player whose name the sanitiser rewrites would write to one partition
                // and read from another — their history would silently come back empty.
                var effectiveOwner = ResolveOwner(identity, owner, integrity);
                if (string.IsNullOrWhiteSpace(effectiveOwner))
                    return Results.BadRequest(new { error = "owner query parameter is required" });

                var records = await repo.GetForOwnerAsync(effectiveOwner, limit);
                return Results.Ok(records);
            })
            .WithName("GetMatches")
            .WithSummary("Read the caller's match history, most recent first")
            .Produces<IEnumerable<MatchRecordDto>>(StatusCodes.Status200OK);

        return app;
    }

    /// <summary>
    /// The partition a caller's match history lives in. A signed-in caller is pinned to their
    /// claim identity; a guest keeps the supplied name, which is inherently low-trust. Either
    /// way the result passes through moderation, because this value is both the partition key
    /// and the name rendered back on the stats page.
    /// </summary>
    internal static string ResolveOwner(
        RequestIdentity.Identity identity, string? supplied, IScoreIntegrityGuard integrity)
    {
        var claimed = identity.IsAuthenticated && !string.IsNullOrWhiteSpace(identity.DisplayName)
            ? identity.DisplayName
            : supplied;

        return string.IsNullOrWhiteSpace(claimed)
            ? string.Empty
            : integrity.ResolveDisplayName(claimed, identity.IsGuest ? "Guest" : "Player");
    }
}
