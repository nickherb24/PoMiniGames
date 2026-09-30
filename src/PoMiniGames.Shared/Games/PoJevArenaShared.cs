using System.Text.Json.Serialization;
using PoMiniGames.Domain.Services;

namespace PoMiniGames.Shared.Games.PoJevArena;

// ───────────────────────────  PoJevArena contracts  ───────────────────────────
//
// Single source of truth for the catalogs, the ability registry, the build budget and the wire
// shapes. The server validates against these and builds every word Jev sees from them; the
// client renders the Factory from them and hands the ability rows to the JS engine at mount,
// so tuning an ability is a data change on this file. The engine keys its behaviour and visual
// handlers by the same ids (js/pojevarena/abilities.js, fx.js) — adding an ability is one row
// here plus one handler and one visual there, and nothing else lists abilities by name.

/// <summary>Which slot an ability occupies. A creature carries at most one ability per slot.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<ArenaAbilitySlot>))]
public enum ArenaAbilitySlot
{
    Offense,
    Defense,
}

/// <summary>Match mode, mirroring the client's <c>/pojevarena/{mode}</c> routes.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<ArenaMode>))]
public enum ArenaMode
{
    OnePlayer,
    TwoPlayer,
    Demo,
}

/// <summary>One catalog entry: a stable id (what Jev and storage see) and a label (what players see).</summary>
public sealed record ArenaCatalogEntry(string Id, string Label, string Summary);

/// <summary>A tactical option every creature is offered, regardless of abilities.</summary>
public sealed record ArenaBaseAction(string Option, string Label, string JevCriterion);

/// <summary>
/// One ability. <see cref="JevOption"/> is the <c>tactical_action</c> key it unlocks and
/// <see cref="JevCriterion"/> the rubric text Jev reads for it. The numeric tuning is consumed by
/// the JS engine (units: seconds, metres, m/s); <see cref="Power"/> is damage for attacks, HP for
/// heals and the damage-reduction fraction for defensive stances.
/// </summary>
public sealed record ArenaAbility(
    string Id,
    ArenaAbilitySlot Slot,
    string Label,
    string Summary,
    double Cost,
    string JevOption,
    string JevCriterion,
    double CooldownSeconds,
    double RangeMeters,
    double Power,
    double ProjectileSpeed,
    double DurationSeconds);

/// <summary>What a player submits from the Factory (create and edit).</summary>
public sealed record ArenaCreatureDraft(
    string Name,
    int MaxHp,
    double MoveSpeed,
    double Mass,
    string[] Abilities,
    string Temperament,
    string TargetBias,
    string PanicThreshold);

/// <summary>A creature as the library, rosters and the engine see it.</summary>
public sealed record ArenaCreature(
    string Id,
    string Name,
    int MaxHp,
    double MoveSpeed,
    double Mass,
    string[] Abilities,
    string Temperament,
    string TargetBias,
    string PanicThreshold,
    double BuildCost,
    string OwnerName = "",
    bool IsMine = false,
    int Deployed = 0,
    int Wins = 0,
    int Losses = 0,
    int Draws = 0,
    DateTimeOffset? UpdatedUtc = null,
    int Rating = 0,
    int Kills = 0,
    int Mvps = 0,
    long DamageDealt = 0)
{
    /// <summary>Presets are code constants, never library rows, and carry no stats.</summary>
    [JsonIgnore]
    public bool IsPreset => Id.StartsWith(PoJevArenaCatalog.PresetPrefix, StringComparison.Ordinal);

    public ArenaCreatureDraft ToDraft() =>
        new(Name, MaxHp, MoveSpeed, Mass, Abilities, Temperament, TargetBias, PanicThreshold);
}

/// <summary>Outcome of <see cref="PoJevArenaRules.Validate"/>. <see cref="Error"/> is a stable code.</summary>
public sealed record ArenaValidation(bool IsValid, string? Error, ArenaCreature? Creature)
{
    public static ArenaValidation Fail(string error) => new(false, error, null);
}

// ── Allowance ──────────────────────────────────────────────────────────────────

/// <summary>What <c>GET /api/pojevarena/status</c> returns.</summary>
public sealed record ArenaStatus(bool Configured, long DailyLimit, long Used, long Remaining, DateTimeOffset ResetUtc);

// ── Match lifecycle ────────────────────────────────────────────────────────────

