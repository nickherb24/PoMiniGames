using System.Text.Json.Serialization;
using PoMiniGames.Shared.Games.PoEcosystem;

namespace PoMiniGamesClient.Games.PoEcosystem.Models;

// Flat records only — these cross the JS interop boundary through the source-generated
// serializer below, so the WASM trim analyzer sees no reflection (§1.7 trimming rules).

/// <summary>One species column in the HUD and the dashboard chart.</summary>
public enum EcoSpecies { Rabbit = 0, Deer = 1, Wolf = 2, Human = 3 }

/// <summary>
/// The species vocabulary the UI needs: the plural the sim uses in its log, and the token
/// each species is drawn with. One table, so adding a species is one edit rather than five.
/// </summary>
public static class EcoSpeciesInfo
{
    public const int Count = 4;

    public static readonly string[] Plural = ["Rabbits", "Deer", "Wolves", "Humans"];

    // Read through tokens (poecosystem.css), so the colour-blind palette in Settings can
    // re-point all four without touching a component.
    public static readonly string[] Colour =
    [
        "var(--poeco-species-0)", "var(--poeco-species-1)", "var(--poeco-species-2)", "var(--poeco-species-3)",
    ];

    /// <summary>The five heritable traits, in the sim's index order (sim/core/config.js TRAITS).</summary>
    public static readonly string[] Traits = ["boldness", "sociability", "curiosity", "greed", "diligence"];

    public static string PluralOf(int species) => Plural[Math.Clamp(species, 0, Count - 1)];
    public static string ColourOf(int species) => Colour[Math.Clamp(species, 0, Count - 1)];
}

/// <summary>World counters pushed twice a second by the sim worker.</summary>
public sealed record EcoStats(
    int Tick,
    int Speed,
    int Year,
    int Day,
    double DayFraction,
    int Alive,
    int Huts,
    int[] Counts,
    bool[] Extinct,
    int LastStanding,
    bool Silent,
    int Carcasses,
    double SimLag,
    bool LlmEnabled,
    EcoLlmCounters Llm,
    int[] PopHistory,
    EcoNaturalEvents NaturalEvents,
    EcoAlmanac? Almanac = null,
    // Per-species trait means over time, flattened [sample * 20 + species * 5 + trait];
    // -1 marks an extinct species in that sample (the evolution chart skips it).
    double[]? TraitHistory = null,
    EcoTech? Tech = null,
    EcoWatched[]? Watched = null,
    int LineageCount = 0,
    TribeStateDto[]? Tribes = null,
    BuildingStateDto[]? Buildings = null,
    TradeCaravanDto[]? Caravans = null,
    int Season = 0,
    double SeasonProgress = 0.0,
    EcoWeather? Weather = null,
    int[]? Sick = null,
    EcoVariety[]? Varieties = null,
    int MaxGeneration = 0,
    EcoBiodiversity? Biodiversity = null,
    EcoTreaty[]? Treaties = null);

/// <summary>The island's weather (sim/events/weather.js). Kind: 0 clear · 1 rain · 2 storm · 3 drought · 4 snow.</summary>
public sealed record EcoWeather(int Kind, string Name, double Intensity, double Wetness, int[]? Counts);

/// <summary>A named variety: a species whose mean personality drifted far enough to earn a name.</summary>
public sealed record EcoVariety(int Species, string Name, int Year);

/// <summary>Shannon diversity H', Pielou evenness J and species richness S.</summary>
public sealed record EcoBiodiversity(double Shannon, double Evenness, int Richness);

/// <summary>A pact the Chieftain Council wrote and the tribe store applied.</summary>
public sealed record EcoTreaty(int Tick, int TribeA, int TribeB, string Action, string Title, string Narrative, int Paid, string Resource, int Years);

/// <summary>One timeline marker: an event worth remembering, where it happened (tile, -1 if nowhere).</summary>
public sealed record EcoLandmark(int Id, int Tick, int Year, string Kind, string Text, int Tile);

/// <summary>
/// The timeline's data: landmarks, one row per year [year, rabbits, deer, wolves, humans, tech, H'×1000],
/// and the journal — the sagas written for this island, which the snapshot carries (2026-09-30).
/// </summary>
public sealed record EcoHistory(EcoLandmark[] Landmarks, int[][] Years, EcoSaga[]? Sagas = null);

/// <summary>One decade chronicle as the island keeps it (sim/world.js journal).</summary>
public sealed record EcoSaga(int FromYear, int ToYear, string Title, string Saga, string Epigraph);

