using Microsoft.Playwright;

namespace PoMiniGames.E2EUI;

[Collection(KestrelServerCollection.Name)]
public sealed class PoRacerUiTests(KestrelServerFixture fixture)
{
    [Theory]
    [InlineData("circuit")]
    [InlineData("neonskyline")]
    [InlineData("desertdustway")]
    public async Task SoloRace_CompletesSavesAndCanPlayAgain(string track)
    {
        using var playwright = await Playwright.CreateAsync();
        var launch = BrowserLaunch.Options();
        launch.SlowMo = 0; // Driving samples steering at 20 Hz; human-scale click delays cannot steer.
        await using var browser = await playwright.Chromium.LaunchAsync(launch);
        await using var context = await browser.NewContextAsync(new() { ViewportSize = new() { Width = 1440, Height = 900 } });
        var page = await context.NewPageAsync();
        var errors = new List<string>();
        page.PageError += (_, error) => errors.Add(error);
        var driver = new PoRacerDriver(page);
        await page.GotoAsync($"{fixture.ServerAddress.TrimEnd('/')}/poracer/1player?autoGuest=1");
        await page.GetByRole(AriaRole.Button, new() { Name = "Start race", Exact = true }).WaitForAsync(new() { Timeout = 60000 });
        await page.Locator($"input[name=poracer-track][value={track}]").CheckAsync();
        // The scripted driver holds 235-300 units/s on the centerline: a bronze-medal lap. That
        // keeps up with the Easy field; Medium and Hard would win and close the race on it.
        await page.GetByText("Easy", new() { Exact = true }).ClickAsync();
        var save = page.WaitForResponseAsync(r => r.Url.EndsWith("/api/poracer/scores", StringComparison.Ordinal) && r.Request.Method == "POST", new() { Timeout = 200000 });
        await page.GetByRole(AriaRole.Button, new() { Name = "Start race", Exact = true }).ClickAsync();
        await page.Locator(".race-countdown").WaitForAsync();
        (await page.Locator("#racerCanvas").EvaluateAsync<bool>("e => e === document.activeElement")).Should().BeTrue();
        await driver.DriveAsync(page, track);
        driver.SawCountdown.Should().BeTrue();
        driver.MovedDuringCountdown.Should().BeFalse();
        var result = driver.Result!;
        var mine = result.Standings.Single(s => s.CarId == driver.LocalId);
        mine.Finished.Should().BeTrue("the keyboard-driven player must cross the line after three actual laps");
        mine.BestLapSeconds.Should().BeGreaterThan(0);
        result.Standings.Where(s => s.Finished).Select(s => s.TotalTimeSeconds).Should().BeInAscendingOrder();
        (await save).Status.Should().Be(201);
        await page.GetByText("Best lap saved to the leaderboard.", new() { Exact = true }).WaitForAsync();
        (await page.Locator(".race-results .local-driver").InnerTextAsync()).Should().NotContain("DNF");
        await page.ScreenshotAsync(new() { Path = $"artifacts/poracer-{track}-results.png" });
        await page.GetByRole(AriaRole.Button, new() { Name = "Play again" }).ClickAsync();
        await page.GetByRole(AriaRole.Button, new() { Name = "Start race", Exact = true }).WaitForAsync();
        // The lap just driven is on its track card as a personal best.
        (await page.Locator(".track-card.selected .track-best").InnerTextAsync()).Should().Contain("Your best");
        driver.Reset();
        await page.GetByRole(AriaRole.Button, new() { Name = "Start race", Exact = true }).ClickAsync();
        await page.Locator(".race-metrics").WaitForAsync();
        await BackToStartAsync(page);
        errors.Should().BeEmpty();
    }

    [Fact]
    public async Task SoloRace_UnfinishedPlayerGetsDnfResultsAndCanRestart()
    {
        using var playwright = await Playwright.CreateAsync();
        var launch = BrowserLaunch.Options(); launch.SlowMo = 0;
        await using var browser = await playwright.Chromium.LaunchAsync(launch);
        var page = await browser.NewPageAsync();
        var errors = new List<string>(); page.PageError += (_, error) => errors.Add(error);
        var driver = new PoRacerDriver(page);
        await page.GotoAsync($"{fixture.ServerAddress.TrimEnd('/')}/poracer/1player?autoGuest=1");
        await page.GetByRole(AriaRole.Button, new() { Name = "Start race", Exact = true }).ClickAsync(new() { Timeout = 60000 });
        await driver.DriveAsync(page, "dnf", drive: false);
        driver.Result!.Standings.Single(s => s.CarId == driver.LocalId).Finished.Should().BeFalse();
        await page.Locator(".race-results").WaitForAsync();
        (await page.Locator(".race-results .local-driver").InnerTextAsync()).Should().Contain("DNF");
        await page.GetByRole(AriaRole.Button, new() { Name = "Play again" }).ClickAsync();
        await page.GetByRole(AriaRole.Button, new() { Name = "Start race", Exact = true }).WaitForAsync();
        errors.Should().BeEmpty();
    }

