using System.Security.Claims;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;
using PoMiniGames.Domain.Primitives;

namespace PoMiniGames.Features.Auth;

/// <summary>
/// Header-driven fake authentication for Dev and Test environments only.
/// Authenticates a request when an <see cref="UserHeader"/> is supplied, optionally
/// assigning roles from <see cref="RolesHeader"/>. Absence of the header yields
/// <see cref="AuthenticateResult.NoResult"/> (anonymous), never an error.
/// </summary>
/// <remarks>
/// <para>
/// Pattern: Strategy. This handler is an interchangeable <see cref="IAuthenticationHandler"/>
/// strategy swapped in for real Microsoft OAuth in non-production environments, allowing tests
/// to assert identity variations by injecting headers without performing a real OAuth handshake.
/// A production startup guard (see Program.cs) throws if this scheme is ever registered in Production.
/// </para>
/// <para>
/// The user value is sanitised through a strict
/// identity grammar (max 64 chars; alphanumerics + <c>._-@</c>) so a tampered header
/// like <c>X-Fake-User: ../admin</c> is rejected as anonymous rather than being used
/// as a <see cref="ClaimTypes.NameIdentifier"/>. Role values go through the typed
/// <see cref="Role"/> primitive for the same reason.
/// </para>
/// </remarks>
public sealed class FakeAuthHandler : AuthenticationHandler<AuthenticationSchemeOptions>
{
    public const string SchemeName = "FakeAuth";
    public const string UserHeader = "X-Fake-User";
    public const string RolesHeader = "X-Fake-Roles";

    private const int MaxUserLength = 64;

    private readonly IHostEnvironment _environment;

    public FakeAuthHandler(
        IOptionsMonitor<AuthenticationSchemeOptions> options,
        ILoggerFactory logger,
        UrlEncoder encoder,
        IHostEnvironment environment)
        : base(options, logger, encoder)
    {
        _environment = environment;
    }

    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        // ── Production execution guard (defence in depth) ──────────────────
        // StartupSecretValidator already refuses to boot when this scheme is REGISTERED in
        // Production, but that check runs once, against the scheme provider, at startup.
        // This one runs on the request path, so a scheme added later (a dynamically-registered
        // provider, a test host mutated after boot, a future refactor that moves registration
        // out of AddPoMiniGamesAuth) still cannot mint an identity in Production. The two
        // guards are deliberately redundant: the cost of a miss here is unauthenticated
        // header-driven impersonation of any user.
        if (_environment.IsProduction())
        {
            throw new InvalidOperationException(
                $"FATAL: authentication scheme '{SchemeName}' executed in a Production environment. " +
                "Fake authentication must never run in Production.");
        }

        if (!Request.Headers.TryGetValue(UserHeader, out var user) || string.IsNullOrEmpty(user))
        {
            return Task.FromResult(AuthenticateResult.NoResult()); // Not an error - just unauthenticated
        }

        var raw = user.ToString();

        // Reject tampered values that wouldn't survive as identifiers. We don't want a header
        // value like "../admin" or "user\nX-Injected: value" to flow into claim stores that
        // get echoed back into logs / DOM attributes / SQL WHERE clauses downstream.
        if (!IsSafeIdentity(raw))
        {
            Logger.LogWarning("Rejected tampered {Header} value (length={Length}); treating as anonymous.", UserHeader, raw.Length);
            return Task.FromResult(AuthenticateResult.NoResult());
        }

        var normalised = NormaliseIdentity(raw);
        var email = normalised.Contains('@') ? normalised : $"{normalised}@example.com";
        var claims = new List<Claim>
        {
            new(ClaimTypes.NameIdentifier, normalised),
            new("oid", normalised),
            new(ClaimTypes.Name, normalised),
            new("name", normalised),
            new(ClaimTypes.Email, email),
            new("preferred_username", email),
            // Tag the identity so downstream code (rate limiter, audit log) can tell FakeAuth
            // sessions apart from real JWT ones — even when the cookie domain is the same.
            new("auth_scheme", SchemeName),
        };

        if (Request.Headers.TryGetValue(RolesHeader, out var roles) && !string.IsNullOrEmpty(roles))
        {
            foreach (var role in roles.ToString().Split(',', StringSplitOptions.RemoveEmptyEntries))
            {
                var parsed = Role.Parse(role);
                if (parsed.IsEmpty || !IsSafeIdentity(parsed.Value))
                {
                    Logger.LogWarning("Rejected tampered role value '{Role}' on {Header}.", role, RolesHeader);
                    continue;
                }
                claims.Add(new Claim(ClaimTypes.Role, parsed.Value));
                claims.Add(new Claim("roles", parsed.Value));
            }
        }

        var principal = new ClaimsPrincipal(new ClaimsIdentity(claims, SchemeName));
        return Task.FromResult(AuthenticateResult.Success(new AuthenticationTicket(principal, SchemeName)));
    }

    private static bool IsSafeIdentity(string value)
    {
        if (string.IsNullOrEmpty(value) || value.Length > MaxUserLength) return false;
        // Allow alphanumerics, '.', '_', '-', '@'. Reject everything else (including path
        // separators, control characters, whitespace, and CRLF injection vectors).
        foreach (var c in value)
        {
            if (!(char.IsLetterOrDigit(c) || c is '.' or '_' or '-' or '@')) return false;
        }
        return true;
    }

    private static string NormaliseIdentity(string value) => value.Trim().ToLowerInvariant();
}
