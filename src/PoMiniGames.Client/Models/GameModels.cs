namespace PoMiniGamesClient.Models;

public class DifficultyStats
{
    public int Wins { get; set; }
    public int Losses { get; set; }
    public int Draws { get; set; }
    public int TotalGames => Wins + Losses + Draws;
    public int WinStreak { get; set; }
    public double WinRate => TotalGames > 0 ? (double)Wins / TotalGames : 0;
    public int EloRating { get; set; } = 1000;
}

public class PlayerStats
{
    public string PlayerId { get; set; } = "";
    public string PlayerName { get; set; } = "";
    public DifficultyStats Easy { get; set; } = new();
    public DifficultyStats Medium { get; set; } = new();
    public DifficultyStats Hard { get; set; } = new();
    public int TotalWins => Easy.Wins + Medium.Wins + Hard.Wins;
    public int TotalLosses => Easy.Losses + Medium.Losses + Hard.Losses;
    public int TotalDraws => Easy.Draws + Medium.Draws + Hard.Draws;
    public int TotalGames => TotalWins + TotalLosses + TotalDraws;
    public double WinRate => TotalGames > 0 ? (double)TotalWins / TotalGames : 0;
}

public class StatItem
{
    public string Value { get; set; } = "";
    public string Label { get; set; } = "";
}

/// <summary>
/// Single adaptive skill rating for a 1-player game (e.g. Connect Five vs CPU).
/// Replaces the fixed Easy/Medium/Hard buckets: the CPU is matched to the
/// player's current <see cref="Elo"/> each game, so a win raises the rating (and
/// the next CPU is tougher) while a loss lowers it (next CPU is easier). Stored
/// locally per player.
/// </summary>
public class AdaptiveRating
{
    public const int StartingElo = 1200;

    public string PlayerName { get; set; } = "";
    public int Elo { get; set; } = StartingElo;
    public int Peak { get; set; } = StartingElo;
    public int Wins { get; set; }
    public int Losses { get; set; }
    public int Draws { get; set; }
    /// <summary>Current consecutive win streak (reset on loss/draw). Surfaced
    /// in the Profile alongside the Easy/Medium/Hard bucket streaks.</summary>
    public int WinStreak { get; set; }

    public int TotalGames => Wins + Losses + Draws;
    public double WinRate => TotalGames > 0 ? (double)Wins / TotalGames : 0;
}

public class StatusInfo
{
    public string Icon { get; set; } = "";
    public string Text { get; set; } = "";
    public string ClassName { get; set; } = "";
}

public class WinResult
{
    public bool Won { get; set; }
    public List<(int Row, int Col)> Cells { get; set; } = new();
}

public class PlayerStatsDto
{
    public string Name { get; set; } = "";
    public string Game { get; set; } = "";
    public PlayerStats Stats { get; set; } = new();
}

/// <summary>A row read back from the PoMarbleRace board. Read-only — the server owns every field.</summary>
public sealed class MarbleRaceHighScore
{
    public string PlayerInitials { get; set; } = "";
    public string UserId { get; set; } = "";
    public bool IsGuest { get; set; }
    public int BestScore { get; set; }
    public DateTimeOffset AchievedAtUtc { get; set; }
}

/// <summary>
/// A PoMarbleRace submission. Carries the score and nothing else: the player's name, id and
/// timestamp are resolved server-side from the auth cookie, so there is no field here to forge
/// them in, and no unread field an attacker can vary to mint duplicate rows.
/// </summary>
public sealed record MarbleRaceHighScoreRequest(int BestScore);

/// <summary>
/// PoCabinet (T11, 2026-09-17): the lap time the server ratchets on
/// <c>POST /api/pocabinet/scores</c>. Identity fields
/// (<c>PlayerDisplayName</c> / <c>UserId</c> / <c>IsGuest</c>) are resolved
/// server-side from the auth cookie, so the payload is intentionally minimal —
/// no field that an attacker could vary to insert duplicate rows.
/// </summary>
public sealed class PoCabinetHighScore
{
    public string PlayerInitials { get; set; } = "";
    public string UserId { get; set; } = "";
    public bool IsGuest { get; set; }
    public string TrackId { get; set; } = "capitol";
    public double BestLapSeconds { get; set; }
    public int FinalPosition { get; set; }
    public DateTimeOffset AchievedAtUtc { get; set; }
}

/// <param name="Inputs">Solo lap proof: the base64 per-tick control log from
/// <c>PoCabinet.lapProof()</c>, which the server re-simulates to time the lap itself. Null for
/// a multiplayer race — the server's own sim already timed it.</param>
/// <param name="Wet">Solo lap proof: the race ran in rain (lower grip).</param>
public sealed record PoCabinetHighScoreRequest(
    string TrackId,
    double BestLapSeconds,
    int FinalPosition,
    bool IsGuest,
    string GameCode = "",
    string? Inputs = null,
    bool Wet = false);

public class PoBrawlHighScore
{
    public string PlayerInitials { get; set; } = "";
    public double KoTimeSeconds { get; set; }
    public string Character { get; set; } = "";
    public string Date { get; set; } = "";
}

// PoSports scores use PoMiniGames.Domain.Models.PoSportsHighScore directly — the client
// references that assembly, so a hand-kept mirror only bought silent drift: a renamed
// server field still deserialized, just as null.

// PoVoxelStrike board rows likewise use PoMiniGames.Domain.Models.PoVoxelStrikeHighScore
// directly. The submission below is a client mirror of the API slice's wire shape
// (PoVoxelStrikeRunRequest in Features/PoVoxelStrike) — identity and timestamp are
// server-derived, so there is no field here to forge them in.
public sealed record PoVoxelStrikeRunRequest(
    int Score, double SurvivalSeconds, int Kills, int BruteKills, int CrushKills, int VoxelsDestroyed);

public class PoBrawlLadderEntry
{
    public string PlayerName { get; set; } = "";
    public int PresidentsBeaten { get; set; }
    public int Elo { get; set; }
    public string Date { get; set; } = "";
}


/// <summary>
/// One finished CPU-vs-CPU demo match. Carries who fought and who won, and nothing else:
/// the ratings, the deltas, and the fighters' display names are all resolved server-side,
/// so there is no field here to forge a rating in. On a draw the winner/loser split is
/// arbitrary and <see cref="IsDraw"/> decides the scoring.
/// </summary>
public sealed record PoBrawlDemoResultRequest(string WinnerFighterId, string LoserFighterId, bool IsDraw);

/// <summary>
/// Queued PlayerStats PUT for the offline score-sync pipeline: a stats snapshot
/// that failed to reach the server is parked and replayed by ScoreSyncService.
/// </summary>
public class PendingPlayerStats
{
    public string GameKey { get; set; } = "";
    public string PlayerName { get; set; } = "";
    public PlayerStats Stats { get; set; } = new();
}
