using Microsoft.Playwright;

namespace PoMiniGames.E2EUI.Features.SandPlayground;

/// <summary>
/// E2E-UI smoke for SandPlayground: the engine must actually boot. Its eleven-plus
/// GLSL programs are compiled in the browser, so a slip in a shader string is
/// invisible to <c>dotnet build</c>; one such slip (a dropped line in the composite
/// pass) leaves the page on the error boundary with nothing red anywhere. The demo route is used because it skips the intro card.
/// </summary>
[Collection(KestrelServerCollection.Name)]
public class SandPlaygroundUiTests
{
    private readonly KestrelServerFixture _fixture;

    public SandPlaygroundUiTests(KestrelServerFixture fixture) => _fixture = fixture;

    [Fact]
    public async Task Demo_BootsTheEngine_WithEveryShaderCompiled()
    {
        using var playwright = await Playwright.CreateAsync();
        var options = BrowserLaunch.Options();
        // The simulation is WebGL2; SwiftShader gives the headless shell a real context.
        options.Args = ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"];
        await using var browser = await playwright.Chromium.LaunchAsync(options);
        var context = await browser.NewContextAsync();
        var page = await context.NewPageAsync();
        var errors = new List<string>();
        page.Console += (_, msg) => { if (msg.Type is "error") errors.Add(msg.Text); };
        page.PageError += (_, err) => errors.Add(err);

        var origin = _fixture.ServerAddress.TrimEnd('/');
        // ?debug installs window.__sandPlayground, which init() only reaches once every
        // program has compiled and linked and the first world has been uploaded.
        await page.GotoAsync($"{origin}/sandplayground/demo?autoGuest=1&debug",
            new PageGotoOptions { WaitUntil = WaitUntilState.NetworkIdle, Timeout = 60_000 });

        try
        {
            await page.WaitForFunctionAsync("() => !!window.__sandPlayground",
                null, new PageWaitForFunctionOptions { Timeout = 90_000 });
        }
        catch (TimeoutException) { /* fall through: the assertions below say why */ }

        errors.Where(e => e.Contains("Shader", StringComparison.OrdinalIgnoreCase)
                       || e.Contains("Program link", StringComparison.OrdinalIgnoreCase))
            .Should().BeEmpty("every simulation and render program must compile");
        (await page.EvaluateAsync<bool>("() => !!window.__sandPlayground"))
            .Should().BeTrue("the engine should finish init() and install its debug hook");
        (await page.EvaluateAsync<int>("() => window.__sandPlayground.counts().sand"))
            .Should().BeGreaterThan(100_000, "the first world should be on the grid");
        // The attract reel shows only the simulation; the dock arrives with the first touch.
        (await page.Locator(".sand-playground-dock").CountAsync()).Should().Be(0);
    }
}