/// <summary>Registers a match. Ids are library ids or <c>preset:*</c>; exactly 10 per team.</summary>
public sealed record ArenaMatchRequest(ArenaMode Mode, string[] BlueIds, string[] RedIds);

/// <summary>The frozen rosters the engine plays with: later library edits cannot change a running match.</summary>
public sealed record ArenaMatchTicket(string MatchId, int Seed, ArenaCreature[] Blue, ArenaCreature[] Red);

/// <summary>
/// Reports a finished match once. <see cref="Winner"/> is <c>blue</c>, <c>red</c> or <c>draw</c>.
/// <see cref="Units"/> carries each roster slot's career numbers (Blue 0-9, Red 10-19) and
/// <see cref="Mvp"/> the slot the engine named MVP (-1 for none). Both are the client's word, like
/// the winner: the server clamps them and adds them to library careers, nothing more.
/// </summary>
public sealed record ArenaMatchResult(string Winner, double DurationSeconds, ArenaUnitStats[]? Units = null, int Mvp = -1);

/// <summary>One roster slot's numbers for a finished match.</summary>
public sealed record ArenaUnitStats(int Slot, int Kills, double Damage, double Healed);

public sealed record ArenaResultReceipt(bool Recorded, string? Reason = null);

// ── Decisions ─────────────────────────────────────────────────────────────────

/// <summary>
/// One candidate the engine measured for a unit. <see cref="Focus"/> is a
/// <see cref="PoJevArenaCatalog.TargetFoci"/> option; the creature behind <see cref="Unit"/> is
/// resolved server-side from the match roster, never taken from the client.
/// </summary>
public sealed record ArenaCandidate(string Focus, string Unit, double DistanceM, int HpPercent);

/// <summary>
/// The dynamic state of one unit (numbers and ids only). <see cref="AbilityCooldowns"/> aligns
/// with the creature's ability list: seconds until ready, 0 meaning ready. The arena hazards ride
/// along as numbers too: <see cref="CoverDistanceM"/> is the edge distance to the nearest pillar
/// (-1 when the arena has none), and <see cref="InBrush"/> / <see cref="InTar"/> say where the unit stands.
/// <see cref="Stamina"/> is the percent left of the unit's energy reserve (-1 when not reported).
/// </summary>
public sealed record ArenaUnitState(
    string Unit,
    int Hp,
    double[] AbilityCooldowns,
    bool Poisoned,
    bool UnderFire,
    int AlliesNear,
    ArenaCandidate[] Candidates,
    int BlueAlive,
    int RedAlive,
    double CoverDistanceM = -1,
    bool InBrush = false,
    bool InTar = false,
    int Stamina = -1);

public sealed record ArenaDecideRequest(ArenaUnitState[] Units);

/// <summary>
/// Jev's answer for one unit, or why there is none. On failure the unit holds its last intent.
/// </summary>
public sealed record ArenaUnitDecision(
    string Unit,
    bool Ok,
    string? Failure,
    string? Action,
    double ActionConfidence,
    Dictionary<string, double>? ActionProbabilities,
    string? Focus,
    double FocusConfidence,
    Dictionary<string, double>? FocusProbabilities,
    double Panic,
    int LatencyMs);

public sealed record ArenaDecideResponse(ArenaUnitDecision[] Decisions, long Remaining, string? Notice = null);

/// <summary>The fixed vocabulary: personality catalogs, base actions, target foci, abilities and presets.</summary>
public static class PoJevArenaCatalog
{
    public const string PresetPrefix = "preset:";
    public const int TeamSize = 10;

    public static readonly ArenaCatalogEntry[] Temperaments =
    [
        new("reckless_berserker", "Reckless berserker", "Charges in, hates to back off"),
        new("disciplined_anchor", "Disciplined anchor", "Holds the line and keeps formation"),
        new("skirmisher", "Skirmisher", "Hits and runs, never stands still"),
        new("cautious_sniper", "Cautious sniper", "Keeps its distance and picks shots"),
        new("loyal_guardian", "Loyal guardian", "Puts allies first"),
        new("opportunist", "Opportunist", "Goes where the easy win is"),
    ];

