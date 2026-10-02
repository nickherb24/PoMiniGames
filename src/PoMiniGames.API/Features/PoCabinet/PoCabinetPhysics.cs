using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoCabinet;

/// <summary>Resolved per-tick controls: throttle and brake in [0, 1], steer in [-1, 1] (+ = right).</summary>
public readonly record struct PoCabinetControls(double Throttle, double Brake, double Steer)
{
    /// <summary>Analog fields win when any is set; otherwise the digital key flags map to full travel.</summary>
    public static PoCabinetControls From(PoCabinetInput? input)
    {
        if (input is null) return default;
        bool analog = input.Throttle != 0 || input.Brake != 0 || input.Steer != 0;
        if (analog)
        {
            return new PoCabinetControls(
                Clamp01(input.Throttle),
                Clamp01(input.Brake),
                Math.Clamp(double.IsFinite(input.Steer) ? input.Steer : 0, -1, 1));
        }
        return new PoCabinetControls(
            input.Up ? 1 : 0,
            input.Down ? 1 : 0,
            (input.Right ? 1 : 0) - (input.Left ? 1 : 0));
    }

    private static double Clamp01(double v) => double.IsFinite(v) ? Math.Clamp(v, 0, 1) : 0;
}

/// <summary>Physical state of one car — everything <see cref="PoCabinetPhysics.Step"/> reads or writes.</summary>
public class PoCabinetCarBody
{
    public double X { get; set; }
    public double Y { get; set; }
    /// <summary>Radians; forward is (cos h, sin h). Right-hand side is (-sin h, cos h).</summary>
    public double Heading { get; set; }
    /// <summary>Units per second along the heading; negative while reversing.</summary>
    public double Speed { get; set; }
    public int SegHint { get; set; } = -1;
    /// <summary>Arc-length position on the loop, in [0, Length).</summary>
    public double Along { get; set; }
    /// <summary>Unwrapped race distance: starts negative on the grid, one lap = track length.</summary>
    public double Distance { get; set; }
    public double Lateral { get; set; }
    public bool OnGrass { get; set; }
    public bool Sliding { get; set; }
    /// <summary>Speed lost into the barrier on the last step (0 = no hit) — drives rumble.</summary>
    public double WallImpact { get; set; }
    /// <summary>Sideways speed a contact left behind, units/s (+ = to the car's right). The tyres scrub it off.</summary>
    public double Slip { get; set; }
    /// <summary>Yaw rate a contact left behind, rad/s. Bleeds off the same way.</summary>
    public double Spin { get; set; }
}

