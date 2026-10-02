using System.Net.Http;

using PoMiniGamesClient.Services.Auth;
using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGamesClient.Services.Http;

/// <summary>
/// SignalR credentials pass-through handler factory.
///
/// <see cref="Microsoft.AspNetCore.SignalR.Client.HubConnectionBuilder"/> with the
/// string-only <c>WithUrl(string)</c> overload constructs its own internal
/// <see cref="HttpClient"/> for the negotiate POST. That HttpClient is created via
/// <c>HttpConnectionOptions.DefaultHttpClientFactory</c>, which is a plain
/// <c>new HttpClient()</c> — it does NOT flow through the DI pipeline, so the
/// <see cref="IncludeCredentialsHandler"/> that protects every other authenticated
/// request in the app never wraps it.
///
/// On the dev auth flow that means the <c>PoMiniGames.DevAuth</c> cookie minted by
/// <c>/api/auth/dev-login</c> (the silent Guest sign-in fired by <c>AuthGate</c>
/// on demo routes) is dropped on the negotiate POST. The hub endpoints have
/// <c>.RequireAuthorization()</c> applied at mapping time
/// (<c>Infrastructure/EndpointRouteExtensions.cs</c>), so the server returns
/// <c>401 Unauthorized</c>, <c>HubConnection.StartAsync()</c> throws an
/// <see cref="HttpRequestException"/>, and the user sees
/// <c>"Demo unavailable: net::http_message_not_success_statuscode_reason.401. Unauthorized"</c>
/// on <c>/poracer/demo</c> (and every other SignalR-driven multiplayer flow).
///
/// Fix: assign <see cref="CreateHandler"/> to
/// <c>HttpConnectionOptions.HttpMessageHandlerFactory</c> on every
/// <c>HubConnectionBuilder.WithUrl(url, options =&gt; …)</c> call so the negotiate
/// request goes out through the same <see cref="IncludeCredentialsHandler"/> chain
/// the DI <see cref="HttpClient"/> uses. Without this, the only way to play a
/// multiplayer game (or the demo) is to be a fully-authenticated Entra ID user —
/// defeating the Guest / dev-login attraction loop.
/// <see cref="HubConnectionFactory.Create"/> is the one place that wiring
/// happens — every client hub connection is built through it.
///
/// The handler chain mirrors the DI HttpClient registered in <c>Program.cs</c>:
///   <c>IncludeCredentialsHandler → HttpClientHandler</c>.
/// <see cref="TransientRetryHandler"/> is intentionally omitted — SignalR negotiates
/// only on connect (single POST) and handles its own transport reconnects; wrapping
/// it adds nothing.
///
/// Used by <see cref="HubConnectionFactory"/>, the single construction path for
/// every SignalR hub connection in the client.
/// </summary>
public static class SignalRCredentialsHttpClientFactory
{
    /// <summary>
    /// <see cref="Microsoft.AspNetCore.Http.Connections.Client.HttpConnectionOptions.HttpMessageHandlerFactory"/>
    /// is typed as <c>Func&lt;HttpMessageHandler, HttpMessageHandler&gt;</c> — it
    /// supplies the default inner handler (a fresh <see cref="HttpClientHandler"/>
    /// backed by the WASM browser fetch shim) and we return a delegating chain
    /// that forces <c>credentials: 'include'</c>. SignalR owns the outer
    /// <see cref="HttpClient"/> and disposes the returned handler with the
    /// <see cref="Microsoft.AspNetCore.SignalR.Client.HubConnection"/>.
    /// </summary>
    public static HttpMessageHandler CreateHandler(HttpMessageHandler innerHandler) => new IncludeCredentialsHandler
    {
        InnerHandler = innerHandler
    };
}
