using Microsoft.JSInterop;

using PoMiniGamesClient.Services.Auth;
using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGamesClient.Services.Ui;

/// <summary>
/// Registers the service worker and surfaces "a new build is waiting" to the player.
/// </summary>
/// <remarks>
/// A cache-first service worker will otherwise serve the same build indefinitely: the
/// new one downloads, parks in <c>waiting</c>, and never takes over while a tab stays
/// open. Without this prompt, shipping a fix would not reach anyone who keeps the app
/// open — the usual failure mode of offline-first apps.
/// </remarks>
public sealed class AppUpdateService : IAsyncDisposable
{
    private readonly IJSRuntime _js;
    private readonly ToastService _toast;
    private DotNetObjectReference<AppUpdateService>? _selfRef;
    private bool _initialized;

    public AppUpdateService(IJSRuntime js, ToastService toast)
    {
        _js = js;
        _toast = toast;
    }

    /// <summary>True once a newer worker is installed and waiting to activate.</summary>
    public bool UpdateAvailable { get; private set; }

    public event Action? StateChanged;

    /// <summary>Idempotent — see <see cref="OnlineStatusService.InitializeAsync"/>.</summary>
    public async Task InitializeAsync()
    {
        if (_initialized) return;
        _initialized = true;
        try
        {
            _selfRef = DotNetObjectReference.Create(this);
            await _js.InvokeVoidAsync("poPwa.setUpdateListener", _selfRef);
            await _js.InvokeAsync<bool>("poPwa.register");
        }
        catch
        {
            // No service worker support, or registration blocked. Offline support is
            // an enhancement — the app is fully functional without it, so this must
            // never surface as an error to the player.
        }
    }

    [JSInvokable]
    public void OnUpdateAvailable() => _ = EvaluateUpdateToastAsync();

    /// <summary>
    /// Decide whether this viewer may be nagged about the waiting worker. One JS call
    /// (<c>poPwa.pageContext</c>) supplies the path/query/host — see pwa.js for why the
    /// decision lives on that side of the interop boundary: the previous C# probes ran
    /// through <c>eval</c> interop, which failed open and showed the toast to exactly the
    /// developers and kiosks this service exists to keep quiet.
    /// </summary>
    private async Task EvaluateUpdateToastAsync()
    {
        if (UpdateAvailable) return;

        string path = "/", query = "", host = "";
        try
        {
            var ctx = await _js.InvokeAsync<PageContext>("poPwa.pageContext");
            path = ctx.Path ?? "/";
            query = ctx.Query ?? "";
            host = ctx.Host ?? "";
        }
        catch
        {
            // Interop unavailable — the page is tearing down, or SW support is missing.
            // Default the gates open (below) so a real visitor still gets the prompt;
            // the toast on a dead page is invisible anyway.
        }

        // Bug fix (2026-08-07): the update toast was surfacing to kiosk
        // spectators, where it competes for attention with the attract reel.
        // The reel cycles every 12-24s and never has a visitor who would
        // press "Update now" — leaving the toast on screen until the next
        // page change is just visual noise. Detection is path-based: any
        // /{game}/demo or ?kiosk=N segment, which is the same shape
        // KioskCoordinator uses to identify its own navigations.
        if (query.Contains("kiosk=", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith("/demo", StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        // 2026-08-10: silence the update nag during local dev. Every `dotnet build`
        // ships a fresh boot.json that the SW sees as "new", and a developer who
        // rebuilds twice in an hour gets the toast twice in an hour. Production
        // users still see it — only the localhost/lan hosts are gated.
        if (host.Equals("localhost", StringComparison.OrdinalIgnoreCase)
            || host.Equals("127.0.0.1", StringComparison.OrdinalIgnoreCase)
            || host.StartsWith("192.168.", StringComparison.OrdinalIgnoreCase)
            || host.EndsWith(".local", StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        UpdateAvailable = true;
        StateChanged?.Invoke();
        // Deliberately an action, not "press F5": a waiting worker keeps waiting
        // through an ordinary reload (it only activates once every tab controlled by
        // the old worker is gone), so telling the player to reload would be telling
        // them to do something that does not work.
        _toast.ShowAction("A new version is ready.", "Update now", ApplyUpdateAsync, ToastType.Info);
    }

    /// <summary>Shapes <c>poPwa.pageContext</c> (pwa.js). Interop JSON is camelCase.</summary>
    private sealed record PageContext(string? Path, string? Query, string? Host);

    /// <summary>Activate the waiting worker and reload onto the new build.</summary>
    public async Task ApplyUpdateAsync()
    {
        try
        {
            await _js.InvokeVoidAsync("poPwa.applyUpdate");
        }
        catch
        {
            // If the interop is gone the page is being torn down anyway.
        }
    }

    public ValueTask DisposeAsync()
    {
        _selfRef?.Dispose();
        _selfRef = null;
        return ValueTask.CompletedTask;
    }
}
