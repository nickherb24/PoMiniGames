using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoRacer;

public static class PoRacerTrackRegistry
{
    private static readonly Dictionary<string, PoRacerTrackData> _tracks = new(StringComparer.OrdinalIgnoreCase);

    static PoRacerTrackRegistry()
    {
        Register(BuildCircuit());
        Register(BuildNeonSkyline());
        Register(BuildDesertDustway());
    }

    private static void Register(PoRacerTrackData track) => _tracks[track.Id] = track;

    public static PoRacerTrackData GetTrack(string? trackId)
    {
        if (!string.IsNullOrWhiteSpace(trackId) && _tracks.TryGetValue(trackId, out var track))
        {
            return track;
        }
        return _tracks["circuit"];
    }

    private static PoRacerTrackData BuildCircuit()
    {
        const double trackWidth = 230.0;
        var centerline = ResampleClosedSpline(Knots("circuit"), 10);
        var walls = GenerateWalls(centerline, trackWidth);

        var surfaces = new List<PoRacerSurfaceZoneDefinition>
        {
            new() { Name = "Main Tarmac", SurfaceType = SurfaceKind.Asphalt, Center = new Vec2(600, 390), Radius = 2000.0, GripMultiplier = 1.0 }
        };

        return new PoRacerTrackData
        {
            Id = "circuit",
            DisplayName = PoRacerCatalog.GetTrack("circuit").Name,
            Description = PoRacerCatalog.GetTrack("circuit").Description,
            TrackWidth = trackWidth,
            Centerline = centerline,
            Walls = walls,
            // One on each straight.
            BoostPads = [PadAt(centerline, 0.10), PadAt(centerline, 0.60)],
            SurfaceZones = surfaces,
            EnvironmentTheme = "circuit"
        };
    }

    private static PoRacerTrackData BuildNeonSkyline()
    {
        const double trackWidth = 210.0;
        var centerline = ResampleClosedSpline(Knots("neonskyline"), 12);
        var walls = GenerateWalls(centerline, trackWidth);

        var surfaces = new List<PoRacerSurfaceZoneDefinition>
        {
            new() { Name = "Cyber Tarmac", SurfaceType = SurfaceKind.Asphalt, Center = new Vec2(900, 400), Radius = 2500.0, GripMultiplier = 1.0 }
        };

        return new PoRacerTrackData
        {
            Id = "neonskyline",
            DisplayName = PoRacerCatalog.GetTrack("neonskyline").Name,
            Description = PoRacerCatalog.GetTrack("neonskyline").Description,
            TrackWidth = trackWidth,
            Centerline = centerline,
            Walls = walls,
            // The fastest arc of each loop, well clear of the crossing.
            BoostPads = [PadAt(centerline, 0.16), PadAt(centerline, 0.69)],
            SurfaceZones = surfaces,
            EnvironmentTheme = "neonskyline"
        };
    }

    private static PoRacerTrackData BuildDesertDustway()
    {
        const double trackWidth = 255.0;
        var centerline = ResampleClosedSpline(Knots("desertdustway"), 14);
        var walls = GenerateWalls(centerline, trackWidth);

        // Sand zones in the outer hairpin run-off areas
        var surfaces = new List<PoRacerSurfaceZoneDefinition>
        {
            new() { Name = "Dune Run-off East", SurfaceType = SurfaceKind.Sand, Center = new Vec2(1850, 500), Radius = 260.0, GripMultiplier = 0.65 },
            new() { Name = "Dune Run-off West", SurfaceType = SurfaceKind.Sand, Center = new Vec2(-150, 800), Radius = 240.0, GripMultiplier = 0.65 }
        };

        return new PoRacerTrackData
        {
            Id = "desertdustway",
            DisplayName = PoRacerCatalog.GetTrack("desertdustway").Name,
            Description = PoRacerCatalog.GetTrack("desertdustway").Description,
            TrackWidth = trackWidth,
            Centerline = centerline,
            Walls = walls,
            // The front straight and the long back straight.
            BoostPads = [PadAt(centerline, 0.07), PadAt(centerline, 0.46)],
            SurfaceZones = surfaces,
            EnvironmentTheme = "desertdustway"
        };
    }

    /// <summary>
    /// A boost pad on the centerline at a fraction of the lap, pointing the way the track runs
    /// there. Every track needs pads, because the start card tells drivers to aim for them.
    /// </summary>
    private static PoRacerBoostPadDefinition PadAt(IReadOnlyList<Vec2> line, double lapFraction)
    {
        int i = (int)(lapFraction * line.Count) % line.Count;
        var a = line[i];
        var b = line[(i + 1) % line.Count];
        return new() { Position = a, Radius = 46, DirectionAngle = Math.Atan2(b.Y - a.Y, b.X - a.X) };
    }

    // Knots live in the shared catalog so the client draws its track cards from the same points.
    private static List<Vec2> Knots(string id) => PoRacerCatalog.GetTrack(id).Knots.Select(p => new Vec2(p.X, p.Y)).ToList();

    private static List<Vec2> ResampleClosedSpline(IReadOnlyList<Vec2> knots, int stepsPerSegment)
    {
        var result = new List<Vec2>(knots.Count * stepsPerSegment);
        int n = knots.Count;
        for (int i = 0; i < n; i++)
        {
            var p0 = knots[(i - 1 + n) % n];
            var p1 = knots[i];
            var p2 = knots[(i + 1) % n];
            var p3 = knots[(i + 2) % n];
            for (int s = 0; s < stepsPerSegment; s++)
            {
                double t = s / (double)stepsPerSegment;
                double t2 = t * t, t3 = t2 * t;
                double x = 0.5 * ((2 * p1.X) + (-p0.X + p2.X) * t + (2 * p0.X - 5 * p1.X + 4 * p2.X - p3.X) * t2 + (-p0.X + 3 * p1.X - 3 * p2.X + p3.X) * t3);
                double y = 0.5 * ((2 * p1.Y) + (-p0.Y + p2.Y) * t + (2 * p0.Y - 5 * p1.Y + 4 * p2.Y - p3.Y) * t2 + (-p0.Y + 3 * p1.Y - 3 * p2.Y + p3.Y) * t3);
                result.Add(new Vec2(x, y));
            }
        }
        return result;
    }

    private static List<(Vec2 a, Vec2 b)> GenerateWalls(IReadOnlyList<Vec2> centerline, double trackWidth)
    {
        var walls = new List<(Vec2 a, Vec2 b)>(centerline.Count * 2);
        int n = centerline.Count;
        double hw = trackWidth * 0.5;

        for (int i = 0; i < n; i++)
        {
            var a = centerline[i];
            var b = centerline[(i + 1) % n];
            var norm = ComputeNormal(a, b);

            var leftA = new Vec2(a.X - norm.X * hw, a.Y - norm.Y * hw);
            var leftB = new Vec2(b.X - norm.X * hw, b.Y - norm.Y * hw);
            var rightA = new Vec2(a.X + norm.X * hw, a.Y + norm.Y * hw);
            var rightB = new Vec2(b.X + norm.X * hw, b.Y + norm.Y * hw);

            walls.Add((leftA, leftB));
            walls.Add((rightA, rightB));
        }
        return walls;
    }

    public static Vec2 ComputeNormal(Vec2 a, Vec2 b)
    {
        double dx = b.X - a.X, dy = b.Y - a.Y;
        double len = Math.Sqrt(dx * dx + dy * dy);
        if (len < 1e-9) return new Vec2(0, 1);
        return new Vec2(-dy / len, dx / len);
    }
}