/// <summary>
/// Arcade car physics shared by every PoCabinet race: a speed-along-heading model with a
/// lateral-grip cap (understeer past it), grass run-off with extra drag, and a barrier that
/// removes the outward velocity component.
///
/// <para>
/// Contacts are between car-shaped hulls, not circles: a capsule 39 long and 17
/// wide, the body the client draws. A hit is an impulse along the contact normal (equal masses,
/// a little restitution) applied where the hulls touch, so it shoves a car sideways
/// (<see cref="PoCabinetCarBody.Slip"/>) and turns it (<see cref="PoCabinetCarBody.Spin"/>) as
/// well as changing its speed; <see cref="Step"/> then bleeds both off through the tyres.
/// </para>
/// <para>
/// <b>Mirror contract:</b> <c>wwwroot/js/pocabinet/physics.js</c> ports <see cref="Step"/>,
/// <see cref="ResolveContacts"/>, <see cref="GridBack"/> and <see cref="GridSlot"/> line for
/// line, with the same constants. Solo races run the JS copy; multiplayer runs this one on the server while the
/// browser runs the JS copy to predict its own car and replays unacknowledged inputs on top of
/// each snapshot. If the two diverge, every correction becomes a visible snap.
/// </para>
/// </summary>
public static class PoCabinetPhysics
{
    public const double TickSeconds = 1.0 / 30.0;
    /// <summary>Top speed on tarmac at full throttle, units/s.</summary>
    public const double MaxSpeed = 140;
    /// <summary>HUD conversion: 140 units/s reads as 280 km/h.</summary>
    public const double KmhPerUnit = 2.0;
    public const double Accel = 55;
    public const double BrakeDecel = 130;
    public const double CoastDecel = 14;
    public const double ReverseAccel = 25;
    public const double ReverseMax = 18;
    /// <summary>Yaw rate at full lock once rolling, rad/s.</summary>
    public const double SteerRate = 2.3;
    /// <summary>Below this speed the available lock scales down linearly — no pivoting on the spot.</summary>
    public const double SteerFullSpeed = 18;
    /// <summary>Lateral acceleration cap (speed × yaw rate). Asking for more understeers.</summary>
    public const double GripAccel = 105;
    public const double ScrubDecel = 30;
    public const double GrassDecel = 50;
    public const double GrassGrip = 0.6;
    /// <summary>Grass strip between the road edge and the barrier.</summary>
    public const double RunOff = 26;
    public const double CarRadius = 14;
    public const double WallRestitution = 0.25;
    public const double WallFriction = 0.85;
    /// <summary>Most negative speed a contact may leave a car with.</summary>
    public const double ContactSpeedFloor = ReverseMax * 1.5;
    /// <summary>Hull: a spine of ±<see cref="HullHalf"/> along the heading, <see cref="HullRadius"/> thick (39 x 17 overall).</summary>
    public const double HullHalf = 11;
    public const double HullRadius = 8.5;
    public const double ContactRestitution = 0.2;
    /// <summary>Yaw inertia over mass: the square of a 39 x 17 body's radius of gyration.</summary>
    public const double YawInertia = 150;
    public const double SlipDecel = 120;
    public const double SpinDecel = 5;
    public const double MaxSlip = 60;
    public const double MaxSpin = 2.5;
    public const double SlipSliding = 8;
    /// <summary>Cars further apart than this along the road never touch: where the Playground run
    /// crosses over itself they are on different levels.</summary>
    public const double SameRoad = 120;
    public const double GridColumn = 22;
    public const double GridRow = 50;

    /// <summary>Barrier distance from the centerline for a track (car centre can't pass it).</summary>
    public static double WallLateral(PoCabinetTrack track) => track.HalfWidth + RunOff - CarRadius * 0.5;

