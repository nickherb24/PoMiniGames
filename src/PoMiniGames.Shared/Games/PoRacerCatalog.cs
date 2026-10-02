namespace PoMiniGames.Shared.Games;

/// <summary>
/// One track: its copy, its medal laps (seconds, best lap of a race) and the spline knots.
/// Medals are set against measured laps (a scripted keyboard driver, time trial) and
/// the floor a car can physically do: the centerline flat out at 320 units/s is 16.0 / 17.5 /
/// 17.7 s on the three tracks, and an inside line beats that. Gold needs a mostly clean lap on
/// the inside line, silver is a tidy centerline lap, bronze is getting round with a few hits.
/// The knots live here, not in the API's track registry, so the server sim and the client's
/// track-card outline are drawn from the same sixteen-odd points.
/// </summary>
public sealed record PoRacerTrackInfo(
    string Id, string Name, string Description,
    double Gold, double Silver, double Bronze,
    IReadOnlyList<(double X, double Y)> Knots)
{
    /// <summary>"gold" / "silver" / "bronze" for a lap that earns one, otherwise null.</summary>
    public string? Medal(double lapSeconds) =>
        !double.IsFinite(lapSeconds) || lapSeconds <= 0 ? null
        : lapSeconds <= Gold ? "gold" : lapSeconds <= Silver ? "silver" : lapSeconds <= Bronze ? "bronze" : null;
}

public static class PoRacerCatalog
{
    public const int TotalLaps = 3;
    public const int CarCount = 8;
    public const string DefaultTrackId = "circuit";
    public static readonly IReadOnlyList<string> Liveries = ["stripe", "dual", "carbon", "neon"];
    public static readonly IReadOnlyList<string> Difficulties = ["easy", "medium", "hard"];

    // Medal laps, measured with boost pads, the drift payout and impact damage in play
    // (a keyboard-only scripted driver through the real page, time trial): clean laps come out at
    // 14.2-14.8 s on the oval, 17.3 on the figure-8 with four wall touches, 16.6-16.8 on the rally
    // stage. Gold is a mostly clean lap on an inside line, silver a tidy one, bronze a lap with a few hits.
    public static IReadOnlyList<PoRacerTrackInfo> Tracks { get; } = Array.AsReadOnly(new[]
    {
        // Classic stadium oval — two long straights joined by tight 180° hairpins.
        new PoRacerTrackInfo("circuit", "Grand Prix Circuit", "Classic asphalt with sweeping bends and high grip.",
            Gold: 15.0, Silver: 17.5, Bronze: 22.0,
            Knots: [(0, 0), (400, 0), (800, 0), (1200, 0), (1500, 80), (1650, 280), (1650, 500), (1500, 700),
                (1200, 780), (800, 780), (400, 780), (0, 780), (-300, 700), (-450, 500), (-450, 280), (-300, 80)]),
        // Figure-8 — a wide fast loop and a tight technical one sharing the crossing at (800, 400).
        new PoRacerTrackInfo("neonskyline", "Neon Skyline", "Neon city streets with fast chicanes.",
            Gold: 17.0, Silver: 20.5, Bronze: 26.5,
            Knots: [(800, 400), (1000, 150), (1400, -50), (1800, 100), (1950, 400), (1800, 700), (1400, 850), (1000, 700),
                (800, 400), (600, 600), (300, 800), (50, 650), (-50, 400), (50, 150), (300, 0), (600, 150)]),
        // L-shaped rally stage — a long front straight, a sweeper, a hairpin and a chicane.
        new PoRacerTrackInfo("desertdustway", "Desert Dustway", "Wide hairpins and loose sand that rewards careful drifting.",
            Gold: 17.0, Silver: 21.5, Bronze: 27.5,
            Knots: [(0, 0), (700, 0), (1400, 0), (1750, 200), (1850, 500), (1750, 800), (1200, 950), (600, 950),
                (100, 950), (-150, 800), (-300, 600), (-100, 400), (-300, 200), (-200, 50)]),
    });

    public static PoRacerTrackInfo GetTrack(string? id) =>
        Tracks.FirstOrDefault(t => string.Equals(t.Id, id?.Trim(), StringComparison.OrdinalIgnoreCase)) ?? Tracks[0];
}
