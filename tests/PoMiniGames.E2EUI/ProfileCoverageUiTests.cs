using Microsoft.Playwright;

namespace PoMiniGames.E2EUI;

/// <summary>
/// §5 E2E-UI coverage for the profile page's game roster and the offline treatment.
/// </summary>
/// <remarks>
/// These live in the browser tier rather than a cheaper one because both surfaces are
/// only reachable through a real browser: the profile's rating classification is
/// private to the Razor component and reads localStorage over JS interop, and the
/// offline treatment is driven by <c>navigator.onLine</c>. Neither has a seam the
/// Unit or Integration tiers can reach without inventing one that exists only for
/// tests.
///
/// Scope limit: the published service worker is NOT exercised here. The test host
/// serves the no-op development worker (see wwwroot/service-worker.js), so real
/// cache-first offline loading has to be verified against published output. What is
/// covered here is the offline *UX contract* — banner shown, network-dependent games
/// made unavailable — which is what regresses silently.
/// </remarks>
[Collection(KestrelServerCollection.Name)]
public class ProfileCoverageUiTests
{
    private readonly KestrelServerFixture _fixture;

    public ProfileCoverageUiTests(KestrelServerFixture fixture) => _fixture = fixture;

    private async Task<IPage> NewSignedInPageAsync(IBrowser browser)
    {
        var context = await browser.NewContextAsync(new BrowserNewContextOptions
        {
            ViewportSize = MobileViewport.Portrait,
        });
        await context.SetExtraHTTPHeadersAsync(new Dictionary<string, string>
        {
            ["X-Fake-User"] = "test-user",
            ["X-Fake-Roles"] = "Player",
        });
        return await context.NewPageAsync();
    }

    [Fact]
    public async Task Profile_ListsEveryGame_IncludingPlayCountOnlyEntries()
    {
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync(BrowserLaunch.Options());
        var page = await NewSignedInPageAsync(browser);

        await page.GotoAsync($"{_fixture.ServerAddress}profile?autoGuest=1",
            new PageGotoOptions { WaitUntil = WaitUntilState.NetworkIdle });
        await page.Locator(".prf-game-name").First.WaitForAsync(
            new LocatorWaitForOptions { Timeout = 30_000 });

        // Seed a session count for a game that has no outcome and no score. Play
        // counts are keyed by the stable player id (see GameStatsService), which the
        // profile render above has already created — so unlike the mutable display
        // name, this key can be reproduced here exactly. Reading the id rather than
        // hardcoding it keeps the test honest if the scheme changes.
        var playerId = await page.EvaluateAsync<string?>(
            "() => localStorage.getItem('pomini_player_id')");
        playerId.Should().NotBeNullOrWhiteSpace(
            because: "rendering the profile resolves the player id that play counts are keyed by");

        await page.EvaluateAsync(
            "id => localStorage.setItem(`pomini_plays_pojoker_${id}`, '3')", playerId);

        await page.ReloadAsync(new PageReloadOptions { WaitUntil = WaitUntilState.NetworkIdle });
        await page.Locator(".prf-game-name").First.WaitForAsync(
            new LocatorWaitForOptions { Timeout = 30_000 });

        var names = await page.Locator(".prf-game-name").AllInnerTextsAsync();

        // The whole point of the change: the profile used to report three of ten
        // games, so several games recorded stats no one could ever see.
        names.Should().Contain(["Tic-Tac-Toe", "Connect Five", "Brawl", "Sports",
            "Fun Quiz", "Racer", "Couple Quiz", "Marble Race", "Joker", "Voxel Strike"]);

        // Joker carries a session count, not a win rate.
        var joker = page.Locator(".prf-game-card", new PageLocatorOptions
        {
            HasText = "Joker",
        }).First;
        (await joker.Locator(".prf-game-plays").InnerTextAsync()).Should().Contain("3",
            because: "a play-count-only game reports sessions where a rated game reports a record");
        (await joker.Locator(".prf-game-wr").CountAsync()).Should().Be(0,
            because: "a game with no win condition must not display a win rate");
    }

    [Fact]
    public async Task Offline_ShowsBanner_AndMakesNetworkOnlyGamesUnavailable()
    {
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync(BrowserLaunch.Options());
        var page = await NewSignedInPageAsync(browser);

        await page.GotoAsync($"{_fixture.ServerAddress}?autoGuest=1",
            new PageGotoOptions { WaitUntil = WaitUntilState.NetworkIdle });

        // The home page is one game-major grid: a card per game, a chip per mode,
        // all of it visible at once. Nothing has to be expanded first — the four
        // collapsible mode sections (and their .home-section-toggle buttons) were
        // replaced when the page moved to GameCatalog.All.
        await page.Locator("a.home-mode-chip[href='/couplequiz']").WaitForAsync(
            new LocatorWaitForOptions { Timeout = 30_000 });

        // Online: nothing is suppressed.
        (await page.Locator(".gl-offline-banner").CountAsync()).Should().Be(0);
        (await page.Locator(".home-mode-chip--offline").CountAsync()).Should().Be(0);

        await page.Context.SetOfflineAsync(true);

        // The banner is the whole reason offline support is discoverable: with a
        // service worker installed the shell keeps working, so without it a failing
        // multiplayer game reads as a bug rather than as a connection problem.
        await page.Locator(".gl-offline-banner").WaitForAsync(
            new LocatorWaitForOptions { Timeout = 15_000 });

        // Every hub-backed entry must stop being navigable — otherwise the player is
        // dropped into a lobby that can never connect.
        //
        // Asserted on aria-label rather than inner text: a mode chip's text is just
        // its mode ("Online", "1P"), so the game it belongs to is only recoverable
        // from the accessible name. That is also the name a screen-reader user gets,
        // which makes it the right thing to be asserting on.
        (await page.Locator(".home-mode-chip--offline").CountAsync())
            .Should().BeGreaterThan(0, because: "hub-backed modes must be suppressed offline");
        (await page.Locator(".home-mode-chip--offline[aria-label*='Couple Quiz']").CountAsync())
            .Should().BeGreaterThan(0, because: "Couple Quiz is hub-backed in every mode");

        // The multiplayer chip must also stop being a link, not merely look disabled.
        (await page.Locator("a.home-mode-chip[href='/couplequiz']").CountAsync())
            .Should().Be(0, because: "an unreachable lobby must not stay navigable");

        // Local games stay playable — that is the point of offline support.
        (await page.Locator("a.home-mode-chip[href='/tictactoe/1player']").CountAsync())
            .Should().Be(1, because: "Tic-Tac-Toe runs entirely in the browser");

        await page.Context.SetOfflineAsync(false);
        await page.Locator(".gl-offline-banner").WaitForAsync(new LocatorWaitForOptions
        {
            State = WaitForSelectorState.Detached,
            Timeout = 15_000,
        });
    }
}
