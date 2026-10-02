using System.Net.Http.Json;
using System.Text.Json.Serialization;

namespace PoMiniGames.TestUtilities;

/// <summary>
/// Arms an <see cref="HttpClient"/> with the antiforgery token every
/// state-changing <c>/api/*</c> call requires.
/// </summary>
/// <remarks>
/// <para>
/// Tests deliberately go through the real token exchange rather than disabling
/// antiforgery for the Test environment. An exemption would mean the entire test suite
/// runs against a pipeline that does not exist in production, and the one control most
/// likely to break a working client (a missing or stale token) would never be exercised.
/// </para>
/// <para>
/// Relies on <c>WebApplicationFactoryClientOptions.HandleCookies</c> (true by default):
/// the GET below sets the paired antiforgery cookie in the client's cookie container, and
/// the header set here is validated against it. Call this AFTER authenticating the client,
/// because the token is bound to the caller's identity claims — arming an anonymous client
/// and then signing it in yields a token the server will reject.
/// </para>
/// </remarks>
public static class AntiforgeryTestExtensions
{
    private const string HeaderName = "X-CSRF-TOKEN";
    private const string TokenPath = "/api/auth/antiforgery-token";

    /// <summary>
    /// Fetches a request token and pins it as a default header on <paramref name="client"/>.
    /// Idempotent — re-arming after a sign-in swaps the stale token for a current one.
    /// </summary>
    public static async Task<HttpClient> ArmAntiforgeryAsync(this HttpClient client)
    {
        var response = await client.GetAsync(TokenPath);
        response.EnsureSuccessStatusCode();

        var payload = await response.Content.ReadFromJsonAsync<AntiforgeryTokenPayload>();
        if (payload is null || string.IsNullOrEmpty(payload.Token))
        {
            throw new InvalidOperationException(
                $"GET {TokenPath} returned no antiforgery token. The endpoint must be mapped " +
                "and anonymous for state-changing test requests to be possible.");
        }

        // Remove first: DefaultRequestHeaders.Add appends, so re-arming without this would
        // send two comma-joined tokens and fail validation.
        client.DefaultRequestHeaders.Remove(HeaderName);
        client.DefaultRequestHeaders.Add(HeaderName, payload.Token);

        return client;
    }

    private sealed record AntiforgeryTokenPayload(
        [property: JsonPropertyName("token")] string Token,
        [property: JsonPropertyName("headerName")] string HeaderName);
}
