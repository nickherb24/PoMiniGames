using Microsoft.AspNetCore.Antiforgery;

namespace PoMiniGames.Infrastructure;

/// <summary>
/// Antiforgery (CSRF) protection for every state-changing API call.
///
/// This app authenticates with a BFF cookie, which browsers attach to cross-site
/// requests automatically — the exact precondition CSRF exploits. <c>SameSite=Strict</c>
/// on the session cookie (see <c>AuthExtensions</c>) already blocks the classic
/// cross-site form post, but it is a single control enforced entirely by the browser:
/// it does nothing for a same-site subdomain takeover, and it silently degrades on
/// clients that do not implement the attribute. The synchroniser-token pattern below
/// is the server-side control that does not depend on browser cooperation.
///
/// Scope is deliberate, and each exclusion is a real requirement rather than a gap:
/// <list type="bullet">
///   <item><b>Only <c>/api/*</c>.</b> SignalR hubs live at their own roots
///     (<c>/poracer/lobby-hub</c>, <c>/couplequiz/hubs/game</c>, …). Their POST
///     <c>/negotiate</c> would fail validation because the SignalR client builds its
///     own request pipeline and cannot be taught to attach the header. Hub traffic is
///     covered by the auth gate plus <c>SameSite=Strict</c>.</item>
///   <item><b>Only unsafe methods.</b> GET/HEAD/OPTIONS/TRACE are required by
///     <see cref="IAntiforgery"/> to be side-effect free, and the token-issuing
///     endpoint is itself a GET so the client can always bootstrap.</item>
/// </list>
///
/// Note that <c>app.UseAntiforgery()</c> alone would NOT satisfy this rule: since
/// .NET 8 that middleware auto-validates only endpoints with form bindings
/// (<c>IFromFormMetadata</c>), and every endpoint in this app takes JSON. The explicit
/// validation below is what actually covers the JSON surface.
/// </summary>
internal static class AntiforgeryExtensions
{
    /// <summary>Header the client echoes the request token back in.</summary>
    public const string HeaderName = "X-CSRF-TOKEN";

    /// <summary>
    /// Cookie holding the antiforgery *cookie token*. Not <c>__Host-</c> prefixed: that
    /// prefix mandates <c>Secure</c>, and development serves the whole app over plain
    /// <c>http://localhost:5000</c>, where a Secure cookie is discarded by the browser and
    /// every write would 403 locally. <see cref="CookieSecurePolicy.SameAsRequest"/> gets
    /// the Secure flag in production (HTTPS) without breaking dev.
    /// </summary>
    private const string CookieName = "PoMiniGames.Antiforgery";

    public static IServiceCollection AddPoMiniGamesAntiforgery(this IServiceCollection services)
    {
        services.AddAntiforgery(options =>
        {
            options.HeaderName = HeaderName;
            options.Cookie.Name = CookieName;
            // HttpOnly stays true: this is the *cookie* half of the pair. The client never
            // reads it — it reads the request token from the JSON endpoint below. Making it
            // script-readable would hand both halves to any XSS payload for nothing.
            options.Cookie.HttpOnly = true;
            options.Cookie.SecurePolicy = CookieSecurePolicy.SameAsRequest;
            // Lax, not Strict: the Microsoft Entra sign-in flow returns via a top-level
            // cross-site redirect, and a Strict antiforgery cookie would be withheld on that
            // navigation, leaving the freshly-signed-in user unable to write until a reload.
            options.Cookie.SameSite = SameSiteMode.Lax;
        });

        return services;
    }

    /// <summary>
    /// Validates the synchroniser token on every state-changing <c>/api/*</c> request.
    /// Must be registered AFTER <c>UseAuthentication</c>: the token is bound to the user's
    /// identity, so validating it against an anonymous principal would reject the very
    /// token the same user was just issued.
    /// </summary>
    public static WebApplication UsePoMiniGamesAntiforgery(this WebApplication app)
    {
        var antiforgery = app.Services.GetRequiredService<IAntiforgery>();

        app.Use(async (context, next) =>
        {
            if (!RequiresValidation(context))
            {
                await next(context);
                return;
            }

            try
            {
                await antiforgery.ValidateRequestAsync(context);
            }
            catch (AntiforgeryValidationException ex)
            {
                app.Logger.LogWarning(
                    ex,
                    "Antiforgery validation failed for {Method} {Path}.",
                    context.Request.Method,
                    context.Request.Path);

                // 403, not 400: the request was well-formed, it was refused. The typed
                // `error` code is the contract the client's AntiforgeryHandler keys off to
                // decide "refresh the token and replay once" rather than surfacing a
                // failure to the player — a generic 403 is indistinguishable from a real
                // authorization denial and must not trigger a replay.
                context.Response.StatusCode = StatusCodes.Status403Forbidden;
                await context.Response.WriteAsJsonAsync(new
                {
                    error = "antiforgery_validation_failed",
                    detail = $"A valid '{HeaderName}' header is required for state-changing requests. "
                           + "Fetch one from GET /api/auth/antiforgery-token.",
                });
                return;
            }

            await next(context);
        });

        return app;
    }

    /// <summary>
    /// Issues the request token (and sets the paired cookie). Anonymous and safe by
    /// design — possession of the token proves nothing on its own; validation requires
    /// the matching cookie, which only this response can set.
    /// </summary>
    public static IEndpointRouteBuilder MapAntiforgeryEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/auth/antiforgery-token", (HttpContext context, IAntiforgery antiforgery) =>
        {
            var tokens = antiforgery.GetAndStoreTokens(context);

            // Never cache: the token is bound to this user's identity, and a shared or
            // browser-cached copy would be replayed for the wrong principal after a
            // sign-in/sign-out and fail validation.
            context.Response.Headers.CacheControl = "no-store, no-cache, must-revalidate";

            return Results.Ok(new AntiforgeryTokenResponse(
                tokens.RequestToken ?? string.Empty,
                tokens.HeaderName ?? HeaderName));
        })
        .AllowAnonymous()
        .WithTags("Auth")
        .WithSummary("Issues the antiforgery request token required by state-changing /api/* calls.");

        return app;
    }

    private static bool RequiresValidation(HttpContext context)
    {
        if (!HttpMethods.IsPost(context.Request.Method)
            && !HttpMethods.IsPut(context.Request.Method)
            && !HttpMethods.IsPatch(context.Request.Method)
            && !HttpMethods.IsDelete(context.Request.Method))
        {
            return false;
        }

        if (!context.Request.Path.StartsWithSegments("/api", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        // /api/infer is the Survive AI relay — a per-turn POST that the orchestrator
        // emits every 250-1500 ms during a running simulation. It is gated by the
        // BFF cookie (SameSite=Lax) plus an AuthenticatedUser requirement and rate
        // limiting at 10 req/s per IP, so the synchroniser-token check adds no real
        // CSRF protection and the client HttpClient used by the relay cannot carry
        // the AntiforgeryHandler header. Excluding it stops a 1-Hz 403 storm from
        // filling /api/diag and the AppInsights request log.
        return !context.Request.Path.StartsWithSegments("/api/infer", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>Response shape of <c>GET /api/auth/antiforgery-token</c>.</summary>
    private sealed record AntiforgeryTokenResponse(string Token, string HeaderName);
}
