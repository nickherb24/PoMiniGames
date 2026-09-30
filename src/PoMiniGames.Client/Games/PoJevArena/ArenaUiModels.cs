using System.Text.Json.Serialization;
using PoMiniGames.Shared.Games.PoJevArena;

namespace PoMiniGamesClient.Games.PoJevArena;

// Payloads the engine (js/pojevarena/index.js) sends back through [JSInvokable] callbacks, as JSON
// strings deserialised with the source-generated context below (trim-safe; no reflection JSON).

/// <summary>One Jev answer as the Black Box recorded it (see blackbox.js recordDecision).</summary>
public sealed record ArenaDecisionView(
    int Frame,
    int Unit,
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

/// <summary>The selected unit on one side, and the Jev distribution governing it at this frame.</summary>
public sealed record ArenaInspectorView(
    string Unit,
    int Index,
    string Team,
    string Name,
    string CreatureId,
    int Hp,
    int MaxHp,
    bool Alive,
    string Action,
    string? Target,
    double StaleSeconds,
    int Frame,
    string Mode,
    ArenaDecisionView? Decision,
    int Stamina = 100);

/// <summary>~4 Hz battle telemetry. <see cref="BlueHp"/>/<see cref="RedHp"/> are each side's share of its full HP, 0..1.</summary>
public sealed record ArenaHudView(
    double Time,
    int BlueAlive,
    int RedAlive,
    int Calls,
    long? Remaining,
    string[] Notices,
    string? Stopped,
    double BlueHp = 1,
    double RedHp = 1,
    string? Arena = null);

/// <summary>A knockout on the Black Box timeline.</summary>
public sealed record ArenaKo(int Frame, string Team);

/// <summary>
/// The whistle. <see cref="Units"/> are every unit's numbers by slot (Blue 0-9, Red 10-19),
/// <see cref="Mvp"/> the engine's pick (-1 for none), <see cref="Clip"/> whether a kill-cam clip
/// was recorded for sharing.
/// </summary>
public sealed record ArenaMatchEndView(
    string Winner,
    string Reason,
    double DurationSeconds,
    int BlueAlive,
    int RedAlive,
    int Calls,
    int Decisions,
    int Frames,
    ArenaDebrief? Debrief = null,
    ArenaUnitStats[]? Units = null,
    int Mvp = -1,
    ArenaKo[]? Kos = null,
    bool Clip = false,
    string? Arena = null);

// ── Jev debrief (js/pojevarena/debrief.js) ──────────────────────────────────

/// <summary>How often one option was chosen, as a count and a share of that team's calls.</summary>
public sealed record ArenaShare(string Key, int Count, double Share);

/// <summary>A decision worth revisiting: <c>surest</c>, <c>torn</c> (closest call) or <c>first-panic</c>.</summary>
public sealed record ArenaMoment(
    string Kind,
    int Frame,
    int UnitIndex,
    string Unit,
    string Name,
    string? Action,
    double Confidence,
    string? RunnerUp,
    double RunnerUpProbability,
    double Panic);

public sealed record ArenaTeamDebrief(
    int Decisions,
    int Failures,
    double AverageConfidence,
    int AverageLatencyMs,
    int CoinFlips,
    ArenaShare[] Actions,
    ArenaShare[] Foci,
    int PanicDecisions,
    int PanickedUnits,
    double PeakPanic,
    int Survivors,
    ArenaMoment[] Moments);

/// <summary>One stretch of a unit's life on the same chosen action (debrief.js folds one-call blips in).</summary>
public sealed record ArenaPhase(string Action, int FromFrame, int ToFrame, int Calls, int? HpPercent, double Confidence);

/// <summary>
/// One unit's lifetime as Jev ran it: when and to whom it fell (no killer = poison or tar), its
/// phases of thinking, its habits and its numbers. Frames are 60 Hz Black Box frames.
/// </summary>
public sealed record ArenaUnitStory(
    int Index,
    string Unit,
    string Name,
    string Team,
    bool Survived,
    int DiedAtFrame,
    string? Killer,
    string? KillerName,
    int HpPercent,
    int Kills,
    int Damage,
    int Healed,
    int Decisions,
    int Failures,
    double AverageConfidence,
    int CoinFlips,
    int Switches,
    ArenaPhase[] Phases,
    string? TopFocus,
    double TopFocusShare,
    int Panics,
    int FirstPanicFrame,
    int EndFrame,
    int WindedFrame = -1);

/// <summary>What each team was "thinking", and each unit's story: computed from the Black Box log, no extra Jev calls.</summary>
public sealed record ArenaDebrief(ArenaTeamDebrief Blue, ArenaTeamDebrief Red, ArenaUnitStory[]? Units = null);


public sealed record ArenaBlackBoxView(int Frame, int Frames, double Seconds, bool Playing, double Speed, int Decisions);

/// <summary>
/// What the page remembers between visits: the last two rosters as creature snapshots, so a
/// creature outside the current library page is never mistaken for a deleted one. The server
/// re-resolves every id at deploy, so a stale snapshot cannot put an outdated design in a match.
/// </summary>
public sealed record ArenaSavedRosters(ArenaCreature?[] Blue, ArenaCreature?[] Red);

/// <summary>A named squad saved from either team column (localStorage), loadable into either.</summary>
public sealed record ArenaSquad(string Name, ArenaCreature?[] Slots);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, PropertyNameCaseInsensitive = true)]
[JsonSerializable(typeof(ArenaInspectorView))]
[JsonSerializable(typeof(ArenaHudView))]
[JsonSerializable(typeof(ArenaMatchEndView))]
[JsonSerializable(typeof(ArenaBlackBoxView))]
[JsonSerializable(typeof(ArenaSavedRosters))]
[JsonSerializable(typeof(List<ArenaSquad>))]

internal sealed partial class ArenaUiJsonContext : JsonSerializerContext
{
}
