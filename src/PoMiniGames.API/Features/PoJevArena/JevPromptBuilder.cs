using System.Globalization;
using System.Text;
using PoMiniGames.Shared.Games.PoJevArena;

namespace PoMiniGames.Features.PoJevArena;

/// <summary>The two frozen rosters of a registered match, indexed by unit label.</summary>
public sealed record ArenaRoster(ArenaCreature[] Blue, ArenaCreature[] Red)
{
    public ArenaCreature? Resolve(string? unit, out bool blue)
    {
        if (!ArenaUnits.TryParse(unit, out blue, out var slot)) return null;
        var team = blue ? Blue : Red;
        return slot < team.Length ? team[slot] : null;
    }
}

/// <summary>One Jev question as sent on the wire (<c>type</c> is <c>choice</c> or <c>noul</c>).</summary>
public sealed record JevQuestion(string Type, string Instructions, IReadOnlyDictionary<string, string> Criteria);

/// <summary>The complete model input for one unit: the state text plus the question set.</summary>
public sealed record JevPrompt(string State, IReadOnlyDictionary<string, JevQuestion> Questions);

/// <summary>Either a prompt or the stable code of the first rule the client's numbers broke.</summary>
public sealed record JevPromptResult(JevPrompt? Prompt, string? Error);

/// <summary>
/// Turns one unit's validated numbers into the exact text Jev is shown. This is the reason the
/// decision proxy is not a pass-through: the client supplies distances, HP and catalog-keyed
/// candidates, and every word — names come from the server-held roster — is written here, so the
/// endpoint cannot be used to put arbitrary text in front of Jev on our key.
/// </summary>
public static class JevPromptBuilder
{
    public const string ActionKey = "tactical_action";
    public const string FocusKey = "target_focus";
    public const string PanicKey = "panic_trigger";

    // The arena is 800x600 px at 40 px/m, so no in-arena distance exceeds its 25 m diagonal.
    private const double MaxDistanceM = 25;
    private const double MaxCooldownSeconds = 60;

    private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    public static JevPromptResult Build(ArenaRoster roster, ArenaUnitState state)
    {
        var subject = roster.Resolve(state.Unit, out var blue);
        if (subject is null) return Fail("unit");
        // The engine reports battle HP (one fifth of the designed HP the roster stores).
        if (state.Hp < 1 || state.Hp > PoJevArenaRules.BattleHp(subject.MaxHp)) return Fail("hp");

        var cooldowns = state.AbilityCooldowns ?? [];
        if (cooldowns.Length != subject.Abilities.Length
            || cooldowns.Any(c => !double.IsFinite(c) || c < 0 || c > MaxCooldownSeconds))
        {
            return Fail("cooldowns");
        }

        if (state.BlueAlive is < 0 or > PoJevArenaCatalog.TeamSize
            || state.RedAlive is < 0 or > PoJevArenaCatalog.TeamSize
            || state.AlliesNear is < 0 or >= PoJevArenaCatalog.TeamSize)
        {
            return Fail("counts");
        }

        // -1 means "this arena has no pillars"; anything else is an in-arena distance.
        if (!double.IsFinite(state.CoverDistanceM) || (state.CoverDistanceM != -1 && state.CoverDistanceM is < 0 or > MaxDistanceM))
        {
            return Fail("cover");
        }

        if (state.Stamina is < -1 or > 100) return Fail("stamina");

        var candidates = state.Candidates ?? [];
        var seenFoci = new HashSet<string>(StringComparer.Ordinal);
        var resolved = new List<(ArenaCandidate Candidate, ArenaCreature Creature)>(candidates.Length);
        foreach (var candidate in candidates)
        {
            if (!PoJevArenaCatalog.IsKnown(PoJevArenaCatalog.TargetFoci, candidate.Focus) || !seenFoci.Add(candidate.Focus))
            {
                return Fail("focus");
            }

            var creature = roster.Resolve(candidate.Unit, out var candidateBlue);
            if (creature is null) return Fail("candidate");

            // protect_ally must point at a teammate (never the subject itself); every other focus at an enemy.
            var wantAlly = candidate.Focus == "protect_ally";
            if ((candidateBlue == blue) != wantAlly || candidate.Unit == state.Unit) return Fail("candidate-team");

            if (!double.IsFinite(candidate.DistanceM) || candidate.DistanceM < 0 || candidate.DistanceM > MaxDistanceM
                || candidate.HpPercent is < 0 or > 100)
            {
                return Fail("candidate-range");
            }

            resolved.Add((candidate, creature));
        }

        var prompt = new JevPrompt(
            State: DescribeState(subject, state, cooldowns, resolved, blue),
            Questions: Questions(subject, resolved));
        return new JevPromptResult(prompt, null);
    }

    private static JevPromptResult Fail(string error) => new(null, error);

