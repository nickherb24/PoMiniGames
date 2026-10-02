using Microsoft.JSInterop;

using PoMiniGamesClient.Services.Auth;
using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGamesClient.Services.Ui;

/// <summary>How the app picks its colour scheme.</summary>
public enum ThemeMode
{
    /// <summary>Follow the OS preference, and keep following it if it changes mid-session.</summary>
    Auto,
    Light,
    Dark,
}

/// <summary>
/// Global app settings shared by every game: colour scheme, master mute and
/// volume, haptics and reduced motion. Persisted as plain localStorage values
/// (<c>pomini_muted</c>, <c>pomini_theme</c>, <c>pomini_volume</c>,
/// <c>pomini_haptics</c>, <c>pomini_reducedmotion</c>) so JS modules (uiAudio.js,
/// audioBus.js, the index.html pre-paint theme script, game engines) can read
/// them directly without an interop round-trip.
/// </summary>
/// <remarks>
/// <para>
/// The setters sit behind <c>Components/SettingsSheet.razor</c>, a dialog rather
/// than a page, which also covers <c>pomini_colorsafe</c>. A fresh browser gets
/// the defaults below (Auto theme, unmuted, full volume, haptics on, motion
/// unreduced, standard palettes).
/// </para>
/// <para>
/// Volume and mute are enforced on the JS side — audioBus.js owns both the gain
/// node and the persisted keys — so their setters only call through; writing
/// the keys here as well would be a second writer that could disagree.
/// </para>
/// <para>
/// The FPS badge used to be gated here too (<c>pomini_showfps</c>, default off).
/// It is now unconditional in the top bar, so the flag is gone — see
/// Components/FpsCounter.razor. The "show game intros" flag went the same way:
/// the controls card now opens every 1-player game.
/// </para>
/// </remarks>
public sealed class SettingsService : IAsyncDisposable
{
    private const string MutedKey = "pomini_muted";
    private const string ThemeKey = "pomini_theme";
    private const string VolumeKey = "pomini_volume";
    private const string HapticsKey = "pomini_haptics";
    private const string ReducedMotionKey = "pomini_reducedmotion";
    private const string ColorSafeKey = "pomini_colorsafe";

    private readonly Lazy<Task<IJSObjectReference>> _prefs;
    private bool _disposed;

    /// <summary>Raised after any setting changes so the sheet and game pages can react.</summary>
    public event Action? Changed;

    /// <summary>
    /// Raised to open the settings sheet. The sheet lives in MainLayout; anything that wants
    /// to offer a way in (the footer, the hub's action row) calls <see cref="RequestOpen"/>.
    /// </summary>
    public event Action? OpenRequested;

    public void RequestOpen() => OpenRequested?.Invoke();

    public SettingsService(IJSRuntime js)
    {
        _prefs = new Lazy<Task<IJSObjectReference>>(() =>
            js.InvokeAsync<IJSObjectReference>("import", "./js/appPrefs.js").AsTask());
    }

    public bool Muted { get; private set; }

    /// <summary>Colour scheme. <see cref="ThemeMode.Auto"/> tracks the OS.</summary>
    public ThemeMode Theme { get; private set; } = ThemeMode.Auto;

    /// <summary>Master output volume as a percentage, 0–100.</summary>
    public int Volume { get; private set; } = 100;

    /// <summary>Whether vibration cues fire on devices that support them.</summary>
    public bool Haptics { get; private set; } = true;

    /// <summary>
    /// The user's own request for less motion. Independent of the OS
    /// <c>prefers-reduced-motion</c> setting, which always applies on its own —
    /// this being false never re-enables motion for someone whose OS asked to
    /// reduce it.
    /// </summary>
    public bool ReducedMotion { get; private set; }

    /// <summary>
    /// Colour-blind-safe palettes in the games that have one (PoEcosystem's charts,
    /// PoCabinet's minimap). Either this or the game's own setting turns it on.
    /// </summary>
    public bool ColorSafe { get; private set; }

    /// <summary>Read persisted values. Call once JS interop is available.</summary>
    public void Load()
    {
        try
        {
            Muted = LocalStorageService.GetItem<string>(MutedKey) == "1";
            Theme = ParseTheme(LocalStorageService.GetItem<string>(ThemeKey));
            Volume = ParseVolume(LocalStorageService.GetItem<string>(VolumeKey));
            Haptics = LocalStorageService.GetItem<string>(HapticsKey) != "0";
            ReducedMotion = LocalStorageService.GetItem<string>(ReducedMotionKey) == "1";
            ColorSafe = LocalStorageService.GetItem<string>(ColorSafeKey) == "1";
        }
        catch { /* pre-render — defaults stand */ }
    }

