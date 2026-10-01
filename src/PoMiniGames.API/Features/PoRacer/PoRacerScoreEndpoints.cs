using Microsoft.AspNetCore.Mvc;
using PoMiniGames.Domain.Models;
using PoMiniGames.Domain.Primitives;
using PoMiniGames.Features.Auth;
using PoMiniGames.Features.Integrity;
using PoMiniGames.Infrastructure.Services;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoRacer;

/// <summary>Authenticated best-lap submission, stored from the server-timed race; reads use the unified leaderboard.</summary>
public static class PoRacerScoreEndpoints
{
    public static void MapPoRacerScoreEndpoints(this IEndpointRouteBuilder app)
    {
        var scores = app.MapGroup("/poracer/scores");

        scores.MapPost("", async (
            [FromBody] PoRacerScoreDto dto,
            HttpContext http,
            StorageService storage,
            PoRacerRaceRegistry races,
            IScoreIntegrityGuard integrity,
            ILoggerFactory loggerFactory) =>
        {
            var errors = new Dictionary<string, string[]>();
            if (!double.IsFinite(dto.BestLapSeconds) || dto.BestLapSeconds is <= 0 or > 3600)
            {
                errors[nameof(dto.BestLapSeconds)] = ["Best lap must be between 0 and 3600 seconds."];
            }
            if (dto.FinalPosition is < 1 or > 8)
            {
                errors[nameof(dto.FinalPosition)] = ["Final position must be between 1 and 8."];
            }
            if (!PoRacerCatalog.Tracks.Any(t => t.Id == dto.TrackId))
                errors[nameof(dto.TrackId)] = ["Choose a supported track."];
            if (errors.Count > 0)
            {
                return Results.ValidationProblem(errors);
            }

            // Authoritative identity from the auth cookie — NEVER trust the client.
            var (userId, displayName, isGuest, _) = RequestIdentity.Resolve(http.User);

            // The lap, the position and the track that get stored are the ones this server timed
            // in the race the code names. The body only says which race; a code this identity did
            // not finish a lap in (or one older than the registry remembers) is refused, not trusted.
            if (races.VerifiedLap(userId, dto.GameCode) is not { } timed)
            {
                return Results.Problem("No finished race on this server backs that lap.", statusCode: StatusCodes.Status422UnprocessableEntity);
            }

            // A best lap cannot be longer than the play session that produced it.
            var verdict = integrity.Inspect(http, GameKey.PoRacer, timed.BestLapSeconds);
            if (!verdict.Allowed)
            {
                return verdict.ToProblem();
            }

            var log = loggerFactory.CreateLogger("PoRacerScores");
            var trackId = timed.TrackId;
            log.LogInformation("PoRacer score POST user={UserId} guest={Guest} track={Track} t={T}s pos={Pos} claimed={Claimed}s",
                userId, isGuest, trackId, timed.BestLapSeconds, timed.Position, dto.BestLapSeconds);

            PoRacerHighScore saved;
            try
            {
                saved = await storage.SavePoRacerHighScoreAsync(new PoRacerHighScore
                {
                    PlayerName = integrity.ResolveDisplayName(displayName, isGuest ? "Guest" : "Player"),
                    UserId = userId,
                    TrackId = trackId,
                    TotalTimeSeconds = timed.BestLapSeconds,
                    FinalPosition = timed.Position,
                    Date = timed.FinishedAtUtc.ToString("yyyy-MM-ddTHH:mm:ssZ"),
                    IsGuest = isGuest,
                    GameCode = dto.GameCode ?? "",
                });
            }
            catch (IOException)
            {
                return Results.Problem("Best lap could not be stored. Please retry.", statusCode: StatusCodes.Status503ServiceUnavailable);
            }
            return Results.Created("/api/poracer/scores", new PoRacerScoreDto
            {
                PlayerDisplayName = saved.PlayerName,
                UserId = saved.UserId,
                TrackId = saved.TrackId,
                BestLapSeconds = saved.TotalTimeSeconds,
                FinalPosition = saved.FinalPosition,
                AchievedAtUtc = DateTimeOffset.TryParse(saved.Date, out var d) ? d : DateTimeOffset.UtcNow,
                IsGuest = saved.IsGuest,
            });
        });
    }
}
