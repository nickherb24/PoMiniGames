using Microsoft.Extensions.Logging;
using Microsoft.JSInterop;

namespace PoMiniGamesClient.Games.PoJoker;

/// <summary>
/// Plays audio effects via the Web Audio API (programmatic drum roll, trombone, fanfare,
/// cymbal). Interop entry points live in <c>wwwroot/js/pojoker-audio-interop.js</c> under the
/// <c>poJokerAudio</c> global. Failures are swallowed (audio is non-essential).
/// </summary>
public sealed class JokerAudioService(IJSRuntime jsRuntime, ILogger<JokerAudioService> logger)
{
    private readonly IJSRuntime _jsRuntime = jsRuntime;
    private readonly ILogger<JokerAudioService> _logger = logger;
    private bool _initialized;

    public async Task InitializeAsync()
    {
        if (_initialized) return;
        try
        {
            // Fetch the interop script here rather than from a <script> tag in
            // index.html. It used to load on every page in the app — 9 KB parsed
            // by every player, for a global only this one game ever calls. The
            // module assigns window.poJokerAudio on evaluation, so importing it
            // is what makes the calls below resolve; the browser's module cache
            // makes a repeat import free.
            await _jsRuntime.InvokeAsync<IJSObjectReference>("import", "./js/pojoker-audio-interop.js");
            await _jsRuntime.InvokeVoidAsync("poJokerAudio.init");
            _initialized = true;
        }
        catch (JSException ex)
        {
            _logger.LogWarning(ex, "Failed to initialize PoJoker audio");
        }
    }

    public async Task PlayDrumRollAsync(double duration = 2.0, double volume = 0.5)
    {
        try { await _jsRuntime.InvokeVoidAsync("poJokerAudio.playDrumRoll", duration, volume); }
        catch (JSException ex) { _logger.LogWarning(ex, "Failed to play drum roll"); }
    }

    public async Task PlayTromboneAsync(double volume = 0.6)
    {
        try { await _jsRuntime.InvokeVoidAsync("poJokerAudio.playTrombone", volume); }
        catch (JSException ex) { _logger.LogWarning(ex, "Failed to play trombone"); }
    }

    public async Task PlayFanfareAsync(double volume = 0.5)
    {
        try { await _jsRuntime.InvokeVoidAsync("poJokerAudio.playFanfare", volume); }
        catch (JSException ex) { _logger.LogWarning(ex, "Failed to play fanfare"); }
    }

    public async Task PlayCymbalAsync(double volume = 0.4)
    {
        try { await _jsRuntime.InvokeVoidAsync("poJokerAudio.playCymbal", volume); }
        catch (JSException ex) { _logger.LogWarning(ex, "Failed to play cymbal"); }
    }

    /// <summary>
    /// The audience reaction to a punchline that landed — a filtered noise swell
    /// with a wobbling voice over it, plus a coin burst.
    /// </summary>
    /// <remarks>
    /// <b>This was implemented and unreachable.</b> <c>poJokerAudio.playLaughter</c>
    /// has existed in the interop module the whole time (and is one of only two
    /// places in the app that routed through the shared cue vocabulary), but it was
    /// never added to this interface, so no C# could call it. The effect was that
    /// PoJoker built a whole comedy stage — drum roll, fanfare, trombone, speech —
    /// in front of an audience that never laughed.
    /// </remarks>
    public async Task PlayLaughterAsync(double volume = 0.45)
    {
        try { await _jsRuntime.InvokeVoidAsync("poJokerAudio.playLaughter", volume); }
        catch (JSException ex) { _logger.LogWarning(ex, "Failed to play laughter"); }
    }

    /// <summary>
    /// The ba-dum-tss sting for a joke that died. Unreachable for the same reason
    /// as <see cref="PlayLaughterAsync"/>.
    /// </summary>
    public async Task PlayRimshotAsync(double volume = 0.5)
    {
        try { await _jsRuntime.InvokeVoidAsync("poJokerAudio.playRimshot", volume); }
        catch (JSException ex) { _logger.LogWarning(ex, "Failed to play rimshot"); }
    }

    /// <summary>
    /// The titter. Goes straight to the cue vocabulary rather than through the
    /// PoJoker interop module: 'giggle' needs no bespoke synthesis on top of the
    /// table entry, and adding a pass-through to poJokerAudio for it would be a
    /// wrapper around a wrapper.
    /// </summary>
    public async Task PlayGiggleAsync(double volume = 0.4)
    {
        try
        {
            await _jsRuntime.InvokeVoidAsync("PoCue.fire", "pojoker", "giggle", new { gain = volume });
        }
        catch (JSException ex) { _logger.LogWarning(ex, "Failed to play giggle"); }
    }

    /// <summary>
    /// Stop every currently-playing cue immediately. Oscillator cues (fanfare,
    /// trombone) play out on their envelope so they don't need cancellation,
    /// but buffer-source cues (drum roll, cymbal) would otherwise ring across
    /// the next state or after Stop. Safe to call when nothing is playing.
    /// </summary>
    public async Task StopAllAsync()
    {
        try { await _jsRuntime.InvokeVoidAsync("poJokerAudio.stopAll"); }
        catch (JSException ex) { _logger.LogWarning(ex, "Failed to stop PoJoker audio"); }
    }
}
