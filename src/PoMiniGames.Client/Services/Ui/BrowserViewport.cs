using Microsoft.JSInterop;

using PoMiniGamesClient.Services.Auth;
using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGamesClient.Services.Ui;

/// <summary>
/// Lightweight viewport-width helper used by Razor components that need to
/// render different amounts of data on phone vs desktop (e.g. leaderboards
/// show top-3 on mobile, top-10 on desktop).
///
/// Components inject this scoped service and call <see cref="RefreshAsync"/>
/// inside OnAfterRenderAsync, then read <see cref="IsNarrow"/> from their
/// build pass. The service also subscribes to <c>window.resize</c> so the
/// value stays current if the user rotates their phone.
/// </summary>
public sealed class BrowserViewport
{
    public const int NarrowBreakpointPx = 640;

    private readonly IJSRuntime _js;

    public BrowserViewport(IJSRuntime js) => _js = js;

    /// <summary>True when the viewport is &lt;= <see cref="NarrowBreakpointPx"/> wide.</summary>
    public bool IsNarrow { get; private set; }

    /// <summary>
    /// Reads window.innerWidth and updates <see cref="IsNarrow"/>. Wires up a
    /// resize listener the first time it's called. Safe to invoke from
    /// OnAfterRenderAsync — throws are swallowed and the previous value sticks.
    /// </summary>
    public async Task RefreshAsync()
    {
        try
        {
            var w = await _js.InvokeAsync<int>("eval", "window.innerWidth || 0");
            IsNarrow = w > 0 && w <= NarrowBreakpointPx;
            // Best-effort: if the page later resizes, refresh via JS subscription.
            await _js.InvokeVoidAsync("eval",
                "window.__bpViewportListener || (window.__bpViewportListener = true, " +
                "window.addEventListener('resize', () => window.dispatchEvent(new CustomEvent('bp-viewport'))));");
        }
        catch
        {
            // No-op: render with last known value.
        }
    }
}
