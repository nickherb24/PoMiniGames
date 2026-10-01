using FluentAssertions;
using PoMiniGames.Features.PoRacer;
using PoMiniGames.Shared.Games;
using Xunit;
using Xunit.Abstractions;

namespace PoMiniGames.Unit.Features.PoRacer;

/// <summary>
/// Headless multi-track simulation tests. Verifies all 3 tracks (circuit, neonskyline, desertdustway),
/// surface physics detection (sand grip reduction), boost pad triggering, and AI lap completion.
/// </summary>
public class PoRacerSimAiTests
{
    private readonly ITestOutputHelper _out;
    public PoRacerSimAiTests(ITestOutputHelper output) => _out = output;

    [Theory]
    [InlineData("circuit")]
    [InlineData("neonskyline")]
    [InlineData("desertdustway")]
    [InlineData("circuit", true)]
    public void RaceCompletion_FinishesBotsOrSerializesDnf(string trackId, bool expireRace = false)
    {
        var sim = new PoRacerSim(Array.Empty<PoRacerLobbyPlayer>(), trackId);
        var noInput = new Dictionary<string, PoRacerInput>();
        if (expireRace)
        {
            VerifyCountdownAndRankings();
            // Advance the race clock past its safety cap without a real-time delay.
            typeof(PoRacerSim).GetField("_startElapsedMs", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!
                .SetValue(sim, -181_000L);
            sim.Tick(0.02, noInput);
            var snapshot = sim.Snapshot("dnf");
            snapshot.Finished.Should().BeTrue();
            snapshot.Cars.Should().OnlyContain(c => !c.Finished && c.FinishTime == -1);
            var result = sim.BuildFinalResult("dnf");
            result.Standings.Should().OnlyContain(c => !c.Finished && c.TotalTimeSeconds == -1);
            // Both messages travel over SignalR when a race ends with unfinished cars.
            var snapshotJson = System.Text.Json.JsonSerializer.Serialize(snapshot);
            var resultJson = System.Text.Json.JsonSerializer.Serialize(result);
            System.Text.Json.JsonSerializer.Deserialize<PoRacerRaceSnapshot>(snapshotJson)!.Finished.Should().BeTrue();
            System.Text.Json.JsonSerializer.Deserialize<PoRacerFinalResult>(resultJson)!.Standings.Should().HaveCount(PoRacerCatalog.CarCount);
            return;
        }
        const double dt = 0.02;              // 50 Hz, matches the server tick rate
        const int maxTicks = 12_000;         // 240 sim-seconds hard budget

        var finishSec = new Dictionary<int, double>();
        int carCount = sim.Snapshot("t").Cars.Count;

        bool anyCarBoosted = false;
        bool anyCarHitSand = false;
        double fastest = 0;

        int tick = 0;
        for (; tick < maxTicks; tick++)
        {
            sim.Tick(dt, noInput);
            var snap = sim.Snapshot("t");
            foreach (var car in snap.Cars)
            {
                fastest = Math.Max(fastest, car.Speed);
                if (car.BoostTimer > 0) anyCarBoosted = true;
                if (car.Surface == "sand") anyCarHitSand = true;
                if (car.Finished && !finishSec.ContainsKey(car.Id))
                    finishSec[car.Id] = (tick + 1) * dt;
            }
            if (finishSec.Count == carCount) break;
        }

        var final = sim.Snapshot("t");
        int finished = final.Cars.Count(c => c.Finished);
        double raceSeconds = (tick + 1) * dt;

        _out.WriteLine($"track={trackId} cars={carCount} finished={finished} raceSeconds={raceSeconds:0.0}");
        foreach (var kv in finishSec.OrderBy(k => k.Value))
            _out.WriteLine($"  car {kv.Key} finished at {kv.Value:0.0}s");
        foreach (var c in final.Cars.Where(c => !c.Finished))
            _out.WriteLine($"  UNFINISHED car {c.Id} ({sim.Static.Roster[c.Id].Name}): Lap={c.Lap}, Pos=({c.X:0.0},{c.Y:0.0}), Speed={c.Speed:0.0}");

        var names = sim.Static.Roster.Select(c => c.Name).ToList();
        names.Distinct().Count().Should().Be(names.Count,
            "each car needs a unique name");

        finished.Should().Be(carCount, $"every AI bot should complete the 3-lap race on {trackId} without getting stuck");

        var times = finishSec.Values.OrderBy(x => x).ToList();
        double winner = times.First();
        double last = times.Last();
        _out.WriteLine($"winner={winner:0.0}s last={last:0.0}s spread={last - winner:0.0}s");

        winner.Should().BeLessThan(140, "the leading bot should not crawl");
        (last - winner).Should().BeGreaterThan(0.2, "racing should produce a spread");

        // Verify boost pad triggering on all tracks
        // Every track has pads since 2026-10-01 (all three shipped with none), a pad lifts top
        // speed as well as push, and a bot must not brake for the extra: the quickest bot's
        // nominal top speed is 325, so anything past 335 was a boost carried at full throttle.
        PoRacerTrackRegistry.GetTrack(trackId).BoostPads.Should().NotBeEmpty();
        anyCarBoosted.Should().BeTrue("at least one car should drive over the track's boost pads");
        fastest.Should().BeGreaterThan(335, "a boost pad raises top speed");

        // Verify desert sand surface interaction
        if (trackId == "desertdustway")
        {
            anyCarHitSand.Should().BeTrue("desert dustway must trigger sand surface physics during cornering");
        }
    }

    private static void VerifyCountdownAndRankings()
    {
        const System.Reflection.BindingFlags flags = System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic;
        var sim = new PoRacerSim([new("connection", "Player", true, true, "owner")], countdownSeconds: 3);
        var input = new Dictionary<string, PoRacerInput> { ["owner"] = new() { Up = true } };
        var grid = sim.Snapshot("rules");
        sim.Tick(0.02, input);
        var waiting = sim.Snapshot("rules");
        waiting.Started.Should().BeFalse();
        waiting.CountdownSeconds.Should().BeInRange(1, 3);
        waiting.ElapsedRaceTime.Should().Be(0);
        waiting.Cars.Select(c => (c.X, c.Y, c.Speed)).Should().Equal(grid.Cars.Select(c => (c.X, c.Y, c.Speed)));
        typeof(PoRacerSim).GetField("_startElapsedMs", flags)!.SetValue(sim, -1L);
        sim.Tick(0.02, input);
        sim.Snapshot("rules").Cars[0].Speed.Should().BeGreaterThan(0);

        var cars = ((System.Collections.IEnumerable)typeof(PoRacerSim).GetField("_cars", flags)!.GetValue(sim)!).Cast<object>().ToArray();
        static void Set(object car, string name, object value) => car.GetType().GetField(name)!.SetValue(car, value);
        void Progress(object car, int lap, int node)
        {
            Set(car, "Lap", lap); Set(car, "LastCheckpoint", node); Set(car, "ProjIdx", node);
            Set(car, "CheckpointT", 0.0); Set(car, "ProjT", 0.0);
            typeof(PoRacerSim).GetMethod("UpdateRaceProgress", flags)!.Invoke(sim, [car]);
        }
        Progress(cars[0], 1, sim.Static.CenterXY.Count / 2 - 4);
        Progress(cars[1], 2, 1);
        typeof(PoRacerSim).GetMethod("Rank", flags)!.Invoke(sim, null);
        var ranked = sim.Snapshot("rules");
        ranked.Cars[1].Position.Should().BeLessThan(ranked.Cars[0].Position, "a whole lap must outweigh position within that lap");

        Set(cars[0], "Lap", 4); Set(cars[0], "FinishTime", 12.0); Set(cars[0], "DistanceAlongTrack", 999999.0);
        Set(cars[1], "Lap", 4); Set(cars[1], "FinishTime", 10.0);
        typeof(PoRacerSim).GetMethod("Rank", flags)!.Invoke(sim, null);
        var finish = sim.BuildFinalResult("rules");
        finish.Standings[0].CarId.Should().Be(1);
        finish.Standings[1].CarId.Should().Be(0);
        finish.Standings.Where(c => c.Finished).Select(c => c.TotalTimeSeconds).Should().BeInAscendingOrder();
        // Finished cars cannot gain another lap or move their crossing timestamp.
        var before = sim.Snapshot("rules").Cars[0];
        sim.Tick(0.02, input);
        var after = sim.Snapshot("rules").Cars[0];
        after.Lap.Should().Be(before.Lap);
        after.FinishTime.Should().Be(before.FinishTime);
        VerifyTrialPaintAnalogAndPause();
    }

    // 2026-09-30 rules: a time trial grids humans only, paint off the wire is validated, an
    // analog axis is clamped and wins over its key, and a pause stops the race clock.
    private static void VerifyTrialPaintAnalogAndPause()
    {
        const System.Reflection.BindingFlags flags = System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic;
        var sim = new PoRacerSim([new("connection", "Player", true, true, "owner")], bots: false);
        sim.Snapshot("trial").Cars.Should().ContainSingle("a time trial has no bots");
        sim.Static.Roster.Should().ContainSingle().Which.IsPlayer.Should().BeTrue();

        var before = sim.Static.Roster[0];
        sim.SetPaint("owner", "red; drop table", "plaid").Should().BeFalse("neither value is a colour or a known livery");
        sim.SetPaint("stranger", "#ff3333", "neon").Should().BeFalse();
        sim.SetPaint("owner", "#FF3333", "neon").Should().BeTrue();
        sim.Static.Roster[0].Should().Match<PoRacerCarInfo>(c => c.Color == "#ff3333" && c.Livery == "neon" && c.ColorDark != before.ColorDark);

        // Throttle 5 is clamped to 1: the car gains exactly what the key would give it.
        var keyed = new PoRacerSim([new("connection", "Player", true, true, "owner")], bots: false);
        for (var i = 0; i < 25; i++)
        {
            sim.Tick(0.02, new Dictionary<string, PoRacerInput> { ["owner"] = new() { Throttle = 5, Steer = double.NaN } });
            keyed.Tick(0.02, new Dictionary<string, PoRacerInput> { ["owner"] = new() { Up = true } });
        }
        var analog = sim.Snapshot("trial").Cars[0];
        analog.Speed.Should().BeGreaterThan(0).And.Be(keyed.Snapshot("trial").Cars[0].Speed);
        // Throttle only, no steering: the grid points 0.09 rad off the first straight, so the car
        // meets the barrier. It must glance off and keep its speed, not be turned into the wall
        // and ground down to a crawl (which is what a wrong-signed deflection did).
        var slowest = double.MaxValue;
        for (var i = 0; i < 700; i++)
        {
            keyed.Tick(0.02, new Dictionary<string, PoRacerInput> { ["owner"] = new() { Up = true } });
            if (i > 150) slowest = Math.Min(slowest, keyed.Snapshot("trial").Cars[0].Speed);
        }
        slowest.Should().BeGreaterThan(120, "a brush with the barrier costs speed once, not on every tick");
        keyed.Snapshot("trial").Cars[0].Damage.Should().BeInRange(0.01, 0.5, "damage is by how hard the barrier was met, and glancing blows are small");
        // Half throttle is a smaller push than full.
        var half = new PoRacerSim([new("connection", "Player", true, true, "owner")], bots: false);
        for (var i = 0; i < 25; i++) half.Tick(0.02, new Dictionary<string, PoRacerInput> { ["owner"] = new() { Throttle = 0.5 } });
        half.Snapshot("trial").Cars[0].Speed.Should().BeInRange(1, analog.Speed - 1);

        // Paused: ticks move nothing and the race clock stands still; resuming carries on from there.
        typeof(PoRacerSim).GetField("_startElapsedMs", flags)!.SetValue(sim, -5_000L);
        sim.SetPaused(true);
        var frozen = sim.Snapshot("trial");
        frozen.Paused.Should().BeTrue();
        Thread.Sleep(40);
        sim.Tick(0.02, new Dictionary<string, PoRacerInput> { ["owner"] = new() { Up = true } });
        var still = sim.Snapshot("trial");
        still.ElapsedRaceTime.Should().Be(frozen.ElapsedRaceTime);
        (still.Cars[0].X, still.Cars[0].Y).Should().Be((frozen.Cars[0].X, frozen.Cars[0].Y));
        sim.SetPaused(false);
        sim.Snapshot("trial").ElapsedRaceTime.Should().BeInRange(frozen.ElapsedRaceTime, frozen.ElapsedRaceTime + 0.03, "the paused 40 ms is not race time");
        VerifyTowDriftAndStandIn();
    }

    // 2026-10-01 rules: a human gets a tow and a non-drafting bot does not, a held drift keeps
    // its speed and pays out a boost on release, and a seat handed to the stand-in bot is driven
    // but loses its claim to the board. (Called from the helper above: the Unit tier is at its
    // 100-method ceiling.)
    private static void VerifyTowDriftAndStandIn()
    {
        static Dictionary<string, PoRacerInput> Keys(PoRacerInput input) => new() { ["owner"] = input };

        // Tow. On the grid the human (car 0) sits a car length behind car 2, and car 2 behind car 4.
        // Car 2 is the Aggressive Bumper, which does not draft, so only the human is in a tow.
        var grid = new PoRacerSim([new("connection", "Player", true, true, "owner")]);
        grid.Tick(0.02, Keys(new()));
        var towed = grid.Snapshot("tow").Cars;
        towed[0].Drafting.Should().BeTrue("every human gets the slipstream");
        towed[2].Drafting.Should().BeFalse("among the bots only the drafting personalities do, so the solo tiers keep their pace");

        // Drift. 1.2 s of throttle (short of the first boost pad), then 0.6 s of handbrake with the wheel turned.
        var sim = new PoRacerSim([new("connection", "Player", true, true, "owner")], bots: false);
        for (var i = 0; i < 60; i++) sim.Tick(0.02, Keys(new() { Up = true }));
        var entry = sim.Snapshot("drift").Cars[0].Speed;
        for (var i = 0; i < 30; i++) sim.Tick(0.02, Keys(new() { Up = true, Right = true, Space = true }));
        var sliding = sim.Snapshot("drift").Cars[0];
        sliding.Drift.Should().BeGreaterThanOrEqualTo(0.3, "a held drift charges");
        sliding.Speed.Should().BeGreaterThan(entry * 0.6, "a drift scrubs speed, it does not stop the car (the old handbrake left a sixth)");
        sliding.BoostTimer.Should().Be(0);
        sim.Tick(0.02, Keys(new() { Up = true }));
        var released = sim.Snapshot("drift").Cars[0];
        released.BoostTimer.Should().BeGreaterThan(0.3, "letting go of a charged drift pays out a boost");
        released.Drift.Should().Be(0);
        // A dab too short to charge pays nothing.
        var dab = new PoRacerSim([new("connection", "Player", true, true, "owner")], bots: false);
        for (var i = 0; i < 60; i++) dab.Tick(0.02, Keys(new() { Up = true }));
        for (var i = 0; i < 8; i++) dab.Tick(0.02, Keys(new() { Up = true, Right = true, Space = true }));
        dab.Tick(0.02, Keys(new() { Up = true }));
        dab.Snapshot("drift").Cars[0].BoostTimer.Should().Be(0);

        // Stand-in. The seat is driven with no input at all, and is no longer anyone's to submit.
        var absent = new PoRacerSim([new("connection", "Player", true, true, "owner")], bots: false);
        absent.Humans.Should().ContainSingle();
        absent.SetAutopilot("owner", true);
        for (var i = 0; i < 100; i++) absent.Tick(0.02, new Dictionary<string, PoRacerInput>());
        absent.Snapshot("stand-in").Cars[0].Speed.Should().BeGreaterThan(100, "the stand-in bot drives the seat");
        absent.Humans.Should().BeEmpty("a lap the bot helped set is not the driver's to put on the board");
        absent.SetAutopilot("owner", false);
        absent.Humans.Should().BeEmpty("having been driven is not undone by taking the wheel back");
    }
}
