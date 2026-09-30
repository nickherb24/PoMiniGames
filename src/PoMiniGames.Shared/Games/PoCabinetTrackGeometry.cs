namespace PoMiniGames.Shared.Games;

/// <summary>
/// Knots, road width and atmosphere for one PoCabinet track. <see cref="PoCabinetTrackGeometry"/>
/// is the ONE place these live: the server sim, the solo in-browser race and the client
/// scene/minimap all derive their centerline from here. Until 2026-09-23 the client drew
/// hand-made ellipses while the server simulated these splines, so the road a player saw
/// was never the road any race was run on.
/// </summary>
public sealed record PoCabinetTrackDefinition(
    string Id,
    double TrackWidth,
    IReadOnlyList<(double X, double Y)> Knots,
    int StepsPerSegment,
    PoCabinetAtmosphereWire Atmosphere);

/// <summary>
/// Shared track geometry. World units are the sim's: car radius 14, speeds in units/s
/// (<c>PoCabinetPhysics</c> on the server, <c>js/pocabinet/physics.js</c> in the browser).
/// The scene divides by 10 when it builds meshes.
/// </summary>
public static class PoCabinetTrackGeometry
{
    /// <summary>Knot scale. The hand-tuned knots were authored at a size that made a lap ~45 s at
    /// sim top speed; 0.75 lands laps near 25–30 s, which is what a 3-lap arcade race wants.</summary>
    private const double KnotScale = 0.75;

    private static readonly Dictionary<string, PoCabinetTrackDefinition> Definitions =
        new(StringComparer.OrdinalIgnoreCase)
        {
            ["capitol"] = new(
                "capitol",
                TrackWidth: 110,
                Knots: Scale(
                [
                    (0, 0), (380, 0), (760, 0), (1100, 60), (1300, 220), (1340, 420), (1220, 600),
                    (1000, 700), (700, 720), (380, 720), (60, 700), (-160, 600), (-280, 420),
                    (-260, 220), (-140, 60),
                ]),
                StepsPerSegment: 12,
                Atmosphere: new PoCabinetAtmosphereWire
                {
                    // Daytime (2026-09-29; was a dark dusk that made the race hard to read).
                    SkyHex = "#8fb8e0",
                    FogStart = 260,
                    FogEnd = 1100,
                    FogHex = "#a9c6e0",
                    AmbientIntensity = 0.7,
                    GroundHex = "#3f6a2e",
                    RoadHex = "#44464d",
                    AccentHex = "#c6a35a",
                }),
            ["maralago"] = new(
                "maralago",
                TrackWidth: 120,
                Knots: Scale(
                [
                    (0, 0), (450, 0), (900, -40), (1300, -180), (1500, -400), (1450, -640),
                    (1200, -800), (800, -840), (400, -800), (50, -700), (-220, -540), (-300, -340),
                    (-220, -150), (-50, -20),
                ]),
                StepsPerSegment: 14,
                Atmosphere: new PoCabinetAtmosphereWire
                {
                    SkyHex = "#79a9d3",
                    FogStart = 260,
                    FogEnd = 1100,
                    FogHex = "#79a9d3",
                    AmbientIntensity = 0.7,
                    GroundHex = "#c2c98a",
                    RoadHex = "#6b675e",
                    AccentHex = "#f0e6c8",
                }),
            ["pressbriefing"] = new(
                "pressbriefing",
                TrackWidth: 105,
                Knots: Scale(
                [
                    (0, 0), (300, 50), (600, 120), (900, 240), (1100, 380), (1180, 540), (1100, 700),
                    (900, 820), (600, 860), (300, 820), (50, 720), (-130, 580), (-180, 400),
                    (-100, 240), (50, 100),
                ]),
                StepsPerSegment: 12,
                Atmosphere: new PoCabinetAtmosphereWire
                {
                    // Daytime (2026-09-29; was a night scene) — a sunlit stone plaza.
                    SkyHex = "#9cc0e4",
                    FogStart = 240,
                    FogEnd = 1000,
                    FogHex = "#b4cbe0",
                    AmbientIntensity = 0.7,
                    GroundHex = "#8a7f78",
                    RoadHex = "#3f3f47",
                    AccentHex = "#c1253b",
                }),
        };

    /// <summary>Definition for <paramref name="trackId"/>, or the default track when unknown.</summary>
    public static PoCabinetTrackDefinition Get(string? trackId) =>
        !string.IsNullOrWhiteSpace(trackId) && Definitions.TryGetValue(trackId.Trim(), out var def)
            ? def
            : Definitions[PoCabinetCatalog.DefaultTrackId];

    /// <summary>
    /// Closed Catmull-Rom resample of the knots, as a flat <c>[x0, y0, x1, y1, …]</c> array.
    /// Deterministic: both ends of the wire call this and get bit-identical doubles.
    /// </summary>
    public static double[] BuildCenterlineXY(PoCabinetTrackDefinition def)
    {
        var knots = def.Knots;
        int n = knots.Count;
        int steps = def.StepsPerSegment;
        var xy = new double[n * steps * 2];
        int k = 0;
        for (int i = 0; i < n; i++)
        {
            var p0 = knots[(i - 1 + n) % n];
            var p1 = knots[i];
            var p2 = knots[(i + 1) % n];
            var p3 = knots[(i + 2) % n];
            for (int s = 0; s < steps; s++)
            {
                double t = s / (double)steps;
                double t2 = t * t, t3 = t2 * t;
                xy[k++] = 0.5 * ((2 * p1.X) + (-p0.X + p2.X) * t + (2 * p0.X - 5 * p1.X + 4 * p2.X - p3.X) * t2 + (-p0.X + 3 * p1.X - 3 * p2.X + p3.X) * t3);
                xy[k++] = 0.5 * ((2 * p1.Y) + (-p0.Y + p2.Y) * t + (2 * p0.Y - 5 * p1.Y + 4 * p2.Y - p3.Y) * t2 + (-p0.Y + 3 * p1.Y - 3 * p2.Y + p3.Y) * t3);
            }
        }
        return xy;
    }

    /// <summary>
    /// The static world payload: what the scene, minimap and in-browser sim mount against,
    /// and what the race hub hands a joining client. Built on demand — it is a few KB and
    /// the client caches nothing it could get wrong.
    /// </summary>
    public static PoCabinetStaticWorld BuildStaticWorld(string? trackId)
    {
        var def = Get(trackId);
        var xy = BuildCenterlineXY(def);
        double minX = double.MaxValue, minY = double.MaxValue, maxX = double.MinValue, maxY = double.MinValue;
        for (int i = 0; i < xy.Length; i += 2)
        {
            minX = Math.Min(minX, xy[i]);
            maxX = Math.Max(maxX, xy[i]);
            minY = Math.Min(minY, xy[i + 1]);
            maxY = Math.Max(maxY, xy[i + 1]);
        }
        return new PoCabinetStaticWorld
        {
            TrackId = def.Id,
            TrackName = PoCabinetCatalog.GetTrack(def.Id).Name,
            Atmosphere = def.Atmosphere,
            CenterXY = xy,
            TrackWidth = def.TrackWidth,
            MinX = minX,
            MinY = minY,
            MaxX = maxX,
            MaxY = maxY,
            TotalLaps = PoCabinetCatalog.TotalLaps,
        };
    }

    private static (double X, double Y)[] Scale((double X, double Y)[] knots) =>
        knots.Select(k => (k.X * KnotScale, k.Y * KnotScale)).ToArray();
}
