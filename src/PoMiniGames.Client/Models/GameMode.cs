namespace PoMiniGamesClient.Models;

/// <summary>
/// The four ways any game in the catalog can be played. This is the canonical
/// vocabulary — the route segment, the home-page chip, and each page's internal
/// branching all resolve through <see cref="GameModes.Parse"/>.
/// </summary>
public enum GameMode
{
    /// <summary>Solo against the CPU. The default when a route carries no mode.</summary>
    OnePlayer,

    /// <summary>Two players sharing one device/keyboard.</summary>
    TwoPlayer,

    /// <summary>Hub-backed online play. Always requires a live server.</summary>
    Multiplayer,

    /// <summary>Unattended attract-mode playback (the kiosk reel).</summary>
    Demo,
}

/// <summary>
/// One parser for the <c>/{game}/{mode}</c> route segment, case-insensitive. Every game
/// page resolves its mode here so they cannot disagree about what a segment means.
/// </summary>
public static class GameModes
{
    public const string OnePlayerSlug = "1player";
    public const string TwoPlayerSlug = "2player";
    public const string MultiplayerSlug = "multi";
    public const string DemoSlug = "demo";

    /// <summary>
    /// Resolve the mode from the <c>{Mode}</c> route parameter. Anything unrecognised,
    /// including null or empty, reads as <see cref="GameMode.OnePlayer"/>: the only mode
    /// that is playable for every game and never auto-starts.
    /// </summary>
    public static GameMode Parse(string? routeSegment) => routeSegment?.ToLowerInvariant() switch
    {
        DemoSlug => GameMode.Demo,
        TwoPlayerSlug => GameMode.TwoPlayer,
        MultiplayerSlug => GameMode.Multiplayer,
        _ => GameMode.OnePlayer,
    };

    /// <summary>The canonical URL segment for a mode.</summary>
    public static string ToSlug(GameMode mode) => mode switch
    {
        GameMode.TwoPlayer => TwoPlayerSlug,
        GameMode.Multiplayer => MultiplayerSlug,
        GameMode.Demo => DemoSlug,
        _ => OnePlayerSlug,
    };

    /// <summary>Short label for the mode chip on the home page.</summary>
    public static string ToLabel(GameMode mode) => mode switch
    {
        GameMode.TwoPlayer => "2P",
        GameMode.Multiplayer => "Online",
        GameMode.Demo => "Demo",
        _ => "1P",
    };

    /// <summary>Accessible name for the mode chip; the short label alone is not one.</summary>
    public static string ToDescription(GameMode mode) => mode switch
    {
        GameMode.TwoPlayer => "2 players, one device",
        GameMode.Multiplayer => "Online multiplayer",
        GameMode.Demo => "Watch a demo",
        _ => "1 player vs CPU",
    };

    /// <summary>
    /// Long-form mode name for a page heading (<c>Connect Five · 2 Players</c>).
    /// </summary>
    /// <remarks>
    /// Distinct from <see cref="ToLabel"/>, which is the terse chip on the home card
    /// ("2P") and is sized for a chip, not a title. Every game title should compose
    /// through this so the mode is readable in the top bar: a heading that names the
    /// game but not the mode cannot tell a player which of the three Connect Five
    /// routes a shared link dropped them into. It exists because the pages had started
    /// inventing their own headings — "Voxel Strike · Co-op", "PoEcosystem · A living
    /// island" — which left twelve of sixteen games with no mode in the title at all.
    /// </remarks>
    public static string ToHeading(GameMode mode) => mode switch
    {
        GameMode.TwoPlayer => "2 Players",
        GameMode.Multiplayer => "Multiplayer",
        GameMode.Demo => "Demo",
        _ => "1 Player",
    };
}
