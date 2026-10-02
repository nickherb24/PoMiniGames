using System.Security.Claims;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.Extensions.Options;

namespace PoMiniGames.Features.Auth;

public static class AuthEndpoints
{
    public static IEndpointRouteBuilder MapAuthEndpoints(this IEndpointRouteBuilder app)
    {
        // §1 MapGroup() per slice: every /api/auth/* endpoint shares the same
        // prefix and OpenAPI tag. The legacy unprefixed /auth/login/microsoft,
        // /auth/login/fake, /auth/logout, and /auth/me routes are kept OUTSIDE
        // this group — those URLs are used by external monitors, so the wire
        // path must not change.
        var auth = app.MapGroup("/api/auth").WithTags("Auth");

        auth.MapGet("/config", (
            IOptions<MicrosoftAuthOptions> options,
            IWebHostEnvironment environment,
            IConfiguration configuration) =>
        {
            var auth = options.Value;
            // microsoftEnabled = dev opted in (config flag OR dev environment short-circuit).
            // microsoftConfigured = real sign-in will actually complete (ClientId + ApiClientId set).
            var microsoftEnabled = auth.Enabled;
            var microsoftConfigured = auth.FullyConfigured;
            // §CI/CD policy (2026-06-27): Dev + Test envs expose the Guest dev-bypass
            // path so the SPA can auto-sign-in as Guest without OAuth. Prod exposes MS
            // OAuth only (Guest button hidden, AutoGuestLogin forbidden).
            var devLoginEnabled = environment.IsDevelopment() || environment.IsEnvironment("Test");
            var usingMockData = configuration.GetValue<bool>("FeatureFlags:UseMockData");
            // Test harness flag: when set (e.g. by the E2E-UI fixture) the SPA silently
            // signs in as a Guest via the dev bypass so browser tests never hit the
            // login wall. Only honoured in Development/Test, where the dev bypass exists.
            var autoGuestLogin = devLoginEnabled && configuration.GetValue<bool>("Auth:AutoGuestLogin");
            // MSAL.js appends `/v2.0/.well-known/openid-configuration` to the authority
            // automatically. If we hand it an authority that already includes `/v2.0`
            // (e.g. `https://login.microsoftonline.com/common/v2.0`), MSAL doubles the
            // path and `init()` throws `endpoints_resolution_error`. Strip the trailing
            // `/v2.0` so MSAL composes the discovery URL correctly.
            var msalAuthority = NormalizeAuthorityForMsal(auth.Authority);
            return Results.Ok(new AuthClientConfiguration(
                microsoftEnabled || devLoginEnabled,
                auth.ClientId,
                msalAuthority,
                auth.EffectiveScope,
                auth.RedirectPath,
                microsoftEnabled,
                microsoftConfigured,
                devLoginEnabled,
                usingMockData,
                autoGuestLogin));
        })
        .WithName("GetAuthConfiguration")
        .WithTags("Auth")
        .WithSummary("Returns the public Microsoft sign-in configuration for the SPA.");

        auth.MapPost("/dev-login", [AllowAnonymous] async (HttpContext context, HttpRequest httpRequest, IWebHostEnvironment environment) =>
        {
            DevLoginRequest? request = null;
            if (httpRequest.HasJsonContentType())
            {
                request = await httpRequest.ReadFromJsonAsync<DevLoginRequest>();
            }

            return await SignInDevelopmentUserAsync(context, environment, request, null);
        })
        .WithName("DevLogin")
        .WithSummary("Creates a local development auth session without Microsoft OAuth.");

        auth.MapPost("/dev-bypass", [AllowAnonymous] (HttpContext context, string? user, IWebHostEnvironment environment) =>
                SignInDevelopmentUserAsync(context, environment, null, user))
            .WithName("DevBypass")
            .WithSummary("Creates a dev session keyed to the selected display name.");

        auth.MapPost("/dev-logout", [AllowAnonymous] async (HttpContext context, IWebHostEnvironment environment) =>
        {
            // Must match SignInDevelopmentUserAsync's guard (Dev + Test) exactly. It did not:
            // sign-in accepted Test per the §CI/CD 2026-06-27 policy while sign-out checked
            // IsDevelopment() alone, so a dev session minted under Test could be created but
            // never cleared — this endpoint just 404'd. Any asymmetry here strands sessions.
            if (!environment.IsDevelopment() && !environment.IsEnvironment("Test"))
            {
                return Results.NotFound();
            }

            await context.SignOutAsync(AuthSchemes.DevCookie);
            return Results.Ok();
        })
        .WithName("DevLogout")
        .WithSummary("Clears the local development auth session.");

        auth.MapGet("/me", [Authorize] (HttpContext context) =>
        {
            if (!AuthenticatedUser.TryCreate(context.User, out var user) || user is null)
            {
                return Results.Unauthorized();
            }

            return Results.Ok(new AuthenticatedUserProfile(user.UserId, user.DisplayName, user.Email));
        })
        .WithName("GetCurrentUser")
        .WithSummary("Returns the authenticated user profile for the current bearer token.")
        .Produces<AuthenticatedUserProfile>(StatusCodes.Status200OK)
        .Produces(StatusCodes.Status401Unauthorized);

        // ─── Rule §2: explicit auth routing engine (exact documented paths) ───

        // Triggers the real Microsoft authentication challenge. The interactive sign-in is
        // performed client-side via MSAL; this server route validates the return target and
        // bounces back into the SPA, degrading gracefully when OAuth is unconfigured.
        app.MapGet("/auth/login/microsoft", [AllowAnonymous] (
            string? returnUrl, HttpContext context, IOptions<MicrosoftAuthOptions> options) =>
        {
            var target = ResolveLocalReturnUrl(returnUrl);
            return Results.Redirect(target);
        })
        .WithName("LoginMicrosoft")
        .WithTags("Auth")
        .WithSummary("Triggers the real Microsoft authentication challenge.");

        // Explicit "fake" login route (Dev/Test only). This is the canonical
        // name documented in §2.3 (Dev/Test: split page showing both Microsoft
        // OAuth and "Continue as Guest"). It mints a guest identity using the
        // same DevCookie pathway as the legacy /api/auth/dev-bypass endpoint,
        // but is reachable from the SPA via a clean /auth/login/fake URL.
        // Hard-guarded: 404 unless Development/Test AND loopback peer.
        //
        // NetRun10 audit #7: accept both `?user=…` and `?displayName=…` —
        // every other dev-bypass endpoint in the project uses `displayName`,
        // so the previous `user`-only binding silently minted "Guest" for
        // anyone copying the example AGENT.md then carried. `displayName` wins if both
        // are supplied; unknown query params are rejected with 400 to keep
        // the contract honest.
        app.MapGet("/auth/login/fake", [AllowAnonymous] async (
            string? user,
            string? displayName,
            string? returnUrl,
            HttpContext context,
            IWebHostEnvironment environment) =>
        {
            if (!environment.IsDevelopment() && !environment.IsEnvironment("Test"))
            {
                return Results.NotFound();
            }
            if (!IsLoopback(context))
            {
                return Results.NotFound();
            }
            // Honor the contract: only the two known params are accepted.
            // Anything else gets a 400 so E2E / curl authors see their typo
            // instead of silently minting a Guest.
            var known = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                "user", "displayName", "returnUrl"
            };
            foreach (var key in context.Request.Query.Keys)
            {
                if (!known.Contains(key))
                {
                    return Results.BadRequest(new { error = "unknown_query_param", parameter = key });
                }
            }
            var chosen = !string.IsNullOrWhiteSpace(displayName) ? displayName : user;
            await SignInDevelopmentUserAsync(context, environment, null, string.IsNullOrWhiteSpace(chosen) ? "Guest" : chosen);
            return Results.Redirect(ResolveLocalReturnUrl(returnUrl));
        })
        .WithName("LoginFake")
        .WithTags("Auth")
        .WithSummary("Mints a guest identity (Dev/Test only). Reachable only from loopback. Accepts `?user=` or `?displayName=`.");

