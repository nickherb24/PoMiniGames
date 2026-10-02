using System.Diagnostics;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoRacer;

/// <summary>
/// Plain-CLR PoRacer simulation engine — NO SignalR, NO Blazor, NO JS. The
/// <see cref="PoRacerRaceService"/> drives it on a timer and broadcasts the
/// snapshot. This is where every physics tick lives; the client renders the
/// same payload it receives, period.
/// </summary>
internal sealed class PoRacerSim
{
    private const int TotalLaps = PoRacerCatalog.TotalLaps;
    private const double CarRadius = 18;
    private const double StopAfterMs = 180_000; // Allows three real laps on the longer tracks; still bounds abandoned races.
    // Once the winner crosses the line (finishes lap 3), the pack gets this much
    // longer to finish; then the race ends and stragglers are DNF'd. Keeps the
    // race from idling to the safety cap after it's effectively decided. It was 5 s while
    // the bots lapped ten seconds slower than anyone who could steer; with the solo tiers a
    // driver who is a second or two a lap off the winner must still get to finish.
    private const double FinishGraceMs = 15_000;
    private double _leaderFinishMs = -1;
    /// <summary>
    /// The share of top speed a bot sheds for the sharpest bend. At 0.58 a bot laps the oval in
    /// about 27 s where a driver who keeps the throttle in manages 17: the cars can take every
    /// corner here far faster than the bots dare. That gap, more than top speed, is what the
    /// solo tiers move (PoRacerRaceRegistry.Join); demo and online bots keep this default.
    /// </summary>
    public const double DefaultBotCaution = 0.58;
    private readonly double _botCaution;

    // What moves a car's top speed: a boost pad or drift payout, a tow, and Damage. Each one
    // changes the ceiling itself, not just how hard the car pushes toward it.
    private const double BoostTopSpeed = 1.10;     // boost pad or drift payout
    private const double DraftTopSpeed = 1.04;     // sitting in another car's tow
    private const double DamageSpeedCost = 0.10;   // share of top speed lost at Damage = 1

    private static double TopSpeed(SimCar c) =>
        c.MaxSpeed * (1 - DamageSpeedCost * c.Damage) * (c.BoostTimer > 0 ? BoostTopSpeed : 1) * (c.Drafting ? DraftTopSpeed : 1);

    public PoRacerStaticWorld Static { get; }

    // Track
    private readonly PoRacerTrackData _track;
    private readonly List<Vec2> _centerline = new();
    private readonly List<(Vec2 a, Vec2 b)> _walls = new();
    private readonly double _trackWidth;

    // Cars + input map
    private readonly List<SimCar> _cars = new();
    private readonly Dictionary<string, SimCar> _byOwnerId = new(StringComparer.Ordinal);

    private readonly Stopwatch _wallClock = Stopwatch.StartNew();
    private long _startElapsedMs;
    // Pause (solo only): the race clock is "now - start", so a pause freezes "now" and resuming
    // slides the start forward by the time spent paused. Every lap and finish time is measured
    // on that clock, so none of them can see the gap.
    private long _pausedAtMs = -1;

    private long NowMs => _pausedAtMs >= 0 ? _pausedAtMs : _wallClock.ElapsedMilliseconds;
    private double RaceSeconds => (NowMs - _startElapsedMs) / 1000.0;
    public bool Paused => _pausedAtMs >= 0;
    public string TrackId => _track.Id;

