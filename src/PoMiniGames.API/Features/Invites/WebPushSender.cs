using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace PoMiniGames.Features.Invites;

/// <summary>What the push service said about one delivery attempt.</summary>
public enum PushOutcome
{
    Sent,
    /// <summary>The subscription no longer exists (404/410). Its row should be deleted.</summary>
    Gone,
    Failed,
}

/// <summary>
/// Sends a Web Push message with no payload: a wake-up, signed with the server's VAPID key.
/// </summary>
/// <remarks>
/// <para>
/// <b>No payload, on purpose.</b> A push with a body has to be encrypted to the subscription
/// (ECDH + HKDF + AES-GCM, RFC 8291), which is either a new dependency or hand-rolled
/// cryptography. A push without one needs only the VAPID signature (RFC 8292), which is one
/// ES256 JWT from the standard library. The service worker (<c>js/pushWorker.js</c>) answers the
/// wake-up by fetching <c>/api/invites/pending</c> with the player's own cookie and shows what it
/// finds. That also means the push service never carries who invited whom.
/// </para>
/// <para>
/// <b>The endpoint is the subscriber's word</b>, and this class POSTs to it, so it is checked
/// against the hosts of the real push services before it is stored and again before every send
/// (<see cref="IsAllowedEndpoint"/>), and redirects are not followed. Without that the endpoint
/// would be a way to make this server issue requests to an address of the caller's choosing.
/// </para>
/// </remarks>
public sealed class WebPushSender(HttpClient http, ILogger<WebPushSender> logger)
{
    // The push services browsers actually hand out: Chrome/Edge-on-FCM, Firefox, Edge/Windows, Safari.
    private static readonly string[] AllowedHosts =
        ["fcm.googleapis.com", ".push.services.mozilla.com", ".notify.windows.com", ".push.apple.com"];

    private static readonly TimeSpan TokenLifetime = TimeSpan.FromHours(12);

    /// <summary>True for an https URL on one of the known push services.</summary>
    public static bool IsAllowedEndpoint(string? endpoint) =>
        endpoint is { Length: > 0 and <= 1024 }
        && Uri.TryCreate(endpoint, UriKind.Absolute, out var uri)
        && uri.Scheme == Uri.UriSchemeHttps
        && AllowedHosts.Any(h => h[0] == '.'
            ? uri.Host.EndsWith(h, StringComparison.OrdinalIgnoreCase)
            : uri.Host.Equals(h, StringComparison.OrdinalIgnoreCase));

    /// <param name="subject">Contact for the push service: a <c>mailto:</c> or https URL (this site's origin).</param>
    public async Task<PushOutcome> SendAsync(string endpoint, VapidKeys keys, string subject, CancellationToken ct = default)
    {
        if (!IsAllowedEndpoint(endpoint)) return PushOutcome.Gone;
        try
        {
            var uri = new Uri(endpoint);
            using var request = new HttpRequestMessage(HttpMethod.Post, uri);
            request.Headers.TryAddWithoutValidation(
                "Authorization", $"vapid t={BuildToken(keys, uri.GetLeftPart(UriPartial.Authority), subject, DateTimeOffset.UtcNow)}, k={keys.PublicKey}");
            // How long the service may hold the wake-up for an offline device: an invite is
            // only worth showing while the lobby it points at is still likely to be open.
            request.Headers.TryAddWithoutValidation("TTL", ((int)InviteStore.InviteLifetime.TotalSeconds).ToString());
            request.Headers.TryAddWithoutValidation("Urgency", "high");
            request.Content = new ByteArrayContent([]);

            using var response = await http.SendAsync(request, ct);
            if (response.IsSuccessStatusCode) return PushOutcome.Sent;
            if ((int)response.StatusCode is 404 or 410) return PushOutcome.Gone;

            logger.LogWarning("Push service {Host} answered {Status}.", uri.Host, (int)response.StatusCode);
            return PushOutcome.Failed;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            logger.LogWarning(ex, "Push delivery failed.");
            return PushOutcome.Failed;
        }
    }

    /// <summary>The VAPID JWT (RFC 8292): ES256 over <c>{aud, exp, sub}</c>, signed with the server's key.</summary>
    public static string BuildToken(VapidKeys keys, string audience, string subject, DateTimeOffset now)
    {
        var header = Encode("""{"typ":"JWT","alg":"ES256"}""");
        var claims = Encode(JsonSerializer.Serialize(new Dictionary<string, object>
        {
            ["aud"] = audience,
            ["exp"] = now.Add(TokenLifetime).ToUnixTimeSeconds(),
            ["sub"] = subject,
        }));
        var signingInput = $"{header}.{claims}";

        using var key = ECDsa.Create();
        key.ImportPkcs8PrivateKey(keys.PrivateKeyPkcs8, out _);
        // JWS wants the raw r||s pair, not the DER structure SignData produces by default.
        var signature = key.SignData(Encoding.ASCII.GetBytes(signingInput), HashAlgorithmName.SHA256,
            DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        return $"{signingInput}.{InviteStore.Base64Url(signature)}";
    }

    private static string Encode(string json) => InviteStore.Base64Url(Encoding.UTF8.GetBytes(json));
}
