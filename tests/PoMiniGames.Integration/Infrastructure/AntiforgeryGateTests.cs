using System.Net;
using System.Net.Http.Json;
using FluentAssertions;

namespace PoMiniGames.Integration;

/// <summary>
/// CSRF regression suite for the antiforgery gate.
///
/// The gate is easy to disable by accident — reordering middleware past
/// <c>UseAuthorization</c>, dropping the <c>MapAntiforgeryEndpoints()</c> registration, or
/// letting a route escape the <c>/api</c> prefix all silently reopen every write to
/// cross-site forgery with no build or runtime error. These tests fail loudly instead.
/// </summary>
public sealed class AntiforgeryGateTests : IClassFixture<TestWebApplicationFactory>
{
    private readonly TestWebApplicationFactory _factory;

    public AntiforgeryGateTests(TestWebApplicationFactory factory) => _factory = factory;

    /// <summary>
    /// The core guarantee: a state-changing call without a VALID token is refused. Asserting
    /// on the typed error code as well as the status matters — a plain 403 could equally come
    /// from the authorization gate, which would let an antiforgery regression pass unnoticed.
    /// </summary>
    [Theory]
    // No token at all.
    [InlineData(null)]
    // A forged token must not be accepted either. Guards against a future "if a header is
    // present, wave it through" shortcut, which would satisfy the no-token case while
    // providing no protection at all.
    [InlineData("not-a-real-token")]
    public async Task Post_WithoutValidToken_IsRefusedByTheAntiforgeryGate(string? forgedToken)
    {
        using var client = _factory.CreateClient();
        if (forgedToken is not null)
        {
            client.DefaultRequestHeaders.Add("X-CSRF-TOKEN", forgedToken);
        }

        var response = await client.PostAsJsonAsync("/api/pobrawl/highscores", new
        {
            PlayerInitials = "CSR",
            KoTimeSeconds = 9.5,
            Character = "obama",
            Date = DateTime.UtcNow.ToString("o"),
        });

        response.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await response.Content.ReadAsStringAsync()).Should().Contain("antiforgery_validation_failed");
    }

    /// <summary>
    /// The same call succeeds once armed. Without this pairing the test above would still
    /// pass if the gate rejected every request unconditionally — proving nothing about
    /// whether the app still works.
    /// </summary>
    [Fact]
    public async Task Post_WithToken_PassesTheAntiforgeryGate()
    {
        using var client = await _factory.CreateClient().ArmAntiforgeryAsync();

        var response = await client.PostAsJsonAsync("/api/pobrawl/highscores", new
        {
            PlayerInitials = "OKY",
            KoTimeSeconds = 8.25,
            Character = "trump",
            Date = DateTime.UtcNow.ToString("o"),
        });

        // Not asserting 200/201 specifically: without Docker the storage write fails on its
        // own terms. The assertion that matters is that it got *past* the CSRF gate.
        response.StatusCode.Should().NotBe(HttpStatusCode.Forbidden,
            because: "a valid synchroniser token must let the request reach its endpoint");
    }

    /// <summary>
    /// Reads must stay unguarded. The gate deliberately covers only unsafe methods; if it
    /// ever started demanding a token on GET, anonymous leaderboard browsing — the app's
    /// guest-first entry point — would break for every new visitor.
    /// </summary>
    [Fact]
    public async Task Get_IsNotGated()
    {
        using var client = _factory.CreateClient();

        var response = await client.GetAsync("/api/leaderboards/pobrawl");

        response.StatusCode.Should().NotBe(HttpStatusCode.Forbidden);
    }

    /// <summary>
    /// The token endpoint has to be anonymous and cache-free. If it required auth, a signed-out
    /// visitor could never obtain a token to sign in with; if it were cacheable, a shared proxy
    /// or the browser cache could hand one user's identity-bound token to another.
    /// </summary>
    [Fact]
    public async Task TokenEndpoint_IsAnonymous_AndNotCacheable()
    {
        using var client = _factory.CreateClient();

        var response = await client.GetAsync("/api/auth/antiforgery-token");

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        response.Headers.CacheControl!.NoStore.Should().BeTrue();

        var payload = await response.Content.ReadFromJsonAsync<TokenPayload>();
        payload!.Token.Should().NotBeNullOrWhiteSpace();
        payload.HeaderName.Should().Be("X-CSRF-TOKEN");
    }

    /// <summary>
    /// SignalR hubs sit outside <c>/api/</c> precisely so their POST <c>/negotiate</c> is not
    /// gated — the SignalR client builds its own request pipeline and cannot attach the
    /// header. A 403 here would mean every multiplayer game stopped connecting.
    /// </summary>
    [Fact]
    public async Task HubNegotiate_IsNotGated()
    {
        using var client = _factory.CreateClient();

        var response = await client.PostAsync("/poracer/lobby-hub/negotiate?negotiateVersion=1", content: null);

        // 401 is the expected answer for an unauthenticated negotiate. What must NOT happen
        // is the antiforgery refusal, which would be a 403 carrying the typed error code.
        (await response.Content.ReadAsStringAsync()).Should().NotContain("antiforgery_validation_failed");
    }

    private sealed record TokenPayload(string Token, string HeaderName);
}
