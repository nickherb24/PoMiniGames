using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using PoMiniGames.Domain.Primitives;
using PoMiniGames.Features.Auth;
using PoMiniGames.TestUtilities;

namespace PoMiniGames.Integration;

/// <summary>
/// Integration tests for endpoints not already covered by HomePageApiTests:
/// player-stats 404 path, PoBrawl high-score ranking, and the diag mask endpoint.
/// Snake and PoDropSquare high-score endpoints have been removed together with
/// those games; the remaining boards (PoBrawl, marble race) live under
/// UnifiedLeaderboardEndpoints and are exercised elsewhere.
/// </summary>
public sealed class LeaderboardEndpointTests : IClassFixture<TestWebApplicationFactory>, IAsyncLifetime
{
    private readonly TestWebApplicationFactory _factory;
    private readonly HttpClient _client;

    public LeaderboardEndpointTests(TestWebApplicationFactory factory)
    {
        _factory = factory;
        _client = factory.CreateClient();
    }

    // §2 CSRF: the high-score and ladder POSTs are state-changing /api/* calls and are
    // refused without a synchroniser token. Arming lives in InitializeAsync rather than
    // the constructor because fetching the token is an HTTP round trip.
    public Task InitializeAsync() => _client.ArmAntiforgeryAsync();

    public Task DisposeAsync()
    {
        _client.Dispose();
        return Task.CompletedTask;
    }

    // ── Player stats – 404 path ────────────────────────────────────────────

    [Fact]
    public async Task GetPlayerStats_Returns404OrOk_WhenPlayerNotFound()
    {
        var response = await _client.GetAsync("/api/tictactoe/players/nonexistent_player_xyz/stats");
        response.StatusCode.Should().BeOneOf(HttpStatusCode.OK, HttpStatusCode.NotFound);
    }

    // ── PoBrawl fastest-KO high scores ────────────────────────────────────

    [Fact]
    public async Task PoBrawlHighScores_PostRanksAscending_AndRejectsBadInput()
    {
        if (!_factory.DockerAvailable) return;

        // Two valid submissions; the faster KO should rank ahead of the slower one.
        var slow = new { PlayerInitials = "SLW", KoTimeSeconds = 42.5, Character = "trump", Date = DateTime.UtcNow.ToString("o") };
        var fast = new { PlayerInitials = "FST", KoTimeSeconds = 7.25, Character = "obama", Date = DateTime.UtcNow.ToString("o") };

        (await _client.PostAsJsonAsync("/api/pobrawl/highscores", slow)).StatusCode
            .Should().BeOneOf(HttpStatusCode.OK, HttpStatusCode.Created);
        (await _client.PostAsJsonAsync("/api/pobrawl/highscores", fast)).StatusCode
            .Should().BeOneOf(HttpStatusCode.OK, HttpStatusCode.Created);

        var scores = await _client.GetFromJsonAsync<List<System.Text.Json.JsonElement>>("/api/pobrawl/highscores");
        scores.Should().NotBeNull();
        scores!.Should().NotBeEmpty();

        // Ranked ascending by KO time, so times are non-decreasing down the board.
        var times = scores!.Select(s => s.GetProperty("koTimeSeconds").GetDouble()).ToList();
        times.Should().BeInAscendingOrder(because: "the fastest KO must rank first");
        times.Should().Contain(7.25).And.Contain(42.5);

        // A signed-in caller's typed name is only a fallback (the claim name is stored), so a
        // blank one is accepted; a non-positive KO time is still rejected.
        (await _client.PostAsJsonAsync("/api/pobrawl/highscores",
            new { PlayerInitials = "", KoTimeSeconds = 5.0 })).StatusCode
            .Should().BeOneOf(HttpStatusCode.OK, HttpStatusCode.Created);
        (await _client.PostAsJsonAsync("/api/pobrawl/highscores",
            new { PlayerInitials = "ABC", KoTimeSeconds = 0.0 })).StatusCode
            .Should().Be(HttpStatusCode.BadRequest);
    }

    // ── PoBrawl presidents-ladder leaderboard ─────────────────────────────

