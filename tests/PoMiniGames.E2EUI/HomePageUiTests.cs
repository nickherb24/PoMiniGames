using Microsoft.Playwright;

namespace PoMiniGames.E2EUI;

/// <summary>
/// E2E-UI smoke tests. Drives a real Chromium browser via Microsoft.Playwright
/// against the live-Kestrel host, asserting the Blazor WASM client actually
/// renders (not just that the HTTP shell is served — that is E2E-API's job).
/// </summary>
/// <remarks>
/// Requires Playwright browsers installed once per machine:
/// <c>pwsh tests/E2EUI/bin/Debug/net10.0/playwright.ps1 install chromium</c>.
/// </remarks>
[Collection(KestrelServerCollection.Name)]
public class HomePageUiTests
{
    private readonly KestrelServerFixture _fixture;

    public HomePageUiTests(KestrelServerFixture fixture) => _fixture = fixture;

    [Fact]
    public async Task Home_RendersBlazorClient_AndShowsAppName()
    {
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync(
            BrowserLaunch.Options());
        // BFF header overrides: the FakeAuth scheme authenticates every request
        // via the X-Fake-User / X-Fake-Roles headers, bypassing the cookie flow
        // entirely. This keeps the E2E-UI suite deterministic across cookie-domain
        // edge cases (loopback vs explicit IP) and matches the integration suite's
        // header-based harness.
        var context = await browser.NewContextAsync(new BrowserNewContextOptions
        {
            ViewportSize = MobileViewport.Portrait,
        });
        await context.SetExtraHTTPHeadersAsync(new Dictionary<string, string>
        {
            ["X-Fake-User"] = "test-user",
            ["X-Fake-Roles"] = "Player",
        });
        var page = await context.NewPageAsync();

        await page.GotoAsync($"{_fixture.ServerAddress}?autoGuest=1", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
        });

        // The WASM bootstrap replaces the #app loading placeholder once Blazor
        // has started; assert the page title carries the Po* identity.
        var title = await page.TitleAsync();
        title.Should().Contain("PoMiniGames");

        // The Blazor router mounts content into #app; after NetworkIdle it must
        // contain rendered markup, proving the WASM runtime booted.
        var appHtml = await page.Locator("#app").InnerHTMLAsync();
        appHtml.Should().NotBeNullOrWhiteSpace();
    }
}
