using PoMiniGames.Domain.Abstractions;
using PoMiniGames.Domain.Models;
using PoMiniGames.Domain.Primitives;
using PoMiniGames.Features.Auth;
using PoMiniGames.Features.Integrity;

namespace PoMiniGames.Features.PoSports;

/// <summary>
/// Minimal API endpoints for PoSports meet times (lower combined time is better).
/// Identity is stamped server-side from the auth cookie like PoRacer — the
/// client-supplied UserId/IsGuest are never trusted.
/// <para>
/// The stored times are the server's: a submit carries the run's key log and
/// <see cref="PoSportsRunVerifier"/> replays it, so the posted times are only a claim that
/// is compared and logged. A submit with no usable log gets 422, like PoCabinet's laps.
/// </para>
/// </summary>
public static class PoSportsHighScoresEndpoints
{
    public static IEndpointRouteBuilder MapPoSportsHighScoresEndpoints(this IEndpointRouteBuilder app)
    {
        // PoSports high scores share /api/posports/highscores.
        var sports = app.MapGroup("/posports/highscores").WithTags("HighScores");

        sports.MapGet("",
            async (IStorageService storage, int count = 10) =>
            {
                var scores = await storage.GetPoSportsHighScoresAsync(count);
                return Results.Ok(scores);
            })
            .WithName("GetPoSportsHighScores")
            .WithSummary("Top PoSports meet times (sprint + hurdles combined, ascending)")
            .Produces<IEnumerable<PoSportsHighScore>>(StatusCodes.Status200OK);

        sports.MapGet("/daily",
            async (IStorageService storage, int count = 10) =>
                Results.Ok(await storage.GetPoSportsHighScoresAsync(count, PoSportsRunVerifier.DayKey(DateTimeOffset.UtcNow))))
            .WithName("GetPoSportsDailyHighScores")
            .WithSummary("Today's daily-meet board (UTC day)")
            .Produces<IEnumerable<PoSportsHighScore>>(StatusCodes.Status200OK);

        sports.MapPost("",
            async (PoSportsHighScore entry, HttpContext http, IStorageService storage,
                   ScoreIntegrityGuard integrity, ILoggerFactory loggers) =>
            {
                if (string.IsNullOrWhiteSpace(entry.PlayerName))
                    return Results.BadRequest(new { error = "Player name is required" });

                if (entry.PlayerName.Trim().Length > 24)
                    return Results.BadRequest(new { error = "Player name must be 24 characters or fewer" });

                if (entry.TotalTimeSeconds is <= 0 or >= 600)
                    return Results.BadRequest(new { error = "Meet time must be between 0 and 600 seconds" });

                if (entry.SprintSeconds is <= 0 or >= 300 || entry.HurdlesSeconds is <= 0 or >= 300)
                    return Results.BadRequest(new { error = "Leg times must be between 0 and 300 seconds" });

                // The total is derived data — reject a payload whose legs don't sum to it.
                if (Math.Abs(entry.SprintSeconds + entry.HurdlesSeconds - entry.TotalTimeSeconds) > 0.05)
                    return Results.BadRequest(new { error = "Leg times must sum to the total" });

                if (!PoSportsConstants.Characters.Contains(entry.Character))
                    return Results.BadRequest(new { error = "Unknown character" });

                // The times that count are the ones the server's own sim produces from the
                // keys. Everything above still runs first so a malformed payload is a 400
                // with its own message rather than a replay failure.
                var run = PoSportsRunVerifier.Replay(entry.Inputs);
                if (run is null)
                {
                    return Results.UnprocessableEntity(new { error = "The run could not be verified from its key log" });
                }
                if (Math.Abs(run.TotalSeconds - entry.TotalTimeSeconds) > 0.1)
                {
                    loggers.CreateLogger("PoSports.RunVerifier").LogWarning(
                        "PoSports run claimed {Claimed:0.00}s but replays to {Replayed:0.00}s; storing the replay",
                        entry.TotalTimeSeconds, run.TotalSeconds);
                }
                entry.SprintSeconds = Math.Round(run.SprintSeconds, 2);
                entry.HurdlesSeconds = Math.Round(run.HurdlesSeconds, 2);
                entry.TotalTimeSeconds = Math.Round(run.TotalSeconds, 2);

                // The meet time IS the ranked value, so the guard's check is exact: a meet
                // cannot have taken longer than the session that produced it has existed.
                var verdict = integrity.Inspect(http, GameKey.PoSports, entry.TotalTimeSeconds);
                if (!verdict.Allowed)
                {
                    return verdict.ToProblem();
                }

                // Authoritative identity from the auth cookie — never trust the client.
                var identity = RequestIdentity.Resolve(http.User);
                entry.UserId = identity.UserId;
                entry.IsGuest = identity.IsGuest;
                // PlayerName is the one field here that is still client-chosen and ends up on a
                // page anyone can read without signing in, so it is moderated before storage.
                // The length cap above stays: it rejects early with a clearer message, and the
                // sanitiser's truncation is a silent fallback rather than a contract.
                entry.PlayerName = integrity.ResolveDisplayName(
                    entry.PlayerName,
                    identity.IsGuest ? "Guest" : "Player");

                var saved = await storage.SavePoSportsHighScoreAsync(entry);
                // The day's seeded meet is filed on that day's board as well. Best effort:
                // the all-time row above is the one the client's retry queue is protecting.
                if (entry.Daily)
                {
                    await storage.SavePoSportsHighScoreAsync(entry, PoSportsRunVerifier.DayKey(DateTimeOffset.UtcNow));
                }
                return Results.Created("/api/posports/highscores", saved);
            })
            .WithName("SavePoSportsHighScore")
            .WithSummary("Submit a PoSports meet result")
            .Produces<PoSportsHighScore>(StatusCodes.Status201Created)
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .RequireRateLimiting("highscores");

        return app;
    }
}