    /// <summary>
    /// Advance one car by <paramref name="dt"/>. <paramref name="grip"/> is the weather factor
    /// (1 = dry). Contacts with other cars are a separate pass (<see cref="ResolveContacts"/>).
    /// </summary>
    public static void Step(PoCabinetTrack track, PoCabinetCarBody car, PoCabinetControls c, double dt, double grip)
    {
        double throttle = c.Throttle, brake = c.Brake, steer = c.Steer;
        double v = car.Speed;
        double surfaceGrip = car.OnGrass ? GrassGrip : 1;

        // ── Longitudinal ────────────────────────────────────────────────
        double v2;
        if (v < -0.01)
        {
            // Rolling backwards: brake keeps reversing, throttle (or nothing) pulls back to zero.
            if (brake > 0 && throttle == 0)
            {
                v2 = Math.Max(-ReverseMax, v - ReverseAccel * brake * dt);
            }
            else
            {
                v2 = v + (throttle * Accel + CoastDecel) * dt;
                if (throttle == 0) v2 = Math.Min(v2, 0);
            }
        }
        else if (v <= 0.5 && throttle == 0 && brake > 0)
        {
            // Stopped with the brake held: that is the reverse gear.
            v2 = Math.Max(-ReverseMax, v - ReverseAccel * brake * dt);
        }
        else
        {
            double ratio = v / MaxSpeed;
            double a = throttle * Accel * grip * Math.Max(0, 1 - ratio * ratio)
                       - brake * BrakeDecel
                       - CoastDecel * (1 - throttle);
            if (car.OnGrass && v > 25) a -= GrassDecel;
            v2 = Math.Max(0, v + a * dt);
        }

        // ── Steering with a lateral-grip cap ────────────────────────────
        double speedAbs = Math.Abs(v2);
        double lockScale = Math.Min(1, speedAbs / SteerFullSpeed);
        double omegaWanted = steer * SteerRate * lockScale * (v2 < 0 ? -1 : 1);
        double omegaGrip = GripAccel * grip * surfaceGrip / Math.Max(speedAbs, 1);
        double omega = Math.Clamp(omegaWanted, -omegaGrip, omegaGrip);
        car.Sliding = Math.Abs(omegaWanted) > omegaGrip * 1.02 && speedAbs > 30;
        if (car.Sliding)
        {
            v2 = v2 > 0 ? Math.Max(0, v2 - ScrubDecel * dt) : Math.Min(0, v2 + ScrubDecel * dt);
        }

        // What a contact left behind: the tyres scrub the sideways slide and the spin off.
        double slipGrip = SlipDecel * grip * surfaceGrip * dt;
        double slip = car.Slip > 0 ? Math.Max(0, car.Slip - slipGrip) : Math.Min(0, car.Slip + slipGrip);
        double spin = car.Spin > 0 ? Math.Max(0, car.Spin - SpinDecel * dt) : Math.Min(0, car.Spin + SpinDecel * dt);
        if (Math.Abs(slip) > SlipSliding) car.Sliding = true;

        double heading = car.Heading + (omega + spin) * dt;
        double x = car.X + (PoCabinetTrack.Cos(heading) * v2 - PoCabinetTrack.Sin(heading) * slip) * dt;
        double y = car.Y + (PoCabinetTrack.Sin(heading) * v2 + PoCabinetTrack.Cos(heading) * slip) * dt;

        // ── Track: grass and barrier ────────────────────────────────────
        var proj = track.Project(x, y, car.SegHint);
        double wallLat = WallLateral(track);
        car.WallImpact = 0;
        if (Math.Abs(proj.Lateral) > wallLat)
        {
            double s = proj.Lateral > 0 ? 1 : -1;
            double nx = -proj.Ty * s, ny = proj.Tx * s; // outward normal
            double excess = Math.Abs(proj.Lateral) - wallLat;
            x -= nx * excess;
            y -= ny * excess;

            double vx = PoCabinetTrack.Cos(heading) * v2 - PoCabinetTrack.Sin(heading) * slip, vy = PoCabinetTrack.Sin(heading) * v2 + PoCabinetTrack.Cos(heading) * slip;
            double vn = vx * nx + vy * ny;
            if (vn > 0)
            {
                double tx = vx - nx * vn, ty = vy - ny * vn;
                vx = tx * WallFriction - nx * vn * WallRestitution;
                vy = ty * WallFriction - ny * vn * WallRestitution;
                double speed = Math.Sqrt(vx * vx + vy * vy);
                if (speed > 1) heading = v2 >= 0 ? PoCabinetTrack.Atan2(vy, vx) : PoCabinetTrack.Atan2(-vy, -vx);
                v2 = v2 >= 0 ? speed : -speed;
                slip = 0; // the car leaves the barrier pointing the way it is going
                car.WallImpact = vn;
            }
            proj = track.Project(x, y, proj.Index);
        }

        car.X = x;
        car.Y = y;
        car.Heading = PoCabinetTrack.WrapAngle(heading);
        car.Speed = v2;
        car.Slip = slip;
        car.Spin = spin;
        car.SegHint = proj.Index;
        car.Lateral = proj.Lateral;
        car.OnGrass = Math.Abs(proj.Lateral) > track.HalfWidth;
        AdvanceDistance(track, car, proj.Along);
    }

    /// <summary>Unwrap the loop position into race distance (so reversing over the line un-counts it).</summary>
    public static void AdvanceDistance(PoCabinetTrack track, PoCabinetCarBody car, double along)
    {
        double delta = along - car.Along;
        double half = track.Length * 0.5;
        if (delta > half) delta -= track.Length;
        else if (delta < -half) delta += track.Length;
        car.Distance += delta;
        car.Along = along;
    }

