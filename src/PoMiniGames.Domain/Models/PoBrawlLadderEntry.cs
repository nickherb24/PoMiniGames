namespace PoMiniGames.Domain.Models;

/// <summary>
/// One player's best run up the PoBrawl presidents ladder (1-player mode).
/// One row per player; <see cref="PresidentsBeaten"/> is the best-ever count
/// (0 to PoBrawlRoster.Count, 15 today) and never goes down. More presidents beaten ranks higher.
/// </summary>
public sealed record PoBrawlLadderEntry
{
    public string PlayerName { get; init; } = string.Empty;
    public int PresidentsBeaten { get; init; }
    public int Elo { get; init; }
    public string Date { get; init; } = string.Empty;
}
