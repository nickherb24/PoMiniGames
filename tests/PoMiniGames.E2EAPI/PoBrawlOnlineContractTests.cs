using System.Net;
using System.Net.Http.Json;
using PoMiniGames.Shared.Games;
using PoMiniGames.TestUtilities;

namespace PoMiniGames.E2EAPI;

/// <summary>
/// §PoBrawlOnline (2026-09-14): contract tests for the live 1v1 surface. The result ingest is
/// write only and auth-gated, so an anonymous POST must return 401 (NOT 403, which would leak
/// existence); a signed-in POST is judged against the server's own copy of the match.
/// </summary>
[Collection(PoMiniGamesE2ECollection.Name)]
public class PoBrawlOnlineContractTests
{
    private readonly PoMiniGamesE2EFixture _factory;

    public PoBrawlOnlineContractTests(PoMiniGamesE2EFixture factory)
    {
        _factory = factory;
    }

    /// <summary>
    /// The body carries only a match id and the server decides everything else, so a signed-in
    /// caller cannot mint a result: a blank id is a 400 and an id the registry does not hold is a
    /// 404 — neither reaches MatchHistory or the Elo table.
    /// </summary>
    [Fact]
    public async Task PostMatch_SignedIn_RejectsBlankAndUnheldMatchIds()
    {
        using var client = _factory.CreateClient();
        // This tier's fixture registers no header-driven FakeAuth scheme, so sign in the way a
        // player does, then arm: the antiforgery token is bound to the identity's claims.
        var login = await client.GetAsync($"/auth/login/fake?displayName=Brawl{Guid.NewGuid().ToString("N")[..8]}");
        login.IsSuccessStatusCode.Should().BeTrue("guest login must succeed under the Test environment");
        await client.ArmAntiforgeryAsync();

        var blank = await client.PostAsJsonAsync("/api/pobrawl/matches", new PoBrawlMatchResultDto { MatchId = " " });
        blank.StatusCode.Should().Be(HttpStatusCode.BadRequest);

        var unheld = await client.PostAsJsonAsync("/api/pobrawl/matches", new PoBrawlMatchResultDto { MatchId = Guid.NewGuid().ToString("N") });
        unheld.StatusCode.Should().Be(HttpStatusCode.NotFound, "a match the server does not hold has no result to report");
    }

    /// <summary>
    /// Every PoBrawl game-data POST must answer an anonymous caller with 401. One theory over
    /// the routes rather than a method each — the E2E-API tier sits at its 25-method ceiling.
    /// The presser row (2026-09-23) also proves the route is on the authenticated group: mapped
    /// on <c>app</c> by mistake it would have answered 400/200 here instead.
    /// </summary>
    [Theory]
    [InlineData("/api/pobrawl/matches")]
    [InlineData("/api/pobrawl/presser")]
    [InlineData("/api/pobrawl/intro")]
    public async Task PostPoBrawlRoutes_Anonymous_Return401(string path)
    {
        using var client = _factory.CreateClient();
        var response = await client.PostAsJsonAsync(path, new PoBrawlMatchResultDto { MatchId = "anon-test" });

        // §CSRF: 401 (not 403) for an anonymous caller — the request is
        // rejected before the antiforgery middleware sees it. 403 would
        // leak "this endpoint exists" to anonymous callers.
        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }
}