    /// <param name="bots">False for a time trial: only the human cars take the grid. Ignored with no humans.</param>
    /// <param name="botPace">Scales every bot's top speed and acceleration (the solo difficulty tier).</param>
    /// <param name="botCaution">How much speed a bot gives up for a bend, 0-1. See <see cref="DefaultBotCaution"/>.</param>
    public PoRacerSim(IReadOnlyList<PoRacerLobbyPlayer> players, string? trackId = null, int countdownSeconds = 0,
        bool bots = true, double botPace = 1.0, double botCaution = DefaultBotCaution)
    {
        _botCaution = botCaution;
        var track = PoRacerTrackRegistry.GetTrack(trackId);
        _track = track;
        _trackWidth = track.TrackWidth;
        _centerline.Clear();
        _walls.Clear();
        _centerline.AddRange(track.Centerline);
        _walls.AddRange(track.Walls);

        // Build flat typed-array payloads for the wire format.
        var centerArr = new double[_centerline.Count * 2];
        for (int i = 0; i < _centerline.Count; i++)
        {
            centerArr[i * 2] = _centerline[i].X;
            centerArr[i * 2 + 1] = _centerline[i].Y;
        }
        var wallsArr = new double[_walls.Count * 4];
        for (int i = 0; i < _walls.Count; i++)
        {
            wallsArr[i * 4] = _walls[i].a.X;
            wallsArr[i * 4 + 1] = _walls[i].a.Y;
            wallsArr[i * 4 + 2] = _walls[i].b.X;
            wallsArr[i * 4 + 3] = _walls[i].b.Y;
        }
        double minX = double.MaxValue, minY = double.MaxValue, maxX = double.MinValue, maxY = double.MinValue;
        foreach (var p in _centerline)
        {
            if (p.X < minX) minX = p.X; if (p.X > maxX) maxX = p.X;
            if (p.Y < minY) minY = p.Y; if (p.Y > maxY) maxY = p.Y;
        }
        var pad = _trackWidth;
        Static = new PoRacerStaticWorld
        {
            TrackId = track.Id,
            TrackName = track.DisplayName,
            Theme = track.EnvironmentTheme,
            CenterXY = centerArr,
            WallsXY = wallsArr,
            TrackWidth = _trackWidth,
            MinX = minX - pad,
            MinY = minY - pad,
            MaxX = maxX + pad,
            MaxY = maxY + pad,
            TotalLaps = TotalLaps,
            BoostPads = track.BoostPads.Select(b => new PoRacerBoostPadWire
            {
                X = b.Position.X,
                Y = b.Position.Y,
                Radius = b.Radius,
                DirectionAngle = b.DirectionAngle
            }).ToList(),
            SurfaceZones = track.SurfaceZones.Select(s => new PoRacerSurfaceZoneWire
            {
                Name = s.Name,
                SurfaceType = s.SurfaceType.ToString().ToLowerInvariant(),
                X = s.Center.X,
                Y = s.Center.Y,
                Radius = s.Radius
            }).ToList()
        };

        // Spawn grid: 2 cols × N rows along the first segment direction.
        var startA = _centerline[0];
        var startB = _centerline[1];
        // Use a tangent directly: tangent = (b - a) normalized
        var dx = startB.X - startA.X; var dy = startB.Y - startA.Y;
        var dlen = Math.Sqrt(dx * dx + dy * dy);
        var tx = dx / dlen; var ty = dy / dlen;
        // perp = (-ty, tx) — but we also want forward = (tx, ty)
        var nrm = new Vec2(-ty, tx);
        // Player goes first (slot 0). Then 7 AI bots fill the rest.
        var palette = new[] { "#4ec3ff", "#ff5d6c", "#ffd24e", "#7eff8a", "#c47bff", "#ff944d", "#5ee7ff", "#ff77c8" };
        var profiles = new (double skill, double maxSpeed, double accel, double handling)[]
        {
            (0.7, 320, 220, 1.0),
            (0.55, 335, 235, 0.95),
            (0.9, 305, 200, 1.05),
            (0.6, 320, 215, 1.0),
            (0.95, 295, 195, 1.1),
            (0.5, 340, 245, 0.92),
            (0.65, 315, 215, 1.0),
            (0.85, 310, 210, 1.05),
        };
        // Pad players to 8 with AI bots.
        var slots = new List<(string connectionId, string name, bool isPlayer)>();
        foreach (var p in players)
        {
            slots.Add((string.IsNullOrEmpty(p.UserId) ? p.ConnectionId : p.UserId, p.DisplayName, true));
        }
        int humanCount = slots.Count;
        for (int i = humanCount; i < 8 && (bots || humanCount == 0); i++)
        {
            var p = PoRacerAiDriver.GetPersonality(i);
            slots.Add(($"bot-{i}", p.Name, false));
        }

        for (int i = 0; i < slots.Count && i < 8; i++)
        {
            var s = slots[i];
            // Every human gets the same car. The profile used to be picked by grid slot, so the
            // second driver in an online race had 15 more top speed and acceleration than the
            // first, on a board that ranks best laps.
            var prof = profiles[s.isPlayer ? 0 : i];
            var personality = s.isPlayer ? null : PoRacerAiDriver.GetPersonality(i);
            int row = i / 2;
            int col = i % 2;
            double fwdOffset = 60 + row * 38;
            double sideOffset = (col == 0 ? -28.0 : 28.0) - (row * 4);
            var pos = new Vec2(
                startA.X + tx * fwdOffset + nrm.X * sideOffset,
                startA.Y + ty * fwdOffset + nrm.Y * sideOffset);
            string carColor = personality?.PrimaryColor ?? palette[i];
            var car = new SimCar
            {
                Id = i,
                OwnerId = s.connectionId,
                Name = s.name,
                IsPlayer = s.isPlayer,
                Personality = personality,
                Color = carColor,
                ColorDark = Darken(carColor),
                Livery = PoRacerCatalog.Liveries[i % PoRacerCatalog.Liveries.Count],
                Pos = pos,
                Heading = Math.Atan2(ty, tx),
                MaxSpeed = personality is null ? prof.maxSpeed : personality.MaxSpeed * botPace,
                Acceleration = personality is null ? prof.accel : personality.Acceleration * botPace,
                Handling = personality?.Handling ?? prof.handling,
                CorneringSkill = personality?.CorneringSkill ?? prof.skill,
                Lap = 1,
                LastCheckpoint = 0,
                CheckpointT = 0,
                DistanceAlongTrack = 0,
            };
            _cars.Add(car);
            if (s.isPlayer) _byOwnerId[s.connectionId] = car;
        }

        _startElapsedMs = _wallClock.ElapsedMilliseconds + Math.Max(0, countdownSeconds) * 1000L;
        foreach (var car in _cars) { Project(car); UpdateRaceProgress(car); }
        Rank();
        Static.Roster = BuildRoster();
    }

    public int? CarIdForOwner(string ownerId) => _byOwnerId.TryGetValue(ownerId, out var car) ? car.Id : null;

    /// <summary>
    /// The human seats, as (owner id, car id): who a finished race's laps belong to. A seat the
    /// stand-in bot drove for even one tick is left out, so a lap a bot set can never be
    /// submitted to the board under the absent driver's name.
    /// </summary>
    public IEnumerable<(string OwnerId, int CarId)> Humans =>
        _byOwnerId.Where(p => !p.Value.BotDriven).Select(p => (p.Key, p.Value.Id));

    /// <summary>
    /// Hand a human's car to the bot driver, or back. A shared race does this for a seat nobody
    /// is connected to: otherwise a driver who closed the tab would leave a parked car on the
    /// racing line for everyone else, for the rest of the race.
    /// </summary>
    public void SetAutopilot(string ownerId, bool on)
    {
        if (_byOwnerId.TryGetValue(ownerId, out var car)) car.Autopilot = on;
    }