    public static readonly ArenaCatalogEntry[] TargetBiases =
    [
        new("engage_closest", "Engage closest", "Fights whatever is nearest"),
        new("hunt_weakest", "Hunt weakest", "Finishes off the wounded"),
        new("protect_allies", "Protect allies", "Guards whoever is in trouble"),
        new("focus_ranged", "Focus ranged", "Goes after the shooters"),
        new("challenge_strongest", "Challenge strongest", "Seeks the biggest threat"),
    ];

    public static readonly ArenaCatalogEntry[] PanicThresholds =
    [
        new("fights_to_death", "Fights to the death", "Never breaks"),
        new("panics_under_25_hp", "Panics under 25% HP", "Breaks when badly hurt"),
        new("panics_under_50_hp", "Panics under 50% HP", "Breaks when half gone"),
        new("flees_if_outnumbered", "Flees if outnumbered", "Breaks when the odds turn"),
        new("flees_when_alone", "Flees when alone", "Breaks without allies nearby"),
        new("breaks_when_allies_fall", "Breaks when allies fall", "Morale collapses as the team thins"),
    ];

    /// <summary>Every creature can melee (<c>melee_charge</c>); abilities only add options.</summary>
    public static readonly ArenaBaseAction[] BaseActions =
    [
        new("melee_charge", "Melee charge", "Rush the target and strike it in melee"),
        new("peel_to_ally", "Peel to ally", "Disengage and move to the closest living ally for protection"),
        new("fall_back", "Fall back", "Back away from the nearest threat without attacking"),
        new("take_cover", "Take cover", "Move behind the nearest pillar so it blocks the nearest threat's line of fire"),
    ];

    public static readonly ArenaCatalogEntry[] TargetFoci =
    [
        new("nearest_threat", "Nearest threat", "Lock onto the enemy closest to physical contact"),
        new("weakest_target", "Weakest target", "Bypass closer enemies to eliminate the lowest-HP enemy"),
        new("strongest_threat", "Strongest threat", "Confront the healthiest, most dangerous enemy"),
        new("ranged_threat", "Ranged threat", "Go after the nearest enemy that attacks from range"),
        new("protect_ally", "Protect ally", "Orient toward the most endangered ally"),
    ];

    public static readonly ArenaAbility[] Abilities =
    [
        new("spit_glob", ArenaAbilitySlot.Offense, "Spit glob", "Fast poison glob from range",
            Cost: 12, JevOption: "kite_and_shoot",
            JevCriterion: "Back away from the target while spitting poison globs from range",
            CooldownSeconds: 1.2, RangeMeters: 10, Power: 10, ProjectileSpeed: 18, DurationSeconds: 2),
        new("hurl_boulder", ArenaAbilitySlot.Offense, "Hurl boulder", "Slow, heavy rock with knockback",
            Cost: 15, JevOption: "lob_boulder",
            JevCriterion: "Plant feet and hurl a heavy boulder at the target",
            CooldownSeconds: 3, RangeMeters: 7, Power: 28, ProjectileSpeed: 11, DurationSeconds: 0.4),
        new("mend_bolt", ArenaAbilitySlot.Offense, "Mend bolt", "Heals the most injured ally",
            Cost: 15, JevOption: "mend_ally",
            JevCriterion: "Move near the most injured ally and heal it",
            CooldownSeconds: 1.5, RangeMeters: 6, Power: 12, ProjectileSpeed: 18, DurationSeconds: 0),
        new("shield_brace", ArenaAbilitySlot.Defense, "Shield brace", "Dig in; heavy and hard to push",
            Cost: 8, JevOption: "shield_brace",
            JevCriterion: "Stop, dig in and brace for impact",
            CooldownSeconds: 0.5, RangeMeters: 0, Power: 0.4, ProjectileSpeed: 0, DurationSeconds: 0),
        new("hard_shell", ArenaAbilitySlot.Defense, "Hard shell", "Retract and shrug off damage",
            Cost: 12, JevOption: "shell_up",
            JevCriterion: "Retract into the shell to survive incoming damage",
            CooldownSeconds: 7, RangeMeters: 0, Power: 0.6, ProjectileSpeed: 0, DurationSeconds: 2.5),
        new("dodge_dash", ArenaAbilitySlot.Defense, "Dodge dash", "Sideways burst, briefly untouchable",
            Cost: 10, JevOption: "dodge_dash",
            JevCriterion: "Dash sideways out of the threat's line of attack",
            CooldownSeconds: 4, RangeMeters: 0, Power: 0, ProjectileSpeed: 0, DurationSeconds: 0.3),
    ];

