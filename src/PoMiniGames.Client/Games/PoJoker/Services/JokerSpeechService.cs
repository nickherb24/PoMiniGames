using Microsoft.Extensions.Logging;
using Microsoft.JSInterop;

namespace PoMiniGamesClient.Games.PoJoker;

/// <summary>
/// Text-to-speech via the Web Speech API with a British male voice preference. Interop entry
/// points live in <c>wwwroot/js/pojoker-speech-interop.js</c> under the <c>poJokerSpeech</c>
/// global. Failures are swallowed (narration is non-essential).
/// </summary>
public sealed class JokerSpeechService(IJSRuntime jsRuntime, ILogger<JokerSpeechService> logger)
{
    private readonly IJSRuntime _jsRuntime = jsRuntime;
    private readonly ILogger<JokerSpeechService> _logger = logger;
    private bool _moduleLoaded;

    /// <summary>
    /// Fetch the interop script on first use rather than from a &lt;script&gt; tag in
    /// index.html, where it cost every player 5 KB for a global only this game calls.
    /// The module assigns <c>window.poJokerSpeech</c> on evaluation, so importing it is
    /// what makes the calls below resolve. Repeat imports hit the browser's module cache.
    /// </summary>
    /// <remarks>
    /// Not guarded by a lock: Blazor WASM is single-threaded, so two callers cannot be
    /// inside this method at once. A concurrent-safe version would be pure ceremony here.
    /// </remarks>
    private async Task EnsureModuleAsync()
    {
        if (_moduleLoaded) return;
        await _jsRuntime.InvokeAsync<IJSObjectReference>("import", "./js/pojoker-speech-interop.js");
        _moduleLoaded = true;
    }

    public async Task SpeakAsync(string text, double rate = 1.0, double pitch = 1.0)
    {
        if (string.IsNullOrWhiteSpace(text)) return;
        try
        {
            await EnsureModuleAsync();
            await _jsRuntime.InvokeVoidAsync("poJokerSpeech.speak", text, rate, pitch);
        }
        catch (JSException ex) { _logger.LogWarning(ex, "Failed to speak text"); }
    }

    public async Task StopAsync()
    {
        try { await _jsRuntime.InvokeVoidAsync("poJokerSpeech.stop"); }
        catch (JSException ex) { _logger.LogWarning(ex, "Failed to stop speech"); }
    }

    public async Task<bool> IsSpeakingAsync()
    {
        try { return await _jsRuntime.InvokeAsync<bool>("poJokerSpeech.isSpeaking"); }
        catch (JSException) { return false; }
    }
}