    private List<PoRacerCarInfo> BuildRoster() => _cars
        .Select(c => new PoRacerCarInfo(c.Id, c.Name, c.Color, c.ColorDark, c.Livery, c.IsPlayer, c.Personality?.Trait ?? ""))
        .ToList();

    /// <summary>
    /// Paint a human's car. The values come off the wire, so anything that is not a #rrggbb colour
    /// or a known livery is ignored. Returns true when the roster changed and must be re-sent.
    /// </summary>
    public bool SetPaint(string ownerId, string? colorHex, string? livery)
    {
        if (!_byOwnerId.TryGetValue(ownerId, out var car)) return false;
        var color = colorHex is { Length: 7 } hex && hex[0] == '#' && hex.Skip(1).All(Uri.IsHexDigit) ? hex.ToLowerInvariant() : car.Color;
        var style = livery is not null && PoRacerCatalog.Liveries.Contains(livery) ? livery : car.Livery;
        if (color == car.Color && style == car.Livery) return false;
        car.Color = color;
        car.ColorDark = Darken(color);
        car.Livery = style;
        Static.Roster = BuildRoster();
        return true;
    }

    public void SetPaused(bool paused)
    {
        if (paused == Paused) return;
        if (paused) _pausedAtMs = _wallClock.ElapsedMilliseconds;
        else
        {
            _startElapsedMs += _wallClock.ElapsedMilliseconds - _pausedAtMs;
            _pausedAtMs = -1;
        }
    }

    public void Tick(double dt, IReadOnlyDictionary<string, PoRacerInput> inputs)
    {
        // Inputs may be held through the countdown, but no car moves before GO.
        if (Paused || NowMs < _startElapsedMs) return;
        // Update surface friction and boost pads for every car
        foreach (var c in _cars)
        {
            UpdateSurfaceAndBoost(c, dt);
        }

        // Apply player input.
        foreach (var (cid, car) in _byOwnerId)
        {
            if (car.Lap > TotalLaps) continue;
            if (car.Autopilot)
            {
                car.BotDriven = true;
                UpdateAi(car, dt);
                continue;
            }
            inputs.TryGetValue(cid, out var inp);
            // A non-zero analog axis (gamepad) wins over its key. Clamped here: this is the wire.
            double steer = Axis(inp?.Steer, -1) is var sx && sx != 0 ? sx : (inp?.Right == true ? 1 : 0) - (inp?.Left == true ? 1 : 0);
            double throttle = Axis(inp?.Throttle, 0) is var tv && tv > 0 ? tv : inp?.Up == true ? 1 : 0;
            double brake = Axis(inp?.Brake, 0) is var bv && bv > 0 ? bv : inp?.Down == true ? 1 : 0;
            ApplyControl(car, dt, throttle, brake, steer, inp?.Space ?? false);
        }
        // AI.
        foreach (var c in _cars)
        {
            if (c.IsPlayer) continue;
            if (c.Lap > TotalLaps) continue;
            UpdateAi(c, dt);
        }
        // Finished cars coast to a halt just past the line instead of being driven,
        // so they don't mill around the finish under collision impulses.
        foreach (var c in _cars)
        {
            if (c.Lap <= TotalLaps) continue;
            c.Speed *= Math.Max(0, 1 - 3.5 * dt);
            if (Math.Abs(c.Speed) < 2) c.Speed = 0;
            c.Pos = new Vec2(c.Pos.X + Math.Cos(c.Heading) * c.Speed * dt,
                             c.Pos.Y + Math.Sin(c.Heading) * c.Speed * dt);
        }
        // Car-car collisions.
        ResolveCarCollisions();
        // Hard safety bound: collision impulses on a jam of stopped cars could
        // otherwise integrate into absurd runaway speeds (the finish-line pile-up).
        // (A boosted car in a tow legitimately runs about 15% over MaxSpeed, hence the headroom.)
        foreach (var c in _cars) c.Speed = Math.Clamp(c.Speed, -c.MaxSpeed, c.MaxSpeed * 1.2);
        // Project onto centerline.
        foreach (var c in _cars) Project(c);
        // Wall collisions.
        foreach (var c in _cars) ResolveWallCollision(c);
        // Lap detection + finish time.
        foreach (var c in _cars) UpdateRaceProgress(c);
        // Rank.
        Rank();

        // Race-end: the winner has crossed the line → start the finish grace.
        // When the grace expires (or the safety cap hits) declare any car
        // still running as DNF, so the race ends when the 3rd lap is won rather
        // than idling on until the cap.
        var elapsed = NowMs - _startElapsedMs;
        if (_leaderFinishMs < 0 && _cars.Any(c => c.Lap > TotalLaps))
        {
            _leaderFinishMs = elapsed;
        }
        var graceExpired = _leaderFinishMs >= 0 && elapsed - _leaderFinishMs > FinishGraceMs;
        if ((elapsed > StopAfterMs || graceExpired) && !_cars.All(c => c.Lap > TotalLaps))
        {
            foreach (var c in _cars)
            {
                if (c.Lap <= TotalLaps && c.FinishTime < 0)
                {
                    c.FinishTime = double.PositiveInfinity;
                }
            }
        }
    }

