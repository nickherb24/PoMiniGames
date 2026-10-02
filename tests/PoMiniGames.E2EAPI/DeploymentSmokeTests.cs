namespace PoMiniGames.E2EAPI;

/// <summary>
/// Deployment smoke tests. Asserts the routes that the
/// Azure App Service availability test pings. Failure of any of these means
/// a regression in the BFF static-file hosting or the BFF /api prefix.
/// </summary>
[Collection(PoMiniGamesE2ECollection.Name)]
public class DeploymentSmokeTests
{
    private readonly PoMiniGamesE2EFixture _factory;

    public DeploymentSmokeTests(PoMiniGamesE2EFixture factory)
    {
        _factory = factory;
    }

    [Theory]
    [InlineData("/health")]
    // The /api/auth/handshake route is the cheapest public probe of the BFF /api prefix; the other
    // BFF routes (hubs, leaderboards) require setup that this fixture intentionally doesn't provide.
    [InlineData("/api/auth/handshake")]
    // Microsoft.AspNetCore.OpenApi must publish the schema doc.
    [InlineData("/openapi/v1.json")]
    public async Task PublicProbe_Is2xx(string path)
    {
        using var client = _factory.CreateClient();
        var response = await client.GetAsync(path);
        response.EnsureSuccessStatusCode();
    }
}
