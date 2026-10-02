using Microsoft.Extensions.Diagnostics.HealthChecks;

namespace PoMiniGames.Features.Health;

/// <summary>
/// Minimal API health endpoints, all under a single <c>/api/health/*</c> prefix.
/// <list type="bullet">
///   <item><c>GET /api/health</c> — structured health report (the legacy contract)</item>
///   <item><c>GET /api/health/ping</c> — zero-dependency <c>pong</c> (no health-check service)</item>
///   <item><c>GET /health</c> — non-prefixed alias kept only for App Service probe compatibility;
///         new callers must use <c>/api/health</c>.</item>
/// </list>
/// </summary>
/// <remarks>
/// Pattern: Adapter over ASP.NET Core's <see cref="HealthCheckService"/>. The
/// application-composition root treats these URLs as a single namespace so
/// <c>curl .../api/health/...</c> is the only shape dev/ops/CI ever have to learn
/// (the previously-divergent <c>/health</c> and <c>/api/health/ping</c> pair was the
/// most-copy-pasted bug across the test suites — see <c>docs/qa-fixes-runbook.md</c>).
/// </remarks>
public static class HealthEndpoints
{
    public static IEndpointRouteBuilder MapHealthEndpoints(this IEndpointRouteBuilder app)
    {
        async Task<IResult> healthHandler(HealthCheckService healthCheckService)
        {
            var report = await healthCheckService.CheckHealthAsync();
            var response = CreateHealthResponse(report);
            return report.Status != HealthStatus.Unhealthy
                ? Results.Ok(response)
                : Results.Json(response, statusCode: StatusCodes.Status503ServiceUnavailable);
        }

        // Every /api/health/* route lives under the same
        // group so the OpenAPI tag, auth gate (none — probes must stay anonymous),
        // and route prefix are declared once.
        var health = app.MapGroup("/api/health").WithTags("Health");

        health.MapGet("", healthHandler)
        .WithName("HealthCheck")
        .WithSummary("Structured health report for all dependencies");

        health.MapGet("/ping", () => Results.Ok("pong"))
            .WithName("HealthPing")
            .WithSummary("Simple liveness probe (no health-check service)");

        // Root <c>/health</c> serves two different audiences from one URL, chosen by Accept:
        //
        //   • A browser (Accept: text/html) gets the Blazor status page —
        //     /health is the human-facing view of external connections.
        //   • Anything else (monitors, curl, the deploy smoke tests — all of which send
        //     */* or application/json) gets the JSON contract.
        //
        // Content negotiation rather than a second route because the server route table is
        // matched ahead of MapFallbackToFile, so a Blazor `@page "/health"` would otherwise
        // be permanently shadowed by this endpoint and simply never render.
        //
        // New JSON callers must prefer <c>/api/health</c>; this alias stays out of OpenAPI
        // to discourage referencing it. NOT inside the /api/health group so the OpenAPI tag
        // stays /api/health only.
        app.MapGet("/health", async (HttpContext context, HealthCheckService healthCheckService, IWebHostEnvironment environment) =>
            PrefersHtml(context.Request)
                ? SpaShell(environment)
                : await healthHandler(healthCheckService))
        .WithName("HealthCheckRootAlias")
        .WithTags("Health")
        .WithSummary("Health report — JSON for monitors, the Blazor status page for browsers")
        .ExcludeFromDescription();

        return app;
    }

    /// <summary>
    /// True only when the caller explicitly asked for HTML. A bare <c>*/*</c> (what
    /// <see cref="HttpClient"/> and most probes send when no Accept header is set) is
    /// deliberately NOT treated as HTML — the JSON report stays the default, so no existing
    /// monitor changes behaviour just because a browser now has somewhere to look.
    /// </summary>
    private static bool PrefersHtml(HttpRequest request)
    {
        foreach (var value in request.Headers.Accept)
        {
            if (value is not null && value.Contains("text/html", StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>
    /// Hands back the Blazor WASM shell so the client router can render the <c>/health</c>
    /// page. The browser's URL stays <c>/health</c>, so the client router picks HealthPage.
    /// </summary>
    /// <remarks>
    /// Resolves through <see cref="IWebHostEnvironment.WebRootFileProvider"/> — the same
    /// provider <c>MapFallbackToFile</c> uses — deliberately, NOT through a physical path.
    /// In development the shell is not a file under the host's wwwroot at all: it is served
    /// out of the static-web-assets manifest pointing into the Client project's own output.
    /// An earlier <c>File.Exists(WebRootPath/index.html)</c> version therefore missed it on
    /// every `dotnet run` and silently fell through to the redirect, so the page rendered in
    /// published builds and nowhere else.
    /// </remarks>
    private static IResult SpaShell(IWebHostEnvironment environment)
    {
        var file = environment.WebRootFileProvider.GetFileInfo("index.html");

        // If the shell genuinely cannot be resolved, fall back to the JSON surface rather
        // than 500ing: a health endpoint that fails because a *UI asset* is missing would
        // report the app as down when it is fine.
        return file.Exists
            ? Results.Stream(file.CreateReadStream(), "text/html; charset=utf-8")
            : Results.Redirect("/api/health");
    }

    private static dynamic CreateHealthResponse(HealthReport report)
    {
        return new
        {
            status = report.Status.ToString(),
            checks = report.Entries.Select(e => new
            {
                name = e.Key,
                status = e.Value.Status.ToString(),
                description = e.Value.Description,
                duration = e.Value.Duration.TotalMilliseconds,
            }),
            totalDuration = report.TotalDuration.TotalMilliseconds,
            checkedAtUtc = DateTimeOffset.UtcNow,
        };
    }
}