    private void UpdateSurfaceAndBoost(SimCar c, double dt)
    {
        // 1. Boost pads check
        foreach (var pad in _track.BoostPads)
        {
            if (pad.Contains(c.Pos))
            {
                c.BoostTimer = pad.DurationSeconds;
                c.BoostGlow = 1.0;
                break;
            }
        }

        // Boost decay
        if (c.BoostTimer > 0)
        {
            c.BoostTimer -= dt;
            c.AccelerationModifier = 1.35;
            c.BoostGlow = Math.Max(c.BoostGlow, Math.Min(1.0, c.BoostTimer / 1.8));
        }
        else
        {
            c.BoostTimer = 0;
            c.AccelerationModifier = 1.0;
        }

        // 2. Surface zone check (sand vs tarmac)
        string detectedSurface = "asphalt";
        double grip = 1.0;
        foreach (var zone in _track.SurfaceZones)
        {
            if (zone.Contains(c.Pos))
            {
                detectedSurface = zone.SurfaceType.ToString().ToLowerInvariant();
                grip = zone.GripMultiplier;
                break;
            }
        }
        c.Surface = detectedSurface;
        c.EffectiveGrip = grip;

        // 3. Slipstream: tucked in behind another car. Every human gets it; among the bots only
        // the two drafting personalities do, as before, so the solo tiers keep their pace.
        c.Drafting = (c.IsPlayer || c.Personality?.PrefersDrafting == true)
            && _cars.Any(o => o.Id != c.Id && o.Lap <= TotalLaps && PoRacerAiDriver.IsDrafting(c.Pos, c.Heading, o.Pos));
        if (c.Drafting) c.AccelerationModifier = Math.Max(c.AccelerationModifier, 1.15);
    }

    private static double Axis(double? value, double min) =>
        value is { } v && double.IsFinite(v) ? Math.Clamp(v, min, 1) : 0;

    /// <param name="throttle">0…1.</param><param name="braking">0…1.</param><param name="steerInput">-1 (left) … 1 (right).</param>
    private void ApplyControl(SimCar c, double dt, double throttle, double braking, double steerInput, bool handbrake)
    {
        bool accel = throttle > 0, brake = braking > 0;
        double steerRate = 3.0 * c.Handling * c.EffectiveGrip;
        double maxSteer = 0.55;
        c.Steer += (steerInput - c.Steer / maxSteer) * steerRate * dt;
        c.Steer = Math.Clamp(c.Steer, -maxSteer, maxSteer);
        if (steerInput == 0) c.Steer *= Math.Max(0, 1 - 2.0 * dt);

        double before = c.Speed;
        double engine = c.Acceleration * c.AccelerationModifier * throttle;
        engine -= c.Acceleration * (c.Speed > 1 ? 1.6 : 0.6) * braking;
        c.Speed += engine * dt;
        double drag = 0.6 + Math.Abs(c.Speed) * 0.004;
        c.Speed -= Math.Sign(c.Speed) * drag * dt;
        if (Math.Abs(c.Speed) < 0.5 && !accel && !brake) c.Speed = 0;

        // The handbrake with the wheel turned, at speed, on tarmac, is a drift: the car rotates
        // half again as fast and scrubs about a third of what a straight-line pull does. A drift
        // that was only that pull plus MORE understeer would make the one control named
        // after cornering make every corner worse. Holding a drift charges it; letting go pays
        // the charge out as a short boost, so it is a way round a tight bend, not a free one
        // down a straight (the scrub costs about what the payout returns).
        bool onSand = c.Surface == "sand";
        bool drift = handbrake && !onSand && Math.Abs(c.Steer) > 0.15 && c.Speed > c.MaxSpeed * 0.3;
        if (handbrake) c.Speed *= Math.Max(0, 1 - (drift ? 1.1 : 3.0) * dt);
        if (drift) c.DriftCharge = Math.Min(1, c.DriftCharge + dt);
        else if (c.DriftCharge > 0)
        {
            if (handbrake) c.DriftCharge = Math.Max(0, c.DriftCharge - dt);   // straightened up, still on the brake
            else
            {
                if (c.DriftCharge >= 0.3)
                {
                    c.BoostTimer = Math.Max(c.BoostTimer, 0.35 + 0.65 * c.DriftCharge);
                    c.BoostGlow = 1;
                }
                c.DriftCharge = 0;
            }
        }

        // Top speed moves with boost, tow and damage. Over it (the boost just ran out) the car
        // bleeds back down instead of snapping; under it this is the plain clamp it always was.
        double top = TopSpeed(c);
        if (c.Speed > top) c.Speed = Math.Max(top, Math.Min(c.Speed, before) - 150 * dt);
        c.Speed = Math.Max(c.Speed, -c.MaxSpeed * 0.4);

        double speedFactor = Math.Min(1, Math.Abs(c.Speed) / 80);
        double turnRate = (c.Speed / 60.0) * c.Steer * (1.0 - 0.3 * speedFactor) * (drift ? 1.5 : 1.0);
        double desiredHeading = c.Heading + turnRate * dt;
        bool sliding = !drift && (handbrake || onSand || (Math.Abs(c.Steer) > 0.35 && Math.Abs(c.Speed) > c.MaxSpeed * 0.45));
        if (sliding)
        {
            double slideStrength = handbrake ? 0.7 : (onSand ? 0.55 : 0.4);
            c.Heading = desiredHeading * (1 - slideStrength) + c.Heading * slideStrength;
            c.SkidIntensity = Math.Min(1, c.SkidIntensity + dt * (onSand ? 5 : 4));
        }
        else
        {
            c.Heading = desiredHeading;
            if (drift) c.SkidIntensity = Math.Min(1, c.SkidIntensity + dt * 4);
            else c.SkidIntensity *= Math.Max(0, 1 - 3 * dt);
        }

        c.Pos = new Vec2(c.Pos.X + Math.Cos(c.Heading) * c.Speed * dt, c.Pos.Y + Math.Sin(c.Heading) * c.Speed * dt);

        c.BoostGlow *= Math.Max(0, 1 - 2 * dt);
        if (accel && Math.Abs(c.Speed) > c.MaxSpeed * 0.85) c.BoostGlow = Math.Min(1, c.BoostGlow + dt * 2);
    }

