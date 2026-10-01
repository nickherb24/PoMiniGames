using Microsoft.Playwright;

namespace PoMiniGames.E2EUI;

/// <summary>
/// PoSports smoke through a real Chromium browser: the demo route boots the canvas
/// engine and reaches the race, and a 1P run responds to the Q-W-A-S sequence keys.
/// The JS engine exposes a read-only debug handle (window.PoSports._game) for
/// deterministic state polling — the same pattern PoBrawl's automation uses.
/// </summary>
[Collection(KestrelServerCollection.Name)]
public class PoSportsUiTests
{
    private static readonly ViewportSize Portrait = new() { Width = 390, Height = 844 };

    private readonly KestrelServerFixture _fixture;

    public PoSportsUiTests(KestrelServerFixture fixture) => _fixture = fixture;

    private async Task<IPage> OpenAsync(IBrowser browser, string path)
    {
        var context = await browser.NewContextAsync(new BrowserNewContextOptions
        {
            ViewportSize = Portrait,
            ExtraHTTPHeaders = new Dictionary<string, string>
            {
                ["X-Fake-User"] = "test-user",
                ["X-Fake-Roles"] = "Player",
            },
        });
        var page = await context.NewPageAsync();
        // Surface browser-side failures in the xUnit output — a canvas that never
        // appears is almost always a JS error, and this is the only place it shows.
        page.Console += (_, msg) =>
        {
            if (msg.Type is "error" or "warning")
            {
                Console.WriteLine($"[browser:{msg.Type}] {msg.Text}");
            }
        };
        page.PageError += (_, err) => Console.WriteLine($"[pageerror] {err}");
        await page.GotoAsync($"{_fixture.ServerAddress.TrimEnd('/')}{path}?autoGuest=1", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 60_000,
        });
        return page;
    }

    [Fact]
    public async Task Demo_BootsCanvas_AndReachesTheRace()
    {
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync(BrowserLaunch.Options());
        var page = await OpenAsync(browser, "/posports/1");

        // The engine creates its canvas inside the host div once the demo intro flash clears.
        try
        {
            await page.Locator("#posports-container canvas.ps-canvas").WaitForAsync(new LocatorWaitForOptions
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
                    hasContainer: !!document.getElementById('posports-container'),
                    poSports: typeof window.PoSports,
                    game: !!window.PoSports?._game,
                    bodySnippet: document.body.innerText.slice(0, 400),
                })");
            throw new Xunit.Sdk.XunitException($"canvas never attached; page state: {diag}");
        }

        // Poll the debug handle until the meet passes the countdown into racing.
        // Demo countdown is 3 s; sprite fetches are local — 30 s is generous.
        var phase = await page.WaitForFunctionAsync(
            "() => window.PoSports && window.PoSports._game && window.PoSports._game.phase === 'racing'",
            null,
            new PageWaitForFunctionOptions { Timeout = 30_000 });
        (await phase.JsonValueAsync<bool>()).Should().BeTrue();

        // AI lanes must actually move — the race is running, not stalled.
        await page.WaitForFunctionAsync(
            "() => window.PoSports._game.lanes.some(l => l.state.position > 1)",
            null,
            new PageWaitForFunctionOptions { Timeout = 30_000 });
    }

    [Fact]
    public async Task OnePlayer_SequenceKeys_AdvanceTheRunner()
    {
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync(BrowserLaunch.Options());
        var page = await OpenAsync(browser, "/posports");

        // Intro card: the default character (Kim) is preselected — just press OK.
        await page.Locator(".gps-intro-btn--primary").First.ClickAsync(new LocatorClickOptions { Timeout = 60_000 });

        await page.Locator("#posports-container canvas.ps-canvas").WaitForAsync(new LocatorWaitForOptions
        {
            State = WaitForSelectorState.Attached,
            Timeout = 60_000,
        });

        // Wait out the 3 s countdown.
        await page.WaitForFunctionAsync(
            "() => window.PoSports?._game?.phase === 'racing'",
            null,
            new PageWaitForFunctionOptions { Timeout = 30_000 });

        // Type three full Q-W-A-S cycles; the human lane (index 0) must move.
        for (var cycle = 0; cycle < 3; cycle++)
        {
            foreach (var key in new[] { "q", "w", "a", "s" })
            {
                await page.Keyboard.PressAsync(key);
            }
        }

        await page.WaitForFunctionAsync(
            "() => window.PoSports._game.lanes[0].state.position > 0.5",
            null,
            new PageWaitForFunctionOptions { Timeout = 15_000 });
    }
}