    /// <summary>
    /// Where two hulls touch: false when they are apart, else the unit normal (a → b), the
    /// overlap depth and the contact point. Mirrors physics.js <c>hullContact</c> (slack 0).
    /// </summary>
    private static bool HullContact(PoCabinetCarBody a, PoCabinetCarBody b,
        out double nx, out double ny, out double depth, out double cx, out double cy)
    {
        nx = ny = depth = cx = cy = 0;
        double reach = (HullHalf + HullRadius) * 2;
        double dx = b.X - a.X, dy = b.Y - a.Y;
        if (dx > reach || dx < -reach || dy > reach || dy < -reach) return false;
        double ahx = PoCabinetTrack.Cos(a.Heading), ahy = PoCabinetTrack.Sin(a.Heading);
        double bhx = PoCabinetTrack.Cos(b.Heading), bhy = PoCabinetTrack.Sin(b.Heading);
        // Closest points of the two spines: a + s·ha and b + t·hb, s and t in ±HullHalf.
        double dot = ahx * bhx + ahy * bhy;
        double da = -(ahx * dx + ahy * dy), db = -(bhx * dx + bhy * dy);
        double denom = 1 - dot * dot;
        // Within ~10° of parallel the sides meet along their overlap, not at one end: take its
        // middle, or every side-by-side rub would turn both cars.
        double s = denom > 0.03 ? (dot * db - da) / denom : -da * 0.5;
        s = Math.Min(HullHalf, Math.Max(-HullHalf, s));
        double t = dot * s + db;
        if (t < -HullHalf)
        {
            t = -HullHalf;
            s = Math.Min(HullHalf, Math.Max(-HullHalf, t * dot - da));
        }
        else if (t > HullHalf)
        {
            t = HullHalf;
            s = Math.Min(HullHalf, Math.Max(-HullHalf, t * dot - da));
        }
        double px = a.X + ahx * s, py = a.Y + ahy * s;
        double qx = b.X + bhx * t, qy = b.Y + bhy * t;
        double ex = qx - px, ey = qy - py;
        double d = Math.Sqrt(ex * ex + ey * ey);
        if (d <= 1e-6 || d >= HullRadius * 2) return false;
        nx = ex / d;
        ny = ey / d;
        depth = HullRadius * 2 - d;
        cx = (px + qx) * 0.5;
        cy = (py + qy) * 0.5;
        return true;
    }

    /// <summary>
    /// Pairwise hull contacts in index order: separate the two cars, then one impulse along the
    /// normal at the contact point, shared between each car's speed, sideways slip and spin.
    /// Order-dependent by design (index order), identically in JS.
    /// </summary>
    // ponytail: O(n²) pair scan, 4,950 pairs a tick at 100 cars (the lap verifier pays it per
    // replayed tick). Sort by Along and sweep if a field ever gets bigger than that. An array,
    // not IReadOnlyList: through the interface the scan cost twelve seconds a replay.
    public static void ResolveContacts(PoCabinetTrack track, PoCabinetCarBody[] cars)
    {
        double half = track.Length * 0.5;
        for (int i = 0; i < cars.Length; i++)
        {
            var a = cars[i];
            if (track.Parked(a.Distance)) continue;
            for (int j = i + 1; j < cars.Length; j++)
            {
                var b = cars[j];
                double gap = b.Along - a.Along;
                if (gap > half) gap -= track.Length;
                else if (gap < -half) gap += track.Length;
                if (gap > SameRoad || gap < -SameRoad || track.Parked(b.Distance)) continue;
                if (!HullContact(a, b, out double nx, out double ny, out double depth, out double cx, out double cy)) continue;
                double rax = cx - a.X, ray = cy - a.Y;
                double rbx = cx - b.X, rby = cy - b.Y;
                double push = depth * 0.5;
                a.X -= nx * push;
                a.Y -= ny * push;
                b.X += nx * push;
                b.Y += ny * push;

                double ahx = PoCabinetTrack.Cos(a.Heading), ahy = PoCabinetTrack.Sin(a.Heading);
                double bhx = PoCabinetTrack.Cos(b.Heading), bhy = PoCabinetTrack.Sin(b.Heading);
                // Each hull's velocity at the contact point: forward speed, slip to its right, spin.
                double vax = ahx * a.Speed - ahy * a.Slip - a.Spin * ray, vay = ahy * a.Speed + ahx * a.Slip + a.Spin * rax;
                double vbx = bhx * b.Speed - bhy * b.Slip - b.Spin * rby, vby = bhy * b.Speed + bhx * b.Slip + b.Spin * rbx;
                double closing = (vax - vbx) * nx + (vay - vby) * ny;
                if (closing <= 0) continue;
                double armA = rax * ny - ray * nx, armB = rbx * ny - rby * nx;
                double impulse = (1 + ContactRestitution) * closing / (2 + (armA * armA + armB * armB) / YawInertia);
                a.Speed -= impulse * (nx * ahx + ny * ahy);
                a.Slip -= impulse * (ny * ahx - nx * ahy);
                a.Spin -= impulse * armA / YawInertia;
                b.Speed += impulse * (nx * bhx + ny * bhy);
                b.Slip += impulse * (ny * bhx - nx * bhy);
                b.Spin += impulse * armB / YawInertia;
                // Bounded so a shove can't launch a car past what its own engine could do:
                // unbounded, a car rammed while facing backwards reached -49 u/s and the two
                // cars locked together for the rest of the race.
                a.Speed = Math.Min(MaxSpeed * 1.08, Math.Max(-ContactSpeedFloor, a.Speed));
                b.Speed = Math.Min(MaxSpeed * 1.08, Math.Max(-ContactSpeedFloor, b.Speed));
                a.Slip = Math.Min(MaxSlip, Math.Max(-MaxSlip, a.Slip));
                b.Slip = Math.Min(MaxSlip, Math.Max(-MaxSlip, b.Slip));
                a.Spin = Math.Min(MaxSpin, Math.Max(-MaxSpin, a.Spin));
                b.Spin = Math.Min(MaxSpin, Math.Max(-MaxSpin, b.Spin));
            }
        }
    }

