using PoMiniGames.Domain.Models;
using PoMiniGames.Domain.Abstractions;
using PoMiniGames.Domain.Primitives;
using PoMiniGames.Features.Auth;
using PoMiniGames.Features.Integrity;

namespace PoMiniGames.Features.Leaderboard;

/// <summary>
/// Consolidated minimal API endpoints for player statistics and leaderboards.
/// </summary>
public static class PlayerStatsEndpoints
{
    public static IEndpointRouteBuilder MapGetPlayerStats(this IEndpointRouteBuilder app)
    {
        // /api/{game}/players/{playerName}/stats lives under
        // a per-game group so the {game} placeholder is captured once at the boundary.
        var player = app.MapGroup("/{game}/players/{playerName}").WithTags("Players");

        player.MapGet("/stats",
            async (string game, string playerName, IStorageService storage,
                   ScoreIntegrityGuard integrity) =>
            {
                // Resolved through the SAME moderation the PUT below applies, because that is
                // what decides the RowKey. Read the raw route name while the write stores the
                // moderated one and a player whose name is rewritten writes to one key and
                // reads from another — their stats come back empty with nothing to show why.
                // Only normalisation is shared, not the write's identity override: this route
                // is still allowed to name a player, which is the whole point of the parameter.
                var key = integrity.ResolveDisplayName(playerName, playerName);
                var stats = await storage.GetPlayerStatsAsync(game, key);
                if (stats is null)
                {
                    return Results.NotFound(new { message = $"Player '{playerName}' not found in game '{game}'" });
                }

                return Results.Ok(new PlayerStatsDto
                {
                    Name = playerName,
                    Game = game,
                    Stats = stats,
                });
            })
            .WithName("GetPlayerStats")
            .WithSummary("Retrieve stats for a player in a specific game")
            .Produces<PlayerStatsDto>(StatusCodes.Status200OK);

        return app;
    }

    public static IEndpointRouteBuilder MapSavePlayerStats(this IEndpointRouteBuilder app)
    {
        // Companion PUT to the GET above shares the
        // {game}/players/{playerName} prefix group so auth + tag apply once.
        var player = app.MapGroup("/{game}/players/{playerName}").WithTags("Players");

        player.MapPut("/stats",
            async (string game, string playerName, PlayerStats stats, HttpContext http,
                   IStorageService storage, ScoreIntegrityGuard integrity) =>
            {
                // Allow-list: reject unknown game keys instead of silently creating an
                // arbitrary partition. Only the well-known catalogue may carry stats.
                if (GameKey.TryParse(game) is null)
                {
                    return Results.BadRequest(new { error = $"Unknown game key '{game}'" });
                }

                // Server-authoritative identity: a signed-in caller may only write their
                // OWN stats row. The route {playerName} is ignored for authenticated users —
                // the persisted key is the caller's claim identity — so nobody can PUT to
                // /players/{victim}/stats and overwrite another player's leaderboard row.
                var identity = RequestIdentity.Resolve(http.User);
                var claimed = identity.IsAuthenticated && !string.IsNullOrWhiteSpace(identity.DisplayName)
                    ? identity.DisplayName
                    : playerName;

                if (string.IsNullOrWhiteSpace(claimed))
                {
                    return Results.BadRequest("Player name cannot be empty");
                }

                // The win-rate board renders this value as the player's name on a page that is
                // readable without signing in, so it is moderated before it becomes a RowKey.
                // Note the side effect: for a name the sanitiser REWRITES, the row key changes
                // and the old row is orphaned rather than updated. That is confined to names
                // carrying invisible characters or collapsed whitespace — i.e. exactly the
                // abuse case — because normalisation is a no-op on an ordinary name.
                var owner = integrity.ResolveDisplayName(claimed, identity.IsGuest ? "Guest" : "Player");

                if (!IsValidStats(stats))
                {
                    return Results.BadRequest("Stats cannot have negative or out-of-range values");
                }

                await storage.SavePlayerStatsAsync(game, owner, stats);
                return Results.NoContent();
            })
            .RequireAuthorization()
            .RequireRateLimiting("highscores")
            .WithName("SavePlayerStats")
            .WithSummary("Save or update player statistics for a game")
            .Produces(StatusCodes.Status204NoContent)
            .ProducesProblem(StatusCodes.Status401Unauthorized);

        return app;
    }

    private static bool IsValidStats(PlayerStats? stats)
    {
        if (stats is null)
        {
            return false;
        }

        return IsValidDifficultyStats(stats.Easy)
            && IsValidDifficultyStats(stats.Medium)
            && IsValidDifficultyStats(stats.Hard);
    }

    private static bool IsValidDifficultyStats(DifficultyStats? stats)
    {
        if (stats is null)
        {
            return true;
        }

        // EloRating is client-authoritative for adaptive-ELO games (they mirror their
        // evolving skill rating into the bucket), but it must stay within the same range
        // the client itself clamps to (100–3000). A wider ceiling here (4000) leaves
        // headroom while rejecting a tampered int.MaxValue that would own the board.
        return stats.Wins >= 0
            && stats.Losses >= 0
            && stats.Draws >= 0
            && stats.TotalGames >= 0
            && stats.WinStreak >= 0
            && stats.EloRating is >= 0 and <= 4000;
    }
}
