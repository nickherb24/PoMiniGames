using System;
using System.Net;
using System.Net.Http;
using System.Net.Http.Json;
using System.Threading;
using System.Threading.Tasks;

using PoMiniGamesClient.Services.Auth;
using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGamesClient.Services.Http;

/// <summary>
/// CSRF: attaches the antiforgery request token to every state-changing call.
///
/// The server refuses POST/PUT/PATCH/DELETE on <c>/api/*</c> without a valid
/// <c>X-CSRF-TOKEN</c> header (see <c>AntiforgeryExtensions</c> on the host). This handler
/// makes that transparent to callers: the token is fetched lazily on the first unsafe
/// request and cached for the session.
/// </summary>
/// <remarks>
/// <para>
/// Pipeline position (outer → inner): <c>TransientRetryHandler</c> →
/// <b>AntiforgeryHandler</b> → <c>IncludeCredentialsHandler</c> → <c>HttpClientHandler</c>.
/// It must sit ABOVE IncludeCredentialsHandler so the token fetch it issues via
/// <see cref="DelegatingHandler.SendAsync"/> inherits credential inclusion — the paired
/// antiforgery cookie is set on that response and is worthless if the browser drops it.
/// Fetching through the inner chain (rather than a second <see cref="HttpClient"/>) is also
/// what keeps this from recursing back into itself.
/// </para>
/// <para>
/// The token is bound to the user's identity claims, so it is invalidated by sign-in and
/// sign-out. Rather than couple this handler to AuthStateService, a 403 carrying the
/// server's <c>antiforgery_validation_failed</c> marker triggers exactly one refresh and
/// replay. The marker matters: a bare 403 is a genuine authorization denial and replaying
/// it would turn one refusal into two.
/// </para>
/// </remarks>
public sealed class AntiforgeryHandler : DelegatingHandler
{
    private const string HeaderName = "X-CSRF-TOKEN";
    private const string TokenPath = "/api/auth/antiforgery-token";
    private const string FailureMarker = "antiforgery_validation_failed";

    // One in-flight fetch at a time. Without this, a page that fires several submits on
    // load would issue a token request per submit and race to overwrite _token.
    private readonly SemaphoreSlim _gate = new(1, 1);
    private string? _token;

    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        if (!RequiresToken(request))
        {
            return await base.SendAsync(request, cancellationToken);
        }

        // Buffer up front so the replay below has a body to send. A request's content
        // stream is consumed by the first send; re-sending the same HttpRequestMessage
        // would otherwise fail with "The request message was already sent" or an empty body.
        var body = request.Content is null
            ? null
            : await request.Content.ReadAsByteArrayAsync(cancellationToken);
        var contentType = request.Content?.Headers.ContentType;

        var token = await GetTokenAsync(request, cancellationToken);
        SetHeader(request, token);

        var response = await base.SendAsync(request, cancellationToken);

        if (!await IsAntiforgeryRejectionAsync(response, cancellationToken))
        {
            return response;
        }

        // Stale token (identity changed since it was minted). Drop it, mint a fresh one,
        // and replay once. Exactly once — a refreshed token that is still rejected means
        // something other than staleness, and looping would hammer the endpoint.
        response.Dispose();
        Invalidate(token);

        var refreshed = await GetTokenAsync(request, cancellationToken);
        using var replay = CloneWithBody(request, body, contentType);
        SetHeader(replay, refreshed);

        return await base.SendAsync(replay, cancellationToken);
    }

    private static bool RequiresToken(HttpRequestMessage request)
    {
        var method = request.Method;
        if (method != HttpMethod.Post
            && method != HttpMethod.Put
            && method != HttpMethod.Patch
            && method != HttpMethod.Delete)
        {
            return false;
        }

        // Mirror the server's scope exactly. Widening it here would attach the header to
        // SignalR negotiate posts, which the hub pipeline does not expect.
        var path = request.RequestUri is null
            ? string.Empty
            : (request.RequestUri.IsAbsoluteUri ? request.RequestUri.AbsolutePath : request.RequestUri.OriginalString);

        return path.StartsWith("/api/", StringComparison.OrdinalIgnoreCase)
            || path.Contains("/api/", StringComparison.OrdinalIgnoreCase);
    }

    private async Task<string?> GetTokenAsync(HttpRequestMessage sibling, CancellationToken cancellationToken)
    {
        var cached = _token;
        if (cached is not null) return cached;

        await _gate.WaitAsync(cancellationToken);
        try
        {
            // Re-check: another caller may have populated it while we waited on the gate.
            if (_token is not null) return _token;

            // Resolve the token URI against the request being sent, so this works whether
            // the client is same-origin (BaseAddress-relative) or standalone on :5261
            // pointing at the API on :5000.
            var uri = sibling.RequestUri is { IsAbsoluteUri: true } absolute
                ? new Uri(absolute, TokenPath)
                : new Uri(TokenPath, UriKind.Relative);

            using var tokenRequest = new HttpRequestMessage(HttpMethod.Get, uri);
            using var tokenResponse = await base.SendAsync(tokenRequest, cancellationToken);
            if (!tokenResponse.IsSuccessStatusCode) return null;

            var payload = await tokenResponse.Content
                .ReadFromJsonAsync(ApiJsonContext.Default.AntiforgeryTokenDto, cancellationToken);

            _token = string.IsNullOrEmpty(payload?.Token) ? null : payload!.Token;
            return _token;
        }
        catch (HttpRequestException)
        {
            // Offline, or the host is down. Return null and let the request go out
            // unstamped: it will fail on its own terms (and the offline score queue will
            // park it) rather than being swallowed here as a confusing CSRF error.
            return null;
        }
        finally
        {
            _gate.Release();
        }
    }

    // Compare-and-clear: only drop the cache if it still holds the token that was refused.
    // A blind clear would discard a good token a concurrent request had just fetched.
    private void Invalidate(string? refused)
    {
        if (refused is not null && _token == refused)
        {
            _token = null;
        }
    }

    private static void SetHeader(HttpRequestMessage request, string? token)
    {
        if (string.IsNullOrEmpty(token)) return;
        request.Headers.Remove(HeaderName);
        request.Headers.Add(HeaderName, token);
    }

    private static async Task<bool> IsAntiforgeryRejectionAsync(
        HttpResponseMessage response,
        CancellationToken cancellationToken)
    {
        if (response.StatusCode != HttpStatusCode.Forbidden) return false;

        var body = await response.Content.ReadAsStringAsync(cancellationToken);
        return body.Contains(FailureMarker, StringComparison.Ordinal);
    }

    private static HttpRequestMessage CloneWithBody(
        HttpRequestMessage original,
        byte[]? body,
        System.Net.Http.Headers.MediaTypeHeaderValue? contentType)
    {
        var clone = new HttpRequestMessage(original.Method, original.RequestUri);

        foreach (var header in original.Headers)
        {
            clone.Headers.TryAddWithoutValidation(header.Key, header.Value);
        }

        // Carry the WASM fetch options (credentials mode, etc.) across — they live in
        // Options, and a replay that loses them would be sent without the auth cookie.
        foreach (var option in original.Options)
        {
            clone.Options.TryAdd(option.Key, option.Value);
        }

        if (body is not null)
        {
            clone.Content = new ByteArrayContent(body);
            if (contentType is not null)
            {
                clone.Content.Headers.ContentType = contentType;
            }
        }

        return clone;
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _gate.Dispose();
        }
        base.Dispose(disposing);
    }
}

/// <summary>Payload of <c>GET /api/auth/antiforgery-token</c>.</summary>
public sealed record AntiforgeryTokenDto(string Token, string HeaderName);
