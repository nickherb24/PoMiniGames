using Microsoft.JSInterop;

using PoMiniGamesClient.Services.Auth;
using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGamesClient.Services.Ui;

/// <summary>
/// The app's single feedback surface: audio, screen impact and particles, fired
/// together as one named cue. Zero audio assets to ship — everything is
/// synthesised. Lazy <c>AudioContext</c> init on first invocation (honours mobile
/// autoplay rules; the first tap falls back to a no-op if the gesture has not
/// happened yet).
/// </summary>
/// <remarks>
/// <para>
/// Pattern: Adapter over the shared cue vocabulary in <c>gameCues.js</c>. Each
/// semantic intent below (<see cref="TapAsync"/>, <see cref="CompleteAsync"/>,
/// <see cref="ErrorAsync"/>, …) resolves to a cue name in that table, so the
/// sound, the impact envelope and the particle burst leave together instead of
/// being three independent calls that can drift apart.
/// </para>
/// <para>
/// <b>This used to be a second, parallel audio stack.</b> The methods here each
/// hand-rolled an oscillator burst (<c>playTone(880, 40, 0.18, "triangle")</c>),
/// while <c>gameCues.js</c> — a per-game timbre table wired to impact and
/// particles — was loaded on every page and called by nothing. The result was
/// that all ten games shared the same three oscillators, and only the ten pages
/// that happened to inject this service made any sound at all. Routing these
/// intents through the vocabulary is what gives each game its own voice; use
/// <see cref="CueAsync"/> to reach a game-specific cue directly.
/// </para>
/// <para>
/// <b>Failure modes</b>: silent. If the AudioContext is unavailable (very old
/// browsers, sandboxed iframes, autoplay blocked before the first gesture) the
/// JS module throws and the await swallows it — feedback is best-effort, never
/// a blocker. An unknown cue name degrades to the primitive tone rather than to
/// silence.
/// </para>
/// </remarks>
public sealed class UiFeedbackService : IAsyncDisposable
{
    private readonly Lazy<Task<IJSObjectReference>> _module;
    private bool _disposed;

    public UiFeedbackService(IJSRuntime js)
    {
        _module = new Lazy<Task<IJSObjectReference>>(() =>
            js.InvokeAsync<IJSObjectReference>("import", "./js/uiAudio.js").AsTask());
    }

    // §7 Haptic vocabulary. Each intent below pairs its audio cue with a short
    // vibration so the same feedback lands on tactile-first mobile players (and
    // in silent/pocket contexts). Patterns are deliberately tiny — a "tick", not
    // a "buzz" — so rapid interactions never fatigue. All are best-effort and
    // gated on the same master-mute as audio (see uiAudio.js `vibrate`).
    private static readonly int[] HapticTap = { 8 };
    private static readonly int[] HapticClick = { 6 };
    private static readonly int[] HapticDrop = { 14 };
    private static readonly int[] HapticComplete = { 12, 28, 12 };
    private static readonly int[] HapticError = { 40 };
    private static readonly int[] HapticStart = { 10, 30, 16 };

    /// <summary>
    /// Fire a named cue from the shared vocabulary, with the game's own timbre.
    /// This is the general entry point — the intents below are the handful of
    /// cross-game shorthands. Pass the game key as <paramref name="scope"/>
    /// ("tictactoe", "pobrawl", "quiz", …) to get that game's voice; the "ui"
    /// scope is the shared fallback for anything not in the game's table.
    /// </summary>
    /// <param name="scope">Cue scope — a game key, or "ui".</param>
    /// <param name="name">Cue name within that scope.</param>
    /// <param name="haptic">Optional vibration to fire alongside it.</param>
    /// <returns>True if a cue matched; false if the name is unknown to the table.</returns>
    public async ValueTask<bool> CueAsync(string scope, string name, int[]? haptic = null)
    {
        if (_disposed) return false;
        try
        {
            var module = await _module.Value;
            var fired = await module.InvokeAsync<bool>("cue", scope, name);
            if (haptic is { Length: > 0 }) await module.InvokeVoidAsync("vibrate", haptic);
            return fired;
        }
        catch
        {
            // Best-effort — never throw from a feedback path.
            return false;
        }
    }

