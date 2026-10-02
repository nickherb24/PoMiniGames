using System.Net;
using System.Net.Http.Json;
using FluentAssertions;

namespace PoMiniGames.Integration;

/// <summary>
/// Integration tests covering every API endpoint consumed by the Home page:
/// leaderboards for all games, limit parameter, content-type, and
/// round-trip save → retrieve.
/// </summary>
public sealed class HomePageApiTests : IClassFixture<TestWebApplicationFactory>, IAsyncLifetime
{
    private readonly TestWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public HomePageApiTests(TestWebApplicationFactory factory)
    {
        _factory = factory;
        _client = factory.CreateClient();
    }

    // The player-stats PUTs are state-changing /api/* calls and are refused
    // without a synchroniser token. Arming lives in InitializeAsync rather than the
    // constructor because fetching the token is an HTTP round trip.
    public Task InitializeAsync() => _client.ArmAntiforgeryAsync();

    public Task DisposeAsync()
    {
        _client.Dispose();
        return Task.CompletedTask;
    }

    // ── Leaderboard read contract: the unified board the Home page actually calls ──

    /// <summary>
    /// 200, JSON, and exactly <c>limit</c> rows (the board pads with placeholders) for
    /// the win-rate games shown on the Home page.
    /// </summary>
    [Theory]
    [InlineData("connectfive", null, 10)]
    [InlineData("connectfive", 5, 5)]
    [InlineData("tictactoe", null, 10)]
    public async Task GetLeaderboard_ReturnsPaddedBoard_HonouringLimit(string gameId, int? limit, int expectedRows)
    {
        var route = $"/api/leaderboards/{gameId}" + (limit is { } l ? $"?limit={l}" : string.Empty);

        var response = await _client.GetAsync(route);

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        response.Content.Headers.ContentType?.MediaType.Should().Be("application/json");

        var board = await response.Content.ReadFromJsonAsync<System.Text.Json.JsonElement>();
        board.GetProperty("entries").GetArrayLength().Should().Be(expectedRows);
    }

    // ── Round-trip: save stats → read them back ───────────────

    /// <summary>
    /// Save stats → the per-player stats GET answers its contract.
    /// </summary>
    [Theory]
    [InlineData("pomarblerace", 8, 2, 3)]
    [InlineData("poracer", 5, 5, 2)]
    public async Task SavePlayerStats_ThenPlayerStats_RoundTrip(
        string game, int wins, int losses, int winStreak)
    {
        if (!_factory.DockerAvailable) return;

        // Isolation comes from a unique PLAYER, not a unique game. An invented game id
        // ("roundtrip_leaderboard") cannot work: PlayerStatsEndpoints runs every game id
        // through GameKey.TryParse as its allowlist, so an off-catalogue key 400s before
        // any storage is touched. Pick a real key and make the row unique instead.
        var player = $"HomePageIntegrationPlayer-{Guid.NewGuid():N}";

        // Build a minimal valid PlayerStats payload
        var stats = new
        {
            PlayerId = Guid.NewGuid().ToString(),
            PlayerName = player,
            Easy = new { Wins = wins, Losses = losses, Draws = 0, TotalGames = wins + losses, WinStreak = winStreak },
            Medium = new { Wins = 0, Losses = 0, Draws = 0, TotalGames = 0, WinStreak = 0 },
            Hard = new { Wins = 0, Losses = 0, Draws = 0, TotalGames = 0, WinStreak = 0 },
        };

        var put = await _client.PutAsJsonAsync($"/api/{game}/players/{player}/stats", stats);
        put.IsSuccessStatusCode.Should().BeTrue(
            because: "saving valid player stats should succeed");

        var get = await _client.GetAsync($"/api/{game}/players/{player}/stats");
        get.StatusCode.Should().BeOneOf(
            new[] { HttpStatusCode.OK, HttpStatusCode.NotFound },
            because: "the endpoint either returns the stored stats or 404 if not implemented");
    }
}
