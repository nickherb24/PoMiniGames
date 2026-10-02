using System.Text.Json;
using PoMiniGames.Features.Auth;

namespace PoMiniGames.Features.Account;

/// <summary>
/// Self-service account-data endpoints: see everything stored about you, and erase it.
/// </summary>
/// <remarks>
/// <para>
/// The platform keys rows on a Microsoft identity across eight tables and has, until now, had
/// no way for a player to read that back or get rid of it. These two routes close that: a
/// signed-in caller can export their rows as JSON and can erase them, and both act ONLY on the
/// caller's own claim identity — the subject is resolved from the cookie, never from a
/// parameter, so there is no id to substitute.
/// </para>
/// <para>
/// <b>Erase is not sign-out.</b> It removes stored rows; it does not revoke the Entra account
/// or the session. A player who erases and keeps playing starts accumulating rows again, which
/// is the behaviour they expect from "delete my scores". Anything that must also end the
/// session is the client's job (see ProfilePage, which signs out afterwards).
/// </para>
/// </remarks>
public static class AccountEndpoints
{
    /// <summary>
    /// Serializer for the export document.
    /// </summary>
    /// <remarks>
    /// Seeded from <see cref="JsonSerializerDefaults.Web"/>, which is the part that matters: a
    /// bare <c>new JsonSerializerOptions()</c> defaults to PascalCase, so the export came out
    /// with <c>"TotalRows"</c> while every other response on this API says <c>"totalRows"</c> —
    /// one endpoint speaking a different dialect than the rest of its own surface. Indented
    /// because a human opens this file; it is a few hundred rows at most and is never on a hot
    /// path.
    /// </remarks>
    private static readonly JsonSerializerOptions ExportJson =
        new(JsonSerializerDefaults.Web) { WriteIndented = true };

    public static IEndpointRouteBuilder MapAccountEndpoints(this IEndpointRouteBuilder app)
    {
        // Account data lives under /api/account.
        var account = app.MapGroup("/account").WithTags("Account");

        account.MapGet("/export",
            async (HttpContext http, PlayerDataService data, CancellationToken ct) =>
            {
                if (ResolveSubject(http) is not { } subject)
                {
                    return Results.BadRequest(new { error = "No identity to export. Sign in first." });
                }

                var identity = RequestIdentity.Resolve(http.User);

                PlayerDataExport export;
                try
                {
                    export = await data.ExportAsync(subject, identity.IsGuest, ct);
                }
                catch (PlayerDataUnavailableException)
                {
                    return StoreUnavailable();
                }

                // Content-Disposition so the browser saves it rather than rendering it — the
                // client fetches this as a blob and hands it straight to a download.
                http.Response.Headers.ContentDisposition =
                    $"attachment; filename=\"pominigames-data-{DateTime.UtcNow:yyyyMMdd}.json\"";

                return Results.Json(export, ExportJson);
            })
            .WithName("ExportAccountData")
            .WithSummary("Download every row this platform stores about the signed-in caller")
            .Produces<PlayerDataExport>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable)
            .RequireRateLimiting("account-data");

        account.MapDelete("/data",
            async (HttpContext http, PlayerDataService data,
                   ILoggerFactory loggerFactory, CancellationToken ct) =>
            {
                if (ResolveSubject(http) is not { } subject)
                {
                    return Results.BadRequest(new { error = "No identity to erase. Sign in first." });
                }

                var identity = RequestIdentity.Resolve(http.User);

                PlayerDataDeletion result;
                try
                {
                    result = await data.DeleteAsync(subject, ct);
                }
                catch (PlayerDataUnavailableException)
                {
                    // Critically NOT an empty success. "Erased 0 rows" and "could not reach the
                    // store" look identical to a player and mean opposite things.
                    return StoreUnavailable();
                }

                AccountLog.Completed(loggerFactory.CreateLogger("AccountData"), "erase", identity.IsGuest, result.TotalRows);
                return Results.Ok(result);
            })
            .WithName("DeleteAccountData")
            .WithSummary("Permanently erase every stored row belonging to the signed-in caller")
            .Produces<PlayerDataDeletion>(StatusCodes.Status200OK)
            .ProducesProblem(StatusCodes.Status400BadRequest)
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable)
            .RequireRateLimiting("account-data");

        return app;
    }

    /// <summary>
    /// 503 rather than 500: the request was fine, the store was not reachable, and retrying
    /// later is the correct response. Deliberately says nothing about how much data exists.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Driven purely by what the read actually did (see <c>PlayerDataUnavailableException</c>),
    /// which is the only passive signal available.
    /// </para>
    /// <para>
    /// <b>Why this does not consult <c>IStorageService.IsStorageHealthy()</c>.</b> It reads like
    /// the obvious extra guard — when the app has fallen back to in-memory storage, scores are
    /// being written to memory while these endpoints read a real table that answers perfectly
    /// well and is empty, so the export under-reports. But that method is not a property read:
    /// it performs a synchronous <c>CreateIfNotExists</c> against the account on a 500 ms budget
    /// and, on any failure, marks storage unavailable FOR THE LIFETIME OF THE PROCESS. Calling
    /// it from a request path means a single slow probe knocks the whole app onto the in-memory
    /// fallback — the very state the guard was meant to detect. It was wired up here, observed
    /// doing exactly that against a cold emulator, and removed.
    /// </para>
    /// <para>
    /// The residual gap is therefore accepted and narrow: an export taken while the fallback is
    /// engaged reports the table's contents, not memory's. In production the fallback only
    /// engages during a real outage, where the table read below fails too and this 503 is
    /// returned correctly. Locally it means "start Azurite before trusting an export".
    /// </para>
    /// </remarks>
    private static IResult StoreUnavailable() => Results.Problem(
        title: "Player data is temporarily unavailable",
        detail: "Your data could not be read right now, so nothing was changed. Please try again shortly.",
        statusCode: StatusCodes.Status503ServiceUnavailable);

    /// <summary>
    /// The subject is always the caller. Returns null when there is nothing to act on, which is
    /// a 400 rather than a 401: the request authenticated fine, it just carries no identity
    /// worth exporting (a claims-less principal that slipped past the group's auth gate).
    /// </summary>
    private static PlayerDataSubject? ResolveSubject(HttpContext http)
    {
        var identity = RequestIdentity.Resolve(http.User);
        if (string.IsNullOrEmpty(identity.UserId) && string.IsNullOrWhiteSpace(identity.DisplayName))
        {
            return null;
        }

        return new PlayerDataSubject(identity.UserId, identity.DisplayName);
    }
}