    public static readonly ArenaCreature[] Presets =
    [
        Preset("vanguard_tank", "Vanguard Tank", 450, 3.0, 4.5, ["shield_brace"],
            "disciplined_anchor", "engage_closest", "fights_to_death"),
        Preset("berserker_rusher", "Berserker Rusher", 160, 8.0, 2.0, ["dodge_dash"],
            "reckless_berserker", "hunt_weakest", "fights_to_death"),
        Preset("poison_spitter", "Poison Spitter", 110, 5.5, 1.5, ["spit_glob", "dodge_dash"],
            "skirmisher", "hunt_weakest", "panics_under_25_hp"),
        Preset("boulder_brute", "Boulder Brute", 300, 3.5, 4.0, ["hurl_boulder", "hard_shell"],
            "opportunist", "challenge_strongest", "panics_under_50_hp"),
        Preset("backline_medic", "Backline Medic", 130, 5.0, 1.5, ["mend_bolt", "hard_shell"],
            "loyal_guardian", "protect_allies", "flees_when_alone"),
    ];

    public static ArenaAbility? FindAbility(string? id) =>
        id is null ? null : Array.Find(Abilities, a => a.Id == id);

    public static ArenaCreature? FindPreset(string? id) =>
        id is null ? null : Array.Find(Presets, p => p.Id == id);

    public static bool IsKnown(ArenaCatalogEntry[] catalog, string? id) =>
        id is not null && Array.Exists(catalog, e => e.Id == id);

    private static ArenaCreature Preset(
        string slug, string name, int hp, double speed, double mass, string[] abilities,
        string temperament, string bias, string panic) =>
        new(PresetPrefix + slug, name, hp, speed, mass, abilities, temperament, bias, panic,
            PoJevArenaRules.BuildCost(hp, speed, mass, abilities), OwnerName: "Arena");
}

/// <summary>Bounds, the build budget and validation. Runs identically on server and client.</summary>
public static class PoJevArenaRules
{
    public const int MinHp = 50;
    public const int MaxHp = 500;
    public const double MinSpeed = 2.0;
    public const double MaxSpeed = 9.0;
    public const double MinMass = 1.0;
    public const double MaxMass = 5.0;
    public const double StatStep = 0.5;
    public const double BuildBudget = 80;
    public const int MaxCreaturesPerOwner = 25;
    public const int MaxNameChars = DisplayNameSanitizer.MaxLength;

    /// <summary>
    /// Designed HP (50-500: what the budget prices and the library stores) over battle HP. A
    /// creature fights with one fifth of it (the user's call, 2026-09-30), and everything a player
    /// or Jev reads shows the battle number. Mirrored by <c>battleHp</c> in js/pojevarena/sim.js.
    /// </summary>
    public const int BattleHpDivisor = 5;

    /// <summary>The HP a creature has in the arena: designed HP / 5, rounded, at least 1.</summary>
    public static int BattleHp(int designedHp) =>
        Math.Max(1, (int)Math.Round(designedHp / (double)BattleHpDivisor, MidpointRounding.AwayFromZero));

    /// <summary>
    /// Build points spent, rounded to 0.1. Maxing all three stats costs 90 — more than the whole
    /// budget — so every creature is a trade-off between bulk, pace, weight and abilities.
    /// Unknown ability ids cost nothing here; <see cref="Validate"/> rejects them separately.
    /// </summary>
    public static double BuildCost(int maxHp, double moveSpeed, double mass, IEnumerable<string> abilities)
    {
        var cost = (maxHp - MinHp) / (double)(MaxHp - MinHp) * 40
                 + (moveSpeed - MinSpeed) / (MaxSpeed - MinSpeed) * 30
                 + (mass - MinMass) / (MaxMass - MinMass) * 20
                 + abilities.Sum(id => PoJevArenaCatalog.FindAbility(id)?.Cost ?? 0);
        return Math.Round(cost, 1, MidpointRounding.AwayFromZero);
    }

