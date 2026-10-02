using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoCabinet;

/// <summary>
/// Server-authoritative PoCabinet race. No SignalR, no Blazor, no JS: the
/// <see cref="PoCabinetRaceRegistry"/> ticks it at 30 Hz and broadcasts what it reports.
///
/// <para>
/// Movement, walls and grass are <see cref="PoCabinetPhysics.Step"/>, the same model the
/// browser runs for solo races and for predicting its own car online.
/// </para>
/// <para>
/// Time is the sum of the <c>dt</c> values passed to <see cref="Tick"/> — no wall clock — so a
/// race replays identically from the same inputs. Lap and finish times are interpolated to
/// the moment the car's race distance crossed the line inside the tick, not rounded to it.
/// </para>
/// </summary>
public sealed class PoCabinetSim
{
    /// <summary>After the first car finishes, the rest have this long to cross the line.</summary>
    private const double FinishGraceSeconds = 15;
    /// <summary>A race that is still running this long after GO is called off (stuck/abandoned).</summary>
    private const double SafetyCutoffSeconds = 300;

    private readonly PoCabinetTrack _track;
    private readonly List<SimCar> _cars = new();
    /// <summary><see cref="_cars"/> as the array the physics and the AI scan every tick.</summary>
    private readonly PoCabinetCarBody[] _bodies;
    private readonly Dictionary<string, SimCar> _byOwnerId = new(StringComparer.Ordinal);
    private readonly Random _rng;
    private double _clock;
    private double _firstFinishAt = -1;
    private int _tickCount;
    private int _finishOrder;

    public PoCabinetSim(string? trackId, int seed, IReadOnlyList<PoCabinetDriver> drivers)
    {
        if (drivers is null || drivers.Count == 0)
            throw new ArgumentException("at least one driver is required", nameof(drivers));
        if (drivers.Count > PoCabinetCatalog.CarCount)
            throw new ArgumentException($"max {PoCabinetCatalog.CarCount} drivers", nameof(drivers));

        _track = PoCabinetTrack.Get(trackId);
        TotalLaps = _track.Laps;
        _rng = new Random(seed);

        for (int i = 0; i < drivers.Count; i++)
        {
            var d = drivers[i];
            var car = new SimCar
            {
                Id = i,
                OwnerId = d.OwnerId,
                Name = d.Name,
                IsPlayer = d.IsPlayer,
                Color = d.Color,
                OfficialId = d.OfficialId,
                Personality = d.Personality,
                MaxSpeed = d.MaxSpeed,
                CorneringSkill = d.CorneringSkill,
                Position = i + 1,
            };
            PoCabinetPhysics.GridSlot(_track, car, i);
            _cars.Add(car);
            if (d.IsPlayer) _byOwnerId[d.OwnerId] = car;
        }
        _bodies = [.. _cars];
    }

    /// <summary>Track this sim is running on (id is the geometry key).</summary>
    public string TrackId => _track.Id;

    public PoCabinetTrack Track => _track;

    /// <summary>Total laps configured for this race (the track's own count unless overridden).</summary>
    public int TotalLaps { get; init; }

    /// <summary>Grid countdown before GO. 0 = cars move on the first tick (tests, demos).</summary>
    public double CountdownSeconds { get; init; }

    /// <summary>Weather grip factor. Multiplayer always races dry: the rain in the browser is
    /// cosmetic online, because prediction must run the server's numbers.</summary>
    public double Grip { get; init; } = 1;

    public int CarCount => _cars.Count;
    public bool IsFinished { get; private set; }

    /// <summary>Seconds since GO; negative during the countdown.</summary>
    public double ElapsedRaceTime => _clock - CountdownSeconds;

    public bool Started => ElapsedRaceTime >= 0;

    /// <summary>Whole seconds left on the countdown, as the HUD shows them (3, 2, 1, then 0).</summary>
    public int CountdownRemaining => Started ? 0 : (int)Math.Ceiling(-ElapsedRaceTime);

    /// <summary>Dialogue raised since the registry last took it (null = nothing new).</summary>
    public PoCabinetDialogueEvent? PendingDialogue { get; private set; }

    public int? CarIdForOwner(string ownerId) => _byOwnerId.TryGetValue(ownerId, out var car) ? car.Id : null;

    public PoCabinetDialogueEvent? TakeDialogue()
    {
        var d = PendingDialogue;
        PendingDialogue = null;
        return d;
    }