        // Clears the application sign-out cookie and returns the user to a validated local target.
        app.MapGet("/auth/logout", [AllowAnonymous] async (string? returnUrl, HttpContext context) =>
        {
            await context.SignOutAsync(AuthSchemes.DevCookie);
            return Results.Redirect(ResolveLocalReturnUrl(returnUrl));
        })
        .WithName("Logout")
        .WithTags("Auth")
        .WithSummary("Clears the sign-out cookie and triggers remote logout.");

        // Returns current server auth state and a flag indicating whether OAuth is fully configured.
        app.MapGet("/auth/me", [AllowAnonymous] (HttpContext context, IOptions<MicrosoftAuthOptions> options) =>
        {
            var oauthConfigured = options.Value.Enabled;
            if (AuthenticatedUser.TryCreate(context.User, out var user) && user is not null)
            {
                return Results.Ok(new AuthStateResponse(
                    true, oauthConfigured, new AuthenticatedUserProfile(user.UserId, user.DisplayName, user.Email)));
            }

            return Results.Ok(new AuthStateResponse(false, oauthConfigured, null));
        })
        .WithName("GetAuthState")
        .WithTags("Auth")
        .WithSummary("Returns server auth state and whether OAuth is fully configured.");
        // §6: single-RTT auth handshake. The SPA used to fetch /api/auth/config and
        // /api/auth/me in sequence — two round-trips plus a frame of layout shift.
        // This endpoint collapses both into one response so AuthGate can hydrate
        // BffAuthenticationStateProvider in a single awaited call.
        auth.MapGet("/handshake", [AllowAnonymous] (
            HttpContext context,
            IOptions<MicrosoftAuthOptions> authOptions,
            IWebHostEnvironment environment,
            IConfiguration configuration) =>
        {
            // 2026-07-19 browser audit #3: detect a stale DevCookie at the
            // edge. When the data-protection key ring was rebuilt (Azurite
            // wipe, dev-box restart) the cookie that the SPA sends is no
            // longer decryptable; the cookie auth handler silently treats
            // the request as anonymous and the SPA's stored identity never
            // gets refreshed. Set X-Reauth: 1 here whenever a DevCookie
            // was sent but failed to authenticate, so the client can
            // transparently re-issue a fresh guest identity.
            var sentCookie = context.Request.Cookies.TryGetValue("PoMiniGames.DevAuth", out var cookieValue);
            var auth = authOptions.Value;
            var microsoftEnabled = auth.Enabled;
            var microsoftConfigured = auth.FullyConfigured;
            // §CI/CD policy (2026-06-27): Dev + Test envs expose the Guest dev-bypass
            // path so the SPA can auto-sign-in as Guest without OAuth.
            var devLoginEnabled = environment.IsDevelopment() || environment.IsEnvironment("Test");
            var usingMockData = configuration.GetValue<bool>("FeatureFlags:UseMockData");
            var autoGuestLogin = devLoginEnabled && configuration.GetValue<bool>("Auth:AutoGuestLogin");
            var msalAuthority = NormalizeAuthorityForMsal(auth.Authority);

            var clientConfig = new AuthClientConfiguration(
                microsoftEnabled || devLoginEnabled,
                auth.ClientId,
                msalAuthority,
                auth.EffectiveScope,
                auth.RedirectPath,
                microsoftEnabled,
                microsoftConfigured,
                devLoginEnabled,
                usingMockData,
                autoGuestLogin);

            AuthenticatedUserProfile? profile = null;
            if (AuthenticatedUser.TryCreate(context.User, out var user) && user is not null)
            {
                profile = new AuthenticatedUserProfile(user.UserId, user.DisplayName, user.Email);
            }
            else if (sentCookie && !string.IsNullOrEmpty(cookieValue) && devLoginEnabled)
            {
                // Cookie was sent but context.User is anonymous → the
                // data-protection key ring no longer matches. Signal the
                // SPA to re-issue a fresh dev identity.
                context.Response.Headers["X-Reauth"] = "1";
            }

            return Results.Ok(new AuthHandshakeResponse(clientConfig, profile));
        })
        .WithName("GetAuthHandshake")
        .WithSummary("Single-roundtrip auth state: client config + current user profile (or null).");