    /// <summary>Columns of the starting grid: as many as the tarmac takes, at least two.</summary>
    public static int GridColumns(PoCabinetTrack track) =>
        Math.Max(2, (int)Math.Floor(track.HalfWidth * 1.6 / GridColumn) + 1);

    /// <summary>
    /// Distance behind the line of grid row <paramref name="row"/>. Rows are
    /// <see cref="GridRow"/> apart, but none stands on a bend tighter than one and a half road
    /// widths: there the slots of neighbouring rows fan into each other, so the row moves back
    /// to where the road has straightened.
    /// </summary>
    public static double GridBack(PoCabinetTrack track, int row)
    {
        double limit = 1 / (track.HalfWidth * 1.5);
        double back = 18;
        for (int r = 0; back < track.Length;)
        {
            double at = track.Length - back;
            if (track.MaxCurvature(at - 25, at + 25) > limit)
            {
                back += 8;
                continue;
            }
            if (r == row) break;
            r++;
            back += GridRow;
        }
        return back;
    }

    /// <summary>
    /// Starting-grid slot <paramref name="slot"/>: rows across the tarmac, pole just behind the
    /// line, so every car's race distance starts negative and lap 1 ends at one lap length.
    /// </summary>
    public static void GridSlot(PoCabinetTrack track, PoCabinetCarBody car, int slot)
    {
        int cols = GridColumns(track);
        double back = GridBack(track, slot / cols);
        double lateral = (slot % cols - (cols - 1) / 2.0) * GridColumn;
        var p = track.PointAt(track.Length - back);
        car.X = p.X + -p.Ty * lateral;
        car.Y = p.Y + p.Tx * lateral;
        car.Heading = PoCabinetTrack.Atan2(p.Ty, p.Tx);
        car.Speed = 0;
        car.Slip = 0;
        car.Spin = 0;
        // Hinted with where the slot is: a long grid runs back over other parts of a course
        // that crosses itself, and a blind nearest-point search can land on the wrong level.
        var proj = track.Project(car.X, car.Y, track.IndexAt(track.Length - back));
        car.SegHint = proj.Index;
        car.Along = proj.Along;
        car.Lateral = proj.Lateral;
        car.OnGrass = false;
        // Race distance starts negative: the slot's own distance behind the line, corrected by
        // where the car projects (a bend moves an outer slot a little along the road). Not
        // "along minus a lap": a front-row slot on a tight last bend can project past the line.
        double off = proj.Along - (track.Length - back);
        if (off > track.Length * 0.5) off -= track.Length;
        else if (off < -track.Length * 0.5) off += track.Length;
        car.Distance = off - back;
    }
}
