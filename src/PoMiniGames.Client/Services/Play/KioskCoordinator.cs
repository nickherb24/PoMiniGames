using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.Routing;

using PoMiniGamesClient.Services.Auth;
using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGamesClient.Services.Play;

/// <summary>
/// Centralized manager for the "Watch All Demos" auto-rotation kiosk mode.
///
/// Fixes a critical bug where each demo page created its own private
/// <c>System.Threading.Timer</c> for the 20s advance-to-next-demo logic.
/// Those timers survived Blazor's enhanced navigation and continued to fire
/// after the user manually navigated to another page, hijacking the user
/// back into the kiosk cycle. They also raced with each demo's own
/// "restart on game-over" loop, causing infinite re-loops on some pages
/// (notably PoFight).
///
/// Design contract:
///   • Only ONE kiosk timer exists for the lifetime of the Blazor session.
///   • Demo pages <c>Register</c> themselves (catalog) and call
///     <c>SetCurrent(key)</c> to report which demo is on screen. The
///     coordinator owns the timer, so canceling or stopping is centralized.
///   • On any <see cref="NavigationManager.LocationChanged"/>:
///       – Kiosk-internal navigations carry <c>?kiosk=N</c> in the URL.
///         The coordinator re-targets the timer to the new index and keeps
///         ticking, so the auto-rotation actually rotates.
///       – Any other navigation (Home, single-player, etc.) cancels the
///         active timer to prevent a stale timer from yanking the user
///         back into the kiosk cycle.
///   • Users can Pause/Resume/Skip/Exit via the on-screen kiosk control
///     bar (<c>Components/KioskControlBar.razor</c>, mounted once in
///     MainLayout). It renders only while <see cref="IsActive"/>.
/// </summary>
public sealed class KioskCoordinator : IDisposable
{
    private readonly NavigationManager _navigation;
    private readonly List<DemoEntry> _entries = new();
    private System.Threading.Timer? _timer;
    private string? _currentKey;
    private int _currentIndex;
    private bool _isPaused;
    private int _advanceIndex; // index of the demo to jump to on the next advance
    private bool _disposed;

    public event Action? Changed;

    public KioskCoordinator(NavigationManager navigation)
    {
        _navigation = navigation;
        _navigation.LocationChanged += OnLocationChanged;
    }

    public bool IsActive => _timer is not null;
    public bool IsPaused => _isPaused;
    public string? CurrentGameName { get; private set; }
    public int SecondsUntilAdvance { get; private set; } = AdvanceSeconds;
    /// <summary>How long every demo stays on screen. A demo whose match ends on a frozen
    /// result screen moves on sooner by calling <see cref="MarkFinished"/>.</summary>
    public const int AdvanceSeconds = 60;

    /// <summary>0-based index of the demo currently on screen. -1 before the first page reports itself.</summary>
    public int CurrentIndex => _currentIndex;
    /// <summary>Total demos in the reel.</summary>
    public int TotalCount => _entries.Count;

    public IReadOnlyList<DemoEntry> Entries => _entries;

    public void RegisterEntries(IEnumerable<DemoEntry> entries)
    {
        _entries.Clear();
        _entries.AddRange(entries);
        Changed?.Invoke();
    }

    public void SetCurrent(string key)
    {
        _currentKey = key;
        CurrentGameName = _entries.FirstOrDefault(e => e.Key == key)?.DisplayName;
        _currentIndex = _entries.FindIndex(e => e.Key == key);
        var normalizedKey = key.EndsWith("-demo", StringComparison.OrdinalIgnoreCase)
            ? key[..^5]
            : key;
        _currentKey = normalizedKey;
        var entry = _entries.FirstOrDefault(e => string.Equals(e.Key, normalizedKey, StringComparison.OrdinalIgnoreCase)
                                              || string.Equals(e.Key, key, StringComparison.OrdinalIgnoreCase));
        if (entry is not null)
        {
            CurrentGameName = entry.DisplayName;
            _currentIndex = _entries.IndexOf(entry);
        }
        else
        {
            _currentIndex = _entries.FindIndex(e => string.Equals(e.Key, normalizedKey, StringComparison.OrdinalIgnoreCase));
            CurrentGameName = _currentIndex >= 0 ? _entries[_currentIndex].DisplayName : null;
        }
        SecondsUntilAdvance = AdvanceSeconds;
        Changed?.Invoke();
    }

    public void Start(int advanceIndex)
    {
        Stop();
        _advanceIndex = advanceIndex;
        _timer = new System.Threading.Timer(_ => OnTick(), null, 1000, 1000);
        Changed?.Invoke();
    }

    public void Stop()
    {
        _timer?.Dispose();
        _timer = null;
        _isPaused = false;
        _currentIndex = -1;
        _currentKey = null;
        CurrentGameName = null;
        SecondsUntilAdvance = AdvanceSeconds;
        Changed?.Invoke();
    }

    public void Pause() { _isPaused = true; Changed?.Invoke(); }
    public void Resume() { _isPaused = false; Changed?.Invoke(); }
    public void TogglePause() { _isPaused = !_isPaused; Changed?.Invoke(); }

    public void SkipNext()
    {
        _timer?.Dispose();
        _timer = null;
        var next = (_advanceIndex + 1) % _entries.Count;
        var nextEntry = _entries[next];
        var sep = nextEntry.Path.Contains('?') ? '&' : '?';
        _navigation.NavigateTo($"{nextEntry.Path}{sep}kiosk={next}", forceLoad: false);
        Changed?.Invoke();
    }