/// <summary>One finder result: a living creature and where it stands.</summary>
public sealed record EcoFound(int Handle, string Name, int Species, double AgeYears, double Health, double Hunger, int Young, bool Sick, bool Watched, double X, double Z);

/// <summary>One decade kept by the time machine (sim/persistence/idb.js keyframes).</summary>
public sealed record EcoKeyframe(int Year, int Tick, int[]? Counts, long SavedAt);

/// <summary>The keyframes of the running world, and the year being visited (-1 in the present).</summary>
public sealed record EcoKeyframes(EcoKeyframe[] Frames, int Past);

/// <summary>The per-year rows read out of a shared island's snapshot, for the gallery's compare view.</summary>
public sealed record EcoIslandPeek(int Seed, int Year, int[][] Years);

/// <summary>
/// The naturalist lenses (render/creatureMeshes.js LENS): what every creature is coloured by.
/// 0–4 are the five traits; the rest read the frame's hunger, health, speed and kinship.
/// </summary>
public static class EcoLens
{
    public const int None = -1;
    public const int Hunger = 5;
    public const int Health = 6;
    public const int Thermal = 7;
    public const int Kin = 8;

    /// <summary>Every lens in the order the L key steps through them (traits first).</summary>
    public static readonly (int Id, string Label, string Low, string High)[] All =
    [
        (None, "Species", "", ""),
        (0, "Boldness", "timid", "bold"),
        (1, "Sociability", "solitary", "gregarious"),
        (2, "Curiosity", "wary", "curious"),
        (3, "Greed", "frugal", "greedy"),
        (4, "Diligence", "idle", "diligent"),
        (Hunger, "Hunger", "fed", "starving"),
        (Health, "Health", "dying", "healthy · purple = sick"),
        (Thermal, "Thermal", "at rest", "running"),
        (Kin, "Kinship", "strangers", "family of the creature on camera"),
    ];

    public static string LabelOf(int lens) => All.FirstOrDefault(l => l.Id == lens).Label ?? "Species";
}

/// <summary>What the printed field journal holds (index.js printJournal builds the page from it).</summary>
public sealed record EcoJournalPrint(string Title, string Subtitle, string Counts, EcoJournalEntry[] Sagas, EcoJournalEntry[] Legends, string[] Landmarks, string[] Notes);

/// <summary>One journal entry: a saga (Saga + Epigraph) or a legend (Text).</summary>
public sealed record EcoJournalEntry(string Title, string? Saga = null, string? Epigraph = null, string? Text = null);

/// <summary>The minimap's data layers (render/minimap.js MAP_LAYERS).</summary>
public static class EcoMapLayer
{
    public static readonly (string Id, string Label, string What)[] All =
    [
        ("none", "Map", "The island as it is"),
        ("deaths", "Deaths", "Where creatures have died"),
        ("predation", "Predation", "Where a predator made the kill"),
        ("sickness", "Sickness", "Where the sick have spent their time"),
        ("grazing", "Grazing", "Where the grass is eaten down right now"),
        ("traffic", "Traffic", "The routes feet have worn this session"),
    ];
}

/// <summary>A field-guide card for the Almanac (host/naturalist.js: iNaturalist + Wikipedia).</summary>
public sealed record EcoSpeciesCard(int Species, string CommonName, string ScientificName, string PhotoUrl, string Attribution, string License, string Url, int Observations, string Summary);

/// <summary>The engine-owned viewing preferences the Settings panel edits.</summary>
public sealed record EcoSettings(
    string Quality,
    string Palette,
    bool ReducedMotion,
    Dictionary<string, string[]> Bindings,
    Dictionary<string, string[]> Defaults,
    string[] Bindable,
    bool Gamepad);

/// <summary>
/// Lifetime world counters for the dashboard's almanac panel (sim/world.js). Stages is the
/// age pyramid flattened species-major: [species * 3 + (0 young, 1 adult, 2 old)].
/// </summary>
public sealed record EcoAlmanac(
    int[] Born,
    int[] Died,
    Dictionary<string, int> ByCause,
    int[] Stages,
    int HutsBuilt,
    int TreesFelled,
    string OldestName,
    int OldestSpecies,
    double OldestAge);

/// <summary>Where the tribe stands on its ladder (sim/behavior/tech.js).</summary>
public sealed record EcoTech(int Level, string Name, string Tribe, bool Campfire, bool Tower, int Fields);

/// <summary>One bookmarked creature, living or fallen.</summary>
public sealed record EcoWatched(int Handle, string Name, int Species, bool Alive, double AgeYears, string Cause);