    private void UpdateAi(SimCar c, double dt)
    {
        int n = _centerline.Count;

        // Stuck accounting + marshal rescue, evaluated first so nothing can pin a
        // bot for the whole race. We track lack of TRACK PROGRESS (not just low
        // speed): a bot boxed at the grid or scraped onto a wall can thrash back and
        // forth with speed yet advance nowhere — the old AI's core failure mode.
        // If a bot fails to advance for a sustained spell despite the reverse
        // maneuver below, a marshal places it back on the racing line facing forward
        // — a hard completion guarantee.
        // Monotonic track progress in node units (n per lap) — unlike DistanceAlongTrack
        // this never dips at the start/finish line, so it won't false-flag a lapping car.
        double progress = c.Lap * n + c.ProjIdx + c.ProjT;
        if (progress > c.ProgressMark + 0.5)
        {
            c.ProgressMark = progress;
            c.StuckTimer = 0;
        }
        else
        {
            c.StuckTimer += dt;
        }
        if (c.StuckTimer > 2.0)
        {
            // Nudge a few nodes PAST the snag, not back onto it, so a bot that keeps
            // re-wedging at the same corner still nets forward progress each rescue.
            int pi = ((c.ProjIdx + 5) % n + n) % n;
            var cp = _centerline[pi];
            var nb = _centerline[(pi + 1) % n];
            c.Pos = cp;
            c.Heading = Math.Atan2(nb.Y - cp.Y, nb.X - cp.X);
            c.Speed = c.MaxSpeed * 0.32;
            c.Steer = 0;
            c.StuckTimer = 0;
            return;
        }

        double speedFrac = Math.Clamp(Math.Abs(c.Speed) / c.MaxSpeed, 0, 1);

        // Aim a few nodes down the track, taking personality lookahead and lateral offset into account
        double lookFactor = c.Personality?.LookaheadFactor ?? 1.0;
        int steerLook = (int)((3 + speedFrac * 6 + c.CorneringSkill * 3) * lookFactor);
        int aimIdx = (c.LastCheckpoint + steerLook) % n;
        var target = _centerline[aimIdx];

        if (c.Personality is { } pers && pers.LateralOffsetRatio != 0)
        {
            var a = _centerline[aimIdx];
            var b = _centerline[(aimIdx + 1) % n];
            var nrm = PoRacerTrackRegistry.ComputeNormal(a, b);
            target = new Vec2(target.X + nrm.X * (pers.LateralOffsetRatio * _trackWidth * 0.35),
                              target.Y + nrm.Y * (pers.LateralOffsetRatio * _trackWidth * 0.35));
        }

        // (The tow is worked out for every car in UpdateSurfaceAndBoost.)

        double desired = Math.Atan2(target.Y - c.Pos.Y, target.X - c.Pos.X);
        double diff = ShortAngleDiff(desired, c.Heading);

        // Predictive corner speed: measure how hard the track bends over a
        // speed-scaled window ahead and slow to a speed the car can actually hold
        // through it. Straights → near top speed; tight bends → a small fraction.
        int scan = (int)(9 + speedFrac * 15);
        double bend = UpcomingBend(c.LastCheckpoint, scan);
        double curviness = Math.Clamp(bend / 0.85, 0, 1);
        double aggression = c.Personality?.Aggression ?? 0.5;
        // Scaled from the car's top speed of the moment, not its nominal one: on a boost pad a
        // bot is well over MaxSpeed, and measured against that it would brake for the boost.
        double top = TopSpeed(c);
        double cornerSpeed = top * (1.0 - _botCaution * curviness) * (0.90 + 0.12 * c.CorneringSkill + 0.08 * aggression);
        cornerSpeed = Math.Clamp(cornerSpeed, c.MaxSpeed * 0.36, top);

        const double deadband = 0.05;
        bool accel, brake = false, handbrake = false;
        bool left = diff < -deadband, right = diff > deadband;

        // Once the crawl has lasted a moment, back STRAIGHT out to make room, then
        // resume. If reversing still can't free the car the marshal rescue above
        // eventually fires; here we give it every chance to recover on its own first.
        if (c.StuckTimer > 0.7)
        {
            accel = false; brake = true;             // low speed + brake ⇒ reverse
            left = false; right = false;             // straight back-out; steer relaxes to centre
        }
        else if (Math.Abs(c.Speed) < c.MaxSpeed * 0.18)
        {
            accel = true;                            // slow but not wedged → power out toward aim
        }
        else if (c.Speed > cornerSpeed * 1.05) { accel = false; brake = true; }   // shed speed
        else if (c.Speed > cornerSpeed) { accel = false; }                 // coast to target
        else { accel = true; }                 // power on

        // Badly misaligned at speed (nose toward a wall) → brake to bleed it off.
        if (c.StuckTimer <= 0.7 && Math.Abs(c.Speed) >= c.MaxSpeed * 0.18 && Math.Abs(diff) > 1.25)
        {
            brake = true; accel = false;
        }

        ApplyControl(c, dt, accel ? 1 : 0, brake ? 1 : 0, (right ? 1 : 0) - (left ? 1 : 0), handbrake);

        // Small stochastic imperfection so the field isn't robotic; less for skilled bots.
        if (Random.Shared.NextDouble() < 0.015 * (1.15 - c.CorneringSkill))
        {
            c.Steer += (Random.Shared.NextDouble() - 0.5) * 0.06;
        }
    }