    [Fact]
    public async Task Multiplayer_BindsBothPlayersAfterLeavingTheLobby()
    {
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync(BrowserLaunch.Options());
        await using var first = await browser.NewContextAsync();
        await using var second = await browser.NewContextAsync();
        var host = await first.NewPageAsync();
        var guest = await second.NewPageAsync();
        var url = $"{fixture.ServerAddress.TrimEnd('/')}/poracer/multi?autoGuest=1";
        await host.GotoAsync(url);
        await host.GetByRole(AriaRole.Button, new() { Name = "Start Race", Exact = true }).WaitForAsync(new() { Timeout = 60000 });
        await guest.GotoAsync(url);
        await guest.GetByRole(AriaRole.Button, new() { Name = "Ready!", Exact = true }).ClickAsync(new() { Timeout = 60000 });
        await host.GetByRole(AriaRole.Button, new() { Name = "Start Race", Exact = true }).ClickAsync();
        foreach (var page in new[] { host, guest })
        {
            await page.Locator(".race-metrics").WaitForAsync(new() { Timeout = 30000 });
            await page.Locator("#racerCanvas").ClickAsync();
            await page.Keyboard.DownAsync("ArrowUp");
            await page.WaitForFunctionAsync("() => [...document.querySelectorAll('.race-metrics span')].some(e => e.textContent.includes('km/h') && parseInt(e.textContent) > 0)", null, new() { Timeout = 10000 });
            await page.Keyboard.UpAsync("ArrowUp");
            (await page.Locator(".race-standings .local-driver").CountAsync()).Should().Be(1);
        }
        var hostDriver = await host.Locator(".race-standings .local-driver").GetAttributeAsync("title");
        var guestDriver = await guest.Locator(".race-standings .local-driver").GetAttributeAsync("title");
        hostDriver.Should().NotBe(guestDriver);
    }

    /// <summary>Leave a race the way a player does: the pause menu, then Back to start.</summary>
    private static async Task BackToStartAsync(IPage page)
    {
        await page.GetByRole(AriaRole.Button, new() { Name = "Pause", Exact = true }).ClickAsync();
        await page.GetByRole(AriaRole.Button, new() { Name = "Back to start", Exact = true }).ClickAsync();
        await page.GetByRole(AriaRole.Button, new() { Name = "Start race", Exact = true }).WaitForAsync();
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Race_StartsWithOneClick_InputMovesCar_AndNavigationReleasesTheRenderer(bool touch)
    {
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync(BrowserLaunch.Options());
        await using var context = await browser.NewContextAsync(new()
        {
            ViewportSize = touch ? new() { Width = 390, Height = 844 } : new() { Width = 1280, Height = 900 },
            HasTouch = touch,
            ExtraHTTPHeaders = new Dictionary<string, string> { ["X-Fake-User"] = "racer-user", ["X-Fake-Roles"] = "Player" }
        });
        var page = await context.NewPageAsync();
        var errors = new List<string>();
        page.PageError += (_, error) => errors.Add(error);
        await page.GotoAsync($"{fixture.ServerAddress.TrimEnd('/')}/poracer?autoGuest=1");
        await page.GetByRole(AriaRole.Button, new() { Name = "Start race", Exact = true }).ClickAsync(new() { Timeout = 60000 });
        await page.Locator(".race-metrics").WaitForAsync(new() { Timeout = 30000 });
        if (touch)
        {
            var gas = page.Locator("[data-po-input=up]");
            await gas.DispatchEventAsync("pointerdown", new { pointerId = 1, pointerType = "touch", bubbles = true });
        }
        else
        {
            await page.Locator("#racerCanvas").ClickAsync();
            await page.Keyboard.DownAsync("ArrowUp");
        }
        await page.WaitForFunctionAsync("() => [...document.querySelectorAll('.race-metrics span')].some(e => e.textContent.includes('km/h') && parseInt(e.textContent) > 0)", null, new() { Timeout = 10000 });
        if (touch) await page.Locator("[data-po-input=up]").DispatchEventAsync("pointerup", new { pointerId = 1, bubbles = true });
        else await page.Keyboard.UpAsync("ArrowUp");
        await page.ScreenshotAsync(new() { Path = $"artifacts/poracer-{(touch ? "mobile" : "desktop")}.png" });
        // The minimap and the mini standings are on screen at both sizes (the phone used to lose the standings).
        (await page.Locator("#racerMinimap").IsVisibleAsync()).Should().BeTrue();
        (await page.Locator(".race-standings li").CountAsync()).Should().Be(4);
        await BackToStartAsync(page);
        await page.GetByRole(AriaRole.Button, new() { Name = "Start race", Exact = true }).ClickAsync();
        await page.Locator(".race-metrics").WaitForAsync();
        await BackToStartAsync(page);
        errors.Should().BeEmpty();
        (await page.EvaluateAsync<bool>("() => document.documentElement.scrollWidth <= innerWidth")).Should().BeTrue();
    }
}
