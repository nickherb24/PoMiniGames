using System.Collections.Concurrent;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoCabinet;

/// <summary>Closest point on the centerline to a car. Lateral is signed: + is the right-hand side
/// of the direction of travel, i.e. along the normal (-Ty, Tx).</summary>
public readonly record struct PoCabinetTrackProjection(int Index, double Along, double Lateral, double Tx, double Ty);

/// <summary>A point at an arc-length distance along the centerline, with its unit tangent.</summary>
public readonly record struct PoCabinetTrackPoint(double X, double Y, double Tx, double Ty);

/// <summary>
/// Runtime view of one track: the resampled centerline from <see cref="PoCabinetTrackGeometry"/>
/// plus the arc-length tables and curvature the physics and AI need. Built once per track id.
///
/// <para>
/// <b>Mirror contract:</b> <c>wwwroot/js/pocabinet/track.js</c> is a line-for-line port. The
/// browser runs the same projection for solo races and for multiplayer client-side
/// prediction, so any change to the search window, the curvature smoothing or the sampling
/// step here must land there too, or predicted cars drift from the server's.
/// </para>
/// </summary>
public sealed class PoCabinetTrack
{
    /// <summary>Distance step used when scanning ahead for the tightest corner.</summary>
    public const double CurvatureSampleStep = 8;

    private static readonly ConcurrentDictionary<string, PoCabinetTrack> Cache = new(StringComparer.OrdinalIgnoreCase);

    private readonly double[] _x;
    private readonly double[] _y;
    private readonly double[] _cum;
    private readonly double[] _segLen;
    private readonly double[] _tx;
    private readonly double[] _ty;
    private readonly double[] _curv;
    private readonly bool _pointToPoint;
    private readonly double _parkAt;

    private PoCabinetTrack(PoCabinetTrackDefinition def)
    {
        Id = def.Id;
        HalfWidth = def.TrackWidth * 0.5;
        var xy = PoCabinetTrackGeometry.BuildCenterlineXY(def);
        Count = xy.Length / 2;
        _x = new double[Count];
        _y = new double[Count];
        for (int i = 0; i < Count; i++)
        {
            _x[i] = xy[i * 2];
            _y[i] = xy[i * 2 + 1];
        }

        _segLen = new double[Count];
        _cum = new double[Count + 1];
        _tx = new double[Count];
        _ty = new double[Count];
        for (int i = 0; i < Count; i++)
        {
            int j = (i + 1) % Count;
            double dx = _x[j] - _x[i], dy = _y[j] - _y[i];
            double len = Math.Sqrt(dx * dx + dy * dy);
            _segLen[i] = len;
            _cum[i + 1] = _cum[i] + len;
            _tx[i] = len > 1e-9 ? dx / len : 1;
            _ty[i] = len > 1e-9 ? dy / len : 0;
        }
        Length = _cum[Count];

        // Point-to-point (the Playground run): the lap ends at the finish knot instead of back
        // at the line, and a finished car rolls on into the run-out and parks half way down
        // it instead of taking a cool-down lap, because past the run-out there is only the
        // return link. Mirrored in track.js.
        Laps = def.Laps;
        _pointToPoint = def.FinishKnot > 0;
        LapLength = _pointToPoint ? _cum[def.FinishKnot * def.StepsPerSegment] : Length;
        _parkAt = _pointToPoint
            ? (_cum[def.FinishKnot * def.StepsPerSegment] + _cum[def.HiddenFromKnot * def.StepsPerSegment]) / 2
            : 0;

        // Curvature at each point: heading change across it over the mean adjacent segment
        // length, then a 3-point average — the raw spline samples are noisy enough that the AI
        // would otherwise brake for kinks that are not corners.
        var raw = new double[Count];
        for (int i = 0; i < Count; i++)
        {
            int p = (i - 1 + Count) % Count;
            double d = WrapAngle(Atan2(_ty[i], _tx[i]) - Atan2(_ty[p], _tx[p]));
            double span = Math.Max(1e-6, (_segLen[p] + _segLen[i]) * 0.5);
            raw[i] = Math.Abs(d) / span;
        }
        _curv = new double[Count];
        for (int i = 0; i < Count; i++)
        {
            _curv[i] = (raw[(i - 1 + Count) % Count] + raw[i] + raw[(i + 1) % Count]) / 3.0;
        }
    }

