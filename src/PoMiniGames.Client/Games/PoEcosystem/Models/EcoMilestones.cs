using System.Text.Json.Serialization;
using PoMiniGamesClient.Services.Play;

namespace PoMiniGamesClient.Games.PoEcosystem.Models;

/// <summary>
/// Field notes: milestones for having <i>witnessed</i> something on
/// the island. PoEcosystem is observed, never steered, so every note is about the world's own
/// history — a dynasty five generations deep, a species that came back from the brink — and
/// none can be earned by doing anything to it. Kept per browser, across every island watched.
/// </summary>
public static class EcoMilestones
{
    public sealed record Milestone(string Id, string Icon, string Title, string What);

    public static readonly Milestone[] All =
    [
        new("fire", "🔥", "Keeper of the flame", "The tribe learned to keep a fire burning."),
        new("palisade", "🪵", "Walls of the village", "The tribe raised a palisade."),
        new("farming", "🫐", "First harvest", "The tribe planted berry fields."),
        new("watchtower", "🗼", "A view from above", "The tribe built a watchtower."),
        new("gen5", "🌳", "Five generations", "A family line reached its fifth generation."),
        new("gen10", "🧬", "Ten generations", "A family line reached its tenth generation."),
        new("elder", "🦉", "A long life", "A creature lived past twenty years."),
        new("boom", "📈", "Carrying capacity", "Three hundred creatures alive at once."),
        new("year50", "⏳", "Half a century", "Watched an island reach year 50."),
        new("year100", "🏛️", "A century of life", "Watched an island reach year 100."),
        new("storm", "⛈️", "Weathered the storm", "Saw a storm roll over the island."),
        new("drought", "🌵", "The dry years", "Saw a drought settle over the island."),
        new("outbreak", "🦠", "Contagion", "Saw a sickness spread through a crowded species."),
        new("variety", "🔬", "A new variety", "Saw a species' personality drift far enough to earn a name."),
        new("eruption", "🌋", "Fire from the mountain", "Saw the volcano erupt."),
        new("extinction", "🕯️", "The last of their kind", "Saw a species go extinct."),
        new("rebound", "🌱", "Back from the brink", "Saw a species fall to three or fewer and recover to twenty."),
        new("balance", "⚖️", "Balance of nature", "All four species thriving in near-perfect evenness (J ≥ 0.9) after year 10."),
        new("war", "⚔️", "Borders in flame", "Saw two clans go to war."),
        new("treaty", "📜", "The council speaks", "Saw the Chieftain Council seal a pact."),
        new("chronicle", "📖", "Chronicler", "Had a decade of history written into a saga."),
        new("watcher", "👁️", "Field researcher", "Kept five creatures on the watch-list at once."),
    ];

    public static Milestone? Find(string id) => All.FirstOrDefault(m => m.Id == id);
}

/// <summary>
/// Watches stats and events for field notes and remembers which are unlocked (localStorage
/// <c>poeco:milestones</c>, id → ISO date). Pure bookkeeping over what the page already
/// receives: nothing is sent to the sim.
/// </summary>
public sealed class EcoMilestoneTracker
{
    private const string StorageKey = "poeco:milestones";
    private readonly Dictionary<string, string> _unlocked;
    // Per-island memory for the "back from the brink" note: which species have been low.
    private readonly bool[] _wasLow = new bool[EcoSpeciesInfo.Count];

    public EcoMilestoneTracker()
    {
        _unlocked = LocalStorageService.GetItem(StorageKey, EcoMilestoneJsonContext.Default.DictionaryStringString) ?? [];
    }

    public IReadOnlyDictionary<string, string> Unlocked => _unlocked;

    /// <summary>A new island: forget per-world memory (the unlocked notes stay).</summary>
    public void ResetWorld() => Array.Clear(_wasLow);

    /// <summary>Returns the notes this stats message unlocked (usually none).</summary>
    public List<EcoMilestones.Milestone> Observe(EcoStats s)
    {
        var fresh = new List<EcoMilestones.Milestone>();
        var tech = s.Tech?.Level ?? 0;
        Check(fresh, "fire", tech >= 1);
        Check(fresh, "palisade", tech >= 2);
        Check(fresh, "farming", tech >= 3);
        Check(fresh, "watchtower", tech >= 4);
        Check(fresh, "gen5", s.MaxGeneration >= 5);
        Check(fresh, "gen10", s.MaxGeneration >= 10);
        Check(fresh, "elder", (s.Almanac?.OldestAge ?? 0) >= 20);
        Check(fresh, "boom", s.Alive >= 300);
        Check(fresh, "year50", s.Year >= 50);
        Check(fresh, "year100", s.Year >= 100);
        Check(fresh, "storm", s.Weather?.Kind == 2 && s.Weather.Intensity > 0.3);
        Check(fresh, "drought", s.Weather?.Kind == 3 && s.Weather.Intensity > 0.3);
        Check(fresh, "eruption", (s.NaturalEvents?.Eruption ?? 0) > 0);
        Check(fresh, "variety", s.Varieties is { Length: > 0 });
        Check(fresh, "treaty", s.Treaties is { Length: > 0 });
        Check(fresh, "watcher", s.Watched is { Length: >= 5 } w && w.Count(x => x.Alive) >= 5);
        Check(fresh, "balance", s.Year >= 10 && s.Biodiversity is { Richness: 4, Evenness: >= 0.9 });
        if (s.Counts is { Length: EcoSpeciesInfo.Count } c)
        {
            for (var k = 0; k < c.Length; k++)
            {
                if (c[k] is > 0 and <= 3) _wasLow[k] = true;
                else if (_wasLow[k] && c[k] >= 20) Check(fresh, "rebound", true);
            }
        }
        return fresh;
    }

    /// <summary>Event-driven notes (the log carries these; stats do not).</summary>
    public List<EcoMilestones.Milestone> Observe(IReadOnlyList<EcoEvent> events)
    {
        var fresh = new List<EcoMilestones.Milestone>();
        foreach (var ev in events)
        {
            Check(fresh, "outbreak", ev.Kind == "outbreak");
            Check(fresh, "extinction", ev.Kind == "extinction");
            Check(fresh, "war", ev.Kind == "diplomacy" && ev.Action == "war");
            Check(fresh, "treaty", ev.Kind == "treaty");
        }
        return fresh;
    }

    public EcoMilestones.Milestone? Grant(string id)
    {
        var fresh = new List<EcoMilestones.Milestone>();
        Check(fresh, id, true);
        return fresh.FirstOrDefault();
    }

    private void Check(List<EcoMilestones.Milestone> fresh, string id, bool condition)
    {
        if (!condition || _unlocked.ContainsKey(id) || EcoMilestones.Find(id) is not { } m) return;
        _unlocked[id] = DateTimeOffset.UtcNow.ToString("yyyy-MM-dd");
        LocalStorageService.SetItem(StorageKey, _unlocked, EcoMilestoneJsonContext.Default.DictionaryStringString);
        fresh.Add(m);
    }
}

[JsonSerializable(typeof(Dictionary<string, string>))]
internal sealed partial class EcoMilestoneJsonContext : JsonSerializerContext;
