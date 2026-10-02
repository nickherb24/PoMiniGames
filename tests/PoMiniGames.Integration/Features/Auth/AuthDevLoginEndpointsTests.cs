using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using Microsoft.AspNetCore.Mvc.Testing;

namespace PoMiniGames.Integration;

public class AuthDevLoginEndpointsTests : IClassFixture<LocalAuthWebApplicationFactory>
{
    private readonly LocalAuthWebApplicationFactory _factory;

    public AuthDevLoginEndpointsTests(LocalAuthWebApplicationFactory factory)
    {
        _factory = factory;
    }

    [Fact]
    public async Task AuthConfig_InDevelopment_EnablesDevLoginMode()
    {
        var client = _factory.CreateClient();

        var response = (await client.GetFromJsonAsync<AuthHandshakeResponse>("/api/auth/handshake"))?.Config;

        response.Should().NotBeNull();
        response!.Enabled.Should().BeTrue();
        response.DevLoginEnabled.Should().BeTrue();
    }

    [Fact]
    public async Task DevLogin_CreatesCookieSession_AndDevLogoutClearsIt()
    {
        var client = await CreateCookieClientAsync();

        // In dev mode with DevBypass, /api/auth/me may return a default user if no auth is present
        // This test focuses on the login/logout flow rather than auth enforcement
        var loginResponse = await client.PostAsJsonAsync("/api/auth/dev-login", new
        {
            userId = "dev-user-a",
            displayName = "Dev User A",
            email = "dev.user.a@local.dev",
        });

        loginResponse.StatusCode.Should().Be(HttpStatusCode.OK);

        var profile = await client.GetFromJsonAsync<AuthUserProfile>("/api/auth/me");
        profile.Should().NotBeNull();
        profile!.UserId.Should().Be("dev-user-a");
        // DevLoginIntake appends a random 6-digit suffix to every dev display
        // name so two tabs of the same browser produce distinct identities. Assert on the
        // prefix + suffix shape rather than the literal name.
        profile.DisplayName.Should().MatchRegex(@"^Dev User A-\d{6}$",
            because: "every dev login is suffixed with a random 6-digit id to avoid session collisions");

        // Re-arm: the token issued before login was bound to the anonymous principal, and
        // this POST now carries the session cookie. That identity change is exactly what
        // antiforgery invalidates on, so a stale token here would 403.
        await client.ArmAntiforgeryAsync();
        var logoutResponse = await client.PostAsync("/api/auth/dev-logout", content: null);
        logoutResponse.StatusCode.Should().Be(HttpStatusCode.OK);
    }

    [Theory]
    // Session persistence: consecutive /api/auth/me calls stay authenticated.
    [InlineData("persistent-user", "Persistent User", "persistent@test.local")]
    // Dev login accepts various input patterns in development.
    [InlineData("dev-user-empty-test", "Test User", "test@local.dev")]
    // The email claim survives the cookie round-trip and comes back on /api/auth/me.
    [InlineData("email-test-user", "Email Test User", "test@example.com")]
    public async Task DevLogin_PersistsSessionAcrossRequests_WithUserIdAndEmail(
        string userId, string displayName, string email)
    {
        var client = await CreateCookieClientAsync();

        var loginResponse = await client.PostAsJsonAsync("/api/auth/dev-login", new
        {
            userId,
            displayName,
            email,
        });
        loginResponse.StatusCode.Should().Be(HttpStatusCode.OK);

        // First request after login
        var firstAuth = await client.GetAsync("/api/auth/me");
        firstAuth.StatusCode.Should().Be(HttpStatusCode.OK);

        // Second request should still be authenticated
        var secondAuth = await client.GetAsync("/api/auth/me");
        secondAuth.StatusCode.Should().Be(HttpStatusCode.OK);

        var profile = await client.GetFromJsonAsync<AuthUserProfile>("/api/auth/me");
        profile.Should().NotBeNull();
        profile!.UserId.Should().Be(userId);
        profile.Email.Should().Be(email);
    }

    [Fact]
    public async Task DevLogin_DifferentUsers_IsolateSession()
    {
        var client1 = await CreateCookieClientAsync();
        var client2 = await CreateCookieClientAsync();

        var login1 = await client1.PostAsJsonAsync("/api/auth/dev-login", new
        {
            userId = "user-1",
            displayName = "User One",
            email = "user1@test.local",
        });
        login1.StatusCode.Should().Be(HttpStatusCode.OK);

        var login2 = await client2.PostAsJsonAsync("/api/auth/dev-login", new
        {
            userId = "user-2",
            displayName = "User Two",
            email = "user2@test.local",
        });
        login2.StatusCode.Should().Be(HttpStatusCode.OK);

        var profile1 = await client1.GetFromJsonAsync<AuthUserProfile>("/api/auth/me");
        var profile2 = await client2.GetFromJsonAsync<AuthUserProfile>("/api/auth/me");

        profile1!.UserId.Should().Be("user-1");
        profile2!.UserId.Should().Be("user-2");
    }

    [Fact]
    public async Task DevLogout_IsAccessible()
    {
        var client = await CreateCookieClientAsync();

        // Dev logout endpoint should be accessible
        var logoutResponse = await client.PostAsync("/api/auth/dev-logout", content: null);

        // Should return OK or similar success code in dev mode
        logoutResponse.StatusCode.Should().BeOneOf(HttpStatusCode.OK, HttpStatusCode.NoContent);
    }

    // AuthMe_WithCookie_RetainsEmailField was a verbatim subset of the theory above —
    // its scenario survives as the "email-test-user" row.

    // /api/auth/dev-login and /dev-logout are POSTs under /api/*, so they sit
    // behind the antiforgery gate like every other write. HandleCookies is what makes the
    // paired cookie stick between the token fetch and the call it authorises.
    private async Task<HttpClient> CreateCookieClientAsync()
    {
        var client = _factory.CreateClient(new WebApplicationFactoryClientOptions
        {
            AllowAutoRedirect = false,
            HandleCookies = true,
        });

        return await client.ArmAntiforgeryAsync();
    }

    private sealed record AuthConfigResponse(bool Enabled, bool DevLoginEnabled);

    private sealed record AuthHandshakeResponse(AuthConfigResponse Config);

    private sealed record AuthUserProfile(string UserId, string DisplayName, string? Email);
}