    /// <summary>
    /// Advance the race by <paramref name="dt"/>. <paramref name="inputs"/> is keyed by driver
    /// <c>OwnerId</c>; a human with no entry coasts. Each applied input's <c>Seq</c> is recorded
    /// as that car's <see cref="SimCar.AckSeq"/>, during the countdown too, so the client's
    /// prediction history drains even before GO.
    /// </summary>
    public void Tick(double dt, IReadOnlyDictionary<string, PoCabinetInput> inputs)
    {
        if (IsFinished) return;
        _tickCount++;
        double before = ElapsedRaceTime;
        _clock += dt;

        foreach (var (ownerId, car) in _byOwnerId)
        {
            if (inputs.TryGetValue(ownerId, out var inp) && inp is not null && inp.Seq > car.AckSeq)
                car.AckSeq = inp.Seq;
        }

        if (_tickCount == 1) Say(DialogueKind.PreRace, BotAt(_rng.Next(Math.Max(1, _cars.Count))));
        if (!Started) return;

        double tickStart = Math.Max(0, before);
        double stepDt = ElapsedRaceTime - tickStart;
        if (stepDt <= 0) return;

        foreach (var car in _cars)
        {
            car.PrevDistance = car.Distance;
            PoCabinetControls controls;
            if (car.Finished || !car.IsPlayer)
            {
                // Finished humans roll a cool-down lap on autopilot so they never park on the line
                // (on a point-to-point track everyone rolls into the run-out and parks there).
                var persona = car.Personality ?? PoCabinetPersonality.Officials.BillB;
                controls = PoCabinetAiDriver.Decide(_track, car, persona, car.Finished ? car.MaxSpeed * _track.CoolDownAt(car.Distance) : car.MaxSpeed,
                    car.CorneringSkill, _bodies, Grip);
            }
            else
            {
                inputs.TryGetValue(car.OwnerId, out var inp);
                controls = PoCabinetControls.From(inp);
            }
            PoCabinetPhysics.Step(_track, car, controls, stepDt, Grip);
        }
        PoCabinetPhysics.ResolveContacts(_track, _bodies);

        foreach (var car in _cars)
        {
            if (car.Finished) continue;
            while (car.Distance >= (car.LapsDone + 1) * _track.LapLength)
            {
                double boundary = (car.LapsDone + 1) * _track.LapLength;
                double span = car.Distance - car.PrevDistance;
                double frac = span > 1e-9 ? Math.Clamp((boundary - car.PrevDistance) / span, 0, 1) : 1;
                double crossedAt = tickStart + frac * stepDt;
                double lapTime = crossedAt - car.LapStartTime;
                car.LapStartTime = crossedAt;
                car.LastLapSeconds = lapTime;
                if (car.BestLapSeconds <= 0 || lapTime < car.BestLapSeconds) car.BestLapSeconds = lapTime;
                car.LapsDone++;
                if (car.LapsDone >= TotalLaps)
                {
                    car.Finished = true;
                    car.FinishTime = crossedAt;
                    car.FinishOrder = ++_finishOrder;
                    if (_firstFinishAt < 0)
                    {
                        _firstFinishAt = ElapsedRaceTime;
                        if (!car.IsPlayer) Say(DialogueKind.RaceFinish, car);
                    }
                    break;
                }
                if (!car.IsPlayer && Rank(car) == 1) Say(DialogueKind.LapFinish, car);
            }
        }

        var order = Standings();
        for (int i = 0; i < order.Count; i++) order[i].Position = i + 1;

        bool humansDone = _byOwnerId.Count > 0 && _byOwnerId.Values.All(c => c.Finished);
        bool everyoneDone = _cars.All(c => c.Finished);
        bool graceOver = _firstFinishAt >= 0 && ElapsedRaceTime - _firstFinishAt > FinishGraceSeconds;
        if (humansDone || everyoneDone || graceOver || ElapsedRaceTime > SafetyCutoffSeconds)
        {
            IsFinished = true;
        }
    }

    /// <summary>Finishers by finish order, then everyone else by race distance.</summary>
    public List<SimCar> Standings() =>
        _cars.OrderBy(c => c.Finished ? 0 : 1)
             .ThenBy(c => c.Finished ? c.FinishOrder : 0)
             .ThenByDescending(c => c.Finished ? 0 : c.Distance)
             .ThenBy(c => c.Id)
             .ToList();

