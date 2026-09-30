namespace PoMiniGames.Domain.Models;

/// <summary>
/// The fastest finish ever recorded on one PoMarbleRace map — one row per map, shown as the
/// "world record" on the track picker. Only a faster time replaces it.
/// </summary>
/// <remarks>
/// <see cref="UserId"/>/<see cref="IsGuest"/>/<see cref="PlayerName"/> are resolved server-side
/// from the auth cookie, never from the request body.
/// </remarks>
public sealed record MarbleRaceMapRecord
{
    public int MapId { get; init; }

    /// <summary>Finish time in race-clock seconds (slow motion included, as the game measures it).</summary>
    public double Seconds { get; init; }

    public string PlayerName { get; init; } = string.Empty;

    public string UserId { get; init; } = string.Empty;

    public bool IsGuest { get; init; }

    public DateTimeOffset AchievedAtUtc { get; init; }
}