    private static string DescribeState(
        ArenaCreature subject,
        ArenaUnitState state,
        double[] cooldowns,
        List<(ArenaCandidate Candidate, ArenaCreature Creature)> candidates,
        bool blue)
    {
        var sb = new StringBuilder(640);
        var maxHp = PoJevArenaRules.BattleHp(subject.MaxHp);
        var hpPct = (int)Math.Round(100.0 * state.Hp / maxHp);

        sb.Append(Inv, $"Subject: {state.Unit} \"{subject.Name}\" (HP: {state.Hp}/{maxHp} [{hpPct}%], ")
          .Append(Inv, $"Mass: {subject.Mass:0.0}, Speed: {subject.MoveSpeed:0.0} m/s)\n");

        sb.Append("Personality: ")
          .Append(Describe(PoJevArenaCatalog.Temperaments, subject.Temperament)).Append("; target bias ")
          .Append(Describe(PoJevArenaCatalog.TargetBiases, subject.TargetBias)).Append("; panic threshold ")
          .Append(Describe(PoJevArenaCatalog.PanicThresholds, subject.PanicThreshold)).Append('\n');

        sb.Append("Abilities: melee (always)");
        for (var i = 0; i < subject.Abilities.Length; i++)
        {
            sb.Append(", ").Append(subject.Abilities[i]).Append(
                cooldowns[i] <= 0 ? " (ready)" : string.Create(Inv, $" ({cooldowns[i]:0.0} s)"));
        }
        sb.Append('\n');

        var status = new List<string>(5);
        if (state.UnderFire) status.Add("Under direct fire");
        if (state.Poisoned) status.Add("poisoned");
        if (state.InTar) status.Add("stuck in the tar pit (slowed, losing HP)");
        if (state.InBrush) status.Add("hidden in brush (ranged hits land softer)");
        status.Add(state.AlliesNear == 1 ? "1 ally within 4 m" : $"{state.AlliesNear} allies within 4 m");
        sb.Append("Status: ").Append(string.Join(", ", status)).Append('\n');
        if (state.CoverDistanceM >= 0) sb.Append(Inv, $"Cover: nearest pillar {state.CoverDistanceM:0.0} m away\n");
        if (state.Stamina >= 0)
        {
            // Sprinting and bursts spend it, resting refills it, and an empty reserve means slow, weak legs.
            var feel = state.Stamina >= 70 ? "fresh" : state.Stamina >= 35 ? "tiring" : state.Stamina >= 15 ? "winded" : "exhausted, cannot sprint";
            sb.Append(Inv, $"Stamina: {state.Stamina}% ({feel})\n");
        }

        // Catalog order, not client order, so the same situation always reads the same way.
        foreach (var focus in PoJevArenaCatalog.TargetFoci)
        {
            var match = candidates.FindIndex(c => c.Candidate.Focus == focus.Id);
            if (match < 0) continue;
            var (candidate, creature) = candidates[match];
            sb.Append(focus.Label).Append(": ").Append(candidate.Unit).Append(" \"").Append(creature.Name).Append('"')
              .Append(Inv, $" (Dist: {candidate.DistanceM:0.0} m, HP: {candidate.HpPercent}%, Abilities: ")
              .Append(creature.Abilities.Length == 0 ? "melee only" : string.Join(", ", creature.Abilities))
              .Append(")\n");
        }

        var (allies, enemies) = blue ? (state.BlueAlive, state.RedAlive) : (state.RedAlive, state.BlueAlive);
        sb.Append(Inv, $"Team Counts: {allies} {(blue ? "Blue" : "Red")} alive vs {enemies} {(blue ? "Red" : "Blue")} alive");
        return sb.ToString();
    }

    private static string Describe(ArenaCatalogEntry[] catalog, string id)
    {
        var entry = Array.Find(catalog, e => e.Id == id);
        return entry is null ? id : $"{entry.Id} ({entry.Summary.ToLowerInvariant()})";
    }

    private static Dictionary<string, JevQuestion> Questions(
        ArenaCreature subject,
        List<(ArenaCandidate Candidate, ArenaCreature Creature)> candidates)
    {
        var actions = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var action in PoJevArenaCatalog.BaseActions) actions[action.Option] = action.JevCriterion;
        foreach (var id in subject.Abilities)
        {
            var ability = PoJevArenaCatalog.FindAbility(id);
            if (ability is not null) actions[ability.JevOption] = ability.JevCriterion;
        }

        var questions = new Dictionary<string, JevQuestion>(StringComparer.Ordinal)
        {
            [ActionKey] = new("choice",
                "Select the primary manoeuvre for this unit given its stats, abilities, cooldowns and personality.",
                actions),
        };

        var foci = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var focus in PoJevArenaCatalog.TargetFoci)
        {
            if (candidates.Exists(c => c.Candidate.Focus == focus.Id)) foci[focus.Id] = focus.Summary;
        }

        // A choice with nothing to choose from is not a question; the unit keeps its last focus.
        if (foci.Count > 0)
        {
            questions[FocusKey] = new("choice",
                "Determine which entity the unit locks onto as its operational focus.", foci);
        }

        questions[PanicKey] = new("noul",
            "Has this creature broken tactical discipline and entered an uncontrollable panic state, given its panic threshold, HP and situation?",
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["true"] = "It abandons the fight and flees",
                ["false"] = "It keeps fighting under control",
            });

        return questions;
    }
}