    /// <summary>Final result for the <c>RaceFinished</c> broadcast.</summary>
    public PoCabinetFinalResult BuildResult(string gameCode) => new(
        gameCode,
        Standings().Select((c, i) => new PoCabinetFinalEntry(
            Position: i + 1,
            Name: c.Name,
            OfficialId: c.OfficialId,
            IsPlayer: c.IsPlayer,
            Finished: c.Finished,
            TotalTimeSeconds: c.Finished ? Math.Round(c.FinishTime, 3) : -1,
            BestLapSeconds: c.BestLapSeconds > 0 ? Math.Round(c.BestLapSeconds, 3) : -1,
            CarId: c.Id)).ToList(),
        DateTimeOffset.UtcNow);

    public IReadOnlyList<SimCar> SnapshotCars() => _cars;

    private int Rank(SimCar car) => Standings().IndexOf(car) + 1;

    private SimCar? BotAt(int index)
    {
        var bots = _cars.Where(c => !c.IsPlayer).ToList();
        return bots.Count == 0 ? null : bots[index % bots.Count];
    }

    private void Say(DialogueKind kind, SimCar? speaker)
    {
        if (speaker is null || speaker.IsPlayer) return;
        PendingDialogue = new PoCabinetDialogueEvent
        {
            OfficialId = speaker.OfficialId,
            Kind = kind.ToString(),
            Text = PoCabinetDialogue.PickLine(speaker.OfficialId, kind, _tickCount),
            RaceTick = _tickCount,
        };
    }

    /// <summary>Per-car race state on top of the physical body. Public so the wire DTO can read it.</summary>
    public sealed class SimCar : PoCabinetCarBody
    {
        public int Id { get; init; }
        public required string OwnerId { get; init; }
        public required string Name { get; init; }
        public required bool IsPlayer { get; init; }
        public required string Color { get; init; }
        public string OfficialId { get; init; } = "player";
        public PoCabinetPersonality? Personality { get; init; }
        public double MaxSpeed { get; init; }
        public double CorneringSkill { get; init; }
        public int LapsDone { get; set; }
        /// <summary>Current lap (1-based). Reads TotalLaps + 1 once finished, as it always has.</summary>
        public int Lap => LapsDone + 1;
        public double LapStartTime { get; set; }
        public double LastLapSeconds { get; set; }
        public double BestLapSeconds { get; set; }
        public bool Finished { get; set; }
        public double FinishTime { get; set; }
        public int FinishOrder { get; set; }
        public int AckSeq { get; set; }
        public int Position { get; set; }
        internal double PrevDistance { get; set; }
    }
}

/// <summary>Driver row passed into <see cref="PoCabinetSim"/> at construction time; list order is grid order.</summary>
public sealed record PoCabinetDriver(
    string OwnerId,
    string Name,
    bool IsPlayer,
    string Color,
    PoCabinetPersonality? Personality,
    double MaxSpeed = PoCabinetPhysics.MaxSpeed,
    double CorneringSkill = 0.7,
    string OfficialId = "player");

