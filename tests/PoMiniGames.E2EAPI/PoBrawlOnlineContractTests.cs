using System.Net;
using System.Net.Http.Json;
using PoMiniGames.Domain.Models;

namespace PoMiniGames.E2EAPI;

/// <summary>
/// §PoBrawlOnline (2026-09-14): contract tests for the live 1v1 surface. The GET
/// board is anonymous so it must always return 200 with the expected shape,
/// even when no matches have been recorded. The POST ingest is auth-gated, so
/// an anonymous POST must return 401 (NOT 403, which would leak existence).
/// </summary>
[Collection(PoMiniGamesE2ECollection.Name)]
public class PoBrawlOnlineContractTests
{
    private readonly PoMiniGamesE2EFixture _factory;

    public PoBrawlOnlineContractTests(PoMiniGamesE2EFixture factory)
    {
        _factory = factory;
    }

    [Fact]
    public async Task GetPoBrawlOnlineRatings_Anonymous_Returns200WithShape()
    {
        using var client = _factory.CreateClient();
        var response = await client.GetAsync("/api/pobrawl/matches?top=10");

        // Anonymous read — same posture as the demo fighter Elo board.
        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var rows = await response.Content.ReadFromJsonAsync<List<PoBrawlPlayerRating>>();
        rows.Should().NotBeNull("the board is anonymous and must always return an array");
        // When storage is down (Azurite not running), the row list is empty rather
        // than a 500 — graceful degradation is the contract.
        rows!.Should().NotBeNull();
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
        var payload = new PoMiniGames.Shared.Games.PoBrawlMatchResultDto
        {
            MatchId = "anon-test",
            OwnerId = "anon",
            OwnerDisplayName = "Anon",
            OpponentId = "opponent",
            OpponentDisplayName = "Opponent",
            Outcome = PoMiniGames.Shared.Games.PoBrawlOutcome.Win,
            DurationSeconds = 30,
        };
        var response = await client.PostAsJsonAsync(path, payload);

        // §CSRF: 401 (not 403) for an anonymous caller — the request is
        // rejected before the antiforgery middleware sees it. 403 would
        // leak "this endpoint exists" to anonymous callers.
        response.StatusCode.Should().Be(HttpStatusCode.Unauthorized);
    }
}
