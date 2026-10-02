using PoMiniGames.Domain.Abstractions;
using PoMiniGames.Domain.Models;
using PoMiniGames.Domain.Primitives;
using PoMiniGames.Features.Auth;
using PoMiniGames.Features.Integrity;
using PoMiniGames.Shared.Games;

// Namespace follows the folder (Features/PoMarbleRace). It previously said
// Features.HighScores, which is a different slice that already exists — so this
// file sat in one vertical slice while claiming membership of another.
namespace PoMiniGames.Features.PoMarbleRace;

/// <summary>Minimal API endpoints for PoMarbleRace high scores (higher score is better).</summary>
public static class MarbleRaceHighScoresEndpoints
{
    public static IEndpointRouteBuilder MapMarbleRaceHighScoresEndpoints(this IEndpointRouteBuilder app)
    {
        // PoMarbleRace high scores share /api/marblerace/highscores.
        var marble = app.MapGroup("/marblerace/highscores").WithTags("HighScores");

        marble.MapGet("",
            async (IStorageService storage, int count = 10) =>
            {
                count = Math.Clamp(count, 1, 50);
                var scores = await storage.GetMarbleRaceHighScoresAsync(count);
                return Results.Ok(scores);
            })
            .WithName("GetMarbleRaceHighScores")
            .WithSummary("Top PoMarbleRace high scores")
            .Produces<IEnumerable<MarbleRaceHighScore>>(StatusCodes.Status200OK);

        marble.MapPost("",
            async (MarbleRaceHighScoreRequest request,
                   HttpContext http,
                   IStorageService storage,
                   ScoreIntegrityGuard integrity,
                   ILoggerFactory loggerFactory) =>
            {
                var log = loggerFactory.CreateLogger("MarbleRaceHighScores");

                // Allow-list the one client-supplied value we accept: a score inside the legal
                // range. MarbleRaceScore is the only way to hold one, so nothing downstream has
                // to re-check it.
                if (!MarbleRaceScore.TryCreate(request.BestScore, out var score))
                {
                    MarbleRaceLog.ScoreRejected(log, request.BestScore, MarbleRaceScore.Min, MarbleRaceScore.Max);
                    return Results.ValidationProblem(new Dictionary<string, string[]>
                    {
                        [nameof(request.BestScore)] =
                            [$"Score must be between {MarbleRaceScore.Min:N0} and {MarbleRaceScore.Max:N0}."],
                    });
                }

                // The stored total is the server's own sum over the run's races, never the
                // claimed one — see MarbleRaceRunVerifier. A run it cannot recompute is refused
                // with 422, which the client treats as final rather than parking it for retry.
                var verified = MarbleRaceRunVerifier.Score(request.MapId, request.Races);
                if (verified is not { } recomputed)
                {
                    MarbleRaceLog.RunUnverifiable(log, request.MapId, request.Races?.Length ?? 0);
                    return Results.Problem("This run could not be verified.", statusCode: StatusCodes.Status422UnprocessableEntity);
                }
                if (recomputed != score.Value) MarbleRaceLog.ClaimMismatch(log, score.Value, recomputed);
                score = MarbleRaceScore.Clamp(recomputed);

                // Plausibility, on top of the checks above: the guard measures how long this
                // player's session has actually been open and rejects a point total that no run of
                // that length could have produced. See ScoreIntegrityGuard.
                var verdict = integrity.Inspect(http, GameKey.PoMarbleRace, score.Value);
                if (!verdict.Allowed)
                {
                    return verdict.ToProblem();
                }

                // Server-authoritative identity: the body carries no name, so a caller cannot post
                // under someone else's.
                var identity = RequestIdentity.Resolve(http.User);
                var fallback = identity.IsAuthenticated ? "Player" : "Guest";
                // Even a claim-derived name is player-chosen — an Entra display name is whatever
                // the account holder typed — so it goes through moderation like any other.
                var name = integrity.ResolveDisplayName(identity.DisplayName, fallback);

                var saved = await storage.SaveMarbleRaceHighScoreAsync(new MarbleRaceHighScore
                {
                    PlayerInitials = name,
                    UserId = identity.UserId,
                    IsGuest = identity.IsGuest,
                    BestScore = score,
                    AchievedAtUtc = DateTimeOffset.UtcNow,
                });

                MarbleRaceLog.ScoreSaved(log, identity.UserId, identity.IsGuest, saved.BestScore);
                return Results.Created("/api/marblerace/highscores", saved);
            })
            .WithName("SaveMarbleRaceHighScore")
            .WithSummary("Submit a new PoMarbleRace high score")
            .Produces<MarbleRaceHighScore>(StatusCodes.Status201Created)
            .ProducesValidationProblem()
            .ProducesProblem(StatusCodes.Status422UnprocessableEntity)
            .RequireRateLimiting("highscores");

        // ── world records: fastest finish per map (track picker) ──
        var records = app.MapGroup("/marblerace/records").WithTags("HighScores");

        records.MapGet("",
            async (IStorageService storage) => Results.Ok(await storage.GetMarbleRaceMapRecordsAsync()))
            .WithName("GetMarbleRaceMapRecords")
            .WithSummary("Fastest finish on each PoMarbleRace map")
            .Produces<IEnumerable<MarbleRaceMapRecord>>(StatusCodes.Status200OK);

        records.MapPost("",
            async (MarbleRaceRecordRequest request, HttpContext http, IStorageService storage, ScoreIntegrityGuard integrity) =>
            {
                // Same physical bound the run check uses: no finish faster than the course allows.
                if (!MarbleRaceRunVerifier.IsPlausibleFinish(request.MapId, request.FinishSeconds))
                {
                    return Results.ValidationProblem(new Dictionary<string, string[]>
                    {
                        [nameof(request.FinishSeconds)] = ["Not a possible finish time for this map."],
                    });
                }
                var identity = RequestIdentity.Resolve(http.User);
                var name = integrity.ResolveDisplayName(identity.DisplayName, identity.IsAuthenticated ? "Player" : "Guest");
                // The board keeps the faster of this and the standing record (ShouldOverwrite).
                var saved = await storage.SaveMarbleRaceMapRecordAsync(new MarbleRaceMapRecord
                {
                    MapId = request.MapId,
                    Seconds = Math.Round(request.FinishSeconds, 2),
                    PlayerName = name,
                    UserId = identity.UserId,
                    IsGuest = identity.IsGuest,
                    AchievedAtUtc = DateTimeOffset.UtcNow,
                });
                return Results.Ok(saved);
            })
            .WithName("SubmitMarbleRaceMapRecord")
            .WithSummary("Offer a finish time as a PoMarbleRace map record")
            .Produces<MarbleRaceMapRecord>(StatusCodes.Status200OK)
            .ProducesValidationProblem()
            .RequireRateLimiting("highscores");

        return app;
    }
}

/// <summary>
/// Source-generated logging for the score path. This slice previously logged nothing, so a save
/// that threw surfaced only as an unattributed 500 — which is how a leaderboard that rejected
/// every single submission stayed unnoticed.
/// </summary>
internal static partial class MarbleRaceLog
{
    [LoggerMessage(Level = LogLevel.Information,
        Message = "MarbleRace score saved user={UserId} guest={IsGuest} score={Score}")]
    public static partial void ScoreSaved(ILogger logger, string userId, bool isGuest, int score);

    [LoggerMessage(Level = LogLevel.Warning,
        Message = "MarbleRace score rejected: {Score} outside [{Min}, {Max}]")]
    public static partial void ScoreRejected(ILogger logger, int score, int min, int max);

    [LoggerMessage(Level = LogLevel.Warning,
        Message = "MarbleRace run unverifiable map={MapId} races={Races}")]
    public static partial void RunUnverifiable(ILogger logger, int mapId, int races);

    [LoggerMessage(Level = LogLevel.Warning,
        Message = "MarbleRace claimed {Claimed} but its races add up to {Recomputed}; storing the recomputed total")]
    public static partial void ClaimMismatch(ILogger logger, int claimed, int recomputed);
}
