namespace PoMiniGames.Shared.Games;

// ──────────────────────────────  Roster  ─────────────────────────────

/// <summary>One playable family member.</summary>
/// <param name="Key">Runtime key, matching the wwwroot/images/PoSports/&lt;key&gt; sprite directory.</param>
/// <param name="IdleCols">Columns in the character's idle sprite sheet (square grid of 256 px frames) — the pickers crop frame 0 out of it as the portrait.</param>
public sealed record PoSportsCharacter(string Key, string Name, string Emoji, int IdleCols = 8);

/// <summary>
/// The playable roster — the one place a character is declared. The server validates score
/// submissions and lobby picks against <see cref="Keys"/>; the lobby and race pages render
/// from <see cref="All"/>.
/// </summary>
/// <remarks>
/// This lived as four hand-synced copies (server constants, both razor pages, the asset
/// script). Adding a character to the client copies alone made character select work while
/// every score POST 400'd — and since the client swallows non-success responses, scores
/// silently stopped persisting. Add a member HERE, then add its sprite directory.
/// </remarks>
public static class PoSportsRoster
{
    public static readonly IReadOnlyList<PoSportsCharacter> All =
    [
        new("kim", "Kim", "👧"),
        new("matt", "Matt", "👦"),
        new("nick", "Nick", "🧒", IdleCols: 5),
        new("tong", "Tong", "🧑"),
    ];

    public static readonly IReadOnlyList<string> Keys = All.Select(c => c.Key).ToList();

    public static bool IsKnown(string key) => Keys.Contains(key);

    /// <summary>Emoji for a character key, or a placeholder for an unknown one.</summary>
    public static string Emoji(string key) =>
        All.FirstOrDefault(c => c.Key == key)?.Emoji ?? "❔";

    /// <summary>Display name for a character key, falling back to the key itself.</summary>
    public static string Name(string key) =>
        All.FirstOrDefault(c => c.Key == key)?.Name ?? key;
}

// ──────────────────────────────  Controls  ───────────────────────────

/// <summary>One local keyboard layout: the four sequence keys in order, plus the jump key.</summary>
public sealed record PoSportsKeyLayout(int Layout, IReadOnlyList<string> Sequence, string Jump);

/// <summary>
/// Display labels for the two local layouts. <c>wwwroot/js/posports/input.js</c> owns the
/// real bindings (as KeyboardEvent codes); this mirrors them for the HUD progress dots,
/// the touch pad, and the how-to-play copy, and the pairing is pinned by a test.
/// Previously these letters were re-typed in the razor markup, so a rebind in input.js
/// left the on-screen tutorial teaching keys that no longer did anything.
/// </summary>
public static class PoSportsLayouts
{
    public static readonly IReadOnlyList<PoSportsKeyLayout> All =
    [
        new(1, ["Q", "W", "A", "S"], "E"),
        new(2, ["I", "O", "K", "L"], "P"),
    ];

    /// <summary>Layout by number, falling back to player 1's.</summary>
    public static PoSportsKeyLayout For(int? layout) =>
        All.FirstOrDefault(l => l.Layout == layout) ?? All[0];
}

// ──────────────────────────────  Lobby  ──────────────────────────────

// The lobby state and event records live in LobbyShared.cs (LobbyState<PoSportsLobbyMember>,
// LobbyEvent) since 2026-09-14 — one wire shape for every ready/start lobby.
public sealed record PoSportsLobbyMember(
    string ConnectionId,
    string DisplayName,
    bool IsGuest,
    /// <summary>Character key (kim|matt|nick|tong), "" until picked. First-come lock.</summary>
    string Character,
    bool IsReady) : ILobbyPlayer;

// ──────────────────────────────  Race  ──────────────────────────────

/// <summary>One lane's state inside a snapshot. Positions in meters from the start line.</summary>
public sealed record PoSportsLaneState(
    int Lane,
    string Name,
    string Character,
    bool IsAi,
    double Position,
    double Speed,
    /// <summary>Index of the next expected sequence key, 0-3 — drives the HUD progress dots.</summary>
    int SeqProgress,
    bool Airborne,
    bool Stumbling,
    /// <summary>Elapsed time on the current leg including stumble penalties, seconds.</summary>
    double LegTime,
    bool Finished,
    /// <summary>Sprint leg time once that leg is done, else -1.</summary>
    double SprintSeconds,
    /// <summary>Hurdles leg time once the meet is done, else -1.</summary>
    double HurdlesSeconds,
    /// <summary>Final placing 1-4 once the meet is done, else 0.</summary>
    int Placing);

/// <summary>
/// Reply to <c>JoinRace</c>: the meet's current state plus which lane (if any) the caller
/// owns. The lane index is authoritative — the client used to identify itself by matching
/// its local player name against lane names, which bound the HUD to the wrong runner (or
/// to nobody) whenever the two name sources disagreed.
/// </summary>
/// <param name="Lane">Owned lane index, or -1 for a spectator.</param>
public sealed record PoSportsJoinResult(int Lane, PoSportsSnapshot Snapshot);

/// <summary>
/// Server-authoritative snapshot of the whole meet. Broadcast hub → client at ~15 Hz;
/// the client renders remote lanes by interpolating between the last two snapshots.
/// </summary>
public sealed record PoSportsSnapshot(
    /// <summary>countdown | sprint | interstitial | hurdles | podium</summary>
    string Phase,
    /// <summary>Seconds remaining in countdown/interstitial, or elapsed leg clock.</summary>
    double Clock,
    IReadOnlyList<PoSportsLaneState> Lanes);