    /// <summary>Cumulative absolute heading change (radians) over the next <paramref name="span"/>
    /// centerline segments — a cheap proxy for how sharp the upcoming track is.</summary>
    private double UpcomingBend(int startIdx, int span)
    {
        int n = _centerline.Count;
        double total = 0;
        for (int k = 0; k < span; k++)
        {
            var p0 = _centerline[(startIdx + k) % n];
            var p1 = _centerline[(startIdx + k + 1) % n];
            var p2 = _centerline[(startIdx + k + 2) % n];
            double h1 = Math.Atan2(p1.Y - p0.Y, p1.X - p0.X);
            double h2 = Math.Atan2(p2.Y - p1.Y, p2.X - p1.X);
            total += Math.Abs(ShortAngleDiff(h2, h1));
        }
        return total;
    }

    private void ResolveCarCollisions()
    {
        for (int i = 0; i < _cars.Count; i++)
        {
            for (int j = i + 1; j < _cars.Count; j++)
            {
                var a = _cars[i]; var b = _cars[j];
                var dx = b.Pos.X - a.Pos.X; var dy = b.Pos.Y - a.Pos.Y;
                var d = Math.Sqrt(dx * dx + dy * dy);
                var minD = CarRadius * 2;
                if (d < minD && d > 1e-3)
                {
                    var overlap = (minD - d) * 0.5;
                    var nx = dx / d; var ny = dy / d;
                    a.Pos = new Vec2(a.Pos.X - nx * overlap, a.Pos.Y - ny * overlap);
                    b.Pos = new Vec2(b.Pos.X + nx * overlap, b.Pos.Y + ny * overlap);
                    var aVel = ProjectVelocity(a, nx, ny);
                    var bVel = ProjectVelocity(b, nx, ny);
                    var rel = aVel - bVel;
                    var impulse = -rel * 0.6;
                    a.Speed += impulse * 0.4;
                    b.Speed -= impulse * 0.4;
                    // Damage is by how hard, not by how long. It was +0.03 for every tick two
                    // cars overlapped, so a grid that bumped off the line was fully dented by
                    // the first corner; now that it costs speed, only a real closing speed counts.
                    var closing = Math.Abs(rel);
                    if (closing > 30)
                    {
                        var dent = Math.Min(0.06, closing / 2500);
                        a.Damage = Math.Min(1, a.Damage + dent);
                        b.Damage = Math.Min(1, b.Damage + dent);
                    }
                }
            }
        }
    }

    private static double ProjectVelocity(SimCar c, double nx, double ny)
    {
        var vx = Math.Cos(c.Heading) * c.Speed;
        var vy = Math.Sin(c.Heading) * c.Speed;
        return vx * nx + vy * ny;
    }

    private void Project(SimCar c)
    {
        var (idx, t, point, dist) = ClosestOnCenterline(c.Pos, c.LastCheckpoint);
        var a = _centerline[idx];
        var b = _centerline[(idx + 1) % _centerline.Count];
        var n = Normal(a, b);
        var dx = c.Pos.X - a.X; var dy = c.Pos.Y - a.Y;
        var side = dx * n.X + dy * n.Y;
        c.ProjIdx = idx; c.ProjT = t; c.ProjSide = side;
    }

    private void ResolveWallCollision(SimCar c)
    {
        double limit = _trackWidth * 0.5 - CarRadius;
        if (Math.Abs(c.ProjSide) <= limit) return;
        var sign = Math.Sign(c.ProjSide);
        var a = _centerline[c.ProjIdx];
        var b = _centerline[(c.ProjIdx + 1) % _centerline.Count];
        var n = Normal(a, b);
        var closest = new Vec2(a.X + (b.X - a.X) * c.ProjT, a.Y + (b.Y - a.Y) * c.ProjT);
        c.Pos = new Vec2(closest.X + n.X * sign * limit, closest.Y + n.Y * sign * limit);
        var tdx = b.X - a.X; var tdy = b.Y - a.Y;
        var tlen = Math.Sqrt(tdx * tdx + tdy * tdy);
        var tx = tdx / tlen; var ty = tdy / tlen;
        var nx = n.X * sign; var ny = n.Y * sign;
        var vx = Math.Cos(c.Heading) * c.Speed;
        var vy = Math.Sin(c.Heading) * c.Speed;
        var vInto = vx * nx + vy * ny;
        var vTangent = vx * tx + vy * ty;
        var vNormalNew = -Math.Abs(vInto) * 0.15;
        var vTangentNew = vTangent * 0.7;
        var vxNew = vTangentNew * tx + vNormalNew * nx;
        var vyNew = vTangentNew * ty + vNormalNew * ny;
        c.Speed = Math.Sqrt(vxNew * vxNew + vyNew * vyNew);
        c.Heading = Math.Atan2(vyNew, vxNew);
        // Glance off: turn the nose 0.2 rad toward the track, whichever way the car is travelling
        // (the sign of heading x inward-normal says which way that is). A fixed `+= sign * 0.2`
        // is right for a car driving the wrong way round and turns one driving the right way
        // INTO the barrier: a single brush becomes a hit on every tick, the speed collapses, the
        // car grinds along the wall and Damage runs to 1 in a quarter second.
        c.Heading += 0.2 * Math.Sign(Math.Sin(c.Heading) * nx - Math.Cos(c.Heading) * ny);
        c.SkidIntensity = 1.0;
        // By the speed into the barrier: a 5 degree brush at full speed is about 0.02, head-on is 0.12.
        if (Math.Abs(vInto) > 20) c.Damage = Math.Min(1, c.Damage + Math.Min(0.12, Math.Abs(vInto) / 1500));
    }

