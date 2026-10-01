using Microsoft.Playwright;
using Xunit.Abstractions;
using Xunit.Sdk;

namespace PoMiniGames.E2EUI;

/// <summary>
/// Two real browsers, one host: every online mode gets paired through its hub and the
/// first thing that has to cross between the two players actually crosses. Turn games
/// relay the opening move; lobby games ready up, start, and both browsers land in the
/// live match. Both contexts sign in as separate auto-guests, so the hubs authenticate
/// through the ordinary cookie rather than injected headers.
/// </summary>
[Collection(KestrelServerCollection.Name)]
public class OnlineModesUiTests
{
    private readonly KestrelServerFixture _fixture;
    private readonly ITestOutputHelper _output;

    public OnlineModesUiTests(KestrelServerFixture fixture, ITestOutputHelper output)
    {
        _fixture = fixture;
        _output = output;
    }

    private string Origin => _fixture.ServerAddress.TrimEnd('/');

    [Theory]
    [InlineData("connectfive", ".cf-status-text", ".cf-cell[aria-colindex='5']", ".cf-cell.red")]
    [InlineData("tictactoe", ".ttt-online__turn", ".ttt-cell:not(.disabled)", ".ttt-cell .ttt-mark--x:not(.ttt-mark--ghost)")]
    public async Task TurnGame_PairsTwoBrowsers_AndRelaysTheOpeningMove(string game, string status, string cell, string placed)
    {
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await LaunchAsync(playwright);
        var a = await OpenAsGuestAsync(browser, $"/{game}/multi", "A");
        var b = await OpenAsGuestAsync(browser, $"/{game}/multi", "B");

        // Who opens is drawn server-side, so wait for whichever browser is told it is on.
        var mover = await WaitForTurnAsync(a, b, status);
        var other = mover == a ? b : a;

        await mover.Locator(cell).First.ClickAsync();

        // The move shows up on the OTHER browser and the turn passes to it.
        await other.Locator(placed).First.WaitForAsync(new LocatorWaitForOptions { Timeout = 20_000 });
        await Assertions.Expect(other.Locator(status).First).ToContainTextAsync("Your turn", new() { Timeout = 20_000 });
        await Assertions.Expect(mover.Locator(status).First).Not.ToContainTextAsync("Your turn", new() { Timeout = 20_000 });
    }

    [Theory]
    [InlineData("/pobrawl/multi", "Start Fight", "/pobrawl/online", "#pobrawl-container canvas")]
    [InlineData("/poracer/multi", "Start Race", "/poracer/multi?code=", ".race-hud")]
    // Voxel Strike's lobby is the Online tab of the game page itself (2026-09-30): the run starts
    // in place, so the URL does not move and the engine canvas — which only exists once the
    // host has started and the squad's arena is built — is what proves both arrived.
    [InlineData("/povoxelstrike/multi", "Start the Run", "/povoxelstrike/multi", "#povoxelstrike-container canvas")]
    public async Task LobbyGame_TwoPlayersReady_HostStarts_AndBothReachTheMatch(string lobby, string startLabel, string matchPath, string marker)
    {
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await LaunchAsync(playwright);
        var first = await OpenAsGuestAsync(browser, lobby, "A");
        var second = await OpenAsGuestAsync(browser, lobby, "B");

        // Both listed, on both screens.
        foreach (var page in new[] { first, second })
        {
            await Assertions.Expect(page.GetByText(new System.Text.RegularExpressions.Regex(@"Players · 2/")))
                .ToBeVisibleAsync(new() { Timeout = 30_000 });
        }

        // Whoever the server made host owns the Start button; everyone with a Ready button presses it
        // (the host has one in Brawl and not in Racer/Voxel Strike — the gates differ per lobby).
        var host = await first.GetByRole(AriaRole.Button, new() { Name = startLabel }).CountAsync() > 0 ? first : second;
        var guest = host == first ? second : first;
        foreach (var page in new[] { guest, host })
        {
            var ready = page.GetByRole(AriaRole.Button, new() { Name = "Ready!" });
            if (await ready.CountAsync() == 0) continue;
            await Assertions.Expect(ready.First).ToBeEnabledAsync(new() { Timeout = 20_000 });
            await ready.First.ClickAsync();
        }

        var start = host.GetByRole(AriaRole.Button, new() { Name = startLabel });
        await Assertions.Expect(start).ToBeEnabledAsync(new() { Timeout = 30_000 });
        await start.ClickAsync();

        foreach (var page in new[] { host, guest })
        {
            await page.WaitForURLAsync(url => url.Contains(matchPath, StringComparison.Ordinal), new() { Timeout = 30_000 });
            // The race/run pages open on their own intro card; Brawl's match page does not.
            await DismissIntroIfShownAsync(page, 15_000);
            // The live match: Brawl's arena canvas, Racer's in-race HUD, Voxel Strike's engine canvas.
            await WaitForMarkerAsync(page, marker, 90_000);
        }
    }

