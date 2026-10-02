using PoMiniGames.Domain.Abstractions;
using PoMiniGames.Domain.Models;
using PoMiniGames.Features.Auth;
using PoMiniGames.Features.Integrity;

namespace PoMiniGames.Features.Account;

/// <summary>
/// Endpoints for the competitive dynamic player license card and global online MMR rating.
/// Supports both JSON DTO payload and raw vector SVG (image/svg+xml) rendering for
/// external embedding (e.g. GitHub profile READMEs, blog widgets, or chat embeds).
/// </summary>
public static class PlayerCardEndpoints
{
    public static void MapPlayerCardEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/player/card").WithTags("PlayerCard");

        // JSON DTO — reads authoritative player card
        group.MapGet("", async (
            string? name,
            HttpContext http,
            IStorageService storage,
            ScoreIntegrityGuard integrity,
            CancellationToken ct) =>
        {
            var identity = RequestIdentity.Resolve(http.User);
            var isGuest = identity.IsGuest;
            var owner = !string.IsNullOrWhiteSpace(identity.UserId) ? identity.UserId : (name ?? identity.DisplayName ?? "Guest");
            var displayName = !string.IsNullOrWhiteSpace(identity.DisplayName) ? identity.DisplayName : (name ?? "Guest");

            if (!string.IsNullOrWhiteSpace(name) && !string.Equals(name, identity.DisplayName, StringComparison.OrdinalIgnoreCase))
            {
                // Reading another player or explicit guest name
                owner = integrity.ResolveDisplayName(name, "Guest");
                displayName = owner;
                isGuest = true;
            }

            var card = await storage.GetPlayerCardAsync(owner, displayName, isGuest, ct);
            return Results.Ok(card);
        })
        .WithName("GetPlayerCard")
        .WithSummary("Retrieve a player's competitive card data (MMR, tier, form, stats)")
        .Produces<PlayerCardDto>(StatusCodes.Status200OK)
        .RequireRateLimiting("leaderboard-read");

        // Raw SVG — directly embeddable image
        group.MapGet("/svg", async (
            string? name,
            HttpContext http,
            IStorageService storage,
            ScoreIntegrityGuard integrity,
            CancellationToken ct) =>
        {
            var identity = RequestIdentity.Resolve(http.User);
            var isGuest = identity.IsGuest;
            var owner = !string.IsNullOrWhiteSpace(identity.UserId) ? identity.UserId : (name ?? identity.DisplayName ?? "Guest");
            var displayName = !string.IsNullOrWhiteSpace(identity.DisplayName) ? identity.DisplayName : (name ?? "Guest");

            if (!string.IsNullOrWhiteSpace(name) && !string.Equals(name, identity.DisplayName, StringComparison.OrdinalIgnoreCase))
            {
                owner = integrity.ResolveDisplayName(name, "Guest");
                displayName = owner;
                isGuest = true;
            }

            var card = await storage.GetPlayerCardAsync(owner, displayName, isGuest, ct);
            var svg = PlayerCardSvgGenerator.Generate(card);
            return Results.Content(svg, "image/svg+xml; charset=utf-8");
        })
        .WithName("GetPlayerCardSvg")
        .WithSummary("Retrieve dynamic vector SVG player card image for embedding")
        .Produces(StatusCodes.Status200OK, contentType: "image/svg+xml")
        .RequireRateLimiting("leaderboard-read");
    }
}

