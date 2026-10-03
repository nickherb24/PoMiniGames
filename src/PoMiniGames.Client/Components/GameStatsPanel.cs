using PoMiniGamesClient.Models;

namespace PoMiniGamesClient.Components;

/// <summary>
/// Builds the standard per-game stats panel (W / L / [D] / Str / Rate / ELO) from a difficulty
/// bucket, with optional leading game-specific items (e.g. Score, Best). One builder replaces the
/// StatItem list that was copy-pasted into every game's UpdateStats.
/// </summary>
/// <remarks>
/// Pattern: the first piece of a shared game shell. The panel shape — the part every game repeated
/// verbatim — now lives once; a game contributes only its own leading stats. Locality: a change to
/// the panel is one edit, not ten.
/// </remarks>
public static class GameStatsPanel
{
    public static List<StatItem> Build(
        DifficultyStats bucket,
        bool includeDraws = true,
        bool includeElo = true,
        params (string Label, string Value)[] leading)
    {
        var items = new List<StatItem>();

        foreach (var (label, value) in leading)
        {
            items.Add(new StatItem { Label = label, Value = value });
        }

        items.Add(new StatItem { Label = "W", Value = bucket.Wins.ToString() });
        items.Add(new StatItem { Label = "L", Value = bucket.Losses.ToString() });
        if (includeDraws)
        {
            items.Add(new StatItem { Label = "D", Value = bucket.Draws.ToString() });
        }
        items.Add(new StatItem { Label = "Str", Value = bucket.WinStreak.ToString() });
        items.Add(new StatItem { Label = "Rate", Value = $"{bucket.WinRate * 100:F0}%" });
        // Games that surface their own adaptive/ladder ELO as a leading stat
        // (PoBrawl 1P) opt out of the bucket ELO to avoid two "ELO" cells.
        if (includeElo)
        {
            items.Add(new StatItem { Label = "ELO", Value = bucket.EloRating.ToString() });
        }

        return items;
    }

    /// <summary>
    /// The panel for the two adaptive-ELO board games (Tic-Tac-Toe, Connect Five): the
    /// player's rating beside the CPU it is currently matched against, then the record.
    /// </summary>
    public static List<StatItem> Build(AdaptiveRating rating, int cpuElo) =>
    [
        new StatItem { Label = "ELO", Value = rating.Elo.ToString() },
        new StatItem { Label = "CPU", Value = cpuElo.ToString() },
        new StatItem { Label = "W", Value = rating.Wins.ToString() },
        new StatItem { Label = "L", Value = rating.Losses.ToString() },
        new StatItem { Label = "D", Value = rating.Draws.ToString() },
        new StatItem { Label = "Rate", Value = $"{rating.WinRate * 100:F0}%" },
    ];
}