/// <summary>
/// Personality parameter bundle for an AI driver (see <see cref="PoCabinetAiDriver"/> for what
/// each knob does). Values default to neutral.
/// </summary>
public sealed record PoCabinetPersonality(
    double LookaheadDistance = 60,
    double LateralOffset = 0.0,
    double BrakingAggression = 0.5,
    double CollisionTolerance = 0.5,
    double DraftingAffinity = 0.0,
    double Wildness = 0.0,
    int Seed = 0)
{
    /// <summary>The four named officials. Mirrored in <c>js/pocabinet/physics.js</c> (<c>OFFICIALS</c>).</summary>
    public static class Officials
    {
        // Lateral offsets are spread across the road so their lines stay visibly apart
        // (PoCabinetAiPersonalityTests asserts it over a full lap).
        public static readonly PoCabinetPersonality SeanS = new(
            LookaheadDistance: 25, LateralOffset: -0.95, BrakingAggression: 0.95,
            CollisionTolerance: 0.2, DraftingAffinity: 0.1, Wildness: 0.12, Seed: 201);
        public static readonly PoCabinetPersonality SteveB = new(
            LookaheadDistance: 45, LateralOffset: 0.85, BrakingAggression: 0.20,
            CollisionTolerance: 0.6, DraftingAffinity: 0.2, Wildness: 0.03, Seed: 202);
        public static readonly PoCabinetPersonality BillB = new(
            LookaheadDistance: 100, LateralOffset: 0.0, BrakingAggression: 0.50,
            CollisionTolerance: 0.9, DraftingAffinity: 0.0, Wildness: 0.01, Seed: 203);
        public static readonly PoCabinetPersonality MikeP = new(
            LookaheadDistance: 130, LateralOffset: -0.40, BrakingAggression: 0.40,
            CollisionTolerance: 0.3, DraftingAffinity: 0.95, Wildness: 0.06, Seed: 204);
    }

    /// <summary>The AI roster in seat order: id, display name, colour, line, pace and cornering.
    /// Top speeds sit a few percent under a player's, and the cornering margin keeps them off
    /// the grip limit, so a clean human lap wins.</summary>
    public static IReadOnlyList<(string Id, string Name, string Color, PoCabinetPersonality Personality, double MaxSpeed, double CorneringSkill)> Roster { get; } =
    [
        ("sean-s", "Sean S.", "#3470d8", Officials.SeanS, PoCabinetPhysics.MaxSpeed * 0.93, 0.62),
        ("steve-b", "Steve B.", "#5e4b8b", Officials.SteveB, PoCabinetPhysics.MaxSpeed * 0.95, 0.55),
        ("bill-b", "Bill B.", "#a02c2c", Officials.BillB, PoCabinetPhysics.MaxSpeed * 0.91, 0.70),
        ("mike-p", "Mike P.", "#1c8054", Officials.MikeP, PoCabinetPhysics.MaxSpeed * 0.96, 0.60),
    ];

    /// <summary>
    /// The 99 rivals of a solo race in grid order: the four officials, then 95 field racers from
    /// the quickest to the slowest. Qualifying order on purpose: a grid sorted any other way has
    /// to overtake itself, and a hundred cars doing that on a 27-second lap is a traffic jam,
    /// not a race. A field racer's pace comes from its index; so does its personality, every
    /// trait from a byte of its own (two hashes of the index), so no two cars drive alike and
    /// no trait follows from another. The arithmetic is exact on both sides of the mirror
    /// (<c>physics.js</c> <c>soloField</c>). No names or colours here: the server only re-runs
    /// the physics (<see cref="PoCabinetLapVerifier"/>).
    /// </summary>
    public static IReadOnlyList<(PoCabinetPersonality Personality, double MaxSpeed, double CorneringSkill)> SoloField { get; } = BuildSoloField();

    private static (PoCabinetPersonality, double, double)[] BuildSoloField()
    {
        var field = new (PoCabinetPersonality, double, double)[PoCabinetCatalog.SoloCarCount - 1];
        for (int i = 0; i < Roster.Count; i++) field[i] = (Roster[i].Personality, Roster[i].MaxSpeed, Roster[i].CorneringSkill);
        int n = field.Length - Roster.Count;
        for (int i = 0; i < n; i++)
        {
            uint h = unchecked((uint)(i + 1) * 0x9E3779B1u);
            uint g = unchecked((uint)(i + 1) * 0x85EBCA6Bu);
            double a = (h & 0xff) / 255.0, b = ((h >> 8) & 0xff) / 255.0, c = ((h >> 16) & 0xff) / 255.0, d = (h >> 24) / 255.0;
            double e = (g & 0xff) / 255.0, f = ((g >> 8) & 0xff) / 255.0, k = ((g >> 16) & 0xff) / 255.0, m = (g >> 24) / 255.0;
            double pace = 1 - i / (double)(n - 1);
            field[Roster.Count + i] = (
                new PoCabinetPersonality(
                    LookaheadDistance: 30 + 90 * c,
                    LateralOffset: -0.9 + 1.8 * d,
                    BrakingAggression: 0.05 + 0.9 * e,
                    CollisionTolerance: 0.1 + 0.8 * k,
                    DraftingAffinity: 0.7 * m,
                    // Most of the field is tidy; a few are a liability.
                    Wildness: 0.01 + 0.2 * f * f,
                    Seed: i + 1),
                PoCabinetPhysics.MaxSpeed * (0.7 + 0.2 * pace + 0.03 * a),
                0.25 + 0.35 * pace + 0.08 * b);
        }
        return field;
    }
}