    public static PoCabinetTrack Get(string? trackId)
    {
        var def = PoCabinetTrackGeometry.Get(trackId);
        return Cache.GetOrAdd(def.Id, _ => new PoCabinetTrack(def));
    }

    public string Id { get; }
    public double HalfWidth { get; }
    public double Length { get; }
    public int Count { get; }

    /// <summary>Race distance of one lap: <see cref="Length"/> on a circuit, the distance from
    /// the line to the finish on a point-to-point track.</summary>
    public double LapLength { get; }

    /// <summary>Laps in a race here.</summary>
    public int Laps { get; }

    /// <summary>Share of its top speed a finished car at race distance <paramref name="distance"/>
    /// holds: 0.6 on a circuit; on a point-to-point track 0.6 into the run-out, then 0 (park).</summary>
    public double CoolDownAt(double distance) => Parked(distance) ? 0 : 0.6;

    /// <summary>
    /// True once a car has rolled to the parking point of a point-to-point track's run-out
    /// (never on a circuit). A parked car is out of the race for good: it no longer collides
    /// and the AI no longer sees it, or the first two dozen finishers of a 100-car field would
    /// fill the run-out and everyone behind would queue back over the finish line.
    /// </summary>
    public bool Parked(double distance) => _pointToPoint && distance >= _parkAt;

    /// <summary>
    /// Project a point onto the centerline. With a valid <paramref name="hint"/> (the segment
    /// found last tick) only a short window around it is searched; a miss that lands far off
    /// the road falls back to the full scan, so a car can never lock onto the wrong straight.
    /// </summary>
    public PoCabinetTrackProjection Project(double x, double y, int hint)
    {
        int best = -1;
        double bestD2 = double.MaxValue, bestT = 0;
        if (hint >= 0 && hint < Count)
        {
            for (int k = -6; k <= 10; k++)
            {
                int i = ((hint + k) % Count + Count) % Count;
                Consider(i, x, y, ref best, ref bestD2, ref bestT);
            }
            double limit = HalfWidth * 3;
            if (bestD2 > limit * limit) best = -1;
        }
        if (best < 0)
        {
            bestD2 = double.MaxValue;
            for (int i = 0; i < Count; i++) Consider(i, x, y, ref best, ref bestD2, ref bestT);
        }

        double px = _x[best] + _tx[best] * bestT * _segLen[best];
        double py = _y[best] + _ty[best] * bestT * _segLen[best];
        double lateral = (x - px) * -_ty[best] + (y - py) * _tx[best];
        return new PoCabinetTrackProjection(best, _cum[best] + bestT * _segLen[best], lateral, _tx[best], _ty[best]);
    }

    private void Consider(int i, double x, double y, ref int best, ref double bestD2, ref double bestT)
    {
        double len = _segLen[i];
        double t = len > 1e-9 ? ((x - _x[i]) * _tx[i] + (y - _y[i]) * _ty[i]) / len : 0;
        t = Math.Clamp(t, 0, 1);
        double px = _x[i] + _tx[i] * t * len;
        double py = _y[i] + _ty[i] * t * len;
        double d2 = (x - px) * (x - px) + (y - py) * (y - py);
        if (d2 < bestD2)
        {
            bestD2 = d2;
            best = i;
            bestT = t;
        }
    }

    /// <summary>Point at <paramref name="distance"/> along the loop (wraps both ways).</summary>
    public PoCabinetTrackPoint PointAt(double distance)
    {
        int i = IndexAt(distance);
        double d = Wrap(distance) - _cum[i];
        return new PoCabinetTrackPoint(_x[i] + _tx[i] * d, _y[i] + _ty[i] * d, _tx[i], _ty[i]);
    }

