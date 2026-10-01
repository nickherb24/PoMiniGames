using Microsoft.AspNetCore.Mvc;
using PoMiniGames.Features.Auth;
using PoMiniGames.Features.Integrity;
using PoMiniGames.Shared.Games.PoEcosystem;

namespace PoMiniGames.Features.PoEcosystem;

/// <summary>
/// PoEcosystem's server surface. Authenticated: the caller's cloud slots, sharing, the
/// chronicle and cloud thoughts. Anonymous: the gallery of shared islands and their bytes.
/// </summary>
/// <remarks>
/// <para>
/// The owner of a slot is always the claim identity — a caller can neither name another
/// partition nor read one. The only cross-identity read is the gallery, which resolves a
/// share code its owner minted; the code never says whose it is.
/// </para>
/// <para>
/// Snapshot bytes travel as raw <c>application/gzip</c> bodies, capped at
/// <see cref="EcoWorldSlots.MaxBytes"/>: a hundred-year world is about a megabyte compressed,
/// and the cap is what keeps a hostile client from turning three slots into free blob storage.
/// </para>
/// </remarks>
public static class EcosystemEndpoints
{
    public static IEndpointRouteBuilder MapPoEcosystemEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/ecosystem").WithTags("PoEcosystem");

        group.MapGet("/worlds", async (HttpContext http, EcosystemWorldStore store, CancellationToken ct) =>
            {
                var who = Owner(http);
                return who is null ? Results.Unauthorized() : Results.Ok(await store.ListAsync(who.Value.UserId, ct));
            })
            .WithName("PoEcosystemListWorlds")
            .Produces<EcoWorldMeta[]>();

        group.MapPut("/worlds/{slot}", async (
                string slot, HttpContext http, EcosystemWorldStore store, IScoreIntegrityGuard integrity, CancellationToken ct,
                [FromQuery] string? name, [FromQuery] int seed = 0, [FromQuery] int year = 0, [FromQuery] int tick = 0, [FromQuery] string? counts = null) =>
            {
                var who = Owner(http);
                if (who is null) return Results.Unauthorized();
                if (!EcoWorldSlots.IsValid(slot)) return Results.BadRequest(new { error = "slot must be 1, 2 or 3" });
                if (http.Request.ContentLength is > EcoWorldSlots.MaxBytes) return Results.StatusCode(StatusCodes.Status413PayloadTooLarge);

                var bytes = await ReadBoundedAsync(http.Request.Body, EcoWorldSlots.MaxBytes, ct);
                if (bytes is null) return Results.StatusCode(StatusCodes.Status413PayloadTooLarge);
                if (bytes.Length < 2 || bytes[0] != 0x1f || bytes[1] != 0x8b) return Results.BadRequest(new { error = "body must be a gzip'd snapshot" });

                var cleanName = CleanName(name, $"Year {year}");
                var ownerName = integrity.ResolveDisplayName(who.Value.DisplayName, "Islander");
                var saved = await store.SaveAsync(who.Value.UserId, ownerName, slot, cleanName, seed, Math.Max(0, year), Math.Max(0, tick), EcosystemWorldStore.ParseCounts(counts), bytes, ct);
                return saved is null ? Results.StatusCode(StatusCodes.Status503ServiceUnavailable) : Results.Ok(saved);
            })
            .WithName("PoEcosystemSaveWorld")
            .Produces<EcoWorldMeta>()
            .RequireRateLimiting("highscores");
        // No .Accepts("application/gzip") here, deliberately. IAcceptsMetadata takes part in
        // endpoint SELECTION: a request with any other Content-Type is routed to a synthetic
        // 415 endpoint that carries no authorization metadata, so an anonymous JSON PUT got
        // past the auth gate and was refused by the antiforgery middleware with a 403 —
        // which is exactly the route-exists leak the 401 contract exists to prevent. The
        // handler checks the gzip magic bytes itself instead.

        group.MapGet("/worlds/{slot}/data", async (string slot, HttpContext http, EcosystemWorldStore store, CancellationToken ct) =>
            {
                var who = Owner(http);
                if (who is null) return Results.Unauthorized();
                if (!EcoWorldSlots.IsValid(slot)) return Results.BadRequest(new { error = "slot must be 1, 2 or 3" });
                var bytes = await store.LoadAsync(who.Value.UserId, slot, ct);
                return bytes is null ? Results.NotFound() : Results.Bytes(bytes, "application/gzip");
            })
            .WithName("PoEcosystemLoadWorld");

