using System.Buffers.Binary;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoCabinet;

/// <summary>
/// Server-side proof for a solo best lap (2026-09-29). The browser runs solo races itself, so a
/// bare "my best lap was 31.2 s" is just a number anyone can POST. Instead the page sends the
/// player's controls for every race tick and this class re-runs the whole race — the player
/// plus the four officials, contacts included — through <see cref="PoCabinetPhysics"/> and
/// <see cref="PoCabinetAiDriver"/>. The lap time that gets stored is the one computed here.
///
/// <para>
/// <b>Mirror contract:</b> <see cref="Replay"/> is <c>race.js</c> <c>buildSoloCars</c> +
/// <c>soloTick</c> + <c>lapBookkeeping</c>: same grid (player id 0 in slot 2, officials in
/// roster order in slots 0, 1, 3, 4), same car order for contacts, same clock arithmetic
/// (<c>clock += TICK</c>, <c>tickStart = max(0, elapsed − TICK)</c>). The page quantizes the
/// player's controls to thousandths <i>before</i> stepping them, so the recorded integers are
/// exactly what the browser simulated. JS and .NET trig can still differ in the last ulp, so
/// the replay is not bit-identical — which is why the stored time is the server's, never the
/// claim.
/// </para>
/// <para>
/// What this does not prove: that a human drove it. A bot that emits a legal input stream
/// sets a legal lap. It does rule out every lap the physics cannot produce.
/// </para>
/// </summary>
public static class PoCabinetLapVerifier
{
    /// <summary>race.js <c>MAX_RECORD_FRAMES</c>: eight minutes of ticks.</summary>
    public const int MaxTicks = 30 * 60 * 8;
    public const int BytesPerTick = 6;
    /// <summary>race.js: solo rain grip (<c>currentEnvironment().raining ? 0.85 : 1</c>).</summary>
    public const double WetGrip = 0.85;
    private const int PlayerSlot = 2;
    private const double Countdown = 3;

    /// <summary>
    /// Decode a base64 input log: per race tick, three little-endian int16s — throttle and
    /// brake in [0, 1000], steer in [-1000, 1000]. Null when malformed or too long.
    /// </summary>
    public static PoCabinetControls[]? Decode(string? base64)
    {
        if (string.IsNullOrEmpty(base64) || base64.Length > (MaxTicks * BytesPerTick + 2) / 3 * 4) return null;
        byte[] bytes;
        try { bytes = Convert.FromBase64String(base64); }
        catch (FormatException) { return null; }
        if (bytes.Length == 0 || bytes.Length % BytesPerTick != 0) return null;

        var ticks = new PoCabinetControls[bytes.Length / BytesPerTick];
        for (int i = 0; i < ticks.Length; i++)
        {
            var span = bytes.AsSpan(i * BytesPerTick);
            short t = BinaryPrimitives.ReadInt16LittleEndian(span);
            short b = BinaryPrimitives.ReadInt16LittleEndian(span[2..]);
            short s = BinaryPrimitives.ReadInt16LittleEndian(span[4..]);
            if (t is < 0 or > 1000 || b is < 0 or > 1000 || s is < -1000 or > 1000) return null;
            ticks[i] = new PoCabinetControls(t / 1000.0, b / 1000.0, s / 1000.0);
        }
        return ticks;
    }

    /// <summary>
    /// Re-run a solo race with the recorded controls and return the player's best completed lap
    /// in seconds, or -1 when the inputs never complete one.
    /// </summary>
    public static double Replay(string trackId, bool wet, IReadOnlyList<PoCabinetControls> inputs)
    {
        var track = PoCabinetTrack.Get(trackId);
        double grip = wet ? WetGrip : 1;
        double tick = PoCabinetPhysics.TickSeconds;
        int totalLaps = PoCabinetCatalog.TotalLaps;

        var cars = new List<Car>();
        var player = new Car { IsPlayer = true };
        PoCabinetPhysics.GridSlot(track, player, PlayerSlot);
        cars.Add(player);
        int slot = 0;
        foreach (var o in PoCabinetPersonality.Roster)
        {
            if (slot == PlayerSlot) slot++;
            var car = new Car { Persona = o.Personality, MaxSpeed = o.MaxSpeed, CorneringSkill = o.CorneringSkill };
            PoCabinetPhysics.GridSlot(track, car, slot++);
            cars.Add(car);
        }

        double clock = 0;
        int used = 0;
        while (used < inputs.Count && !player.Finished)
        {
            clock += tick;
            double elapsed = clock - Countdown;
            if (elapsed < 0) continue;
            double tickStart = Math.Max(0, elapsed - tick);
            double stepDt = elapsed - tickStart;
            var controls = inputs[used++];

            foreach (var car in cars)
            {
                car.PrevDistance = car.Distance;
                var c = car.IsPlayer
                    ? controls
                    : PoCabinetAiDriver.Decide(track, car, car.Persona!, car.Finished ? car.MaxSpeed * 0.6 : car.MaxSpeed,
                        car.CorneringSkill, cars, grip);
                PoCabinetPhysics.Step(track, car, c, stepDt, grip);
            }
            PoCabinetPhysics.ResolveContacts(cars);

            foreach (var car in cars)
            {
                if (car.Finished) continue;
                while (car.Distance >= (car.LapsDone + 1) * track.Length)
                {
                    double boundary = (car.LapsDone + 1) * track.Length;
                    double span = car.Distance - car.PrevDistance;
                    double frac = span > 1e-9 ? Math.Min(1, Math.Max(0, (boundary - car.PrevDistance) / span)) : 1;
                    double crossedAt = tickStart + frac * stepDt;
                    double lapTime = crossedAt - car.LapStart;
                    car.LapStart = crossedAt;
                    if (car.BestLap <= 0 || lapTime < car.BestLap) car.BestLap = lapTime;
                    car.LapsDone++;
                    if (car.LapsDone >= totalLaps)
                    {
                        car.Finished = true;
                        break;
                    }
                }
            }
        }
        return player.BestLap > 0 ? player.BestLap : -1;
    }

    private sealed class Car : PoCabinetCarBody
    {
        public bool IsPlayer { get; init; }
        public PoCabinetPersonality? Persona { get; init; }
        public double MaxSpeed { get; init; } = PoCabinetPhysics.MaxSpeed;
        public double CorneringSkill { get; init; } = 0.7;
        public double PrevDistance { get; set; }
        public int LapsDone { get; set; }
        public double LapStart { get; set; }
        public double BestLap { get; set; }
        public bool Finished { get; set; }
    }
}
