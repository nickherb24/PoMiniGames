using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Authentication.Cookies;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.IdentityModel.Tokens;
using PoMiniGames.Features.Auth;

namespace PoMiniGames.Infrastructure;

/// <summary>
/// Registers the authentication scheme (DevCookie / JWT Bearer) for the current environment.
/// </summary>
internal static class AuthExtensions
{
    public static IServiceCollection AddPoMiniGamesAuth(
        this IServiceCollection services,
        IWebHostEnvironment env,
        IConfiguration configuration)
    {
        var microsoftAuthSection = configuration.GetSection(MicrosoftAuthOptions.SectionName);
        services.Configure<MicrosoftAuthOptions>(microsoftAuthSection);
        var microsoftAuthOptions = microsoftAuthSection.Get<MicrosoftAuthOptions>() ?? new MicrosoftAuthOptions();

        // Dev + Test environments get the dev-login pathway so the test harness can
        // sign in as Guest without going through the MSAL/OAuth handshake. Production
        // NEVER gets this — a startup guard in Program.cs enforces that even if the
        // config flag slips in (see FakeAuthHandler + StartupSecretValidator).
        var devLoginEnabled = env.IsDevelopment() || env.IsEnvironment("Test");

        // Fake auth (header-driven) is gated to non-Production environments behind an
        // explicit config flag. Both Dev and Test honor it so e2e fixtures can opt
        // into header-driven identity assertions; Production guards remain intact via
        // StartupSecretValidator (throws if FakeAuth is ever registered in Prod).
        var fakeAuthEnabled = (env.IsDevelopment() || env.IsEnvironment("Test"))
            && configuration.GetValue<bool>("Auth:EnableFakeAuth");

        var authBuilder = services.AddAuthentication(options =>
            {
                options.DefaultAuthenticateScheme = AuthSchemes.Composite;
                options.DefaultChallengeScheme = AuthSchemes.Composite;
            })
            .AddPolicyScheme(AuthSchemes.Composite, AuthSchemes.Composite, options =>
            {
                options.ForwardDefaultSelector = context =>
                {
                    var authHeader = context.Request.Headers.Authorization.ToString();
                    if (!string.IsNullOrWhiteSpace(authHeader)
                        && authHeader.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
                    {
                        return JwtBearerDefaults.AuthenticationScheme;
                    }

                    if (context.Request.Query.ContainsKey("access_token")
                        && !string.IsNullOrWhiteSpace(context.Request.Query["access_token"]))
                    {
                        return JwtBearerDefaults.AuthenticationScheme;
                    }

                    if (fakeAuthEnabled && context.Request.Headers.ContainsKey(FakeAuthHandler.UserHeader))
                    {
                        return FakeAuthHandler.SchemeName;
                    }

                    if (devLoginEnabled)
                    {
                        return AuthSchemes.DevCookie;
                    }

                    return JwtBearerDefaults.AuthenticationScheme;
                };
            });

        if (fakeAuthEnabled)
        {
            authBuilder.AddScheme<AuthenticationSchemeOptions, FakeAuthHandler>(
                FakeAuthHandler.SchemeName, _ => { });
        }

        authBuilder
            .AddCookie(AuthSchemes.DevCookie, options =>
            {
                options.Cookie.Name = "PoMiniGames.DevAuth";
                options.Cookie.HttpOnly = true;
                // Session cookies are SameSite=Strict. The dev/guest cookie is
                // minted and read entirely same-origin (the /auth/login/fake redirect and
                // /api/auth/dev-* posts all originate from the SPA on the host origin), so
                // Strict never blocks a legitimate flow while closing the cross-site vector.
                options.Cookie.SameSite = SameSiteMode.Strict;
                options.Cookie.SecurePolicy = CookieSecurePolicy.SameAsRequest;
                options.Events = new CookieAuthenticationEvents
                {
                    OnRedirectToLogin = context =>
                    {
                        context.Response.StatusCode = StatusCodes.Status401Unauthorized;
                        return Task.CompletedTask;
                    },
                    OnRedirectToAccessDenied = context =>
                    {
                        context.Response.StatusCode = StatusCodes.Status403Forbidden;
                        return Task.CompletedTask;
                    },
                };
                // See /api/auth/handshake — the
                // reauth signal is set on the handshake endpoint whenever a
                // DevCookie was sent but context.User is anonymous (i.e. the
                // data-protection key ring no longer matches). The handshake
                // endpoint is the right place to detect this: cookie auth
                // failures are swallowed upstream, so a per-endpoint check
                // against the request cookie is the only reliable hook.
            })
            .AddJwtBearer(options =>
            {
                var authority = microsoftAuthOptions.Authority;
                var audience = microsoftAuthOptions.ApiClientId;

                options.MapInboundClaims = false;
                options.RequireHttpsMetadata = !env.IsDevelopment();

                if (!string.IsNullOrWhiteSpace(authority))
                {
                    options.Authority = authority;
                }

                options.TokenValidationParameters = new TokenValidationParameters
                {
                    // ValidateIssuer must be true. A custom IssuerValidator
                    // allow-lists the well-known public authorities (common / organizations /
                    // consumers) plus any tenant IDs configured under
                    // PoMiniGames:MicrosoftAuth:AllowedTenantIds.
                    ValidateIssuer = true,
                    ValidIssuer = authority,
                    IssuerValidator = (issuer, token, parameters) =>
                        MicrosoftAuthIssuerValidator.Validate(issuer, microsoftAuthOptions.AllowedTenantIds),
                    ValidateAudience = !string.IsNullOrWhiteSpace(audience),
                    ValidAudience = audience,
                    NameClaimType = "name",
                    RoleClaimType = "roles",
                };

                options.Events = new JwtBearerEvents
                {
                    OnMessageReceived = context =>
                    {
                        // Browsers cannot set headers on a WebSocket upgrade, so SignalR sends
                        // the token in the query string. Accept it for hub endpoints only.
                        var accessToken = context.Request.Query["access_token"];
                        var isHub = context.HttpContext.GetEndpoint()?.Metadata
                            .GetMetadata<Microsoft.AspNetCore.SignalR.HubMetadata>() is not null;
                        if (!string.IsNullOrWhiteSpace(accessToken) && isHub)
                        {
                            context.Token = accessToken;
                        }

                        return Task.CompletedTask;
                    },

                    // Canonical UserSignedIn record. A bearer token is validated on EVERY request,
                    // so dedupe:true collapses an active SPA session down to one record per user
                    // per window instead of hundreds.
                    OnTokenValidated = context =>
                    {
                        SignInTelemetry.TrackFrom(
                            context.HttpContext, context.Principal, "PoMiniGames", dedupe: true);
                        return Task.CompletedTask;
                    },
                };
            });

        return services;
    }
}