    /// <summary>
    /// Fire a cue with placement and pitch — the expressive form of
    /// <see cref="CueAsync(string, string, int[])"/>. Named separately rather than
    /// overloaded: a two-argument call would be ambiguous against it.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The cue vocabulary has always accepted these (see <c>gameCues.fire</c>), but
    /// until now only the JS engines could pass them, so every cue fired from C#
    /// landed dead centre at a fixed pitch. That is survivable for UI chrome and
    /// wrong for a game: eight runners in eight lanes, or a rival car passing on
    /// the left, are spatial events, and a cue that ignores the speed it was fired
    /// at is the single biggest tell that a sound is canned.
    /// </para>
    /// <para>
    /// <paramref name="pitch"/> shifts frequency for pitched voices and brightness
    /// (filter cutoff) for noise voices, because scaling the frequency of a noise
    /// source is a no-op — <c>gameCues</c> handles that split internally.
    /// </para>
    /// </remarks>
    /// <param name="scope">Cue scope — a game key, or "ui".</param>
    /// <param name="name">Cue name within that scope.</param>
    /// <param name="pan">-1 (hard left) .. 1 (hard right).</param>
    /// <param name="pitch">Frequency multiplier; 1 is the cue as written.</param>
    /// <param name="gain">Level multiplier; 1 is the cue as written.</param>
    /// <param name="scale">Impact and particle strength multiplier.</param>
    /// <returns>True if a cue matched; false if the name is unknown to the table.</returns>
    public async ValueTask<bool> CueAtAsync(
        string scope, string name, double pan = 0, double pitch = 1, double gain = 1, double scale = 1)
    {
        if (_disposed) return false;
        try
        {
            var module = await _module.Value;
            // Anonymous object, matching ChipDropAsync below — the JS side reads
            // these by name off an options bag.
            return await module.InvokeAsync<bool>("cue", scope, name, new { pan, pitch, gain, scale });
        }
        catch
        {
            // Best-effort — never throw from a feedback path.
            return false;
        }
    }

    /// <summary>
    /// Fire the first cue in <paramref name="names"/> that this scope actually
    /// defines. Outcome cues are not named uniformly across games — a win is
    /// "win" in TicTacToe, "ko" in Brawl, "finish" in Marble Race, "goal" in
    /// Sports, "fanfare" in Joker — so a shared component that wants "whatever
    /// this game calls winning" has to ask for a list, not a name.
    /// </summary>
    public async ValueTask<bool> CueFirstAsync(string scope, string[] names, int[]? haptic = null)
    {
        foreach (var name in names)
        {
            if (await CueAsync(scope, name, haptic)) return true;
        }
        return false;
    }

    /// <summary>A short tap for button presses — the "ui/tap" cue, plus a light haptic tick.</summary>
    public async ValueTask TapAsync()
    {
        if (!await CueAsync("ui", "tap", HapticTap))
        {
            await PlayToneAsync(880, 40, 0.18, "triangle");
            await VibrateAsync(HapticTap);
        }
    }

    /// <summary>A bright completion cue — "ui/confirm", plus a three-beat haptic.</summary>
    public async ValueTask CompleteAsync()
    {
        if (!await CueAsync("ui", "confirm", HapticComplete))
        {
            await PlayChordAsync(new[] { 523.25, 659.25, 783.99 }, 220, 0.12);
            await VibrateAsync(HapticComplete);
        }
    }

    /// <summary>A low error buzz — "ui/error" (two voices 11 Hz apart), plus a haptic buzz.</summary>
    public async ValueTask ErrorAsync()
    {
        if (!await CueAsync("ui", "error", HapticError))
        {
            await PlayToneAsync(220, 120, 0.22, "square");
            await VibrateAsync(HapticError);
        }
    }

    /// <summary>
    /// A confident game-start cue. Prefers the game's own "start" cue when a scope
    /// is given, so a round of Brawl opens in Brawl's voice rather than in the
    /// generic one; falls back to the shared rising "ui/open".
    /// </summary>
    /// <param name="scope">Optional game key for a game-specific start cue.</param>
    public async ValueTask GameStartAsync(string? scope = null)
    {
        if (scope is not null && await CueAsync(scope, "start", HapticStart)) return;
        if (!await CueAsync("ui", "open", HapticStart))
        {
            await PlayChordAsync(new[] { 392.00, 523.25, 659.25 }, 280, 0.15);
            await VibrateAsync(HapticStart);
        }
    }

