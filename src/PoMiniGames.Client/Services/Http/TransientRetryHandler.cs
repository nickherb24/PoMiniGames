using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;

using PoMiniGamesClient.Services.Auth;
using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGamesClient.Services.Http;

/// <summary>
/// Client resilience: a dependency-free retry/backoff <see cref="DelegatingHandler"/> for
/// transient failures. Blazor WASM cannot use the full transport handler stack (no
/// SocketsHttpHandler / Polly transport pipeline), so this is a hand-rolled equivalent
/// wired directly into the client <see cref="HttpClient"/> pipeline in <c>Program.cs</c>.
///
/// Deliberately conservative:
///   • only <see cref="HttpMethod.Get"/> is replayed — retrying a POST/PUT/PATCH/DELETE
///     could duplicate a write, so non-idempotent methods pass straight through.
///   • retries up to 3 attempts on <see cref="HttpRequestException"/> (transport blip) or a
///     5xx / 408 response, with exponential backoff (200ms → 400ms → 800ms).
///   • a sent <see cref="HttpRequestMessage"/> cannot be re-sent, so each replay goes out on
///     a shallow clone that preserves headers and the WASM browser fetch options
///     (e.g. the credentials mode set by <see cref="IncludeCredentialsHandler"/>).
/// </summary>
public sealed class TransientRetryHandler : DelegatingHandler
{
    private const int MaxAttempts = 3;

    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        // Only idempotent GETs are safe to replay; everything else is passed through as-is.
        if (request.Method != HttpMethod.Get)
        {
            return await base.SendAsync(request, cancellationToken);
        }

        for (var attempt = 1; ; attempt++)
        {
            var isLastAttempt = attempt >= MaxAttempts;
            try
            {
                // The original message can only be sent once; replays use a clone.
                var response = await base.SendAsync(
                    attempt == 1 ? request : CloneRequest(request), cancellationToken);

                if (isLastAttempt || !IsTransientStatus(response.StatusCode))
                {
                    return response;
                }

                response.Dispose();
            }
            catch (HttpRequestException) when (!isLastAttempt && !cancellationToken.IsCancellationRequested)
            {
                // Transient transport failure (connection reset, CORS-preflight blip, …):
                // swallow, back off, and try again. On the last attempt the exception
                // propagates because this filter no longer matches.
            }

            // Exponential backoff: 200ms, 400ms, 800ms …
            await Task.Delay(BackoffFor(attempt), cancellationToken);
        }
    }

    private static bool IsTransientStatus(HttpStatusCode status) =>
        (int)status >= 500 || status == HttpStatusCode.RequestTimeout;

    private static TimeSpan BackoffFor(int attempt) =>
        TimeSpan.FromMilliseconds(200 * Math.Pow(2, attempt - 1));

    /// <summary>
    /// Shallow-clone a GET request so it can be re-sent. GETs carry no body, so only the
    /// method, URI, version, headers, and the WASM fetch options (credentials mode) are
    /// copied — the last of these keeps cross-origin cookie auth working across retries.
    /// </summary>
    private static HttpRequestMessage CloneRequest(HttpRequestMessage request)
    {
        var clone = new HttpRequestMessage(request.Method, request.RequestUri)
        {
            Version = request.Version
        };

        foreach (var header in request.Headers)
        {
            clone.Headers.TryAddWithoutValidation(header.Key, header.Value);
        }

        foreach (var option in (IEnumerable<KeyValuePair<string, object?>>)request.Options)
        {
            ((IDictionary<string, object?>)clone.Options)[option.Key] = option.Value;
        }

        return clone;
    }
}
