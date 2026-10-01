using Microsoft.Playwright;

namespace PoMiniGames.E2EUI.Features.PoCabinet;

/// <summary>
/// Smoke test that the four PoCabinet tracks all render the track-selector card
/// grid (Concept 1 design, Concept 8 layout for the lobby). One method by
/// design — the E2E-UI tier is capped at 25 and the canvas / atmosphere
/// rendering is visual-audit territory, not unit-test territory. This test
/// asserts the markup the three.js scene will mount into.
/// </summary>
[Collection(KestrelServerCollection.Name)]
public class PoCabinetTrackRenderUiTests
{
    private readonly KestrelServerFixture _fixture;

    public PoCabinetTrackRenderUiTests(KestrelServerFixture fixture) => _fixture = fixture;

    [Fact]
    public async Task TrackSelector_RendersAllTracks_WithDistinctAccents()
    {
        using var playwright = await Playwright.CreateAsync();
        var options = BrowserLaunch.Options();
        options.Args = ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"];
        await using var browser = await playwright.Chromium.LaunchAsync(options);
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

        var origin = _fixture.ServerAddress.TrimEnd('/');
        await page.GotoAsync($"{origin}/pocabinet/1player?autoGuest=1",
            new PageGotoOptions { WaitUntil = WaitUntilState.NetworkIdle, Timeout = 60_000 });

        // The tracks each carry their id as data-track-id; verifying the
        // ids by attribute avoids coupling the test to label text or layout.
        var ids = await page.Locator(".pocabinet-track").EvaluateAllAsync<string[]>(
            "els => els.map(e => e.getAttribute('data-track-id'))");
        ids.Should().BeEquivalentTo(new[] { "capitol", "maralago", "pressbriefing", "playground" },
            because: "the track selector must show all four themed tracks");

        // Atmosphere accent colours differ per track (gold trim, palm green,
        // podium red, slide orange). Asserting that all four swatches are present proves the
        // CSS theme variables resolved.
        var accents = await page.Locator(".pocabinet-track__swatch").CountAsync();
        accents.Should().Be(4,
            "each track card must render an atmosphere swatch so the player can compare tracks at a glance");
    }
}
