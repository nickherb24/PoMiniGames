using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using PoMiniGames.Features.Health;
using PoMiniGames.Features.Invites;
using PoMiniGames.TestUtilities;

namespace PoMiniGames.E2EAPI;

/// <summary>
/// 2026-10-01: the two surfaces added together, in the one method this tier has room for.
/// <list type="bullet">
/// <item>The browser error sink (<c>POST /client-errors</c>) is anonymous and sits outside the
/// antiforgery scope, so what bounds it is asserted here: a small body, a non-empty message.</item>
/// <item>Invites are inside the authenticated group (401 for an anonymous caller, never a 403 that
/// would say the route exists), only write links to this app's own lobbies, and only reach people
/// the caller has played.</item>
/// <item>The push sender POSTs to an address a subscriber supplied, so the host allowlist is the
/// security boundary; and its VAPID token is hand-built, so its signature is checked against the
/// key that is supposed to have made it.</item>
/// </list>
/// </summary>
[Collection(PoMiniGamesE2ECollection.Name)]
public class InviteAndClientErrorContractTests
{
    private readonly PoMiniGamesE2EFixture _factory;

    public InviteAndClientErrorContractTests(PoMiniGamesE2EFixture factory)
    {
        _factory = factory;
    }

    [Fact]
    public async Task InviteAndErrorSurfaces_HoldTheirContracts()
    {
        using var client = _factory.CreateClient();

        // ── Error sink: anonymous, no antiforgery token, bounded ──────────
        (await PostJsonAsync(client, ClientErrorEndpoints.Route, """{"kind":"error","message":"boom\nforged line","path":"/x"}"""))
            .Should().Be(HttpStatusCode.NoContent);
        (await PostJsonAsync(client, ClientErrorEndpoints.Route, """{"kind":"error","message":"  "}"""))
            .Should().Be(HttpStatusCode.BadRequest, "a report with nothing to say is not logged");
        (await PostJsonAsync(client, ClientErrorEndpoints.Route, "not json"))
            .Should().Be(HttpStatusCode.BadRequest);
        (await PostJsonAsync(client, ClientErrorEndpoints.Route,
                $$"""{"message":"{{new string('x', ClientErrorEndpoints.MaxBodyBytes)}}"}"""))
            .Should().Be(HttpStatusCode.RequestEntityTooLarge);

        // ── Invites: anonymous callers learn nothing ─────────────────────
        foreach (var (method, path) in new[]
                 {
                     ("GET", "/api/push/key"), ("POST", "/api/push/subscriptions"), ("POST", "/api/invites"),
                     ("GET", "/api/invites/pending"), ("GET", "/api/invites/qr?game=poracer"),
                 })
        {
            using var request = new HttpRequestMessage(new HttpMethod(method), path);
            if (method == "POST") request.Content = new StringContent("{}", Encoding.UTF8, "application/json");
            using var response = await client.SendAsync(request);
            response.StatusCode.Should().Be(HttpStatusCode.Unauthorized, $"{method} {path} is behind the auth gate");
        }

        // ── Invites: a signed-in guest ───────────────────────────────────
        var login = await client.GetAsync($"/auth/login/fake?displayName=Invite{Guid.NewGuid().ToString("N")[..8]}");
        login.IsSuccessStatusCode.Should().BeTrue("guest login must succeed under the Test environment");
        await client.ArmAntiforgeryAsync();

        using (var qr = await client.GetAsync("/api/invites/qr?game=poracer"))
        {
            qr.StatusCode.Should().Be(HttpStatusCode.OK);
            qr.Content.Headers.ContentType?.MediaType.Should().Be("image/svg+xml");
            (await qr.Content.ReadAsStringAsync()).Should().StartWith("<svg").And.Contain("<path");
        }
        (await client.GetAsync("/api/invites/qr?game=evil.example")).StatusCode
            .Should().Be(HttpStatusCode.BadRequest, "a QR code is only drawn for this app's own lobbies");

        (await PostJsonAsync(client, "/api/invites", """{"owner":"x","opponentName":"Somebody","game":"evil"}"""))
            .Should().Be(HttpStatusCode.BadRequest);
        (await PostJsonAsync(client, "/api/invites", """{"owner":"x","opponentName":"Somebody Never Met","game":"poracer"}"""))
            .Should().Be(HttpStatusCode.Forbidden, "an invite only goes to someone in the caller's own online match history");
        (await PostJsonAsync(client, "/api/push/subscriptions", """{"endpoint":"https://169.254.169.254/latest/meta-data"}"""))
            .Should().Be(HttpStatusCode.BadRequest, "the server never stores an address it would refuse to POST to");

        // ── Push sender: where it will POST ──────────────────────────────
        WebPushSender.IsAllowedEndpoint("https://fcm.googleapis.com/fcm/send/abc").Should().BeTrue();
        WebPushSender.IsAllowedEndpoint("https://updates.push.services.mozilla.com/wpush/v2/abc").Should().BeTrue();
        WebPushSender.IsAllowedEndpoint("https://web.push.apple.com/abc").Should().BeTrue();
        WebPushSender.IsAllowedEndpoint("https://wns2-by3p.notify.windows.com/w/?token=abc").Should().BeTrue();
        WebPushSender.IsAllowedEndpoint("http://fcm.googleapis.com/fcm/send/abc").Should().BeFalse("https only");
        WebPushSender.IsAllowedEndpoint("https://fcm.googleapis.com.evil.example/x").Should().BeFalse();
        WebPushSender.IsAllowedEndpoint("https://evilpush.apple.com/x").Should().BeFalse("a suffix match must start at a label");
        WebPushSender.IsAllowedEndpoint("https://localhost/x").Should().BeFalse();
        WebPushSender.IsAllowedEndpoint(null).Should().BeFalse();

        // ── Push sender: the VAPID token verifies against its own key ────
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var keys = new VapidKeys("unused", key.ExportPkcs8PrivateKey());
        var now = DateTimeOffset.UtcNow;
        var token = WebPushSender.BuildToken(keys, "https://fcm.googleapis.com", "https://example.test", now).Split('.');

        token.Should().HaveCount(3);
        key.VerifyData(Encoding.ASCII.GetBytes($"{token[0]}.{token[1]}"), FromBase64Url(token[2]),
                HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation)
            .Should().BeTrue("a push service rejects a token it cannot verify with the subscription's key");
        using var claims = JsonDocument.Parse(FromBase64Url(token[1]));
        claims.RootElement.GetProperty("aud").GetString().Should().Be("https://fcm.googleapis.com");
        claims.RootElement.GetProperty("sub").GetString().Should().Be("https://example.test");
        claims.RootElement.GetProperty("exp").GetInt64().Should()
            .BeInRange(now.ToUnixTimeSeconds() + 60, now.AddHours(24).ToUnixTimeSeconds(), "push services cap a token at 24 hours");
    }

    private static async Task<HttpStatusCode> PostJsonAsync(HttpClient client, string path, string json)
    {
        using var response = await client.PostAsync(path, new StringContent(json, Encoding.UTF8, "application/json"));
        return response.StatusCode;
    }

    private static byte[] FromBase64Url(string value)
    {
        var base64 = value.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(base64.PadRight(base64.Length + (4 - base64.Length % 4) % 4, '='));
    }
}
