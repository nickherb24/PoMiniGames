using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Components.WebAssembly.Http;

using PoMiniGamesClient.Services.Auth;
using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGamesClient.Services.Http;

/// <summary>
/// Cross-origin credentials: the Blazor WASM <see cref="HttpClient"/> defaults
/// to <c>credentials: 'omit'</c> on the underlying browser fetch, which means
/// cross-origin requests (e.g. the standalone Blazor client on
/// <c>http://localhost:5261</c> calling the API on
/// <c>http://localhost:5000</c>) drop the auth cookie set by
/// <c>/api/auth/dev-login</c> and every subsequent protected endpoint returns
/// 401 "Requires an authenticated user".
///
/// This handler sets the WASM-native
/// <see cref="WebAssemblyHttpRequestMessageExtensions.SetBrowserRequestCredentials"/>
/// option on every outgoing request, restoring the same-origin behaviour for
/// cookie auth without callers needing to remember to set it per-request.
/// </summary>
/// <remarks>
/// Wired as a <see cref="DelegatingHandler"/> in the client HttpClient pipeline in
/// <c>Program.cs</c>: it sits above <c>HttpClientHandler</c> (which backs the WASM
/// browser fetch shim and must remain the innermost handler in the chain) and below
/// <see cref="TransientRetryHandler"/>. It is intentionally not registered as a primary
/// handler — that would replace the browser fetch shim and break all requests. This is
/// the code-level fallback for cross-origin cookie inclusion; the
/// <c>wwwroot/js/crossOriginFetchPatch.js</c> monkey-patch is the belt-and-braces
/// equivalent at the JS layer.
/// </remarks>
public sealed class IncludeCredentialsHandler : DelegatingHandler
{
    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        // Idempotent: SetBrowserRequestCredentials overwrites any prior value
        // stored under the same key, so calling it on every request is safe.
        request.SetBrowserRequestCredentials(BrowserRequestCredentials.Include);
        return base.SendAsync(request, cancellationToken);
    }
}
