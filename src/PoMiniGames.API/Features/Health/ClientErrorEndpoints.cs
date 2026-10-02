using System.Text.Json;

namespace PoMiniGames.Features.Health;

/// <summary>One browser-side failure, as posted by <c>wwwroot/js/errorReporter.js</c>.</summary>
public sealed record ClientErrorReport(string? Kind, string? Message, string? Source, string? Stack, string? Path);

/// <summary>
/// The sink behind the client error reporter: a page that breaks in a player's browser
/// (an uncaught error, a rejected promise, a lost WebGL context, anything that reaches
/// <c>console.error</c>) becomes one Warning in the server log, and so in Application Insights.
/// </summary>
/// <remarks>
/// <para>
/// It exists because nothing reported these. SandPlayground sat on the error boundary from
/// 2026-09-16 to 2026-09-30 behind a shader typo <c>dotnet build</c> cannot see, and the boundary's
/// own copy said "the team has been notified" while notifying nobody.
/// </para>
/// <para>
/// <b>Outside <c>/api</c> on purpose.</b> The reporter uses <c>navigator.sendBeacon</c>, which
/// survives the page unloading and cannot attach a header, so the route has to sit outside the
/// scope <c>AntiforgeryExtensions</c> validates — the same reason the SignalR hubs do. It is
/// anonymous for the same reason the leaderboard reads are: a page can break before sign-in.
/// What that leaves is an unauthenticated write to the log, so it is bounded three ways: a small
/// body, truncated fields with control characters removed, and its own rate limit.
/// </para>
/// </remarks>
public static class ClientErrorEndpoints
{
    public const string Route = "/client-errors";
    public const int MaxBodyBytes = 8 * 1024;

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static IEndpointRouteBuilder MapClientErrorEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost(Route, async (HttpContext http, ILoggerFactory logs) =>
            {
                if (http.Request.ContentLength > MaxBodyBytes)
                    return Results.StatusCode(StatusCodes.Status413PayloadTooLarge);

                // Read at most one byte past the cap: ContentLength is the client's word, and a
                // chunked body carries none at all.
                var buffer = new byte[MaxBodyBytes + 1];
                var read = 0;
                while (read < buffer.Length)
                {
                    var n = await http.Request.Body.ReadAsync(buffer.AsMemory(read), http.RequestAborted);
                    if (n == 0) break;
                    read += n;
                }
                if (read > MaxBodyBytes) return Results.StatusCode(StatusCodes.Status413PayloadTooLarge);

                ClientErrorReport? report;
                try
                {
                    report = JsonSerializer.Deserialize<ClientErrorReport>(buffer.AsSpan(0, read), Json);
                }
                catch (JsonException)
                {
                    return Results.BadRequest();
                }
                var message = Clean(report?.Message, 500);
                if (message.Length == 0) return Results.BadRequest();

                logs.CreateLogger("ClientErrors").LogWarning(
                    "Client error {Kind} on {Path}: {Message} | source={Source} | agent={Agent} | stack={Stack}",
                    Clean(report!.Kind, 40), Clean(report.Path, 200), message, Clean(report.Source, 200),
                    Clean(http.Request.Headers.UserAgent.ToString(), 200), Clean(report.Stack, 2000));
                return Results.NoContent();
            })
            .AllowAnonymous()
            .RequireRateLimiting("client-errors")
            .WithName("ReportClientError")
            .WithTags("Diagnostics")
            .WithSummary("Records a browser-side error in the server log.")
            .ExcludeFromDescription();

        return app;
    }

    /// <summary>
    /// Truncated, with control characters flattened to spaces: the value is attacker-controlled
    /// text headed for a log line, where a newline would let it forge a second entry.
    /// </summary>
    internal static string Clean(string? value, int max)
    {
        if (string.IsNullOrWhiteSpace(value)) return string.Empty;
        var text = value.Length <= max ? value : value[..max];
        return string.Create(text.Length, text, static (span, source) =>
        {
            for (var i = 0; i < source.Length; i++)
                span[i] = char.IsControl(source[i]) ? ' ' : source[i];
        }).Trim();
    }
}