    private void UpdateRaceProgress(SimCar c)
    {
        if (c.Lap > TotalLaps) return;
        if (c.LastCheckpoint >= 0)
        {
            int prev = c.LastCheckpoint;
            double prevT = c.CheckpointT;
            int n = _centerline.Count;
            var advance = c.ProjIdx + c.ProjT - prev - prevT;
            if (advance < -n / 2.0) advance += n;
            if (advance > n / 2.0) advance -= n;
            c.LapTravel += advance;
            // Crossing the line counts only after traversing the circuit. Reversing
            // over the line or sliding backwards within a segment cannot award a lap.
            if (prev > n / 2 && c.ProjIdx < n / 2 && advance > 0 && c.LapTravel >= n * 0.75)
            {
                c.Lap++;
                c.LapTravel = 0;
                // Fastest-lap timing: a lap just closed — measure it against the
                // race clock and keep the best. LapStartElapsed rebases to now so
                // the next lap times independently. This is the metric 1P scores on.
                var nowSec = RaceSeconds;
                var lapTime = nowSec - c.LapStartElapsed;
                c.LastLapTime = lapTime;
                if (lapTime > 0 && (c.BestLapTime < 0 || lapTime < c.BestLapTime))
                {
                    c.BestLapTime = lapTime;
                }
                c.LapStartElapsed = nowSec;
                if (c.Lap > TotalLaps && c.FinishTime < 0)
                {
                    c.FinishTime = nowSec;
                }
            }
        }
        c.LastCheckpoint = c.ProjIdx;
        c.CheckpointT = c.ProjT;
        c.DistanceAlongTrack = (c.Lap - 1) * _centerline.Count + c.ProjIdx + c.ProjT;
    }

    private IOrderedEnumerable<SimCar> OrderedCars() => _cars
        .OrderBy(c => c.Lap > TotalLaps ? 0 : 1)
        .ThenBy(c => c.Lap > TotalLaps ? c.FinishTime : 0)
        .ThenByDescending(c => c.DistanceAlongTrack)
        .ThenBy(c => c.Id);

    private void Rank()
    {
        var sorted = OrderedCars().ToList();
        for (int i = 0; i < sorted.Count; i++) sorted[i].Position = i + 1;
    }

    public bool AllFinishedOrStopped()
    {
        // Race is over when:
        //   * the safety cap has elapsed, OR
        //   * every car (player + AI) has crossed the line.
        // We deliberately check ALL cars (not just players) so a bot-only race
        // doesn't immediately finish via the vacuous-All-of-empty-set trap.
        var elapsed = NowMs - _startElapsedMs;
        if (elapsed > StopAfterMs) return true;
        // Winner crossed + grace elapsed → the race is decided.
        if (_leaderFinishMs >= 0 && elapsed - _leaderFinishMs > FinishGraceMs) return true;
        return _cars.All(c => c.Lap > TotalLaps);
    }

    public PoRacerFinalResult BuildFinalResult(string code)
    {
        var standings = OrderedCars()
            .Select((c, idx) => new PoRacerFinalEntry(
                idx + 1,
                c.Name,
                c.Id,
                !c.IsPlayer, // ai or guest by sign-up
                double.IsFinite(c.FinishTime) ? c.FinishTime : -1,
                c.Lap > TotalLaps && c.FinishTime >= 0 && !double.IsInfinity(c.FinishTime),
                c.BestLapTime))
            .ToList();
        return new PoRacerFinalResult(code, standings, DateTimeOffset.UtcNow);
    }

    public PoRacerRaceSnapshot Snapshot(string code)
    {
        var elapsed = RaceSeconds;
        // Positions are rounded for the wire: twenty frames a second of seventeen-digit doubles is
        // most of the payload, and a tenth of a unit is a twentieth of a pixel at the usual zoom.
        // Lap times and the track fraction keep more, because they are compared and steered by.
        var cars = _cars.Select(c => new PoRacerCarState
        {
            Id = c.Id,
            X = Math.Round(c.Pos.X, 1),
            Y = Math.Round(c.Pos.Y, 1),
            Heading = Math.Round(c.Heading, 3),
            Speed = Math.Round(c.Speed, 1),
            Lap = c.Lap,
            // DNF uses infinity internally; JSON/SignalR requires a finite wire value.
            FinishTime = double.IsFinite(c.FinishTime) ? c.FinishTime : -1,
            BestLapSeconds = c.BestLapTime,
            CurrentLapSeconds = c.Lap > TotalLaps ? c.LastLapTime : Math.Round(Math.Max(0, elapsed - c.LapStartElapsed), 3),
            LastLapSeconds = c.LastLapTime,
            LapProgress = Math.Round((c.ProjIdx + c.ProjT) / _centerline.Count, 5),
            Finished = c.Lap > TotalLaps,
            Position = c.Position,
            SkidIntensity = Math.Round(c.SkidIntensity, 2),
            BoostGlow = Math.Round(c.BoostGlow, 2),
            BoostTimer = Math.Round(c.BoostTimer, 2),
            Surface = c.Surface,
            Damage = Math.Round(c.Damage, 2),
            Drafting = c.Drafting,
            Drift = Math.Round(c.DriftCharge, 2),
        }).ToList();
        return new PoRacerRaceSnapshot
        {
            GameCode = code,
            ServerTimeMs = _wallClock.ElapsedMilliseconds,
            Cars = cars,
            ElapsedRaceTime = Math.Round(Math.Max(0, elapsed), 3),
            Started = elapsed >= 0,
            CountdownSeconds = (int)Math.Max(0, Math.Ceiling(-elapsed)),
            CountdownMs = (int)Math.Max(0, -elapsed * 1000),
            Paused = Paused,
            Finished = AllFinishedOrStopped(),
        };
    }

