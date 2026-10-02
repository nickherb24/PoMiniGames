using System.Text;
using PoMiniGames.Features.Auth;
using PoMiniGames.Features.Integrity;
using PoMiniGames.Features.MatchHistory;
using QRCoder;

namespace PoMiniGames.Features.Invites;

/// <summary>A browser's push subscription. Only the endpoint: pushes carry no payload, so no keys are needed.</summary>
public sealed record PushSubscriptionRequest(string? Endpoint);

/// <param name="Owner">The caller's match-history name. Used for guests only; a signed-in caller's comes from the claims.</param>
/// <param name="OpponentName">The person to invite, as their name appears in the caller's head-to-head list.</param>
/// <param name="Game">Route slug of the game, e.g. <c>poracer</c>.</param>
public sealed record InviteRequest(string? Owner, string? OpponentName, string? Game);

/// <param name="Sent">Devices the wake-up reached. Zero means the person has not turned invites on.</param>
public sealed record InviteResult(int Sent);

public sealed record PushKeyResponse(string Key);

/// <summary>
/// Game invites: a push to someone you have played, and a QR code for the lobby you are in.
/// </summary>
/// <remarks>
/// <para>
/// <b>The server writes every word and every link.</b> A caller names a person and a game; the
/// notification text and its URL are built here from <see cref="OnlineGames"/>, so an invite can
/// only ever say "X invites you to play Y" and can only ever open this app's own lobby for Y.
/// </para>
/// <para>
/// <b>You can only invite people you have met.</b> The recipient must appear as an online
/// opponent in the caller's own match history, and must have turned invites on from their own
/// device. Together with the <c>invites</c> rate limit that keeps this from being a way to
/// notify strangers.
/// </para>
/// </remarks>
public static class InviteEndpoints
{
    /// <summary>
    /// Games with an online lobby at <c>/{slug}/multi</c>, and the name an invite calls them
    /// (the titles the client's <c>GameCatalog</c> shows on the hub). The allowlist for every
    /// link this slice writes.
    /// </summary>
    internal static readonly IReadOnlyDictionary<string, string> OnlineGames =
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["connectfive"] = "Connect Five",
            ["tictactoe"] = "Tic-Tac-Toe",
            ["couplequiz"] = "Couple Quiz",
            ["funquiz"] = "Fun Quiz",
            ["pobrawl"] = "Brawl",
            ["pocabinet"] = "Cabinet",
            ["pomarblerace"] = "Marble Race",
            ["poracer"] = "Racer",
            ["posports"] = "Sports",
            ["povoxelstrike"] = "Voxel Strike",
        };

    public static IEndpointRouteBuilder MapInviteEndpoints(this IEndpointRouteBuilder app)
    {
        var push = app.MapGroup("/push").WithTags("Invites");

        push.MapGet("/key", async (InviteStore store, CancellationToken ct) =>
                await store.GetVapidKeysAsync(ct) is { } keys
                    ? Results.Ok(new PushKeyResponse(keys.PublicKey))
                    : Results.Problem("Invites are unavailable right now.", statusCode: StatusCodes.Status503ServiceUnavailable))
            .WithName("GetPushKey")
            .WithSummary("The public key a browser subscribes to push with");

        push.MapPost("/subscriptions", async (PushSubscriptionRequest request, HttpContext http, InviteStore store,
                ScoreIntegrityGuard integrity, CancellationToken ct) =>
            {
                if (!WebPushSender.IsAllowedEndpoint(request.Endpoint))
                    return Results.BadRequest(new { error = "Not a push service endpoint" });
                if (Addressee(http, integrity) is not { } me)
                    return Results.BadRequest(new { error = "A display name is required to receive invites" });

                return await store.SubscribeAsync(me, request.Endpoint!, ct)
                    ? Results.NoContent()
                    : Results.Problem("Invites are unavailable right now.", statusCode: StatusCodes.Status503ServiceUnavailable);
            })
            .WithName("SubscribeToPush")
            .WithSummary("Turn game invites on for this device")
            .RequireRateLimiting("invites");

        push.MapPost("/unsubscribe", async (PushSubscriptionRequest request, HttpContext http, InviteStore store,
                ScoreIntegrityGuard integrity, CancellationToken ct) =>
            {
                if (Addressee(http, integrity) is { } me && !string.IsNullOrEmpty(request.Endpoint))
                    await store.UnsubscribeAsync(me, request.Endpoint, ct);
                return Results.NoContent();
            })
            .WithName("UnsubscribeFromPush")
            .WithSummary("Turn game invites off for this device")
            .RequireRateLimiting("invites");

        var invites = app.MapGroup("/invites").WithTags("Invites");

        invites.MapPost("", async (InviteRequest request, HttpContext http, InviteStore store, WebPushSender sender,
                MatchHistoryRepository matches, ScoreIntegrityGuard integrity, CancellationToken ct) =>
            {
                if (!OnlineGames.TryGetValue(request.Game ?? "", out var title))
                    return Results.BadRequest(new { error = "Unknown game" });
                if (string.IsNullOrWhiteSpace(request.OpponentName))
                    return Results.BadRequest(new { error = "OpponentName is required" });

                var identity = RequestIdentity.Resolve(http.User);
                var owner = MatchHistoryEndpoints.ResolveOwner(identity, request.Owner, integrity);
                // The same moderation the match-history write applied, so the name compares
                // equal to the row it was read from.
                var opponent = integrity.ResolveDisplayName(request.OpponentName, "Opponent");

                var history = string.IsNullOrWhiteSpace(owner) ? [] : await matches.GetForOwnerAsync(owner, 1000, ct);
                if (!history.Any(m => m.Mode != "local-2p"
                                      && string.Equals(m.OpponentName, opponent, StringComparison.OrdinalIgnoreCase)))
                {
                    return Results.Problem("You can only invite players you have met online.",
                        statusCode: StatusCodes.Status403Forbidden);
                }

                var keys = await store.GetVapidKeysAsync(ct);
                var endpoints = keys is null ? [] : await store.GetEndpointsAsync(opponent, ct);
                if (keys is null || endpoints.Count == 0) return Results.Ok(new InviteResult(0));

                var slug = request.Game!.ToLowerInvariant();
                var from = integrity.ResolveDisplayName(identity.DisplayName, "A player");
                await store.AddInviteAsync(opponent,
                    new PendingInvite(from, slug, title, $"/{slug}/multi", DateTimeOffset.UtcNow), ct);

                var sent = 0;
                foreach (var endpoint in endpoints)
                {
                    var outcome = await sender.SendAsync(endpoint, keys, Contact(http), ct);
                    if (outcome == PushOutcome.Sent) sent++;
                    else if (outcome == PushOutcome.Gone) await store.UnsubscribeAsync(opponent, endpoint, ct);
                }
                return Results.Ok(new InviteResult(sent));
            })
            .WithName("SendInvite")
            .WithSummary("Invite a player you have met to an online lobby")
            .Produces<InviteResult>()
            .RequireRateLimiting("invites");

        // Read by the service worker when a wake-up push arrives, on the player's own cookie.
        invites.MapGet("/pending", async (HttpContext http, InviteStore store, ScoreIntegrityGuard integrity, CancellationToken ct) =>
                Results.Ok(Addressee(http, integrity) is { } me ? await store.GetPendingAsync(me, ct) : []))
            .WithName("GetPendingInvites")
            .WithSummary("Invites sent to the caller in the last ten minutes")
            .Produces<IEnumerable<PendingInvite>>();

        invites.MapGet("/qr", (string? game, HttpContext http) =>
            {
                if (!OnlineGames.ContainsKey(game ?? "")) return Results.BadRequest(new { error = "Unknown game" });
                http.Response.Headers.CacheControl = "private, max-age=3600";
                return Results.Text(
                    QrSvg($"{http.Request.Scheme}://{http.Request.Host}/{game!.ToLowerInvariant()}/multi"), "image/svg+xml");
            })
            .WithName("GetInviteQr")
            .WithSummary("A QR code for a game's online lobby on this host");

        return app;
    }

    /// <summary>
    /// The name invites to the caller are filed under: their claim display name, moderated the way
    /// a lobby shows it, because that is what an opponent's head-to-head row recorded. Null when
    /// the caller has no name to be addressed by.
    /// </summary>
    private static string? Addressee(HttpContext http, ScoreIntegrityGuard integrity)
    {
        var name = RequestIdentity.Resolve(http.User).DisplayName;
        return string.IsNullOrWhiteSpace(name) ? null : integrity.ResolveDisplayName(name, "Player");
    }

    /// <summary>
    /// The VAPID contact. Push services want a mailto: or an https URL to reach the sender at;
    /// this site's own origin is the honest answer, and a local http host gets a placeholder.
    /// </summary>
    private static string Contact(HttpContext http) =>
        http.Request.IsHttps ? $"https://{http.Request.Host}" : "mailto:dev@localhost";

    /// <summary>One black path on white. Not themed: a scanner needs the contrast, whatever the page looks like.</summary>
    internal static string QrSvg(string text)
    {
        using var generator = new QRCodeGenerator();
        using var data = generator.CreateQrCode(text, QRCodeGenerator.ECCLevel.M);
        var size = data.ModuleMatrix.Count;
        var path = new StringBuilder();
        for (var y = 0; y < size; y++)
            for (var x = 0; x < size; x++)
                if (data.ModuleMatrix[y][x]) path.Append($"M{x} {y}h1v1h-1z");

        return $"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {size} {size}\" shape-rendering=\"crispEdges\">"
             + $"<rect width=\"{size}\" height=\"{size}\" fill=\"#fff\"/><path fill=\"#000\" d=\"{path}\"/></svg>";
    }
}
