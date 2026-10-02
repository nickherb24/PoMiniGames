using System.Security.Claims;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authorization;
using Microsoft.Extensions.Options;

namespace PoMiniGames.Features.Auth;

public static class AuthEndpoints
{
    public static IEndpointRouteBuilder MapAuthEndpoints(this IEndpointRouteBuilder app)
    {
        // Every /api/auth/* endpoint shares the same
        // prefix and OpenAPI tag. The unprefixed /auth/login/microsoft and
        // /auth/login/fake routes are kept OUTSIDE this group.
        var auth = app.MapGroup("/api/auth").WithTags("Auth");

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

        auth.MapPost("/dev-logout", [AllowAnonymous] async (HttpContext context, IWebHostEnvironment environment) =>
        {
            // Must match SignInDevelopmentUserAsync's guard (Dev + Test) exactly. If sign-out
            // checked IsDevelopment() alone, a dev session minted under Test could be created but
            // never cleared. Any asymmetry here strands sessions.
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

        // ─── Explicit auth routing (exact paths) ───

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

        // Explicit "fake" login route (Dev/Test only): the Dev/Test split page shows both
        // Microsoft OAuth and "Continue as Guest". It mints a guest identity using the
        // same DevCookie pathway as /api/auth/dev-login, but is reachable from
        // the SPA via a clean /auth/login/fake URL.
        // Hard-guarded: 404 unless Development/Test AND loopback peer.
        //
        // Accepts both `?user=…` and `?displayName=…`: every other dev-bypass endpoint
        // in the project uses `displayName`, so a `user`-only binding would silently mint
        // "Guest" for anyone using that name. `displayName` wins if both
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

        // Single-RTT auth handshake: client config + current user in one response,
        // so AuthGate can hydrate BffAuthenticationStateProvider in a single awaited call.
        // This is the only place the SPA's sign-in configuration is served.
        auth.MapGet("/handshake", [AllowAnonymous] (
            HttpContext context,
            IOptions<MicrosoftAuthOptions> authOptions,
            IWebHostEnvironment environment,
            IConfiguration configuration) =>
        {
            // Detect a stale DevCookie at the
            // edge. When the data-protection key ring is rebuilt (Azurite
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
            // Dev + Test envs expose the Guest dev-bypass
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
        // Dev + Test envs can mint dev identities. Prod
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

public sealed record DevLoginRequest(string? UserId, string? DisplayName, string? Email);

/// <summary>Single-response shape returned by <c>/api/auth/handshake</c>.</summary>
public sealed record AuthHandshakeResponse(
    AuthClientConfiguration Config,
    AuthenticatedUserProfile? User);