    /// <summary>A subtle UI confirmation — "ui/toggle", plus a faint haptic.</summary>
    public async ValueTask ClickAsync()
    {
        if (!await CueAsync("ui", "toggle", HapticClick))
        {
            await PlayToneAsync(1046.50, 60, 0.10, "sine");
            await VibrateAsync(HapticClick);
        }
    }

    /// <summary>
    /// A disc-drop "tock" (75 ms, low triangle at 20 % gain + haptic) synced to a
    /// piece landing in a Connect-style board. Deliberately low and short so rapid
    /// moves don't fatigue — the settle-bounce visual and this cue fire together.
    /// </summary>
    /// <param name="pan">-1 (left) .. 1 (right): where on the board the piece went down.</param>
    public async ValueTask DiscDropAsync(double pan = 0)
    {
        await PlayToneAsync(174.61, 75, 0.20, "triangle", pan);
        await VibrateAsync(HapticDrop);
    }

    /// <summary>
    /// Realistic Connect-style chip-drop cue. Plays a band-passed noise slide
    /// (chip scraping down the slot) followed by a thud + click on landing. The
    /// landing row (0..8, where 8 = bottom of board) shifts the thud frequency
    /// and decay slightly so high drops sound thinner than low drops. Fires a
    /// short haptic at the impact moment so the cue lands on tactile devices.
    /// Best-effort; silent on autoplay-blocked / no-AudioContext environments.
    /// </summary>
    /// <param name="rowIndex">0..8 — the row the chip landed on (8 = bottom).</param>
    /// <param name="pan">-1 (left) .. 1 (right): the column it fell in (see <see cref="BoardPan"/>).</param>
    public async ValueTask ChipDropAsync(int rowIndex, double pan = 0)
    {
        if (_disposed) return;
        try
        {
            var module = await _module.Value;
            // Match the CSS drop length: the slide takes ~400 ms so it
            // synchronises with cf-slide-down's 0.55s easing as the disc
            // crosses the board. The thud fires at ~0.40s — feels "with" the
            // settle bounce.
            await module.InvokeVoidAsync("playChipDrop", new
            {
                rowIndex,
                pan,
                slideMs = 400,
                thudMs = 110,
                masterGain = 0.22,
            });
            await module.InvokeVoidAsync("vibrate", HapticDrop);
        }
        catch
        {
            // Best-effort — never throw from a feedback path.
        }
    }

    /// <summary>
    /// §10 Swipe-back gesture feedback — a 90 ms downsweep from C5 → A3 with
    /// a soft attack. Matches the navigation gesture direction (low = leaving).
    /// </summary>
    public async ValueTask SwipeBackAsync()
    {
        // "ui/back" is the same idea expressed in the vocabulary: a downward sweep,
        // because players read rising as forward and falling as backward.
        if (!await CueAsync("ui", "back"))
        {
            await PlaySweepAsync(523.25, 220.00, 90, 0.14, "triangle");
        }
    }

    /// <summary>
    /// §10 Personal-best celebration — three ascending arpeggio notes (C5 → E5 → G5)
    /// with a short vibration burst on supporting devices. The audio is the
    /// milestone cue; the haptic reinforces it for tactile-first users.
    /// </summary>
    public async ValueTask PersonalBestAsync()
    {
        // "ui/confirm" carries the milestone; the win-scale haptic distinguishes it
        // from an ordinary confirmation on tactile-first devices.
        if (!await CueAsync("ui", "confirm", new[] { 12, 40, 18 }))
        {
            await PlayArpeggioAsync(
                new[] { 523.25, 659.25, 783.99 },
                new[] { 80, 80, 180 },
                0.16,
                vibrate: new[] { 12, 40, 18 });
        }
    }

    /// <summary>
    /// §10 Mock-data environment cue — a single low buzz (140 ms, F3, 14 % gain)
    /// whenever the USING MOCK DATA banner appears. Best-effort, never blocks.
    /// </summary>
    public ValueTask MockDataAsync() => PlayToneAsync(174.61, 140, 0.14, "square");

    /// <summary>Crystalline ping for high-gloss modals, gems, and achievements.</summary>
    public async ValueTask CrystalPingAsync() => await CueAsync("ui", "crystalPing", HapticClick);

