namespace PoMiniGames.Domain.Models;

/// <summary>
/// A single PoMarbleRace high-score entry in Azure Table Storage. Higher score is better.
/// </summary>
/// <remarks>
/// <para>
/// <see cref="UserId"/>/<see cref="IsGuest"/> are the row's identity and are always resolved
/// server-side from the auth cookie — never from the request body. Without them a row was
/// identified by display name alone, so an anonymous caller could post under any signed-in
/// player's name and land on the board as them.
/// </para>
/// <para>
/// The former <c>GameDuration</c> field is gone: no code ever read it, the client always sent 0,
/// and because it was hashed into the RowKey an attacker could vary it to mint unlimited rows for
/// the same score. Legacy rows may still carry the column; it is simply not read back.
/// </para>
/// </remarks>
public sealed record MarbleRaceHighScore
{
    /// <summary>Display name shown on the board. Legacy rows hold 3-letter initials.</summary>
    public string PlayerInitials { get; init; } = string.Empty;

    /// <summary>Stable claims id of the submitter; empty for an anonymous caller.</summary>
    public string UserId { get; init; } = string.Empty;

    /// <summary>True when the submitter had no real signed-in identity.</summary>
    public bool IsGuest { get; init; }

    /// <summary>Best run total (consecutive top-10 finishes). See <see cref="MarbleRaceScore"/> for the valid range.</summary>
    public int BestScore { get; init; }

    /// <summary>When the run happened. Persisted as an ISO-8601 string for compatibility with legacy rows.</summary>
    public DateTimeOffset AchievedAtUtc { get; init; }
}
