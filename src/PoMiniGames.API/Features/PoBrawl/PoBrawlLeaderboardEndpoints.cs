using PoMiniGames.Domain.Abstractions;
using PoMiniGames.Domain.Models;
using PoMiniGames.Domain.Primitives;
using PoMiniGames.Features.Auth;
using PoMiniGames.Features.Integrity;

namespace PoMiniGames.Features.PoBrawl;

/// <summary>
/// Minimal API endpoints for PoBrawl's three leaderboards: fastest-KO high scores
/// (lower time is better), the presidents ladder, and the demo-mode fighter Elo board.
/// </summary>
public static class PoBrawlLeaderboardEndpoints
{
    public static IEndpointRouteBuilder MapPoBrawlLeaderboardEndpoints(this IEndpointRouteBuilder app)
    {
        // PoBrawl high scores share /api/pobrawl/highscores.
        var brawl = app.MapGroup("/pobrawl/highscores").WithTags("HighScores");

        brawl.MapGet("",
            async (IStorageService storage, int count = 10) =>
            {
                var scores = await storage.GetPoBrawlHighScoresAsync(count);
                return Results.Ok(scores);
            })
            .WithName("GetPoBrawlHighScores")
            .WithSummary("Top PoBrawl fastest-KO times")
            .Produces<IEnumerable<PoBrawlHighScore>>(StatusCodes.Status200OK);

        brawl.MapPost("",
            async (PoBrawlHighScore entry, HttpContext http, IStorageService storage,
                   ScoreIntegrityGuard integrity) =>
            {
                // The typed name is only a fallback (the claim name wins below), so it is only
                // validated when it is the one that will be stored. Checked unconditionally, a
                // signed-in player whose display name ran past 24 characters would have every KO
                // refused for a name the board is about to discard.
                var claimName = ClaimName(http);
                if (claimName is null && string.IsNullOrWhiteSpace(entry.PlayerInitials))
                    return Results.BadRequest(new { error = "Player name is required" });

                if (claimName is null && entry.PlayerInitials.Trim().Length > 24)
                    return Results.BadRequest(new { error = "Player name must be 24 characters or fewer" });

                if (entry.KoTimeSeconds <= 0 || entry.KoTimeSeconds >= 600)
                    return Results.BadRequest(new { error = "KO time must be between 0 and 600 seconds" });

                // KO time is the ranked value, so the guard's duration check applies directly:
                // a 4-second KO cannot come out of a session that has existed for one second.
                var verdict = integrity.Inspect(http, GameKey.PoBrawl, entry.KoTimeSeconds);
                if (!verdict.Allowed)
                    return verdict.ToProblem();

                // This board took its name entirely from the request body and consulted no
                // identity at all, so any caller could post under any player's name. Prefer the
                // claim identity, and moderate whatever is left.
                var name = StoredName(http, integrity, claimName, entry.PlayerInitials);

                var saved = await storage.SavePoBrawlHighScoreAsync(entry with { PlayerInitials = name });
                return Results.Created("/api/pobrawl/highscores", saved);
            })
            .WithName("SavePoBrawlHighScore")
            .WithSummary("Submit a new PoBrawl fastest-KO time")
            .Produces<PoBrawlHighScore>(StatusCodes.Status201Created)
            .RequireRateLimiting("highscores");

        // ── Presidents-ladder leaderboard ─────────────────────────────────
        // One row per player; ranks by how many of the presidents the player has beaten in
        // 1-player mode (best run ever), Elo as the tiebreaker. The rung ceiling is
        // PoBrawlRoster.Count, never a literal: the client ladder walks PoBrawlRoster.Fighters,
        // so a hardcoded 10 rejected every rung past the tenth once the roster grew to 15 —
        // and because the client discards the submit result, the board silently froze at 10.
        var ladder = app.MapGroup("/pobrawl/ladder").WithTags("HighScores");

        // WRITE ONLY, and deliberately so. There is no GET here because the ladder
        // standings are already served by the unified board:
        // UnifiedLeaderboardEndpoints.BuildPoBrawlAsync reads the same PoBrawlLadder
        // table through IStorageService and exposes it at /api/leaderboards/pobrawl,
        // which the /leaderboards page renders. A dedicated GET here would
        // have no caller in the client. If you need to
        // read the ladder, use the unified route — do not add a second one.
        //
        // The 1P end-of-match modal shows the fastest-KO view at
        // /api/leaderboards/pobrawlko (BuildPoBrawlKoAsync), which
        // ranks the GET above's data rather than the ladder's.
        ladder.MapPost("",
            async (PoBrawlLadderEntry entry, HttpContext http, IStorageService storage,
                   ScoreIntegrityGuard integrity) =>
            {
                // Same rule as the KO board: the typed name is validated only when it is stored.
                var claimName = ClaimName(http);
                if (claimName is null && string.IsNullOrWhiteSpace(entry.PlayerName))
                    return Results.BadRequest(new { error = "Player name is required" });

                if (claimName is null && entry.PlayerName.Trim().Length > 24)
                    return Results.BadRequest(new { error = "Player name must be 24 characters or fewer" });

                if (entry.PresidentsBeaten < 0 || entry.PresidentsBeaten > PoBrawlRoster.Count)
                    return Results.BadRequest(new { error = $"Presidents beaten must be between 0 and {PoBrawlRoster.Count}" });

                // No score guard here on purpose: the ladder accumulates rungs beaten rather
                // than points or a time, so there is no rate for ScoreRules to check and the
                // rung ceiling above already IS its whole range. The name still reaches a
                // public board, so it is moderated like everywhere else.
                var name = StoredName(http, integrity, claimName, entry.PlayerName);

                var saved = await storage.SavePoBrawlLadderAsync(entry with { PlayerName = name });
                return Results.Created("/api/pobrawl/ladder", saved);
            })
            .WithName("SavePoBrawlLadder")
            .WithSummary("Submit a player's presidents-ladder progress")
            .Produces<PoBrawlLadderEntry>(StatusCodes.Status201Created)
            .RequireRateLimiting("highscores");

        // ── Demo-mode fighter Elo ─────────────────────────────────────────
        // Head-to-head ratings for the presidents, accumulated from CPU-vs-CPU demo
        // matches. Rates characters, not players — see PoBrawlFighterRating. WRITE ONLY,
        // like the ladder: the board is read at /api/leaderboards/pobrawldemo.
        app.MapPost("/pobrawl/elo",
            async (PoBrawlDemoResultRequest request, IStorageService storage) =>
            {
                // The server owns the Elo arithmetic and the roster: the submission names
                // only who fought and who won. Ratings are never accepted from the client,
                // and an id outside the roster is rejected rather than creating a row —
                // the rating partition stays bounded at the roster size.
                if (!PoBrawlRoster.IsRateable(request.WinnerFighterId) ||
                    !PoBrawlRoster.IsRateable(request.LoserFighterId))
                {
                    return Results.BadRequest(new { error = "Both fighters must be on the PoBrawl presidents roster" });
                }

                if (string.Equals(request.WinnerFighterId, request.LoserFighterId, StringComparison.OrdinalIgnoreCase))
                {
                    return Results.BadRequest(new { error = "A fighter cannot fight itself" });
                }

                await storage.RecordPoBrawlDemoResultAsync(
                    request.WinnerFighterId, request.LoserFighterId, request.IsDraw);
                return Results.NoContent();
            })
            .WithTags("HighScores")
            .WithName("RecordPoBrawlDemoResult")
            .WithSummary("Record one CPU-vs-CPU demo match")
            .Produces(StatusCodes.Status204NoContent)
            .ProducesValidationProblem()
            // 10/min is comfortably above the real demo cadence (a match runs tens of
            // seconds), so a 429 here means something other than the kiosk is posting.
            // A dropped match costs the board one sample and nothing else.
            .RequireRateLimiting("highscores");

        return app;
    }

    /// <summary>The signed-in display name, or null when the typed name is all there is.</summary>
    private static string? ClaimName(HttpContext http)
    {
        var identity = RequestIdentity.Resolve(http.User);
        return identity.IsAuthenticated && !string.IsNullOrWhiteSpace(identity.DisplayName) ? identity.DisplayName : null;
    }

    /// <summary>
    /// The name a board row stores: the claim name, else the typed one — moderated either way, and
    /// held to the boards' 24 characters (the sanitizer caps it; this covers moderation switched off).
    /// </summary>
    private static string StoredName(HttpContext http, ScoreIntegrityGuard integrity, string? claimName, string typed)
    {
        var name = integrity.ResolveDisplayName(claimName ?? typed,
            RequestIdentity.Resolve(http.User).IsGuest ? "Guest" : "Player").Trim();
        return name.Length > 24 ? name[..24].TrimEnd() : name;
    }
}
