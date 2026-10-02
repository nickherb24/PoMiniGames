namespace PoMiniGames.E2EAPI;

/// <summary>
/// Home page smoke tests.
///
/// These tests assert the HTML shape of the home route because the Blazor
/// WASM client is BFF-served (no separate Vite/Node). The deeper
/// component-level coverage (button clicks, navigation, game-specific
/// selectors) lives in the unit tests under tests/PoMiniGames.Unit/Features
/// via bUnit-style assertions; the e2e project only asserts the
/// public-facing HTTP contract here.
/// </summary>
[Collection(PoMiniGamesE2ECollection.Name)]
public class HomeSmokeTests
{
    private readonly PoMiniGamesE2EFixture _factory;

    public HomeSmokeTests(PoMiniGamesE2EFixture factory)
    {
        _factory = factory;
    }

    [Fact]
    public async Task Index_ServesSpaFallback()
    {
        using var client = _factory.CreateClient();
        // /  -> SPA shell (index.html) which bootstraps the Blazor WASM client
        var response = await client.GetAsync("/");

        response.EnsureSuccessStatusCode();
        var body = await response.Content.ReadAsStringAsync();
        body.Should().Contain("<!DOCTYPE html", "the BFF must serve the WASM shell at the root");
        body.Should().Contain("PoMiniGames");
    }

    [Fact]
    public async Task DeepLink_FallsBackToSpa()
    {
        using var client = _factory.CreateClient();
        // Client-side routes fall through to the SPA shell; the host does not
        // own these paths but must still serve index.html so the WASM router
        // can take over.
        var response = await client.GetAsync("/single-player");

        response.EnsureSuccessStatusCode();
        var body = await response.Content.ReadAsStringAsync();
        body.Should().Contain("<!DOCTYPE html");
    }
}