    /// <summary>
    /// Anything unrecognised (including a missing key or a value written by an
    /// older build) means Auto — the safest reading of "no explicit choice".
    /// </summary>
    private static ThemeMode ParseTheme(string? raw) => raw switch
    {
        "light" => ThemeMode.Light,
        "dark" => ThemeMode.Dark,
        _ => ThemeMode.Auto,
    };

    /// <summary>
    /// Clamped to 0–100. A corrupt or missing value reads as full volume rather
    /// than 0, so a bad key never presents as broken audio.
    /// </summary>
    private static int ParseVolume(string? raw) =>
        int.TryParse(raw, out var pct) ? Math.Clamp(pct, 0, 100) : 100;

    private static string ThemeToStorage(ThemeMode mode) => mode switch
    {
        ThemeMode.Light => "light",
        ThemeMode.Dark => "dark",
        _ => "auto",
    };

    public async Task SetThemeAsync(ThemeMode mode)
    {
        Theme = mode;
        LocalStorageService.SetItem(ThemeKey, ThemeToStorage(mode));
        Changed?.Invoke();
        await InvokeAsync("applyTheme", ThemeToStorage(mode));
    }

    public async Task SetMutedAsync(bool muted)
    {
        Muted = muted;
        Changed?.Invoke();
        await InvokeAsync("applyMuted", muted);
    }

    public async Task SetVolumeAsync(int percent)
    {
        Volume = Math.Clamp(percent, 0, 100);
        Changed?.Invoke();
        await InvokeAsync("applyVolume", Volume / 100.0);
    }

    public void SetHaptics(bool enabled)
    {
        Haptics = enabled;
        LocalStorageService.SetItem(HapticsKey, enabled ? "1" : "0");
        Changed?.Invoke();
    }

    public async Task SetReducedMotionAsync(bool reduce)
    {
        ReducedMotion = reduce;
        LocalStorageService.SetItem(ReducedMotionKey, reduce ? "1" : "0");
        Changed?.Invoke();
        await InvokeAsync("applyReducedMotion", reduce);
    }

    public async Task SetColorSafeAsync(bool on)
    {
        ColorSafe = on;
        LocalStorageService.SetItem(ColorSafeKey, on ? "1" : "0");
        Changed?.Invoke();
        await InvokeAsync("applyColorSafe", on);
    }

    /// <summary>
    /// True when the OS itself asks for reduced motion, in which case the app is
    /// already calmer regardless of <see cref="ReducedMotion"/>. Used only to
    /// explain that in the settings sheet.
    /// </summary>
    public async Task<bool> OsPrefersReducedMotionAsync()
    {
        if (_disposed) return false;
        try
        {
            var module = await _prefs.Value;
            return await module.InvokeAsync<bool>("prefersReducedMotion");
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// Push the persisted values into the DOM and audio graph. Call once after
    /// first render: the pre-paint script in index.html has already stamped the
    /// theme, but nothing has wired up the OS-change listener for Auto mode yet.
    /// </summary>
    public async Task ApplyAsync()
    {
        await InvokeAsync("applyTheme", ThemeToStorage(Theme));
        if (ReducedMotion) await InvokeAsync("applyReducedMotion", true);
        // Volume and mute are not re-pushed here: audioBus.js reads both keys
        // itself when it builds the graph, which it may already have done. Re-
        // sending them would only risk constructing an AudioContext before the
        // first user gesture, which mobile autoplay policy rejects.
    }

    /// <summary>
    /// Best-effort interop. Preferences are an enhancement layered on top of a
    /// working app — a browser that cannot load the module keeps the defaults
    /// rather than failing a user action.
    /// </summary>
    private async Task InvokeAsync(string fn, object arg)
    {
        if (_disposed) return;
        try
        {
            var module = await _prefs.Value;
            await module.InvokeVoidAsync(fn, arg);
        }
        catch
        {
            // Best-effort — never throw from a settings path.
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        _disposed = true;
        if (_prefs.IsValueCreated)
        {
            try
            {
                var module = await _prefs.Value;
                await module.DisposeAsync();
            }
            catch { /* module never loaded — fine */ }
        }
    }
}
