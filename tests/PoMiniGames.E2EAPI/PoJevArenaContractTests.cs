using System.Net;
using System.Net.Http.Json;
using PoMiniGames.TestUtilities;

namespace PoMiniGames.E2EAPI;

/// <summary>
/// The HTTP contract of the arena's server surface. Anonymous callers get
/// 401 (never 403 — a route's existence must not leak); a signed-in caller without the antiforgery
/// token gets 403; with it, malformed input is refused with the documented status before any Jev
/// call or storage write. The host runs under "Test", so Jev is the deterministic stub and
/// <c>status</c> reports configured. One theory: this tier holds 25 methods in total.
/// </summary>
[Collection(PoMiniGamesE2ECollection.Name)]
public class PoJevArenaContractTests
{
    private const string ValidDraft = """
        {"name":"Contract Gob","maxHp":200,"moveSpeed":5.0,"mass":2.5,"abilities":["spit_glob"],
         "temperament":"skirmisher","targetBias":"hunt_weakest","panicThreshold":"fights_to_death"}
        """;

    private const string OneUnitBatch = """
        {"units":[{"unit":"Blue-01","hp":100,"abilityCooldowns":[0],"poisoned":false,"underFire":false,
                   "alliesNear":0,"candidates":[],"blueAlive":10,"redAlive":10}]}
        """;

    private readonly PoMiniGamesE2EFixture _factory;

    public PoJevArenaContractTests(PoMiniGamesE2EFixture factory)
    {
        _factory = factory;
    }

    [Theory]
    // Anonymous: every route is behind the authenticated /api group.
    [InlineData("GET", "/api/pojevarena/status", "anon", null, HttpStatusCode.Unauthorized)]
    [InlineData("GET", "/api/pojevarena/creatures", "anon", null, HttpStatusCode.Unauthorized)]
    [InlineData("POST", "/api/pojevarena/creatures", "anon", ValidDraft, HttpStatusCode.Unauthorized)]
    [InlineData("POST", "/api/pojevarena/matches/abc/decisions", "anon", OneUnitBatch, HttpStatusCode.Unauthorized)]
    [InlineData("POST", "/api/pojevarena/matches/abc/result", "anon", """{"winner":"blue","durationSeconds":60}""", HttpStatusCode.Unauthorized)]
    // Signed in, reads.
    [InlineData("GET", "/api/pojevarena/status", "user", null, HttpStatusCode.OK)]
    // Signed in without the synchroniser token: writes are refused by the CSRF gate.
    [InlineData("POST", "/api/pojevarena/creatures", "user", ValidDraft, HttpStatusCode.Forbidden)]
    [InlineData("DELETE", "/api/pojevarena/creatures/abc", "user", null, HttpStatusCode.Forbidden)]
    // Signed in and armed: input validation happens before any Jev call or storage write.
    [InlineData("POST", "/api/pojevarena/creatures", "armed", """{"name":"Too Weak","maxHp":10,"moveSpeed":5.0,"mass":2.5,"abilities":[],"temperament":"skirmisher","targetBias":"hunt_weakest","panicThreshold":"fights_to_death"}""", HttpStatusCode.UnprocessableEntity)]
    [InlineData("POST", "/api/pojevarena/matches", "armed", """{"mode":"OnePlayer","blueIds":["preset:vanguard_tank"],"redIds":["preset:vanguard_tank"]}""", HttpStatusCode.BadRequest)]
    [InlineData("POST", "/api/pojevarena/matches/no-such-match/decisions", "armed", OneUnitBatch, HttpStatusCode.NotFound)]
    [InlineData("POST", "/api/pojevarena/matches/no-such-match/result", "armed", """{"winner":"purple","durationSeconds":60}""", HttpStatusCode.BadRequest)]
    public async Task Routes_AnswerAsContracted(string method, string path, string caller, string? body, HttpStatusCode expected)
    {
        using var client = _factory.CreateClient();
        if (caller != "anon")
        {
            // Sign in the way a player does (guest login, Dev/Test + loopback only; the client
            // keeps the cookie), then arm: the antiforgery token is bound to the identity's claims.
            // This tier's fixture registers no header-driven FakeAuth scheme at startup.
            var login = await client.GetAsync($"/auth/login/fake?displayName=Arena{Guid.NewGuid().ToString("N")[..8]}");
            login.IsSuccessStatusCode.Should().BeTrue("guest login must succeed under the Test environment");
            if (caller == "armed") await client.ArmAntiforgeryAsync();
        }

        using var request = new HttpRequestMessage(new HttpMethod(method), path);
        if (body is not null) request.Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json");

        using var response = await client.SendAsync(request);

        response.StatusCode.Should().Be(expected, await response.Content.ReadAsStringAsync());
        if (path.EndsWith("/status", StringComparison.Ordinal) && expected == HttpStatusCode.OK)
        {
            var status = await response.Content.ReadFromJsonAsync<StatusProbe>();
            status!.Configured.Should().BeTrue("the Test host serves the Jev stub");
            status.Remaining.Should().Be(status.DailyLimit);
        }
    }

    private sealed record StatusProbe(bool Configured, long DailyLimit, long Remaining);
}