        group.MapDelete("/worlds/{slot}", async (string slot, HttpContext http, EcosystemWorldStore store, CancellationToken ct) =>
            {
                var who = Owner(http);
                if (who is null) return Results.Unauthorized();
                if (!EcoWorldSlots.IsValid(slot)) return Results.BadRequest(new { error = "slot must be 1, 2 or 3" });
                return await store.DeleteAsync(who.Value.UserId, slot, ct) ? Results.NoContent() : Results.StatusCode(StatusCodes.Status503ServiceUnavailable);
            })
            .WithName("PoEcosystemDeleteWorld")
            .RequireRateLimiting("highscores");

        group.MapPost("/worlds/{slot}/share", async (string slot, EcoShareRequest request, HttpContext http, EcosystemWorldStore store, CancellationToken ct) =>
            {
                var who = Owner(http);
                if (who is null) return Results.Unauthorized();
                if (!EcoWorldSlots.IsValid(slot)) return Results.BadRequest(new { error = "slot must be 1, 2 or 3" });
                var meta = await store.ShareAsync(who.Value.UserId, slot, request.Public, ct);
                return meta is null ? Results.NotFound() : Results.Ok(meta);
            })
            .WithName("PoEcosystemShareWorld")
            .Produces<EcoWorldMeta>()
            .RequireRateLimiting("highscores");

