namespace PoMiniGames.Shared.Games.PoEcosystem;

// ───────────────────────────  PoEcosystem cloud contracts  ───────────────────────────
//
// Cloud saves and the chronicle are the only server surfaces the island has. Saves are
// opaque gzip'd snapshot bytes produced by the browser engine (js/poecosystem/sim/
// persistence/codec.js) — the server never parses a world, it stores blobs and the
// metadata rows the slot picker and the gallery render from.

/// <summary>Slot identifiers a caller may save into. Three, so the store stays bounded per identity.</summary>
public static class EcoWorldSlots
{
    public static readonly string[] All = ["1", "2", "3"];
    public const int MaxBytes = 12 * 1024 * 1024;
    public const int MaxNameChars = 40;
    public static bool IsValid(string? slot) => slot is not null && Array.IndexOf(All, slot) >= 0;
}

/// <summary>One of the caller's saved worlds, as the slot picker shows it.</summary>
public sealed record EcoWorldMeta(
    string Slot,
    string Name,
    int Seed,
    int Year,
    int Tick,
    int[] Counts,
    DateTimeOffset SavedAt,
    long SizeBytes,
    string? ShareCode,
    string? OwnerName);

/// <summary>A world its owner made public, as the gallery lists it.</summary>
public sealed record EcoSharedWorld(
    string Code,
    string Name,
    string OwnerName,
    int Seed,
    int Year,
    int[] Counts,
    DateTimeOffset SavedAt,
    long SizeBytes);

public sealed record EcoShareRequest(bool Public);

/// <summary>What the chronicler is handed: the decade's log, the counts, and who the tribe is.</summary>
public sealed record EcoChronicleRequest(
    int Seed,
    int FromYear,
    int ToYear,
    string Tribe,
    int[] Counts,
    bool[] Extinct,
    string[] Log,
    string? Almanac);

/// <summary>A decade of island history as a short saga.</summary>
public sealed record EcoChronicle(string Title, string Saga, string Epigraph, bool Mock, DateTimeOffset WrittenAt);

/// <summary>One creature's thought, asked of the server-side model when the browser cannot run one.</summary>
public sealed record EcoThoughtRequest(string System, string Prompt);

public sealed record EcoThoughtReply(string Text, bool Mock);

// ───────────────────────────  Multi-Tribe & Civilization Contracts  ───────────────────────────

/// <summary>Diplomatic posture between two tribes.</summary>
public enum TribeDiplomacy
{
    Neutral = 0,
    Allied = 1,
    Rival = 2,
    War = 3
}

/// <summary>Evolutionary technology tiers for tribal civilizations.</summary>
public enum TechTier
{
    Primitive = 0,
    Toolcraft = 1,
    Agrarian = 2,
    Fortification = 3
}

/// <summary>Functional structures constructed in tribal settlements.</summary>
public enum BuildingKind
{
    Hut = 0,
    Granary = 1,
    Watchtower = 2,
    WarTotem = 3
}

/// <summary>Snapshot state of an individual tribe on the island.</summary>
public sealed record TribeStateDto(
    int Id,
    string Name,
    string BannerColor,
    TechTier Tech,
    int Population,
    int Warriors,
    int Wood,
    int Stone,
    int Food,
    float CenterX,
    float CenterZ,
    float TerritoryRadius,
    int[] Relations);

/// <summary>Snapshot state of a settlement building.</summary>
public sealed record BuildingStateDto(
    int Id,
    int TribeId,
    BuildingKind Kind,
    float X,
    float Z,
    float Progress,
    float Health,
    bool IsComplete);

/// <summary>Snapshot state of an active trade caravan traveling between tribes.</summary>
public sealed record TradeCaravanDto(
    int Id,
    int FromTribeId,
    int ToTribeId,
    string CargoKind,
    int Amount,
    float X,
    float Z,
    float Progress,
    bool Returning);

/// <summary>Real-time telemetry delta dispatched to the Blazor Analytics Dashboard.</summary>
public sealed record EcosystemTelemetryDeltaDto(
    int Year,
    int Day,
    int Tick,
    IReadOnlyList<TribeStateDto> Tribes,
    IReadOnlyList<BuildingStateDto> Buildings,
    int RabbitCount,
    int WolfCount,
    int TotalHumanCount,
    bool IsYearMilestone,
    IReadOnlyList<TradeCaravanDto>? Caravans = null,
    int Season = 0,
    float SeasonProgress = 0f);

