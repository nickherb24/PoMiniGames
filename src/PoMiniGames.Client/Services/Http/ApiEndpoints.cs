using Microsoft.AspNetCore.Components.WebAssembly.Hosting;

using PoMiniGamesClient.Services.Auth;
using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGamesClient.Services.Http;

/// <summary>
/// Absolute API endpoints — single source of truth for the base URL every
/// cross-origin transport (HttpClient, SignalR, fetch, third-party SDKs)
/// should target.
///
/// Most of the app uses the DI-registered <see cref="System.Net.Http.HttpClient"/>
/// (which already has <c>BaseAddress</c> set from <c>appsettings.Development.json</c>
/// or the served origin), but SignalR <c>HubConnectionBuilder.WithUrl(string)</c>
/// does NOT honour that — it builds a URL string from the
/// <c>NavigationManager.BaseUri</c> when given a relative path, which on the
/// standalone client is the WASM host (e.g. :5261), not the API (e.g. :5000).
/// The hubs live on the API host, so SignalR must be given an absolute URL.
///
/// The DI-injected <see cref="IConfiguration"/> is resolved at construction
/// time; the resolved base ends with a trailing slash so callers can append
/// hub paths directly (e.g. <c>Endpoints.ApiBase + "poracer/lobby-hub"</c>).
/// </summary>
public sealed class ApiEndpoints
{
    private readonly string _base;

    public ApiEndpoints(IConfiguration configuration, IWebAssemblyHostEnvironment env)
    {
        var fromConfig =
            configuration["PoMiniGames:ApiBaseAddress"]
            ?? configuration["ApiBaseAddress"];

        if (!string.IsNullOrWhiteSpace(fromConfig))
        {
            _base = fromConfig.TrimEnd('/') + "/";
        }
        else
        {
            // Same-origin fallback (production + dev on the API host :5000).
            // env.BaseAddress is the page origin; the API lives on the same
            // origin in those deployments.
            _base = env.BaseAddress.TrimEnd('/') + "/";
        }
    }

    /// <summary>The absolute API base URL, always ending with a trailing slash.</summary>
    public string ApiBase => _base;

    /// <summary>Convenience: append a hub path and return the absolute URL.</summary>
    public string Hub(string relativePath) => _base + relativePath.TrimStart('/');
}