    // ── Math helpers (mirror the client's Catmull-Rom track) ─────────────

    private static Vec2 Normal(Vec2 a, Vec2 b)
    {
        var dx = b.X - a.X; var dy = b.Y - a.Y;
        var len = Math.Sqrt(dx * dx + dy * dy);
        if (len < 1e-6) return new Vec2(0, 0);
        return new Vec2(-dy / len, dx / len);
    }

    private (int idx, double t, Vec2 point, double dist) ClosestOnCenterline(Vec2 p, int hint = -1)
    {
        int n = _centerline.Count;
        double bestSq = double.MaxValue;
        int bestIdx = 0; double bestT = 0; Vec2 bestPt = default;
        if (hint >= 0 && n > 0)
        {
            const int window = 6;
            for (int k = -window; k <= window; k++)
            {
                int i = ((hint + k) % n + n) % n;
                var a = _centerline[i];
                var b = _centerline[(i + 1) % n];
                var (pt, t) = ClosestPointOnSegment(p, a, b);
                double ddx = p.X - pt.X, ddy = p.Y - pt.Y;
                double sq = ddx * ddx + ddy * ddy;
                if (sq < bestSq) { bestSq = sq; bestIdx = i; bestT = t; bestPt = pt; }
            }
            return (bestIdx, bestT, bestPt, Math.Sqrt(bestSq));
        }
        for (int i = 0; i < n; i++)
        {
            var a = _centerline[i];
            var b = _centerline[(i + 1) % n];
            var (pt, t) = ClosestPointOnSegment(p, a, b);
            double ddx = p.X - pt.X, ddy = p.Y - pt.Y;
            double sq = ddx * ddx + ddy * ddy;
            if (sq < bestSq) { bestSq = sq; bestIdx = i; bestT = t; bestPt = pt; }
        }
        return (bestIdx, bestT, bestPt, Math.Sqrt(bestSq));
    }

    private static (Vec2 pt, double t) ClosestPointOnSegment(Vec2 p, Vec2 a, Vec2 b)
    {
        var abx = b.X - a.X; var aby = b.Y - a.Y;
        var len2 = abx * abx + aby * aby;
        if (len2 < 1e-9) return (a, 0);
        var t = ((p.X - a.X) * abx + (p.Y - a.Y) * aby) / len2;
        t = Math.Clamp(t, 0, 1);
        return (new Vec2(a.X + abx * t, a.Y + aby * t), t);
    }

    private static double ShortAngleDiff(double a, double b)
    {
        var diff = (a - b) % (2 * Math.PI);
        if (diff > Math.PI) diff -= 2 * Math.PI;
        if (diff < -Math.PI) diff += 2 * Math.PI;
        return diff;
    }

    private static string Darken(string hex)
    {
        if (hex.StartsWith("#") && hex.Length == 7)
        {
            int r = Convert.ToInt32(hex.Substring(1, 2), 16);
            int g = Convert.ToInt32(hex.Substring(3, 2), 16);
            int b = Convert.ToInt32(hex.Substring(5, 2), 16);
            r = (int)(r * 0.35); g = (int)(g * 0.35); b = (int)(b * 0.35);
            return $"#{r:X2}{g:X2}{b:X2}";
        }
        return "#222";
    }

    private sealed class SimCar
    {
        public int Id;
        public string OwnerId = "";
        public string Name = "";
        public string Color = "#ffffff";
        public string ColorDark = "#222";
        public string Livery = "stripe";
        public Vec2 Pos;
        public double Heading;
        public double Speed;
        public double Steer;
        public bool IsPlayer;
        public double CorneringSkill;
        public double MaxSpeed;
        public double Acceleration;
        public double Handling;
        public int Lap = 1;
        public int LastCheckpoint = -1;
        public double CheckpointT;
        public double DistanceAlongTrack;
        public double FinishTime = -1;
        public double BestLapTime = -1;   // fastest single lap (s); -1 until first lap done
        public double LapStartElapsed = 0; // race-clock seconds when the current lap began
        public double LastLapTime = -1;
        public double LapTravel;
        public int Position;
        public int ProjIdx;
        public double ProjT;
        public double ProjSide;
        public double SkidIntensity;
        public double BoostGlow;
        public double BoostTimer;
        public string Surface = "asphalt";
        public double EffectiveGrip = 1.0;
        public double AccelerationModifier = 1.0;
        public PoRacerAiPersonality? Personality;
        public double Damage;
        public bool Drafting;       // in another car's tow this tick
        public double DriftCharge;  // 0..1, seconds of drift held; paid out as a boost on release
        public bool Autopilot;      // a human seat the stand-in bot is driving right now
        public bool BotDriven;      // ...or ever did: this car's laps do not go on the board
        public double StuckTimer;   // seconds without track progress — drives the AI unstick maneuver
        public double ProgressMark; // last DistanceAlongTrack the car meaningfully advanced past
    }
}