        return app;
    }

    /// <summary>
    /// Returns <paramref name="returnUrl"/> only when it is a local relative path; otherwise "/".
    /// Prevents open-redirect attacks by rejecting absolute URLs and protocol-relative ("//") targets.
    /// </summary>
    private static string ResolveLocalReturnUrl(string? returnUrl)
    {
        if (string.IsNullOrWhiteSpace(returnUrl))
        {
            return "/";
        }

        // Must be a rooted, single-slash relative path and not protocol-relative.
        if (returnUrl.StartsWith('/')
            && !returnUrl.StartsWith("//", StringComparison.Ordinal)
            && !returnUrl.StartsWith("/\\", StringComparison.Ordinal)
            && !Uri.IsWellFormedUriString(returnUrl, UriKind.Absolute))
        {
            return returnUrl;
        }

        return "/";
    }

    /// <summary>
    /// Strips a trailing <c>/v2.0</c> from the authority URL so MSAL.js can compose
    /// the discovery URL (<c>{authority}/v2.0/.well-known/openid-configuration</c>)
    /// without doubling the segment. Returns the input unchanged if it doesn't match
    /// the common v2.0 pattern, so custom authority values still flow through.
    /// </summary>
    internal static string NormalizeAuthorityForMsal(string? authority)
    {
        if (string.IsNullOrWhiteSpace(authority)) return string.Empty;
        var trimmed = authority.TrimEnd('/');
        const string suffix = "/v2.0";
        if (trimmed.EndsWith(suffix, StringComparison.OrdinalIgnoreCase))
        {
            return trimmed[..^suffix.Length];
        }
        return trimmed;
    }

    /// <summary>
    /// True when the request peer is the loopback interface (or absent, as with the
    /// in-memory <c>TestServer</c> used by integration tests, which has no real socket).
    /// </summary>
    private static bool IsLoopback(HttpContext context)
    {
        var remote = context.Connection.RemoteIpAddress;
        return remote is null || System.Net.IPAddress.IsLoopback(remote);
    }

    private static async Task<IResult> SignInDevelopmentUserAsync(
        HttpContext context,
        IWebHostEnvironment environment,
        DevLoginRequest? request,
        string? userName)
    {
        // §CI/CD policy (2026-06-27): Dev + Test envs can mint dev identities. Prod
        // never reaches here — Program.cs only maps these endpoints in non-Production
        // environments, and the StartupSecretValidator fails-fast in Prod if
        // AutoGuestLogin or FakeAuth scheme slip through.
        if (!environment.IsDevelopment() && !environment.IsEnvironment("Test"))
        {
            return Results.NotFound();
        }

        // Defense-in-depth: even within Development, an unauthenticated sign-in that
        // mints an arbitrary identity must never be reachable from off-box. Requiring a
        // loopback peer closes remote abuse and the cross-site request vector (a remote
        // page cannot make the browser originate from 127.0.0.1).
        if (!IsLoopback(context))
        {
            return Results.NotFound();
        }

        var profile = DevLoginIntake.BuildProfile(request, userName);
        var identity = new ClaimsIdentity(DevLoginIntake.BuildClaims(profile), AuthSchemes.DevCookie);
        var principal = new ClaimsPrincipal(identity);

        await context.SignInAsync(AuthSchemes.DevCookie, principal, new AuthenticationProperties
        {
            IsPersistent = true,
            ExpiresUtc = DateTimeOffset.UtcNow.AddHours(12),
            AllowRefresh = true,
        });

        return Results.Ok(profile);
    }
}

public sealed record AuthClientConfiguration(
    bool Enabled,
    string ClientId,
    string Authority,
    string Scope,
    string RedirectPath,
    bool MicrosoftEnabled,
    bool MicrosoftConfigured,
    bool DevLoginEnabled,
    bool UsingMockData,
    bool AutoGuestLogin);

public sealed record AuthenticatedUserProfile(string UserId, string DisplayName, string? Email);

public sealed record AuthStateResponse(bool Authenticated, bool OAuthConfigured, AuthenticatedUserProfile? User);

public sealed record DevLoginRequest(string? UserId, string? DisplayName, string? Email);

/// <summary>Single-response shape returned by <c>/api/auth/handshake</c>.</summary>
public sealed record AuthHandshakeResponse(
    AuthClientConfiguration Config,
    AuthenticatedUserProfile? User);
