using System.Security.Claims;
using Microsoft.AspNetCore.Components.Authorization;

using PoMiniGamesClient.Services.Auth;
using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGamesClient.Services.Auth;

/// <summary>
/// BFF-aware <see cref="AuthenticationStateProvider"/>: the real session lives in an
/// HttpOnly cookie managed by the host. This provider proxies the cookie's presence via
/// <c>GET /api/auth/handshake</c> and surfaces the result to Blazor's authorization pipeline.
/// </summary>
/// <remarks>
/// <para>
/// NOTE on the token flow: a full BFF would keep the access token entirely server-side.
/// This client is NOT there yet — for Microsoft sign-in, <see cref="AuthStateService"/>
/// currently holds the bearer token in WASM memory and <c>ApiService</c> attaches it as an
/// <c>Authorization</c> header. A true token-never-leaves-the-server BFF is a future
/// hardening goal; today this provider only mirrors the resolved profile/cookie state and
/// prevents page flashing on unauthenticated routes. The provider defers to the resolved
/// session for the truth, so the WASM client can implement <c>&lt;AuthorizeRouteView&gt;</c>
/// with a real <see cref="AuthenticationState"/> rather than a synthetic one.
/// </para>
/// <para>
/// Pattern: Adapter (Gamma et al., 1994). The Blazor authorization surface
/// (<see cref="AuthenticationState"/>, <see cref="ClaimsPrincipal"/>) is the
/// target; the underlying store is the BFF's <c>/api/auth/handshake</c> HTTP endpoint. The
/// adapter translates between the two contracts and caches the result for the
/// duration of the WASM session.
/// </para>
/// </remarks>
public sealed class BffAuthenticationStateProvider : AuthenticationStateProvider
{
    private readonly AuthStateService _authState;

    public BffAuthenticationStateProvider(AuthStateService authState)
    {
        _authState = authState;
        _authState.StateChanged += NotifyAuthenticationStateChanged;
    }

    public override Task<AuthenticationState> GetAuthenticationStateAsync()
    {
        // Until the BFF has confirmed a session, every render assumes anonymous.
        // This is the conservative choice: it means @context.User.Identity?.IsAuthenticated
        // is always false on the first paint, which is the safe default for the
        // <AuthorizeView>/<AuthorizeRouteView> gates in App.razor.
        if (_authState.User is null)
        {
            return Task.FromResult(new AuthenticationState(new ClaimsPrincipal(new ClaimsIdentity())));
        }

        var claims = new List<Claim>
        {
            new(ClaimTypes.NameIdentifier, _authState.User.UserId),
            new(ClaimTypes.Name, _authState.User.DisplayName),
        };
        if (!string.IsNullOrEmpty(_authState.User.Email))
        {
            claims.Add(new Claim(ClaimTypes.Email, _authState.User.Email));
        }

        var identity = new ClaimsIdentity(claims, authenticationType: "BFF");
        return Task.FromResult(new AuthenticationState(new ClaimsPrincipal(identity)));
    }

    private void NotifyAuthenticationStateChanged() => NotifyAuthenticationStateChanged(GetAuthenticationStateAsync());
}
