namespace PoMiniGames.Domain.Models;

/// <summary>
/// A single PoVoxelStrike best-run entry in Azure Table Storage. Higher score is better;
/// the descriptor keeps ONE ratcheted row per player.
/// </summary>
/// <remarks>
/// <see cref="UserId"/>/<see cref="IsGuest"/> are the row's identity and are always resolved
/// server-side from the auth cookie — never from the request body (same rule as
/// <see cref="MarbleRaceHighScore"/>). The run stats ride along for display; only
/// <see cref="Score"/> ranks.
/// </remarks>
public sealed record PoVoxelStrikeHighScore
{
    /// <summary>Display name shown on the board (server-stamped, max 24 chars).</summary>
    public string PlayerName { get; init; } = string.Empty;

    /// <summary>Stable claims id of the submitter; empty for an anonymous caller.</summary>
    public string UserId { get; init; } = string.Empty;

    /// <summary>True when the submitter had no real signed-in identity.</summary>
    public bool IsGuest { get; init; }

    /// <summary>Run score. See <see cref="PoVoxelStrikeScore"/> for the valid range.</summary>
    public int Score { get; init; }

    /// <summary>How long the run lasted, in seconds.</summary>
    public double SurvivalSeconds { get; init; }

    public int Kills { get; init; }

    public int BruteKills { get; init; }

    /// <summary>Kills scored by dropping debris on enemies rather than direct fire.</summary>
    public int CrushKills { get; init; }

    public int VoxelsDestroyed { get; init; }

    /// <summary>True when the run ended with the chalice taken rather than a death.</summary>
    public bool Won { get; init; }

    /// <summary>When the run happened. Persisted as an ISO-8601 string, matching sibling boards.</summary>
    public DateTimeOffset AchievedAtUtc { get; init; }
}