// ───────────────────────────  Advanced AI DTOs  ───────────────────────────

/// <summary>Prompt data for a single creature inside a batch query.</summary>
public sealed record EcoThoughtPromptItem(
    int Id,
    string Species,
    string Name,
    float Hunger,
    float Thirst,
    float Health,
    string Goal,
    string Nearby);

/// <summary>Request for batched creature thoughts to minimize HTTP & AI overhead.</summary>
public sealed record EcoThoughtBatchRequest(IReadOnlyList<EcoThoughtPromptItem> Items);

/// <summary>Result for one creature in a batch thought reply.</summary>
public sealed record EcoThoughtItemResult(int Id, string Thought, string Trait, float Delta);

/// <summary>Batch reply containing thoughts for multiple creatures.</summary>
public sealed record EcoThoughtBatchReply(IReadOnlyList<EcoThoughtItemResult> Results, bool Mock);

/// <summary>Request for AI-mediated tribal diplomacy negotiation.</summary>
public sealed record EcoTreatyRequest(
    int Seed,
    int Year,
    TribeStateDto TribeA,
    TribeStateDto TribeB,
    string Reason,
    IReadOnlyList<string>? RecentEvents = null);

/// <summary>Diplomatic treaty or ultimatum generated by Chieftain Council.</summary>
public sealed record EcoTreatyReply(
    string Title,
    string Narrative,
    string Action,
    string DemandedResource,
    int ResourceAmount,
    int PeaceYears,
    bool Mock);

/// <summary>Request for generating a historical oral legend upon reaching a milestone.</summary>
public sealed record EcoMilestoneLoreRequest(
    int Seed,
    int Year,
    string MilestoneType,
    string TribeName,
    string Details);

/// <summary>Historical oral legend or prophecy commemorating a milestone.</summary>
public sealed record EcoMilestoneLoreReply(
    string Epithet,
    string OralLegend,
    bool Mock);

/// <summary>Cultural identity, deity, totem, taboo, and war cry for a tribe.</summary>
public sealed record EcoCultureProfile(
    int TribeId,
    string Name,
    string Deity,
    string SacredTotem,
    string Taboo,
    string WarCry);

[System.Text.Json.Serialization.JsonSerializable(typeof(EcoWorldMeta))]
[System.Text.Json.Serialization.JsonSerializable(typeof(EcoSharedWorld))]
[System.Text.Json.Serialization.JsonSerializable(typeof(EcoChronicleRequest))]
[System.Text.Json.Serialization.JsonSerializable(typeof(EcoChronicle))]
[System.Text.Json.Serialization.JsonSerializable(typeof(EcoThoughtRequest))]
[System.Text.Json.Serialization.JsonSerializable(typeof(EcoThoughtReply))]
[System.Text.Json.Serialization.JsonSerializable(typeof(EcoThoughtPromptItem))]
[System.Text.Json.Serialization.JsonSerializable(typeof(EcoThoughtBatchRequest))]
[System.Text.Json.Serialization.JsonSerializable(typeof(EcoThoughtItemResult))]
[System.Text.Json.Serialization.JsonSerializable(typeof(EcoThoughtBatchReply))]
[System.Text.Json.Serialization.JsonSerializable(typeof(EcoTreatyRequest))]
[System.Text.Json.Serialization.JsonSerializable(typeof(EcoTreatyReply))]
[System.Text.Json.Serialization.JsonSerializable(typeof(EcoMilestoneLoreRequest))]
[System.Text.Json.Serialization.JsonSerializable(typeof(EcoMilestoneLoreReply))]
[System.Text.Json.Serialization.JsonSerializable(typeof(EcoCultureProfile))]
[System.Text.Json.Serialization.JsonSerializable(typeof(List<EcoCultureProfile>))]
[System.Text.Json.Serialization.JsonSerializable(typeof(TribeStateDto))]
[System.Text.Json.Serialization.JsonSerializable(typeof(BuildingStateDto))]
[System.Text.Json.Serialization.JsonSerializable(typeof(TradeCaravanDto))]
[System.Text.Json.Serialization.JsonSerializable(typeof(List<TradeCaravanDto>))]
[System.Text.Json.Serialization.JsonSerializable(typeof(EcosystemTelemetryDeltaDto))]
public partial class PoEcosystemJsonContext : System.Text.Json.Serialization.JsonSerializerContext
{
}