    [Fact]
    public async Task MarbleRace_PairsHostAndGuest_AndStreamsTheRaceToTheGuest()
    {
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await LaunchAsync(playwright);
        var first = await OpenAsGuestAsync(browser, "/pomarblerace/multi", "A");
        var second = await OpenAsGuestAsync(browser, "/pomarblerace/multi", "B");

        // Pairing boots both engines on the dealt seed: the host lands on its countdown card
        // (red marble), the guest on the waiting card (white marble). Both need the GLB course
        // and three.js from the CDN, so this is the slow part.
        var pages = new[] { first, second };
        IPage? host = null;
        var deadline = DateTime.UtcNow.AddSeconds(120);
        while (host is null && DateTime.UtcNow < deadline)
        {
            foreach (var page in pages)
            {
                if (await page.GetByText("You're the RED marble").CountAsync() > 0) { host = page; break; }
            }
            if (host is null) await Task.Delay(1000);
        }
        host.Should().NotBeNull("one of the two browsers must have booted as the host");
        var guest = host == first ? second : first;
        await Assertions.Expect(guest.GetByText("You're the WHITE marble")).ToBeVisibleAsync(new() { Timeout = 120_000 });

        // The host's countdown starts the race; the guest's race starts on the first streamed
        // frame, and its HUD place pill only renders once its engine reports the racing phase.
        await Assertions.Expect(host.Locator(".mr-place")).ToBeVisibleAsync(new() { Timeout = 60_000 });
        await Assertions.Expect(guest.Locator(".mr-place")).ToBeVisibleAsync(new() { Timeout = 60_000 });
    }

    private static async Task<IBrowser> LaunchAsync(IPlaywright playwright)
    {
        var options = BrowserLaunch.Options();
        // Same SwiftShader allowance as the PoVoxelStrike smoke: the three.js games need a GL
        // context to get past GameShell's "needs 3D graphics" gate. Harmless for the 2D boards.
        options.Args = ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"];
        return await playwright.Chromium.LaunchAsync(options);
    }

    /// <summary>A fresh context (own cookies → own guest session), landed on the page with the intro dismissed.</summary>
    private async Task<IPage> OpenAsGuestAsync(IBrowser browser, string path, string tag)
    {
        var context = await browser.NewContextAsync(new BrowserNewContextOptions
        {
            ViewportSize = new ViewportSize { Width = 1280, Height = 900 },
        });
        var page = await context.NewPageAsync();
        page.Console += (_, msg) =>
        {
            if (msg.Type is "error") _output.WriteLine($"[{tag}:browser] {msg.Text}");
        };
        page.PageError += (_, err) => _output.WriteLine($"[{tag}:pageerror] {err}");

        await page.GotoAsync($"{Origin}{path}?autoGuest=1", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 60_000,
        });
        // Most online modes open on the intro card, whose Start is also what connects to the hub.
        // The Racer lobby has none (dropped 2026-09-17) and joins on arrival, so its shared lobby
        // card counts as arrived too.
        var start = page.Locator(".gps-intro-btn--primary").First;
        try
        {
            await page.Locator(".gps-intro-btn--primary, .lobby").First
                .WaitForAsync(new LocatorWaitForOptions { Timeout = 60_000 });
        }
        catch (TimeoutException)
        {
            throw new XunitException($"[{tag}] no intro card or lobby at {page.Url}. {await DescribeAsync(page)}");
        }
        if (await start.CountAsync() > 0) await start.ClickAsync();
        return page;
    }

    private static async Task DismissIntroIfShownAsync(IPage page, int timeoutMs)
    {
        var start = page.Locator(".gps-intro-btn--primary").First;
        try
        {
            await start.WaitForAsync(new LocatorWaitForOptions { Timeout = timeoutMs });
            await start.ClickAsync();
        }
        catch (TimeoutException)
        {
            // No intro on this page — fine.
        }
    }

    private static async Task WaitForMarkerAsync(IPage page, string marker, int timeoutMs)
    {
        try
        {
            await page.Locator(marker).First.WaitForAsync(new LocatorWaitForOptions
            {
                State = WaitForSelectorState.Attached,
                Timeout = timeoutMs,
            });
        }
        catch (TimeoutException)
        {
            throw new XunitException($"'{marker}' never appeared at {page.Url}. {await DescribeAsync(page)}");
        }
    }

    /// <summary>What the page is actually showing, for a failure message that explains itself.</summary>
    private static async Task<string> DescribeAsync(IPage page)
    {
        try
        {
            var text = await page.EvaluateAsync<string>(@"() => (document.body.innerText || '').split(/\s+/).join(' ').slice(0, 700)");
            return $"Page text: {text}";
        }
        catch (Exception ex)
        {
            return $"(page text unavailable: {ex.Message})";
        }
    }

    private static async Task<IPage> WaitForTurnAsync(IPage a, IPage b, string status)
    {
        var deadline = DateTime.UtcNow.AddSeconds(60);
        while (DateTime.UtcNow < deadline)
        {
            foreach (var page in new[] { a, b })
            {
                var locator = page.Locator(status).First;
                if (await locator.CountAsync() == 0) continue;
                var text = await locator.InnerTextAsync();
                if (text.Contains("Your turn", StringComparison.Ordinal)) return page;
            }
            await Task.Delay(500);
        }
        throw new TimeoutException("Neither browser was given the opening move.");
    }
}
