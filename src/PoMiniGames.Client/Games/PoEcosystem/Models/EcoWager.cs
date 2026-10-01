using System.Text.Json.Serialization;
using PoMiniGamesClient.Services.Play;

namespace PoMiniGamesClient.Games.PoEcosystem.Models;

/// <summary>
/// The naturalist's wager (2026-09-30): three predictions about an island, made in its first
/// two years and settled by the island's own history. Observation only — a wager changes
/// nothing on the island; it is a guess about what the sim will do by itself.
/// </summary>
/// <remarks>
/// Settled from the timeline's per-year rows (<see cref="EcoHistory.Years"/>), which the
/// snapshot carries, so a wager survives Resume and is judged the same on every machine
/// watching the same seed. The score is this browser's word, kept in localStorage: a world
/// is deterministic per seed, so anyone could watch first and bet after — there is no
/// leaderboard for exactly that reason.
/// </remarks>
public static class EcoWagers
{
    /// <summary>Bets close once the island's year reaches this.</summary>
    public const int ClosesAtYear = 2;

    public sealed record Question(string Id, string Text, int SettlesAtYear, string[] Options, int Points);

    public static readonly Question[] All =
    [
        new("extinct", "Which species dies out first, by year 30?", 30, ["Rabbits", "Deer", "Wolves", "Humans", "None of them"], 3),
        new("alive10", "How many creatures are alive at year 10?", 10, ["Under 100", "100 – 174", "175 – 249", "250 or more"], 2),
        new("tech20", "How far up the ladder is the tribe at year 20?", 20, ["Camp", "Fire", "Palisade", "Farming", "Watchtower"], 2),
    ];

    /// <summary>
    /// The settled answer to a question, or null while the island has not got there yet.
    /// Rows are [year, rabbits, deer, wolves, humans, tech, …].
    /// </summary>
    public static int? Outcome(Question q, int[][] years)
    {
        if (years.Length == 0) return null;
        var last = years[^1][0];
        switch (q.Id)
        {
            case "extinct":
                foreach (var r in years)
                {
                    if (r[0] > q.SettlesAtYear || r.Length < 5) break;
                    for (var s = 0; s < EcoSpeciesInfo.Count; s++) if (r[s + 1] == 0) return s;
                }
                return last >= q.SettlesAtYear ? 4 : null;
            case "alive10":
                {
                    var row = years.FirstOrDefault(r => r[0] == q.SettlesAtYear && r.Length >= 5);
                    if (row is null) return null;
                    var alive = row[1] + row[2] + row[3] + row[4];
                    return alive < 100 ? 0 : alive < 175 ? 1 : alive < 250 ? 2 : 3;
                }
            case "tech20":
                {
                    var row = years.FirstOrDefault(r => r[0] == q.SettlesAtYear && r.Length >= 6);
                    return row is null ? null : Math.Clamp(row[5], 0, 4);
                }
            default: return null;
        }
    }
}

/// <summary>One island's bets: question id → chosen option, and which have been scored already.</summary>
public sealed class EcoWagerSlip
{
    public Dictionary<string, int> Picks { get; set; } = [];
    public List<string> Scored { get; set; } = [];
}

/// <summary>This browser's lifetime record across every island it has bet on.</summary>
public sealed class EcoWagerRecord
{
    public int Points { get; set; }
    public int Right { get; set; }
    public int Settled { get; set; }
}

/// <summary>
/// Holds the slip for the island on screen and the lifetime record (localStorage
/// <c>poeco:wager:{seed}</c> and <c>poeco:wagerRecord</c>).
/// </summary>
public sealed class EcoWagerBook
{
    private const string RecordKey = "poeco:wagerRecord";
    private int _seed;

    public EcoWagerSlip Slip { get; private set; } = new();
    public EcoWagerRecord Record { get; } = Load(RecordKey, EcoWagerJsonContext.Default.EcoWagerRecord) ?? new();

    /// <summary>A world came up: load the slip kept for its seed (an empty one if there is none).</summary>
    public void Open(int seed)
    {
        _seed = seed;
        Slip = Load(SlipKey, EcoWagerJsonContext.Default.EcoWagerSlip) ?? new();
    }

    private string SlipKey => $"poeco:wager:{_seed}";

    public void Pick(string questionId, int option)
    {
        Slip.Picks[questionId] = option;
        Save(SlipKey, Slip, EcoWagerJsonContext.Default.EcoWagerSlip);
    }

    /// <summary>
    /// Score whatever the history has settled since last time. Returns one line per newly
    /// settled bet, for the ticker.
    /// </summary>
    public List<string> Settle(int[][] years)
    {
        var lines = new List<string>();
        foreach (var q in EcoWagers.All)
        {
            if (!Slip.Picks.TryGetValue(q.Id, out var pick) || Slip.Scored.Contains(q.Id)) continue;
            if (EcoWagers.Outcome(q, years) is not { } outcome) continue;
            Slip.Scored.Add(q.Id);
            Record.Settled++;
            var right = pick == outcome;
            if (right) { Record.Right++; Record.Points += q.Points; }
            lines.Add(right
                ? $"Wager won (+{q.Points}): {q.Options[outcome]}"
                : $"Wager lost: it was {q.Options[outcome]}, not {q.Options[Math.Clamp(pick, 0, q.Options.Length - 1)]}");
        }
        if (lines.Count > 0)
        {
            Save(SlipKey, Slip, EcoWagerJsonContext.Default.EcoWagerSlip);
            Save(RecordKey, Record, EcoWagerJsonContext.Default.EcoWagerRecord);
        }
        return lines;
    }

    private static T? Load<T>(string key, System.Text.Json.Serialization.Metadata.JsonTypeInfo<T> info) where T : class
    {
        try { return LocalStorageService.GetItem(key, info); } catch { return null; }
    }

    private static void Save<T>(string key, T value, System.Text.Json.Serialization.Metadata.JsonTypeInfo<T> info)
    {
        try { LocalStorageService.SetItem(key, value, info); } catch { /* storage off: the bet lasts the session */ }
    }
}

[JsonSerializable(typeof(EcoWagerSlip))]
[JsonSerializable(typeof(EcoWagerRecord))]
internal sealed partial class EcoWagerJsonContext : JsonSerializerContext;
