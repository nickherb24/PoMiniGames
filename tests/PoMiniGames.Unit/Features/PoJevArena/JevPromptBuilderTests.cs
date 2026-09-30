using PoMiniGames.Features.PoJevArena;
using PoMiniGames.Shared.Games.PoJevArena;
using static VerifyXunit.Verifier;

namespace PoMiniGames.Unit.Features.PoJevArena;

/// <summary>
/// Snapshots every word Jev is shown. The state string and the question rubric ARE the model's
/// input, so a wording change is a behaviour change: it must show up as a reviewed diff in a
/// <c>*.verified.txt</c>, never slip through as a refactor. Rejection rows snapshot the error code,
/// which pins the server-side validation of the client's numbers in the same place.
/// </summary>
public sealed class JevPromptBuilderTests
{
    private static readonly ArenaCreature PlainClaw = new(
        "lib-plain01", "Plain Claw", 220, 4.5, 3.0, [], "opportunist", "engage_closest",
        "flees_if_outnumbered", PoJevArenaRules.BuildCost(220, 4.5, 3.0, []), OwnerName: "Tester");

    // Blue slots 1-5 are the presets in catalog order, slot 6 is an ability-less creature;
    // Red mirrors the presets so candidates resolve to known creatures.
    private static readonly ArenaRoster Roster = new(
        Blue: [.. PoJevArenaCatalog.Presets, PlainClaw, .. PoJevArenaCatalog.Presets[..4]],
        Red: [.. PoJevArenaCatalog.Presets, .. PoJevArenaCatalog.Presets]);

    private static readonly ArenaCandidate[] AllCandidates =
    [
        new("nearest_threat", "Red-01", 2.3, 85),
        new("weakest_target", "Red-03", 6.8, 12),
        new("strongest_threat", "Red-04", 9.4, 100),
        new("ranged_threat", "Red-03", 6.8, 12),
        new("protect_ally", "Blue-02", 3.1, 40),
    ];

    [Theory]
    [InlineData("preset-vanguard_tank")]
    [InlineData("preset-berserker_rusher")]
    [InlineData("preset-poison_spitter")]
    [InlineData("preset-boulder_brute")]
    [InlineData("preset-backline_medic")]
    [InlineData("no-abilities")]
    [InlineData("no-candidates")]
    [InlineData("hazards")]
    [InlineData("reject-bad-unit")]
    [InlineData("reject-hp-over-max")]
    [InlineData("reject-cooldown-length")]
    [InlineData("reject-candidate-unknown")]
    [InlineData("reject-protect-enemy")]
    [InlineData("reject-attack-ally")]
    [InlineData("reject-distance-nan")]
    [InlineData("reject-duplicate-focus")]
    [InlineData("reject-team-count")]
    [InlineData("reject-cover-range")]
    public Task JevPromptBuilder_BuildsStateAndOptions(string scenario)
    {
        var state = Scenario(scenario);
        var result = JevPromptBuilder.Build(Roster, state);
        return Verify(result).UseParameters(scenario);
    }

    private static ArenaUnitState Scenario(string scenario)
    {
        if (scenario.StartsWith("preset-", StringComparison.Ordinal))
        {
            var slot = Array.FindIndex(PoJevArenaCatalog.Presets, p => p.Id == "preset:" + scenario[7..]);
            var preset = PoJevArenaCatalog.Presets[slot];
            // First ability ready, second cooling down, so both renderings are pinned.
            var cooldowns = preset.Abilities.Select((_, i) => i == 0 ? 0 : 2.1).ToArray();
            return Base(ArenaUnits.Label(blue: true, slot), PoJevArenaRules.BattleHp(preset.MaxHp) / 3, cooldowns) with
            {
                Candidates = slot == 1 ? AllCandidates.Where(c => c.Unit != "Blue-02").ToArray() : AllCandidates,
            };
        }

        return scenario switch
        {
            "no-abilities" => Base("Blue-06", 36, []),
            "no-candidates" => Base("Blue-06", 36, []) with { Candidates = [], RedAlive = 0 },
            "reject-bad-unit" => Base("Green-01", 100, []),
            "reject-hp-over-max" => Base("Blue-06", PoJevArenaRules.BattleHp(220) + 1, []),
            "reject-cooldown-length" => Base("Blue-06", 30, [1.0]),
            "reject-candidate-unknown" => Base("Blue-06", 30, []) with { Candidates = [new("nearest_threat", "Red-11", 2, 50)] },
            "reject-protect-enemy" => Base("Blue-06", 30, []) with { Candidates = [new("protect_ally", "Red-02", 2, 50)] },
            "reject-attack-ally" => Base("Blue-06", 30, []) with { Candidates = [new("nearest_threat", "Blue-02", 2, 50)] },
            "reject-distance-nan" => Base("Blue-06", 30, []) with { Candidates = [new("nearest_threat", "Red-02", double.NaN, 50)] },
            "reject-duplicate-focus" => Base("Blue-06", 30, []) with
            {
                Candidates = [new("nearest_threat", "Red-02", 2, 50), new("nearest_threat", "Red-03", 3, 50)],
            },
            "reject-team-count" => Base("Blue-06", 30, []) with { BlueAlive = 11 },
            "hazards" => Base("Blue-06", 36, []) with { CoverDistanceM = 2.4, InBrush = true, InTar = true, Stamina = 35 },
            "reject-cover-range" => Base("Blue-06", 30, []) with { CoverDistanceM = 26 },
            _ => throw new ArgumentOutOfRangeException(nameof(scenario), scenario, null),
        };
    }

    private static ArenaUnitState Base(string unit, int hp, double[] cooldowns) => new(
        Unit: unit,
        Hp: hp,
        AbilityCooldowns: cooldowns,
        Poisoned: unit == "Blue-03",
        UnderFire: true,
        AlliesNear: 1,
        Candidates: AllCandidates,
        BlueAlive: 7,
        RedAlive: 9);
}