    [Fact]
    public async Task PoBrawlLadder_KeepsBestRunPerPlayer_RanksByPresidentsBeaten_AndRejectsBadInput()
    {
        if (!_factory.DockerAvailable) return;

        var name = $"ladder_test_{Guid.NewGuid():N}"[..24];
        var rival = $"ladder_riva_{Guid.NewGuid():N}"[..24];

        using var nameClient = _factory.CreateClient();
        nameClient.DefaultRequestHeaders.Remove(FakeAuthHandler.UserHeader);
        nameClient.DefaultRequestHeaders.Add(FakeAuthHandler.UserHeader, name);
        await nameClient.ArmAntiforgeryAsync();

        using var rivalClient = _factory.CreateClient();
        rivalClient.DefaultRequestHeaders.Remove(FakeAuthHandler.UserHeader);
        rivalClient.DefaultRequestHeaders.Add(FakeAuthHandler.UserHeader, rival);
        await rivalClient.ArmAntiforgeryAsync();

        // Best-progress semantics: 4 → then a worse run (2) must NOT overwrite it.
        (await nameClient.PostAsJsonAsync("/api/pobrawl/ladder",
            new { PlayerName = name, PresidentsBeaten = 4, Elo = 1300 })).StatusCode
            .Should().BeOneOf(HttpStatusCode.OK, HttpStatusCode.Created);
        (await nameClient.PostAsJsonAsync("/api/pobrawl/ladder",
            new { PlayerName = name, PresidentsBeaten = 2, Elo = 1250 })).StatusCode
            .Should().BeOneOf(HttpStatusCode.OK, HttpStatusCode.Created);
        // A full clear posts the whole roster, not a literal 10. The ceiling used to be
        // hardcoded at 10 while the client ladder walked all 15 fighters, so every rung past
        // the tenth 400'd and the board silently froze one rung short of the roster.
        (await rivalClient.PostAsJsonAsync("/api/pobrawl/ladder",
            new { PlayerName = rival, PresidentsBeaten = PoBrawlRoster.Count, Elo = 1700 })).StatusCode
            .Should().BeOneOf(HttpStatusCode.OK, HttpStatusCode.Created);

        // Read back through the UNIFIED board, not a PoBrawl-specific GET. That is the
        // only route the ladder is ever read over: /api/pobrawl/ladder is write-only
        // (see PoBrawlLeaderboardEndpoints), and GameOverModal's "Top 3 / Best rung"
        // panel and the leaderboards list are both fed from here. Asserting against the
        // route real users hit also covers BuildPoBrawlAsync's ranking, which the old
        // PoBrawl-only GET did not exercise at all.
        var board = await _client.GetFromJsonAsync<System.Text.Json.JsonElement>(
            "/api/leaderboards/pobrawl?limit=50");
        var entries = board.GetProperty("entries").EnumerateArray().ToList();
        entries.Should().NotBeEmpty();

        var mine = entries.Single(e => e.GetProperty("name").GetString() == name);
        mine.GetProperty("value").GetDouble()
            .Should().Be(4, because: "a worse later run must not overwrite the best");
        entries.Should().ContainSingle(e => e.GetProperty("name").GetString() == name,
            because: "the ladder keeps one row per player");
        mine.GetProperty("displayValue").GetString()
            .Should().Be($"4/{PoBrawlRoster.Count}",
                because: "the rung denominator tracks the roster, never a literal");

        // Ranked by presidents beaten, descending.
        var beaten = entries.Select(e => e.GetProperty("value").GetDouble()).ToList();
        beaten.Should().BeInDescendingOrder(because: "most presidents beaten ranks first");

        // Same rule as the KO board: a signed-in caller's blank typed name is fine (the claim
        // name is stored); an out-of-range count is still rejected.
        (await _client.PostAsJsonAsync("/api/pobrawl/ladder",
            new { PlayerName = "", PresidentsBeaten = 3 })).StatusCode
            .Should().BeOneOf(HttpStatusCode.OK, HttpStatusCode.Created);
        (await _client.PostAsJsonAsync("/api/pobrawl/ladder",
            new { PlayerName = "abc", PresidentsBeaten = PoBrawlRoster.Count + 1 })).StatusCode
            .Should().Be(HttpStatusCode.BadRequest);
    }
}
