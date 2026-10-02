namespace PoMiniGames.Shared.Games;

/// <summary>
/// Display metadata for the four themed PoCabinet tracks. Geometry (knots, width,
/// atmosphere) lives next door in <see cref="PoCabinetTrackGeometry"/>, keyed by the same ids.
/// Track ids are lower-case, kebab-friendly strings safe for URL paths.
/// </summary>
public sealed record PoCabinetTrackInfo(string Id, string Name, string Description);

public static class PoCabinetCatalog
{
    /// <summary>Race laps on a circuit. Matches PoRacer's per-race length so leaderboard comparisons are
    /// apples-to-apples. A track can say otherwise (<see cref="PoCabinetTrackDefinition.Laps"/>): the
    /// point-to-point Playground run is 1.</summary>
    public const int TotalLaps = 3;

    /// <summary>Seats in a multiplayer race (players + AI officials). The per-tick snapshot is
    /// budgeted for this many cars, which is why online did not grow with the solo field.</summary>
    public const int CarCount = 8;

    /// <summary>Cars in a solo or demo race: 99 rivals and the player. The whole
    /// race runs in the browser, so only the lap verifier pays for it server-side.</summary>
    public const int SoloCarCount = 100;

    /// <summary>The player's grid slot in a solo race: mid-pack, quicker cars ahead and slower
    /// behind. Rival i takes slot i, or i + 1 from here back. Mirrors physics.js PLAYER_SLOT.</summary>
    public const int SoloPlayerSlot = 50;

    /// <summary>Solo places that mean something, now that "the podium" is 3 of 100 and the
    /// player starts 51st: the top ten earn the fanfare and count as a win, a top-quarter finish
    /// clears a campaign stage, and a top-ten finish in the final race wins the trophy. Set from
    /// headless runs in the real page with the throttle held and both driver aids on, which
    /// finished 4th-25th on the circuits and 15th on the Playground run: a stage takes a little
    /// more than that, the trophy takes driving.</summary>
    public const int SoloFrontRunners = 10;
    public const int CampaignPassPlace = 25;
    public const int CampaignTrophyPlace = 10;

    /// <summary>Default track when none is specified (matches the championship opening leg).</summary>
    public const string DefaultTrackId = "capitol";

    public static IReadOnlyList<PoCabinetTrackInfo> Tracks { get; } = Array.AsReadOnly(new[]
    {
        new PoCabinetTrackInfo(
            "capitol",
            "Capitol Speedway",
            "Asphalt oval framed by marble columns and gold trim. Government-building backdrop."),
        new PoCabinetTrackInfo(
            "maralago",
            "Mar-a-Lago Grand Prix",
            "Palm-lined beachside course with golf-course greens and ocean mist."),
        new PoCabinetTrackInfo(
            "pressbriefing",
            "Press Briefing 500",
            "Podium-shaped stadium with press-box grandstands and klieg lights."),
        new PoCabinetTrackInfo(
            "playground",
            "Playground Marble Run",
            "Point-to-point down a giant play structure's marble run: off the top, round the banked turns, down the slide to the finish tray. One run."),
    });

    public static PoCabinetTrackInfo GetTrack(string? id) =>
        Tracks.FirstOrDefault(t => string.Equals(t.Id, id?.Trim(), StringComparison.OrdinalIgnoreCase)) ?? Tracks[0];

    public static bool IsKnownTrack(string? id) =>
        Tracks.Any(t => string.Equals(t.Id, id?.Trim(), StringComparison.OrdinalIgnoreCase));
}
