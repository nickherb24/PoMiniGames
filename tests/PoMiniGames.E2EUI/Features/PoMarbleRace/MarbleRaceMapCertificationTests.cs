using System.Text.Json;
using FluentAssertions;
using Microsoft.Playwright;
using Xunit.Abstractions;

namespace PoMiniGames.E2EUI.Features.PoMarbleRace;

/// <summary>
/// Map certification: every Marble Race course runs one full 101-marble race in the real engine
/// (demo field, no steering) and must keep every marble on the map and bring the field home.
/// Rendering is stubbed and the physics is stepped at a fixed 1/60 s as fast as the CPU allows,
/// so this measures the course, not the frame rate.
/// </summary>
/// <remarks>
/// This exists because the maps were never checked as a whole: a 2026-09-30 census found Spiral
/// Works losing ~50 marbles a race (and ~35 more stuck to the timeout) and Grand Spiral losing
/// all 101 — 98% of those to an out-of-bounds test that measured side lanes against the main
/// lane. Run it after any change to a course, the collision shell, the containment or the
/// physics constants. It is slow (a few minutes per map) by nature.
/// </remarks>
[Collection(KestrelServerCollection.Name)]
public class MarbleRaceMapCertificationTests
{
    private const int FieldSize = 101;
    private const int MinFinishers = 96;   // 95% of the field inside the race timeout

    private readonly KestrelServerFixture _fixture;
    private readonly ITestOutputHelper _output;

    public MarbleRaceMapCertificationTests(KestrelServerFixture fixture, ITestOutputHelper output)
    {
        _fixture = fixture;
        _output = output;
    }

    // Boots `mapId` on a fresh engine, stubs rendering, starts the race and hooks eliminate() so a
    // lost marble is reported with where it was.
    private const string SetupJs = """
        async (mapId) => {
          window.PoMarbleRace.stop();
          await window.PoMarbleRace.start('marble-race-container', null, true, mapId, null, null);
          const g = window.__game();
          g.scene.render = () => {};
          g.resume();
          g.pick(0);
          const falls = [];
          const ms = g.marbleSet;
          const eliminate = ms.eliminate;
          ms.eliminate = (m) => {
            if (!m.eliminated) falls.push(`#${m.index} at s=${Math.round(m.s)} lat=${Math.round(m.proj.lateral)} h=${Math.round(m.proj.height)}`);
            eliminate(m);
          };
          window.__cert = { falls };
        }
        """;

    // Steps up to `frames` fixed frames; true once the race has resolved.
    private const string StepJs = """
        (frames) => {
          const g = window.__game();
          for (let k = 0; k < frames && g.phase === 'racing'; k++) g._frame(1 / 60);
          return g.phase !== 'racing';
        }
        """;

    private const string ResultJs = """
        () => {
          const g = window.__game();
          const ms = g.marbleSet.marbles;
          return JSON.stringify({
            finished: ms.filter((m) => m.finished && m.finishTime < 179).length,
            eliminated: ms.filter((m) => m.eliminated).length,
            stalled: ms.filter((m) => m.finished && m.finishTime >= 179).map((m) => Math.round(m.s)),
            clock: Math.round(g.raceClock),
            falls: window.__cert.falls,
          });
        }
        """;

    [Theory]
    [InlineData(1)]   // Neon Chute (procedural; a new seed every run)
    [InlineData(2)]   // Spiral Works
    [InlineData(3)]   // Grand Spiral
    [InlineData(4)]   // Canyon Run (procedural)
    public async Task Map_KeepsEveryMarbleOnTheCourse_AndBringsTheFieldHome(int mapId)
    {
        using var playwright = await Playwright.CreateAsync();
        var options = BrowserLaunch.Options();
        // The engine needs a GL context to boot even though nothing is drawn.
        options.Args = ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"];
        await using var browser = await playwright.Chromium.LaunchAsync(options);
        var page = await (await browser.NewContextAsync()).NewPageAsync();
        page.PageError += (_, err) => _output.WriteLine($"[pageerror] {err}");

        var origin = _fixture.ServerAddress.TrimEnd('/');
        await page.GotoAsync($"{origin}/pomarblerace/demo?autoGuest=1",
            new PageGotoOptions { WaitUntil = WaitUntilState.NetworkIdle, Timeout = 60_000 });
        await page.WaitForFunctionAsync("() => window.__game && window.__game()", null,
            new PageWaitForFunctionOptions { Timeout = 120_000 });

        await page.EvaluateAsync(SetupJs, mapId);
        var deadline = DateTime.UtcNow.AddMinutes(12);
        while (!await page.EvaluateAsync<bool>(StepJs, 300))
        {
            DateTime.UtcNow.Should().BeBefore(deadline, "a race must resolve (finish or time out) within the step budget");
        }

        using var result = JsonDocument.Parse(await page.EvaluateAsync<string>(ResultJs));
        var root = result.RootElement;
        var finished = root.GetProperty("finished").GetInt32();
        var eliminated = root.GetProperty("eliminated").GetInt32();
        var falls = root.GetProperty("falls").EnumerateArray().Select(f => f.GetString()).ToList();
        var stalled = root.GetProperty("stalled").EnumerateArray().Select(s => s.GetInt32()).ToList();
        _output.WriteLine($"map {mapId}: finished {finished}/{FieldSize}, lost {eliminated}, stalled {stalled.Count}, clock {root.GetProperty("clock").GetInt32()}s");

        eliminated.Should().Be(0, $"no marble may leave map {mapId}; lost: {string.Join("; ", falls)}");
        finished.Should().BeGreaterThanOrEqualTo(MinFinishers,
            $"map {mapId} must bring the field home; stuck at s = {string.Join(", ", stalled)}");
    }
}
