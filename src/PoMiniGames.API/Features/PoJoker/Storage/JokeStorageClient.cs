using Azure;
using Azure.Data.Tables;
using PoMiniGames.Shared.Games.PoJoker;

namespace PoMiniGames.Features.PoJoker.Storage;

/// <summary>
/// Joke performance persistence on Azure Table Storage. Injects the shared
/// <see cref="TableServiceClient"/> registered by <c>AddPoMiniGamesStorage</c> and resolves the
/// <see cref="TableName"/> table — same pattern as PoFunQuiz's LeaderboardRepository.
/// </summary>
public sealed class JokeStorageClient
{
    /// <summary>Table name. Ensured eagerly by <c>StorageInitializer</c>.</summary>
    public const string TableName = "PoJokerPerformances";

    private readonly TableClient _tableClient;
    private readonly ILogger<JokeStorageClient> _logger;

    public JokeStorageClient(TableServiceClient tableServiceClient, ILogger<JokeStorageClient> logger)
    {
        _tableClient = tableServiceClient.GetTableClient(TableName);
        _logger = logger;
    }

    public async Task SavePerformanceAsync(JokePerformanceDto performance, CancellationToken cancellationToken = default)
    {
        // Performances are append-only so an AddEntity is the correct semantic,
        // but a duplicate Id (retry-after-OK) would 409 and surface to the caller. Wrap
        // in a tolerant insert-or-noop so the demo orchestrator can safely re-publish.
        var entity = MapToEntity(performance);
        try
        {
            await _tableClient.AddEntityAsync(entity, cancellationToken);
            _logger.LogDebug("Saved performance {PerformanceId} for session {SessionId}", performance.Id, performance.SessionId);
        }
        catch (RequestFailedException ex) when (ex.Status == 409)
        {
            // Already exists — idempotent retry path.
            _logger.LogDebug("Performance {PerformanceId} already persisted; treating duplicate submit as success.", performance.Id);
        }
        // Graceful degradation: an unreachable Table Storage backend (Azurite down, missing
        // connection string) must NOT 500 the demo orchestrator. Drop the write silently —
        // matches StorageService.MarkUnavailable's policy on the high-score boards. The
        // catch-Range for RequestFailedException is intentionally broader than the 409 above
        // so a transport-level RequestFailedException (timeout, connection refused) is
        // swallowed here and the demo keeps running.
        catch (RequestFailedException ex)
        {
            _logger.LogWarning(ex, "Failed to save performance {PerformanceId}; storage is unreachable, dropping the write silently.", performance.Id);
        }
    }