    /// <summary>Tightest smoothed curvature (radians per unit) between two distances ahead.</summary>
    public double MaxCurvature(double fromDistance, double toDistance)
    {
        double max = 0;
        for (double d = fromDistance; d <= toDistance; d += CurvatureSampleStep)
        {
            double c = _curv[IndexAt(d)];
            if (c > max) max = c;
        }
        return max;
    }

    /// <summary>Segment index containing <paramref name="distance"/> (binary search on the arc-length table).</summary>
    public int IndexAt(double distance)
    {
        double d = Wrap(distance);
        int lo = 0, hi = Count - 1;
        while (lo < hi)
        {
            int mid = (lo + hi + 1) >> 1;
            if (_cum[mid] <= d) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    }

    private double Wrap(double distance)
    {
        double d = distance % Length;
        return d < 0 ? d + Length : d;
    }

    // ── Trig the sim can rely on ────────────────────────────────────────────
    // Sin, Cos and Atan2 built from + − × ÷, floor and sqrt only, which IEEE 754 pins to the
    // last bit, so this process and every browser get the SAME double. Math.Sin and friends
    // are not pinned (Chrome and node differed by one ulp sixteen ticks into a race), and a
    // 100-car field is chaotic enough to turn one ulp into a different race by the first
    // corner — which PoCabinetLapVerifier would then time as a crash. Everything that feeds
    // the simulation uses these. Mirrored operation for operation in track.js.

    private const double HalfPi = Math.PI / 2;

    /// <summary>sin(a + quarter·π/2): reduce to within π/4 of a multiple of π/2, then the Taylor series.</summary>
    private static double SinShifted(double a, int quarter)
    {
        double k = Math.Floor(a / HalfPi + 0.5);
        double r = a - k * HalfPi;
        double r2 = r * r;
        double q = (((k + quarter) % 4) + 4) % 4;
        if (q == 0 || q == 2)
        {
            double s = r * (1 - r2 / 6 * (1 - r2 / 20 * (1 - r2 / 42 * (1 - r2 / 72 * (1 - r2 / 110 * (1 - r2 / 156 * (1 - r2 / 210)))))));
            return q == 0 ? s : -s;
        }
        double c = 1 - r2 / 2 * (1 - r2 / 12 * (1 - r2 / 30 * (1 - r2 / 56 * (1 - r2 / 90 * (1 - r2 / 132 * (1 - r2 / 182 * (1 - r2 / 240)))))));
        return q == 1 ? c : -c;
    }

    public static double Sin(double a) => SinShifted(a, 0);

    public static double Cos(double a) => SinShifted(a, 1);

    /// <summary>atan z for |z| ≤ 1: halve the angle three times, then the series.</summary>
    private static double AtanUnit(double z)
    {
        double t = z / (1 + Math.Sqrt(1 + z * z));
        t = t / (1 + Math.Sqrt(1 + t * t));
        t = t / (1 + Math.Sqrt(1 + t * t));
        double t2 = t * t;
        return 8 * t * (1 - t2 * (1.0 / 3 - t2 * (1.0 / 5 - t2 * (1.0 / 7 - t2 * (1.0 / 9 - t2 * (1.0 / 11 - t2 * (1.0 / 13 - t2 / 15)))))));
    }

    public static double Atan2(double y, double x)
    {
        double ax = Math.Abs(x), ay = Math.Abs(y);
        if (ax >= ay)
        {
            if (ax == 0) return 0;
            double a = AtanUnit(y / x);
            return x > 0 ? a : y >= 0 ? a + Math.PI : a - Math.PI;
        }
        double b = AtanUnit(x / y);
        return y > 0 ? HalfPi - b : -HalfPi - b;
    }

    /// <summary>Signed angle normalised to (-π, π].</summary>
    public static double WrapAngle(double a)
    {
        a %= 2 * Math.PI;
        if (a > Math.PI) a -= 2 * Math.PI;
        if (a <= -Math.PI) a += 2 * Math.PI;
        return a;
    }
}
