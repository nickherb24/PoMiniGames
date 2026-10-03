using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.SignalR.Client;

using PoMiniGamesClient.Services.Auth;
using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGamesClient.Services.Http;

/// <summary>
/// The single construction path for every SignalR hub connection in the client.
/// Bakes in the two things every hub connection here must have:
/// <list type="bullet">
/// <item>SignalR's default HttpClientFactory doesn't flow through
/// DI, so the negotiate POST drops the dev cookie and the hub's
/// RequireAuthorization() returns 401. Every connection forces the credentials
/// handler (<see cref="SignalRCredentialsHttpClientFactory.CreateHandler"/>) so
/// the PoMiniGames.DevAuth cookie round-trips — see that class for the full
/// failure story.</item>
/// <item>Automatic reconnect, so a dropped WebSocket heals instead of leaving
/// the lobby/race dead.</item>
/// </list>
/// </summary>
public static class HubConnectionFactory
{
    /// <summary>
    /// Build a hub connection with the credentials handler and automatic
    /// reconnect applied.
    /// </summary>
    /// <param name="hubUrl">Absolute hub URL — compose via <see cref="ApiEndpoints.Hub"/>;
    /// SignalR does not honour the DI HttpClient BaseAddress (see <see cref="ApiEndpoints"/>).</param>
    /// <param name="transports">Optional transport restriction (e.g. FunQuiz's
    /// dev-box escape hatch that skips the slow WebSocket upgrade). Null keeps
    /// SignalR's default transport negotiation.</param>
    /// <param name="reconnectDelays">Optional custom reconnect backoff; null uses
    /// SignalR's default 0/2/10/30s schedule.</param>
    /// <summary>
    /// The Microsoft access token for the signed-in user, or null for a cookie session.
    /// Set alongside <see cref="ApiService.SetBearer"/>. Outside Dev/Test the server
    /// accepts bearer tokens only, so without this every authorized hub answers 401.
    /// </summary>
    public static string? BearerToken { get; set; }

    public static HubConnection Create(string hubUrl, HttpTransportType? transports = null, TimeSpan[]? reconnectDelays = null)
    {
        var builder = new HubConnectionBuilder()
            .WithUrl(hubUrl, options =>
            {
                options.HttpMessageHandlerFactory = SignalRCredentialsHttpClientFactory.CreateHandler;
                // Read per (re)connect, so a sign-in after the connection was built still applies.
                options.AccessTokenProvider = () => Task.FromResult(BearerToken);
                if (transports is { } restricted) options.Transports = restricted;
            })
            // PoBrawlOnline: the server-side hub protocol serialises
            // enums as camelCase strings via JsonStringEnumConverter (Program.cs
            // AddJsonProtocol). The SignalR client's default JSON uses numbers for
            // enums, so deserialising PoBrawlSide etc. fails with
            // "DeserializeUnableToConvertValue". Apply the same converter so the
            // client and server agree on the wire format for every hub the app uses.
            .AddJsonProtocol(options =>
            {
                options.PayloadSerializerOptions.Converters.Add(
                    new JsonStringEnumConverter(JsonNamingPolicy.CamelCase));
            });
        builder = reconnectDelays is null
            ? builder.WithAutomaticReconnect()
            : builder.WithAutomaticReconnect(reconnectDelays);
        return builder.Build();
    }
}