    public async Task<IReadOnlyList<JokePerformanceDto>> GetSessionPerformancesAsync(
        string sessionId,
        CancellationToken cancellationToken = default)
    {
        var performances = new List<JokePerformanceDto>();
        try
        {
            await foreach (var entity in _tableClient.QueryAsync<JokePerformanceEntity>(
                filter: $"PartitionKey eq '{sessionId.Replace("'", "''")}'",
                cancellationToken: cancellationToken))
            {
                performances.Add(MapToDto(entity));
            }
        }
        // Broadened from RequestFailedException to include TaskCanceledException (raised by
        // the configured 2s network timeout) and any other transport-level failure so a
        // storage outage never 500s the API.
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to get performances for session {SessionId}; returning an empty result.", sessionId);
            return [];
        }
        return performances;
    }

    /// <summary>
    /// The best-rated jokes across every session, one row per joke id, highest score first.
    /// Feeds the unified <c>/api/leaderboards/pojoker</c> board — see <see cref="TopJokeDto"/>
    /// for what "best" means and why it is not the stored rating average.
    /// </summary>
    public async Task<IReadOnlyList<TopJokeDto>> GetTopJokesAsync(
        int top = 10,
        CancellationToken cancellationToken = default)
    {
        // Same unpartitioned scan caveat as GetLeaderboardAsync above — and the same follow-up
        // applies if this table grows: pre-roll a per-joke aggregate row rather than re-reducing
        // all of history on every board request.
        //
        // This method owns ONLY the I/O. Every ranking decision lives in TopJokeRanking.Rank,
        // which is pure and hermetically unit-tested — the scoring, the eligibility rules and the
        // dedup are the parts that can be quietly wrong, and they should not need Azurite to
        // verify. (The Integration tier is also at its 50-method ceiling, so a storage-backed
        // test for this had nowhere to go.)
        var rows = new List<JokePerformanceEntity>();
        try
        {
            await foreach (var entity in _tableClient.QueryAsync<JokePerformanceEntity>(
                maxPerPage: 1000, cancellationToken: cancellationToken))
            {
                rows.Add(entity);
            }
        }
        // Broadened from RequestFailedException to also catch TaskCanceledException (raised
        // by the configured 2s network timeout) and any other transport-level failure so a
        // storage outage never 500s the API.
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to get top jokes from table storage; returning an empty board.");
            return [];
        }

        return TopJokeRanking.Rank(rows, top);
    }

    private static string GenerateRowKey(DateTimeOffset timestamp, Guid performanceId)
    {
        var invertedTicks = DateTimeOffset.MaxValue.Ticks - timestamp.Ticks;
        return $"{invertedTicks:D19}_{performanceId:N}";
    }

    private static JokePerformanceEntity MapToEntity(JokePerformanceDto dto) => new()
    {
        PartitionKey = dto.SessionId,
        RowKey = GenerateRowKey(dto.CompletedAt, dto.Id),
        PerformanceId = dto.Id.ToString(),
        SessionId = dto.SessionId,
        SequenceNumber = dto.SequenceNumber,
        JokeId = dto.Joke.Id,
        JokeCategory = dto.Joke.Category,
        JokeType = dto.Joke.Type,
        JokeSetup = dto.Joke.Setup,
        JokePunchline = dto.Joke.Punchline,
        JokeText = dto.Joke.Joke,
        SafeMode = dto.Joke.SafeMode,
        AiPunchline = dto.Analysis.AiPunchline,
        Confidence = dto.Analysis.Confidence,
        IsTriumph = dto.Analysis.IsTriumph,
        SimilarityScore = dto.Analysis.SimilarityScore,
        AiLatencyMs = dto.Analysis.LatencyMs,
        StartedAt = dto.StartedAt,
        CompletedAt = dto.CompletedAt,
        DurationMs = dto.DurationMs,
        FlagNsfw = dto.Joke.Flags.Nsfw,
        FlagReligious = dto.Joke.Flags.Religious,
        FlagPolitical = dto.Joke.Flags.Political,
        FlagRacist = dto.Joke.Flags.Racist,
        FlagSexist = dto.Joke.Flags.Sexist,
        FlagExplicit = dto.Joke.Flags.Explicit,
        RatingCleverness = dto.Analysis.Rating?.Cleverness ?? 0,
        RatingRudeness = dto.Analysis.Rating?.Rudeness ?? 0,
        RatingComplexity = dto.Analysis.Rating?.Complexity ?? 0,
        RatingDifficulty = dto.Analysis.Rating?.Difficulty ?? 0,
        RatingAverage = dto.Analysis.Rating?.Average ?? 0.0,
        RatingCommentary = dto.Analysis.Rating?.Commentary ?? string.Empty
    };

    private static JokePerformanceDto MapToDto(JokePerformanceEntity entity)
    {
        var joke = new JokeDto
        {
            Id = entity.JokeId,
            Category = entity.JokeCategory,
            Type = entity.JokeType,
            Setup = entity.JokeSetup,
            Punchline = entity.JokePunchline,
            Joke = entity.JokeText,
            SafeMode = entity.SafeMode,
            Flags = new JokeFlags
            {
                Nsfw = entity.FlagNsfw,
                Religious = entity.FlagReligious,
                Political = entity.FlagPolitical,
                Racist = entity.FlagRacist,
                Sexist = entity.FlagSexist,
                Explicit = entity.FlagExplicit
            }
        };

        JokeRatingDto? rating = null;
        if (entity.RatingCleverness > 0 || entity.RatingRudeness > 0 || entity.RatingComplexity > 0 || entity.RatingDifficulty > 0)
        {
            rating = new JokeRatingDto
            {
                Cleverness = entity.RatingCleverness,
                Rudeness = entity.RatingRudeness,
                Complexity = entity.RatingComplexity,
                Difficulty = entity.RatingDifficulty,
                Commentary = entity.RatingCommentary
            };
        }

        var analysis = new JokeAnalysisDto
        {
            Id = Guid.TryParse(entity.PerformanceId, out var id) ? id : Guid.NewGuid(),
            OriginalJoke = joke,
            AiPunchline = entity.AiPunchline,
            Confidence = entity.Confidence,
            IsTriumph = entity.IsTriumph,
            SimilarityScore = entity.SimilarityScore,
            LatencyMs = entity.AiLatencyMs,
            AnalyzedAt = entity.CompletedAt,
            Rating = rating
        };

        return new JokePerformanceDto
        {
            Id = Guid.TryParse(entity.PerformanceId, out var perfId) ? perfId : Guid.NewGuid(),
            SessionId = entity.SessionId,
            Joke = joke,
            Analysis = analysis,
            SequenceNumber = entity.SequenceNumber,
            StartedAt = entity.StartedAt,
            CompletedAt = entity.CompletedAt,
            State = PerformanceState.Transitioning
        };
    }
}
