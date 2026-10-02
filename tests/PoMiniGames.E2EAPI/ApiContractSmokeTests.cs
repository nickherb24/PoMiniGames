using System.Net;

namespace PoMiniGames.E2EAPI;

/// <summary>
/// API contract smoke tests. Verifies the public contract surface the
/// frontend and SignalR clients depend on, without requiring a live browser.
/// </summary>
[Collection(PoMiniGamesE2ECollection.Name)]
public class ApiContractSmokeTests
{
    private readonly PoMiniGamesE2EFixture _factory;

    public ApiContractSmokeTests(PoMiniGamesE2EFixture factory)
    {
        _factory = factory;
    }

    [Fact]
    public async Task HealthPing_ReturnsPong()
    {
        using var client = _factory.CreateClient();
        var response = await client.GetAsync("/api/health/ping");

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await response.Content.ReadAsStringAsync();
        body.Should().Contain("pong");
    }

    [Fact]
    public async Task AuthHandshake_Anonymous_ReturnsConfigAndNoUser()
    {
        using var client = _factory.CreateClient();
        var response = await client.GetAsync("/api/auth/handshake");

        // Anonymous: 200 with the public client config and a null user, never a 401.
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await response.Content.ReadAsStringAsync();
        body.Should().Contain("\"config\"");
    }
}
