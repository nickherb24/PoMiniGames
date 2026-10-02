using System.Net;
using System.Net.Http.Json;
using PoMiniGames.Shared.Games.PoEcosystem;

namespace PoMiniGames.E2EAPI;

/// <summary>
/// Contract tests for the island's server surface. The gallery is
/// anonymous and must always answer with an array (empty when storage is down); everything
/// under the authenticated group must answer 401 — not 403 — to an anonymous caller, so a
/// slot's existence never leaks. One theory over the routes: the E2E-API tier has room for
/// a handful of methods, not one per route.
/// </summary>
[Collection(PoMiniGamesE2ECollection.Name)]
public class PoEcosystemContractTests
{
    private readonly PoMiniGamesE2EFixture _factory;

    public PoEcosystemContractTests(PoMiniGamesE2EFixture factory)
    {
        _factory = factory;
    }

    [Theory]
    [InlineData("GET", "/api/ecosystem/worlds", HttpStatusCode.Unauthorized)]
    [InlineData("PUT", "/api/ecosystem/worlds/1?name=x", HttpStatusCode.Unauthorized)]
    [InlineData("DELETE", "/api/ecosystem/worlds/1", HttpStatusCode.Unauthorized)]
    [InlineData("POST", "/api/ecosystem/worlds/1/share", HttpStatusCode.Unauthorized)]
    [InlineData("POST", "/api/ecosystem/chronicle", HttpStatusCode.Unauthorized)]
    [InlineData("POST", "/api/ecosystem/thought", HttpStatusCode.Unauthorized)]
    [InlineData("GET", "/api/ecosystem/gallery?top=5", HttpStatusCode.OK)]
    [InlineData("GET", "/api/ecosystem/gallery/nosuchcode/data", HttpStatusCode.NotFound)]
    public async Task Routes_AnswerAnonymousCallersAsContracted(string method, string path, HttpStatusCode expected)
    {
        using var client = _factory.CreateClient();
        using var request = new HttpRequestMessage(new HttpMethod(method), path);
        if (method is "POST" or "PUT") request.Content = JsonContent.Create(new EcoShareRequest(true));

        using var response = await client.SendAsync(request);

        response.StatusCode.Should().Be(expected);
        if (expected == HttpStatusCode.OK)
        {
            var rows = await response.Content.ReadFromJsonAsync<List<EcoSharedWorld>>();
            rows.Should().NotBeNull("the gallery is anonymous and must always return an array, empty when storage is down");
        }
    }
}
