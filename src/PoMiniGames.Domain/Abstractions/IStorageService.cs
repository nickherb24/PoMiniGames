using PoMiniGames.Domain.Models;

namespace PoMiniGames.Domain.Abstractions;

/// <summary>
/// Unified storage abstraction for player stats and remaining per-game high score boards.
/// </summary>
public interface IStorageService
{
    // Player Stats
    IAsyncEnumerable<PlayerStatsDto> GetAllPlayerStatsAsync(CancellationToken cancellationToken = default);
    Task<PlayerStats?> GetPlayerStatsAsync(string game, string playerName);
    Task SavePlayerStatsAsync(string game, string playerName, PlayerStats stats);
    Task<List<(string Name, PlayerStats Stats)>> GetLeaderboardAsync(string game, int limit, string? difficulty = null);

    // PoMarbleRace High Scores
    Task<List<MarbleRaceHighScore>> GetMarbleRaceHighScoresAsync(int limit = 10);
    Task<MarbleRaceHighScore> SaveMarbleRaceHighScoreAsync(MarbleRaceHighScore entry);

    // PoBrawl High Scores (fastest KO)
    Task<List<PoBrawlHighScore>> GetPoBrawlHighScoresAsync(int limit = 10);
    Task<PoBrawlHighScore> SavePoBrawlHighScoreAsync(PoBrawlHighScore entry);

    // PoRacer High Scores (lowest race time wins)
    Task<List<PoRacerHighScore>> GetPoRacerHighScoresAsync(int limit = 10, string? trackId = null);
    Task<PoRacerHighScore> SavePoRacerHighScoreAsync(PoRacerHighScore entry);

    // PoBrawl presidents-ladder leaderboard (one row per player, best-ever progress)
    Task<List<PoBrawlLadderEntry>> GetPoBrawlLadderAsync(int limit = 10);
    Task<PoBrawlLadderEntry> SavePoBrawlLadderAsync(PoBrawlLadderEntry entry);

    // PoBrawl demo-mode fighter Elo (one row per fighter, head-to-head ratings)
    Task<List<PoBrawlFighterRating>> GetPoBrawlFighterRatingsAsync(int limit = 10);

    /// <summary>
    /// Records one CPU-vs-CPU demo match and moves both fighters' ratings. The server owns the
    /// Elo arithmetic — callers submit only who fought and who won.
    /// </summary>
    /// <param name="winnerFighterId">Winning fighter, or either side when <paramref name="isDraw"/>.</param>
    /// <param name="loserFighterId">Losing fighter, or the other side when <paramref name="isDraw"/>.</param>
    Task RecordPoBrawlDemoResultAsync(
        string winnerFighterId, string loserFighterId, bool isDraw);

    // ── PoBrawl online player Elo (one row per principal, head-to-head over SignalR) ──
    //
    // Deliberately separate from the demo fighter board — see PoBrawlPlayerRating's
    // remarks. The two share PairwiseEloCalculator for arithmetic but have nothing
    // else in common: different row key (principal vs fighter id), different display
    // name source, different sample population, different floor/seed policy.

    /// <summary>Top-ranked online players by head-to-head Elo.</summary>
    Task<List<PoBrawlPlayerRating>> GetPoBrawlPlayerRatingsAsync(int limit = 10);

    /// <summary>
    /// Records one online 1v1 match and moves both players' ratings. The Elo arithmetic
    /// runs through the same <see cref="Services.PairwiseEloCalculator"/> the demo board
    /// uses, so the two rating systems cannot drift in their definition of "win".
    /// </summary>
    /// <param name="winnerPrincipalId">Principal id of the winner; either side when <paramref name="isDraw"/>.</param>
    /// <param name="loserPrincipalId">Principal id of the loser; the other side when <paramref name="isDraw"/>.</param>
    /// <param name="winnerDisplayName">Display name for the winner's row (claim identity at submit time).</param>
    /// <param name="loserDisplayName">Display name for the loser's row.</param>
    Task RecordPoBrawlOnlineMatchAsync(
        string winnerPrincipalId, string loserPrincipalId,
        string winnerDisplayName, string loserDisplayName,
        bool isDraw);

    /// <summary>
    /// Computes or retrieves a player's dynamic online player card containing
    /// overall MMR, tier progression, win-rate, signature game, and recent form.
    /// </summary>
    Task<PlayerCardDto> GetPlayerCardAsync(
        string owner, string? displayName = null, bool isGuest = true, CancellationToken ct = default) =>
        Task.FromResult(new PlayerCardDto
        {
            DisplayName = displayName ?? owner,
            UserId = isGuest ? "" : owner,
            AccountKind = isGuest ? "guest" : "microsoft",
            Initials = string.IsNullOrWhiteSpace(displayName ?? owner) ? "P" : (displayName ?? owner).Substring(0, Math.Min(2, (displayName ?? owner).Length)).ToUpperInvariant()
        });

    /// <summary>Top-ranked online multiplayer players by global competitive MMR.</summary>
    Task<List<PlayerCardDto>> GetOnlineMmrLeaderboardAsync(int limit = 10, CancellationToken ct = default) =>
        Task.FromResult(new List<PlayerCardDto>());

    /// <summary>
    /// Bounded probe of the Table Storage backend. Returns <c>true</c> when the last attempt
    /// succeeded; <c>false</c> when storage is unreachable so the caller can render a
    /// "scores unavailable" state instead of letting an empty-list read mask the outage.
    /// </summary>
    bool IsStorageHealthy();

    // PoSports High Scores (lowest combined meet time wins, one row per player)
    Task<List<PoSportsHighScore>> GetPoSportsHighScoresAsync(int limit = 10);
    Task<PoSportsHighScore> SavePoSportsHighScoreAsync(PoSportsHighScore entry);

    // PoVoxelStrike High Scores (highest run score wins, one ratcheted row per player)
    Task<List<PoVoxelStrikeHighScore>> GetPoVoxelStrikeHighScoresAsync(int limit = 10);
    Task<PoVoxelStrikeHighScore> SavePoVoxelStrikeHighScoreAsync(PoVoxelStrikeHighScore entry);

    // PoCabinet High Scores (lowest best-lap wins, partitioned by TrackId)
    Task<List<PoCabinetHighScore>> GetPoCabinetHighScoresAsync(int limit = 10, string? trackId = null);
    Task<PoCabinetHighScore> SavePoCabinetHighScoreAsync(PoCabinetHighScore entry);
}