    /// <summary>Crisp dual-micro-click for switches and pill controls.</summary>
    public async ValueTask MagneticSnapAsync() => await CueAsync("ui", "magneticSnap", HapticClick);

    /// <summary>Soft fluid frequency sweep for ripples, drops, and selections.</summary>
    public async ValueTask FluidRippleAsync() => await CueAsync("ui", "fluidRipple", HapticTap);

    /// <summary>Resonant crystal glass wine-rim shimmer for dashboard overlays.</summary>
    public async ValueTask GlassResonateAsync() => await CueAsync("ui", "glassResonate", HapticTap);

    /// <summary>Karplus-Strong physical modeling plucked string (pentatonic / ancestor tree).</summary>
    public async ValueTask PluckAsync(double freq = 440)
    {
        if (_disposed) return;
        try
        {
            var module = await _module.Value;
            await module.InvokeVoidAsync("pluck", freq);
            await VibrateAsync(HapticTap);
        }
        catch { /* best-effort */ }
    }

    /// <summary>Inharmonic bronze ceremonial gong with long resonant decay.</summary>
    public async ValueTask GongAsync(double freq = 110)
    {
        if (_disposed) return;
        try
        {
            var module = await _module.Value;
            await module.InvokeVoidAsync("gong", freq);
            await VibrateAsync(HapticComplete);
        }
        catch { /* best-effort */ }
    }

    /// <summary>
    /// §7 Fire a raw haptic pattern (alternating vibrate/pause milliseconds, e.g.
    /// <c>[12, 40, 18]</c>). Gated on <c>navigator.vibrate</c> support and the
    /// global master-mute; a no-op on desktop/unsupported devices. Best-effort —
    /// never throws. Games can call this directly for bespoke cues (hit, near-miss,
    /// countdown) beyond the shared intents above.
    /// </summary>
    public async ValueTask VibrateAsync(int[] pattern)
    {
        if (_disposed || pattern is not { Length: > 0 }) return;
        try
        {
            var module = await _module.Value;
            await module.InvokeVoidAsync("vibrate", pattern);
        }
        catch
        {
            // Best-effort — never throw from a feedback path.
        }
    }

    /// <summary>
    /// Stereo placement for a piece played in <paramref name="col"/> of a board
    /// <paramref name="cols"/> wide. Stops at 0.7: a hard-panned mono voice reads
    /// as a broken channel on headphones.
    /// </summary>
    public static double BoardPan(int col, int cols) =>
        cols <= 1 ? 0 : Math.Clamp(((col / (double)(cols - 1)) * 2) - 1, -1, 1) * 0.7;

    private async ValueTask PlayToneAsync(double freq, int ms, double gain, string type, double pan = 0)
    {
        if (_disposed) return;
        try
        {
            var module = await _module.Value;
            await module.InvokeVoidAsync("playTone", freq, ms, gain, type, pan);
        }
        catch
        {
            // Best-effort — never throw from a feedback path.
        }
    }

    private async ValueTask PlayChordAsync(double[] freqs, int ms, double gain)
    {
        if (_disposed) return;
        try
        {
            var module = await _module.Value;
            await module.InvokeVoidAsync("playChord", freqs, ms, gain);
        }
        catch
        {
            // Best-effort — never throw from a feedback path.
        }
    }

    private async ValueTask PlaySweepAsync(double fromHz, double toHz, int ms, double gain, string type)
    {
        if (_disposed) return;
        try
        {
            var module = await _module.Value;
            await module.InvokeVoidAsync("playSweep", fromHz, toHz, ms, gain, type);
        }
        catch
        {
            // Best-effort.
        }
    }

    private async ValueTask PlayArpeggioAsync(double[] freqs, int[] durationsMs, double gain, int[]? vibrate)
    {
        if (_disposed) return;
        try
        {
            var module = await _module.Value;
            await module.InvokeVoidAsync("playArpeggio", freqs, durationsMs, gain);
            if (vibrate is { Length: > 0 })
            {
                await module.InvokeVoidAsync("vibrate", vibrate);
            }
        }
        catch
        {
            // Best-effort.
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        _disposed = true;
        if (_module.IsValueCreated)
        {
            try
            {
                var module = await _module.Value;
                await module.DisposeAsync();
            }
            catch { /* module never loaded — fine */ }
        }
    }
}