/// <summary>One entry in the island-wide thought feed (dashboard).</summary>
public sealed record EcoThought(int Id, int Tick, int Handle, string Name, int Species, int Source, string Text);

public sealed record EcoLlmCounters(int Requested, int Applied, int Rejected);

public sealed record EcoNaturalEvents(int Lightning, int Rockslide, int Eruption);

/// <summary>
/// One line in the world log / HUD toasts. Births carry the child (Creature) and both
/// parents; deaths carry the creature — that is what lets the watch-list react.
/// </summary>
public sealed record EcoEvent(int Id, int Tick, string Kind, string Text, int? Species, string? Cause, int? Creature = null, int? Mother = null, int? Father = null, int? Level = null,
    // Diplomacy entries carry the pair and the moment (sim/tribe/diplomacy.js) so the page can
    // ask the council what the peace or the war actually says; weather entries carry the kind.
    string? Action = null, int? TribeA = null, int? TribeB = null, string? Reason = null, int? Tile = null, int? Weather = null);

/// <summary>Everything the inspector popover shows about the creature under the crosshair.</summary>
public sealed record EcoDetail(
    int Handle,
    string Name,
    int Species,
    string SpeciesName,
    int Sex,
    double AgeYears,
    int LifeStage,
    double Hunger,
    double Thirst,
    double Health,
    double[] Traits,
    double[] BaseTraits,
    EcoNudge? Nudge,
    string Goal,
    string LastThought,
    int LastThoughtSource,
    string Mother,
    string Father,
    double X,
    double Y,
    double Z,
    bool Watched = false,
    int Children = 0,
    int Descendants = 0,
    int Generation = 0,
    bool Sick = false);

public sealed record EcoNudge(string Trait, double Delta);

/// <summary>One node of a family tree (sim/creatures/lineage.js).</summary>
public sealed record EcoKin(int Handle, string Name, int Species, int Sex, bool Alive, string Cause, int BornTick, int DiedTick);

/// <summary>A creature's family: two generations up, its children, and the headline counts.</summary>
public sealed record EcoLineage(
    EcoKin Self,
    EcoKin? Mother,
    EcoKin? Father,
    EcoKin?[] Grandparents,
    EcoKin[] Children,
    int Siblings,
    int Descendants,
    int Generation);

/// <summary>The in-browser model's state, for the settings panel.</summary>
public sealed record EcoLlmState(string State, string ModelId, double Progress, string Message);

/// <summary>One selectable model (id, label, VRAM in MB, one-line note).</summary>
public sealed record EcoModel(string Id, string Label, int VramMb, string Note);

/// <summary>Result of probing IndexedDB for a saved world.</summary>
public sealed record EcoSaveInfo(bool Exists, int Seed, int Tick, int Year, long SavedAt, int[]? Counts);

[JsonSerializable(typeof(EcoStats))]
[JsonSerializable(typeof(EcoEvent[]))]
[JsonSerializable(typeof(EcoDetail))]
[JsonSerializable(typeof(EcoLineage))]
[JsonSerializable(typeof(EcoLlmState))]
[JsonSerializable(typeof(EcoModel[]))]
[JsonSerializable(typeof(EcoSaveInfo))]
[JsonSerializable(typeof(EcoAlmanac))]
[JsonSerializable(typeof(EcoThought[]))]
[JsonSerializable(typeof(TribeStateDto[]))]
[JsonSerializable(typeof(BuildingStateDto[]))]
[JsonSerializable(typeof(TribeStateDto))]
[JsonSerializable(typeof(BuildingStateDto))]
[JsonSerializable(typeof(TradeCaravanDto[]))]
[JsonSerializable(typeof(TradeCaravanDto))]
[JsonSerializable(typeof(EcoHistory))]
[JsonSerializable(typeof(EcoSettings))]
[JsonSerializable(typeof(EcoSpeciesCard[]))]
[JsonSerializable(typeof(EcoThoughtPromptItem[]))]
[JsonSerializable(typeof(EcoThoughtBatchReply))]
[JsonSerializable(typeof(EcoTreatyReply))]
[JsonSerializable(typeof(EcoFound[]))]
[JsonSerializable(typeof(EcoKeyframes))]
[JsonSerializable(typeof(EcoIslandPeek))]
[JsonSerializable(typeof(EcoJournalPrint))]
[JsonSerializable(typeof(int[][]))]
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, PropertyNameCaseInsensitive = true)]
internal sealed partial class EcoJsonContext : System.Text.Json.Serialization.JsonSerializerContext;