    /// <summary>
    /// Validates a draft and returns the normalised creature (id and owner are filled in by the
    /// caller). The first failing rule wins; error codes are stable for the client and tests.
    /// </summary>
    public static ArenaValidation Validate(ArenaCreatureDraft draft)
    {
        var name = DisplayNameSanitizer.Sanitize(draft.Name, fallback: string.Empty);
        if (!name.IsPublishable) return ArenaValidation.Fail("name");

        if (draft.MaxHp is < MinHp or > MaxHp) return ArenaValidation.Fail("hp");
        if (!OnStep(draft.MoveSpeed, MinSpeed, MaxSpeed)) return ArenaValidation.Fail("speed");
        if (!OnStep(draft.Mass, MinMass, MaxMass)) return ArenaValidation.Fail("mass");

        var abilities = draft.Abilities ?? [];
        var resolved = new List<ArenaAbility>(abilities.Length);
        foreach (var id in abilities)
        {
            var ability = PoJevArenaCatalog.FindAbility(id);
            if (ability is null) return ArenaValidation.Fail("ability");
            resolved.Add(ability);
        }

        var slotCount = Enum.GetValues<ArenaAbilitySlot>().Length;
        if (resolved.Count > slotCount
            || resolved.GroupBy(a => a.Slot).Any(g => g.Count() > 1))
        {
            return ArenaValidation.Fail("ability-slot");
        }

        if (!PoJevArenaCatalog.IsKnown(PoJevArenaCatalog.Temperaments, draft.Temperament)) return ArenaValidation.Fail("temperament");
        if (!PoJevArenaCatalog.IsKnown(PoJevArenaCatalog.TargetBiases, draft.TargetBias)) return ArenaValidation.Fail("target-bias");
        if (!PoJevArenaCatalog.IsKnown(PoJevArenaCatalog.PanicThresholds, draft.PanicThreshold)) return ArenaValidation.Fail("panic");

        // Offense before defense, so the stored list and the Jev option order are stable.
        var ordered = resolved.OrderBy(a => a.Slot).Select(a => a.Id).ToArray();
        var cost = BuildCost(draft.MaxHp, draft.MoveSpeed, draft.Mass, ordered);
        if (cost > BuildBudget) return ArenaValidation.Fail("budget");

        var creature = new ArenaCreature(
            Id: string.Empty,
            Name: name.Value,
            MaxHp: draft.MaxHp,
            MoveSpeed: draft.MoveSpeed,
            Mass: draft.Mass,
            Abilities: ordered,
            Temperament: draft.Temperament,
            TargetBias: draft.TargetBias,
            PanicThreshold: draft.PanicThreshold,
            BuildCost: cost);
        return new ArenaValidation(true, null, creature);
    }

    private static bool OnStep(double value, double min, double max)
    {
        if (!double.IsFinite(value) || value < min || value > max) return false;
        var steps = (value - min) / StatStep;
        return Math.Abs(steps - Math.Round(steps)) < 1e-9;
    }
}

/// <summary>Unit labels are <c>Blue-01</c>…<c>Blue-10</c> and <c>Red-01</c>…<c>Red-10</c>, by roster slot.</summary>
public static class ArenaUnits
{
    public static string Label(bool blue, int slot) => $"{(blue ? "Blue" : "Red")}-{slot + 1:00}";

    public static bool TryParse(string? label, out bool blue, out int slot)
    {
        blue = false;
        slot = -1;
        if (label is null) return false;

        string digits;
        if (label.StartsWith("Blue-", StringComparison.Ordinal)) { blue = true; digits = label[5..]; }
        else if (label.StartsWith("Red-", StringComparison.Ordinal)) { digits = label[4..]; }
        else return false;

        if (digits.Length != 2 || !int.TryParse(digits, out var n) || n is < 1 or > PoJevArenaCatalog.TeamSize) return false;
        slot = n - 1;
        return true;
    }
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(ArenaCreature))]
[JsonSerializable(typeof(ArenaCreature[]))]
[JsonSerializable(typeof(ArenaCreatureDraft))]
[JsonSerializable(typeof(ArenaAbility[]))]
[JsonSerializable(typeof(ArenaStatus))]
[JsonSerializable(typeof(ArenaMatchRequest))]
[JsonSerializable(typeof(ArenaMatchTicket))]
[JsonSerializable(typeof(ArenaMatchResult))]
[JsonSerializable(typeof(ArenaUnitStats[]))]
[JsonSerializable(typeof(ArenaResultReceipt))]
[JsonSerializable(typeof(ArenaDecideRequest))]
[JsonSerializable(typeof(ArenaDecideResponse))]
public partial class PoJevArenaJsonContext : JsonSerializerContext
{
}
