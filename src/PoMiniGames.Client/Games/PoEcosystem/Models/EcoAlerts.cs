using System.Text.Json.Serialization;
using PoMiniGamesClient.Services.Play;

namespace PoMiniGamesClient.Games.PoEcosystem.Models;

/// <summary>
/// One alert the viewer asked for (2026-09-30): "tell me when wolves fall below 5". A rule
/// only ever reads the counts the page already receives twice a second — it watches, it
/// does not act.
/// </summary>
/// <param name="Species">0–3, or -1 for every creature alive.</param>
/// <param name="Below">True: fires when the count drops under <paramref name="Value"/>; false: when it rises over it.</param>
public sealed record EcoAlertRule(int Species, bool Below, int Value)
{
    public string Describe() =>
        $"{(Species < 0 ? "All creatures" : EcoSpeciesInfo.PluralOf(Species))} {(Below ? "below" : "above")} {Value}";

    public bool Holds(EcoStats s)
    {
        var n = Species < 0 ? s.Alive : s.Counts is { Length: EcoSpeciesInfo.Count } c ? c[Species] : 0;
        return Below ? n < Value : n > Value;
    }
}

/// <summary>
/// The viewer's alert rules (localStorage <c>poeco:alerts</c>, kept across islands) and the
/// edge detection that turns a standing condition into one alert: a rule fires when it
/// starts to hold and re-arms once it stops.
/// </summary>
public sealed class EcoAlertBook
{
    private const string StorageKey = "poeco:alerts";
    public const int MaxRules = 8;
    private readonly List<EcoAlertRule> _rules;
    private readonly HashSet<EcoAlertRule> _holding = [];
    private bool _primed;

    public EcoAlertBook()
    {
        EcoAlertRule[]? saved = null;
        try { saved = LocalStorageService.GetItem(StorageKey, EcoAlertJsonContext.Default.EcoAlertRuleArray); } catch { /* storage off */ }
        _rules = [.. (saved ?? []).Take(MaxRules)];
    }

    public IReadOnlyList<EcoAlertRule> Rules => _rules;

    public bool Add(EcoAlertRule rule)
    {
        if (_rules.Count >= MaxRules || _rules.Contains(rule)) return false;
        _rules.Add(rule);
        Save();
        return true;
    }

    public void Remove(EcoAlertRule rule)
    {
        if (_rules.Remove(rule)) { _holding.Remove(rule); Save(); }
    }

    /// <summary>A new island: whatever holds on its first stats message is its starting state, not news.</summary>
    public void ResetWorld() { _holding.Clear(); _primed = false; }

    /// <summary>The rules that have just started to hold.</summary>
    public List<EcoAlertRule> Observe(EcoStats stats)
    {
        var fired = new List<EcoAlertRule>();
        foreach (var rule in _rules)
        {
            if (rule.Holds(stats)) { if (_holding.Add(rule) && _primed) fired.Add(rule); }
            else _holding.Remove(rule);
        }
        _primed = true;
        return fired;
    }

    private void Save()
    {
        try { LocalStorageService.SetItem(StorageKey, _rules.ToArray(), EcoAlertJsonContext.Default.EcoAlertRuleArray); } catch { /* best effort */ }
    }
}

[JsonSerializable(typeof(EcoAlertRule[]))]
internal sealed partial class EcoAlertJsonContext : JsonSerializerContext;
