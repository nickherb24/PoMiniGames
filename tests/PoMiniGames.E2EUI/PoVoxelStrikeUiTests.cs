using Microsoft.Playwright;

namespace PoMiniGames.E2EUI;

/// <summary>
/// PoVoxelStrike smoke through a real Chromium browser: the demo route boots the
/// three.js engine, builds the arena (imported voxel assets or the procedural
/// fallback), and the debug handle (window.__pvs — same convention as PoSports'
/// _game) reports a live, populated world.
/// </summary>
[Collection(KestrelServerCollection.Name)]
public class PoVoxelStrikeUiTests
{
    private static readonly ViewportSize Portrait = new() { Width = 390, Height = 844 };

    private readonly KestrelServerFixture _fixture;

    public PoVoxelStrikeUiTests(KestrelServerFixture fixture) => _fixture = fixture;

    [Fact]
    public async Task Demo_BootsTheArena()
    {
        using var playwright = await Playwright.CreateAsync();
        // Three.js needs a WebGL context and this Playwright build's default headless
        // launch has none (GameShell then correctly shows the "needs 3D graphics"
        // panel — which is also why no other three.js game has a canvas smoke here).
        // Allow SwiftShader software GL for this one test.
        var options = BrowserLaunch.Options();
        options.Args = ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"];
        await using var browser = await playwright.Chromium.LaunchAsync(options);
        var context = await browser.NewContextAsync(new BrowserNewContextOptions { ViewportSize = Portrait });

        // Same header-driven FakeAuth identity the PoSports UI smoke uses — but injected
        // per-request for the app origin ONLY. Context-wide ExtraHTTPHeaders ride on every
        // request including the three.js/cannon-es CDN imports, where a custom X-Fake-*
        // header forces a CORS preflight jsdelivr rejects — killing the engine import.
        var origin = _fixture.ServerAddress.TrimEnd('/');
        await context.RouteAsync($"{origin}/**", async route =>
        {
            var headers = new Dictionary<string, string>(route.Request.Headers)
            {
                ["X-Fake-User"] = "test-user",
                ["X-Fake-Roles"] = "Player",
            };
            await route.ContinueAsync(new RouteContinueOptions { Headers = headers });
        });
        var page = await context.NewPageAsync();
        page.Console += (_, msg) =>
        {
            if (msg.Type is "error" or "warning")
            {
                Console.WriteLine($"[browser:{msg.Type}] {msg.Text}");
            }
        };
        page.PageError += (_, err) => Console.WriteLine($"[pageerror] {err}");

        await page.GotoAsync($"{_fixture.ServerAddress.TrimEnd('/')}/povoxelstrike/demo?autoGuest=1", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 60_000,
        });

        // The engine mounts its canvas inside the host div after the demo intro clears
        // and the voxel assets stream in (Cache API cold on a fresh browser context).
        try
        {
            await page.Locator("#povoxelstrike-container canvas").WaitForAsync(new LocatorWaitForOptions
            {
                State = WaitForSelectorState.Attached,
                Timeout = 60_000,
            });
        }
        catch (TimeoutException)
        {
            var diag = await page.EvaluateAsync<string>(
                @"() => JSON.stringify({
                    url: location.href,
                    hasContainer: !!document.getElementById('povoxelstrike-container'),
                    webgl: typeof window.isWebGlAvailable === 'function' ? window.isWebGlAvailable() : 'no-probe',
                    engine: typeof window.PoVoxelStrike,
                    bodySnippet: document.body.innerText.slice(0, 400),
                })");
            throw new Xunit.Sdk.XunitException($"canvas never attached; page state: {diag}");
        }

        // A live world: structures placed (imported or procedural fallback — either way
        // non-zero) and the render loop running.
        await page.WaitForFunctionAsync(
            "() => window.__pvs && window.__pvs() && window.__pvs().structures.length > 0 && window.__pvs().running",
            null,
            new PageWaitForFunctionOptions { Timeout = 30_000 });
    }
}