        group.MapPost("/chronicle", async (EcoChronicleRequest request, IEcosystemChronicleService chronicler, CancellationToken ct) =>
            {
                if (request.Log is { Length: > EcosystemChronicleService.MaxLogLines * 2 }) return Results.BadRequest(new { error = "too many log lines" });
                try { return Results.Ok(await chronicler.WriteAsync(request, ct)); }
                catch (InvalidOperationException) { return Results.StatusCode(StatusCodes.Status503ServiceUnavailable); }
            })
            .WithName("PoEcosystemChronicle")
            .Produces<EcoChronicle>()
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable)
            .RequireRateLimiting("ai-generation");

        group.MapPost("/thought", async (EcoThoughtRequest request, IEcosystemChronicleService chronicler, CancellationToken ct) =>
            {
                if (string.IsNullOrWhiteSpace(request.Prompt) || request.Prompt.Length > 2_000) return Results.BadRequest(new { error = "prompt is required and bounded" });
                try { return Results.Ok(await chronicler.ThinkAsync(request, ct)); }
                catch (InvalidOperationException) { return Results.StatusCode(StatusCodes.Status503ServiceUnavailable); }
            })
            .WithName("PoEcosystemThought")
            .Produces<EcoThoughtReply>()
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable)
            .RequireRateLimiting("ai-generation");

        group.MapPost("/thoughts/batch", async (EcoThoughtBatchRequest request, IEcosystemChronicleService chronicler, CancellationToken ct) =>
            {
                if (request.Items is null || request.Items.Count == 0 || request.Items.Count > 16) return Results.BadRequest(new { error = "items required (1-16)" });
                try { return Results.Ok(await chronicler.ThinkBatchAsync(request, ct)); }
                catch (InvalidOperationException) { return Results.StatusCode(StatusCodes.Status503ServiceUnavailable); }
            })
            .WithName("PoEcosystemThoughtBatch")
            .Produces<EcoThoughtBatchReply>()
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable)
            .RequireRateLimiting("ai-generation");

        group.MapPost("/treaty", async (EcoTreatyRequest request, IEcosystemChronicleService chronicler, CancellationToken ct) =>
            {
                if (request.TribeA is null || request.TribeB is null) return Results.BadRequest(new { error = "both tribes required" });
                try { return Results.Ok(await chronicler.NegotiateTreatyAsync(request, ct)); }
                catch (InvalidOperationException) { return Results.StatusCode(StatusCodes.Status503ServiceUnavailable); }
            })
            .WithName("PoEcosystemTreaty")
            .Produces<EcoTreatyReply>()
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable)
            .RequireRateLimiting("ai-generation");

        group.MapPost("/milestone-lore", async (EcoMilestoneLoreRequest request, IEcosystemChronicleService chronicler, CancellationToken ct) =>
            {
                if (string.IsNullOrWhiteSpace(request.MilestoneType)) return Results.BadRequest(new { error = "milestone type required" });
                try { return Results.Ok(await chronicler.GenerateMilestoneLoreAsync(request, ct)); }
                catch (InvalidOperationException) { return Results.StatusCode(StatusCodes.Status503ServiceUnavailable); }
            })
            .WithName("PoEcosystemMilestoneLore")
            .Produces<EcoMilestoneLoreReply>()
            .ProducesProblem(StatusCodes.Status503ServiceUnavailable)
            .RequireRateLimiting("ai-generation");

        group.MapGet("/culture/{seed:int}", (int seed, IEcosystemChronicleService chronicler) =>
            {
                return Results.Ok(chronicler.GenerateTribeCultures(seed));
            })
            .WithName("PoEcosystemCulture")
            .Produces<EcoCultureProfile[]>();

        group.MapPost("/chronicle/prewarm", async (EcoChronicleRequest request, IEcosystemChronicleService chronicler, CancellationToken ct) =>
            {
                await chronicler.PrewarmChronicleAsync(request, ct);
                return Results.Accepted();
            })
            .WithName("PoEcosystemPrewarmChronicle")
            .RequireRateLimiting("ai-generation");

        return app;
    }

    /// <summary>
    /// The gallery: anonymous, read-only, rate-limited like every other public read. Mapped on
    /// <c>app</c>, not the authenticated group, so it spells its full path.
    /// </summary>
    public static IEndpointRouteBuilder MapPoEcosystemGalleryEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/ecosystem/gallery", async (EcosystemWorldStore store, CancellationToken ct, int top = 20) =>
                Results.Ok(await store.GalleryAsync(Math.Clamp(top, 1, 50), ct)))
            .WithName("PoEcosystemGallery")
            .WithTags("PoEcosystem")
            .Produces<EcoSharedWorld[]>()
            .AllowAnonymous()
            .RequireRateLimiting("leaderboard-read");

        app.MapGet("/api/ecosystem/gallery/{code}/data", async (string code, EcosystemWorldStore store, CancellationToken ct) =>
            {
                if (string.IsNullOrWhiteSpace(code) || code.Length > 16 || !code.All(char.IsAsciiLetterOrDigit)) return Results.BadRequest();
                var bytes = await store.LoadSharedAsync(code, ct);
                return bytes is null ? Results.NotFound() : Results.Bytes(bytes, "application/gzip");
            })
            .WithName("PoEcosystemGalleryData")
            .WithTags("PoEcosystem")
            .AllowAnonymous()
            .RequireRateLimiting("leaderboard-read");

        return app;
    }

    /// <summary>The stable id and display name of the caller, or null when there is no usable identity.</summary>
    private static RequestIdentity.Identity? Owner(HttpContext http)
    {
        var identity = RequestIdentity.Resolve(http.User);
        if (!string.IsNullOrEmpty(identity.UserId)) return identity;
        // A cookie session without a stable id (older dev logins): the display name is the
        // best partition there is, and it is at least the same one every visit.
        return string.IsNullOrEmpty(identity.DisplayName) ? null : identity with { UserId = "name:" + identity.DisplayName };
    }

    private static string CleanName(string? name, string fallback)
    {
        var chars = (name ?? string.Empty).Where(c => !char.IsControl(c)).Take(EcoWorldSlots.MaxNameChars).ToArray();
        var cleaned = new string(chars).Trim();
        return cleaned.Length == 0 ? fallback : cleaned;
    }

    /// <summary>Read a body up to a byte ceiling; null when the ceiling is passed.</summary>
    private static async Task<byte[]?> ReadBoundedAsync(Stream body, int max, CancellationToken ct)
    {
        using var ms = new MemoryStream();
        var buffer = new byte[64 * 1024];
        int read;
        while ((read = await body.ReadAsync(buffer, ct)) > 0)
        {
            if (ms.Length + read > max) return null;
            ms.Write(buffer, 0, read);
        }
        return ms.ToArray();
    }
}