    /// <summary>
    /// Jump to the previous demo in the reel. Symmetric with <see cref="SkipNext"/> —
    /// decrements with wrap-around so a museum visitor who missed a demo doesn't
    /// have to wait the full ~3-minute loop to see it again.
    /// </summary>
    public void PreviousDemo()
    {
        if (_entries.Count == 0) return;
        _timer?.Dispose();
        _timer = null;
        var prev = (_advanceIndex - 1 + _entries.Count) % _entries.Count;
        var prevEntry = _entries[prev];
        var sep = prevEntry.Path.Contains('?') ? '&' : '?';
        _navigation.NavigateTo($"{prevEntry.Path}{sep}kiosk={prev}", forceLoad: false);
        Changed?.Invoke();
    }

    /// <summary>
    /// Demo pages call this when their match ends (post-mortem screen, game-over
    /// modal, race finished, etc.) so the reel advances immediately instead of
    /// sitting on the "Game over" screen for the rest of the per-game dwell. The
    /// effect is identical to <see cref="SkipNext"/> from the viewer's point of
    /// view — both rotate the reel — but it lives here so a per-game page can
    /// opt in without having to know the timer internals.
    /// </summary>
    public void MarkFinished()
    {
        if (!IsActive) return;
        if (_entries.Count == 0) return;
        // Drop straight to the next demo. We deliberately do NOT pause first —
        // a finished match that then sits paused is the same visual problem as
        // one that sits on the timer, just with a different cause.
        SkipNext();
    }

    /// <summary>
    /// Jump directly to a specific demo by its catalog index. Used by the home page's
    /// "start here" affordance so a passer-by can land on the most visually striking
    /// demo (PoVoxelStrike) instead of always opening on TicTacToe.
    /// </summary>
    public void JumpTo(int index)
    {
        if (_entries.Count == 0) return;
        if (index < 0 || index >= _entries.Count) return;
        // Resume the reel if it was already active; if not, take it from index 0 and
        // rotate forward from the chosen entry.
        if (_timer is null) Start(index);
        else
        {
            _timer.Dispose();
            _timer = null;
            _advanceIndex = index;
            var entry = _entries[index];
            var sep = entry.Path.Contains('?') ? '&' : '?';
            _navigation.NavigateTo($"{entry.Path}{sep}kiosk={index}", forceLoad: false);
            Changed?.Invoke();
        }
    }

    public void Exit()
    {
        Stop();
        _navigation.NavigateTo("/", forceLoad: false);
    }

    private void OnTick()
    {
        if (_disposed || _timer is null) return;
        if (_isPaused) return;
        SecondsUntilAdvance--;
        Changed?.Invoke();
        if (SecondsUntilAdvance <= 0)
        {
            // Advance to next kiosk index. The SinglePlayerPage will pick
            // up the new index and route to the corresponding demo game.
            _timer?.Dispose();
            _timer = null;
            var next = (_advanceIndex + 1) % _entries.Count;
            var nextEntry = _entries[next];
            var sep = nextEntry.Path.Contains('?') ? '&' : '?';
            _navigation.NavigateTo($"{nextEntry.Path}{sep}kiosk={next}", forceLoad: false);
        }
    }

    private void OnLocationChanged(object? sender, LocationChangedEventArgs e)
    {
        // Kiosk-internal navigations carry ?kiosk=N in the query string —
        // these are emitted by the coordinator itself (Start, OnTick,
        // SkipNext) and must NOT cancel the timer, otherwise the very first
        // call to Start() followed by NavigateTo(...) would dispose the
        // timer before the first tick. Re-target the countdown to the new
        // index and (re)arm the timer if the previous non-kiosk navigation
        // had killed it.
        if (TryGetKioskIndex(e.Location, out var kioskIndex))
        {
            _advanceIndex = kioskIndex;
            _currentIndex = kioskIndex;
            if (kioskIndex >= 0 && kioskIndex < _entries.Count)
            {
                _currentKey = _entries[kioskIndex].Key;
                CurrentGameName = _entries[kioskIndex].DisplayName;
            }
            SecondsUntilAdvance = AdvanceSeconds;
            if (_timer is null && !_disposed)
            {
                _timer = new System.Threading.Timer(_ => OnTick(), null, 1000, 1000);
            }
            Changed?.Invoke();
            return;
        }

        // Any non-kiosk location change cancels the auto-tick. This is what
        // stops the "stale timer hijacks manual navigation" bug — if the
        // user clicks Home or a single-player game, the kiosk cycle stops
        // instead of yanking them back 20s later.
        if (_timer is not null)
        {
            _timer.Dispose();
            _timer = null;
            Changed?.Invoke();
        }
    }

    // Parses ?kiosk=N (or &kiosk=N) from a URL. Returns true and the index
    // when present and a non-negative integer; false otherwise.
    private static bool TryGetKioskIndex(string url, out int index)
    {
        index = 0;
        var qIdx = url.IndexOf('?');
        if (qIdx < 0) return false;
        foreach (var part in url[(qIdx + 1)..].Split('&'))
        {
            var eq = part.IndexOf('=');
            if (eq <= 0) continue;
            if (!string.Equals(part[..eq], "kiosk", StringComparison.OrdinalIgnoreCase)) continue;
            return int.TryParse(part[(eq + 1)..], out index) && index >= 0;
        }
        return false;
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _navigation.LocationChanged -= OnLocationChanged;
        _timer?.Dispose();
        _timer = null;
    }
}

public sealed record DemoEntry(string Key, string Path, string DisplayName, string Icon);
