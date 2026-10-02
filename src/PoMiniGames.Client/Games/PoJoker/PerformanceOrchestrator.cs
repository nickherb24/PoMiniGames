using System.Net.Http;
using System.Net.Http.Json;
using PoMiniGamesClient.Services.Auth;
using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;
using PoMiniGames.Shared.Games.PoJoker;

namespace PoMiniGamesClient.Games.PoJoker;

/// <summary>
/// Orchestrates the autonomous performance loop for the Jester Stage (demo mode):
/// fetch joke → show setup → AI predicts punchline → reveal → transition, capped at 10 jokes.
/// Separates business logic from the UI component (single responsibility). Ported from the
/// standalone PoJoker app; API paths retargeted to the PoMiniGames host's <c>/api/joker/*</c>.
/// </summary>
public sealed class PerformanceOrchestrator : IAsyncDisposable
{
    private readonly HttpClient _http;
    private readonly JokerSpeechService _speechService;
    private readonly JokerAudioService _audioService;
    private readonly PerformanceSettings _settings;
    private CancellationTokenSource? _cts;
    private Task? _performanceLoopTask;
    private bool _isRunning;

    public string SessionId { get; } = GenerateMedievalAlias();

    private static string GenerateMedievalAlias()
    {
        string[] adjectives = ["Swift", "Bold", "Mighty", "Cunning", "Noble", "Witty", "Brave", "Fierce",
                                "Wise", "Jolly", "Merry", "Grand", "Iron", "Silver", "Golden", "Dark",
                                "Bright", "Grim", "Lucky", "Fair"];
        string[] titles = ["Jester", "Knight", "Fool", "Baron", "Herald", "Squire", "Bard", "Sage",
                           "Rogue", "Archer", "Mage", "Smith", "Drake", "Hawk", "Fox", "Wolf",
                           "Bear", "Raven", "Crane", "Swan"];
        var rng = Random.Shared;
        return $"{adjectives[rng.Next(adjectives.Length)]}{titles[rng.Next(titles.Length)]}-{Guid.NewGuid().ToString("N")[..4]}";
    }

    public PerformanceState CurrentState { get; private set; } = PerformanceState.Idle;
    public JokeDto? CurrentJoke { get; private set; }
    public JokeAnalysisDto? CurrentAnalysis { get; private set; }
    public int SessionTriumphs { get; private set; }
    public int SessionDefeats { get; private set; }
    public bool IsRunning => _isRunning;
    public List<int> SeenJokeIds { get; } = [];

    // Mood/category selection — set by JesterStage before starting.
    public string SelectedCategory { get; set; } = "Any";
    public bool SelectedSafeMode { get; set; }
    public string SelectedMoodLabel { get; set; } = "Royal Court";

    // Demo mode: 10 jokes per show.
    private const int MaxJokesPerShow = 10;
    public int JokesDisplayed { get; private set; }
    public bool IsShowComplete { get; private set; }
    public List<JokeAnalysisDto> TopJokes { get; } = [];

    /// <summary>
    /// True once the punchline text has been revealed on screen. Decoupled
    /// from <see cref="PerformanceState.RevealingPunchline"/> so the visual
    /// reveal can be locked to the moment the speech begins (see
    /// <c>RevealPunchlineAsync</c>) instead of flashing in immediately while
    /// the fanfare/breathing-beat still plays — that flash was the UI being
    /// out of sync with the audio.
    /// </summary>
    public bool PunchlineRevealed { get; private set; }

    // Error handling state.
    public bool ShowNetworkOverlay { get; private set; }
    public string NetworkStatusText { get; private set; } = "Searching for a path to the server...";
    public bool IsRetrying { get; private set; }
    public int RetryCount { get; private set; }

    public event Action? StateChanged;

    public PerformanceOrchestrator(
        HttpClient http,
        JokerSpeechService speechService,
        JokerAudioService audioService,
        PerformanceSettings? settings = null)
    {
        _http = http;
        _speechService = speechService;
        _audioService = audioService;
        _settings = settings ?? new PerformanceSettings();
        _settings.Validate();
    }

    public async Task StartAsync()
    {
        _isRunning = true;
        _cts = new CancellationTokenSource();

        try
        {
            await _audioService.InitializeAsync();
            _performanceLoopTask = RunPerformanceLoopAsync(_cts.Token);
            await _performanceLoopTask;
        }
        catch (OperationCanceledException)
        {
            // Expected when StopAsync() cancels the token.
        }
        finally
        {
            _isRunning = false;
            // Belt-and-braces: a cancelled run can leave a buffer-source cue
            // (drum roll, cymbal) ringing, and the orchestrator may have just
            // transitioned past one. Clear them so nothing bleeds into Idle.
            try { await _audioService.StopAllAsync(); } catch { /* non-essential */ }
            try { await _speechService.StopAsync(); } catch { /* non-essential */ }
            NotifyStateChanged();
        }
    }

    public async Task StopAsync()
    {
        _isRunning = false;
        _cts?.Cancel();
        CurrentState = PerformanceState.Idle;
        PunchlineRevealed = false;

        try { await _speechService.StopAsync(); }
        catch { /* ignore errors during stop */ }

        // Same teardown as the natural end-of-show: cancel any audio cue that
        // is still playing so the Idle screen is silent, not still ringing.
        try { await _audioService.StopAllAsync(); } catch { /* non-essential */ }

        if (_performanceLoopTask is not null)
        {
            try { await _performanceLoopTask; }
            catch (OperationCanceledException) { /* expected */ }
        }

        NotifyStateChanged();
    }

    public void ResetForNewShow()
    {
        CurrentState = PerformanceState.Idle;
        CurrentJoke = null;
        CurrentAnalysis = null;
        JokesDisplayed = 0;
        IsShowComplete = false;
        TopJokes.Clear();
        PunchlineRevealed = false;
        ShowNetworkOverlay = false;
        RetryCount = 0;
        NotifyStateChanged();
    }

    public async Task RetryNetworkAsync()
    {
        IsRetrying = true;
        RetryCount++;
        NotifyStateChanged();

        try { await Task.Delay(TimeSpan.FromMilliseconds(_settings.RetryDelayMilliseconds), _cts?.Token ?? CancellationToken.None); }
        catch (OperationCanceledException) { /* ignore if cancelled during retry delay */ }

        IsRetrying = false;
        ShowNetworkOverlay = false;
        NotifyStateChanged();
    }

    private async Task RunPerformanceLoopAsync(CancellationToken cancellationToken)
    {
        JokesDisplayed = 0;
        IsShowComplete = false;
        TopJokes.Clear();
        PunchlineRevealed = false;

        while (!cancellationToken.IsCancellationRequested && JokesDisplayed < MaxJokesPerShow)
        {
            try
            {
                await FetchJokeAsync(cancellationToken);
                if (cancellationToken.IsCancellationRequested || CurrentJoke == null) break;

                await ShowSetupAsync(cancellationToken);
                if (cancellationToken.IsCancellationRequested) break;

                await ShowAiGuessAsync(cancellationToken);
                if (cancellationToken.IsCancellationRequested) break;
                if (CurrentAnalysis is null) continue; // content-filtered — skip to next joke

                await RevealPunchlineAsync(cancellationToken);
                if (cancellationToken.IsCancellationRequested) break;

                JokesDisplayed++;
                if (CurrentAnalysis is not null)
                {
                    TopJokes.Add(CurrentAnalysis);
                }

                if (JokesDisplayed < MaxJokesPerShow)
                {
                    await TransitionAsync(cancellationToken);
                }

                // Tear down any leftover cue between jokes. Buffer-source sounds
                // (drum roll, cymbal) finish on `stop()`; oscillators (fanfare,
                // trombone) are already gone. Without this, the next joke's setup
                // narration could begin on top of a tail that was still ringing.
                try { await _audioService.StopAllAsync(); } catch { /* non-essential */ }
            }
            catch (HttpRequestException)
            {
                await HandleNetworkErrorAsync(cancellationToken);
            }
            catch (OperationCanceledException)
            {
                throw; // expected during stop
            }
            catch (Exception)
            {
                try { await Task.Delay(3000, cancellationToken); }
                catch (OperationCanceledException) { throw; }
            }
        }

        if (JokesDisplayed >= MaxJokesPerShow && !cancellationToken.IsCancellationRequested)
        {
            IsShowComplete = true;
            CurrentState = PerformanceState.Complete;
            PunchlineRevealed = false;
            NotifyStateChanged();
        }
    }

    private async Task FetchJokeAsync(CancellationToken cancellationToken)
    {
        CurrentState = PerformanceState.Fetching;
        NotifyStateChanged();

        var safeMode = SelectedSafeMode ? "true" : "false";
        var excludeIdsQuery = SeenJokeIds.Count > 0
            ? string.Join("", SeenJokeIds.TakeLast(50).Select(id => $"&excludeIds={id}"))
            : "";

        HttpResponseMessage? response = null;
        try
        {
            response = await _http.GetAsync(
                $"/api/joker/fetch?safeMode={safeMode}&category={Uri.EscapeDataString(SelectedCategory)}{excludeIdsQuery}",
                cancellationToken);

            if (!response.IsSuccessStatusCode)
            {
                // Surface the failure so the operator sees it instead of stale state.
                // 401 = session expired (e.g. cookie cleared mid-show); 503 = upstream joke API down;
                // everything else is treated as transient.
                var code = (int)response.StatusCode;
                NetworkStatusText = code switch
                {
                    401 => "The royal seal is missing — sign in again to continue the show.",
                    403 => "Access to the jester's joke vault was denied.",
                    404 => "The jester has no joke for that category.",
                    503 => "The comedic muses are off duty (upstream joke API unreachable).",
                    _ => $"The courier returned {code}; will try again in a moment."
                };
                ShowNetworkOverlay = true;
                NotifyStateChanged();
                await Task.Delay(TimeSpan.FromMilliseconds(_settings.RetryDelayMilliseconds), cancellationToken);
                return;
            }

            CurrentJoke = await response.Content.ReadFromJsonAsync(
                ApiJsonContext.Default.JokeDto, cancellationToken);
            if (CurrentJoke is not null)
            {
                SeenJokeIds.Add(CurrentJoke.Id);
            }
        }
        catch (HttpRequestException)
        {
            // Network blip — let the catch in RunPerformanceLoopAsync surface the overlay.
            throw;
        }
        finally
        {
            response?.Dispose();
        }
    }

    private async Task ShowSetupAsync(CancellationToken cancellationToken)
    {
        CurrentState = PerformanceState.ShowingSetup;
        NotifyStateChanged();

        if (CurrentJoke is not null)
        {
            // Belt-and-braces: ensure no leftover cue from the previous phase
            // is still ringing when the setup speech begins. Without this, a
            // 2s drum roll that finished its JS-side promise 5ms before
            // speech starts could still produce audible noise under the first
            // syllable (Web Audio's `stop()` is bounded by the audio clock,
            // not the wall clock, and they drift by several ms).
            try { await _audioService.StopAllAsync(); } catch { /* non-essential */ }
            await _speechService.SpeakAsync(CurrentJoke.Setup, rate: 0.9, pitch: 1.1);
        }

        await Task.Delay(TimeSpan.FromSeconds(_settings.SetupDurationSeconds), cancellationToken);
    }

    private async Task ShowAiGuessAsync(CancellationToken cancellationToken)
    {
        CurrentState = PerformanceState.ShowingAiGuess;
        CurrentAnalysis = null;
        NotifyStateChanged();

        // Drum roll in parallel with the analyze call. We tear it down on the
        // path out so it can't bleed into the next phase — without this a 1.9s
        // drum roll surviving a fast analysis response would overlap the
        // "Jester guesses:" speech that begins a few ms later.
        var drumRollTask = _audioService.PlayDrumRollAsync(2.0, 0.4);

        var request = new HttpRequestMessage(HttpMethod.Post, "/api/joker/analyze");
        request.Headers.Add("X-Session-Id", SessionId);
        request.Content = JsonContent.Create(CurrentJoke, ApiJsonContext.Default.JokeDto);

        // Hard timeout so a slow model can't pin the demo on "Jester is thinking…".
        // WaitAsync throws TimeoutException on expiry; the catch below surfaces a
        // shrug-line analysis so the show keeps moving. The drum-roll and any
        // already-buffered audio still complete before we move on.
        HttpResponseMessage? analysisResponse = null;
        try
        {
            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeoutCts.CancelAfter(TimeSpan.FromSeconds(_settings.AnalysisTimeoutSeconds));
            analysisResponse = await _http.SendAsync(request, timeoutCts.Token);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            CurrentAnalysis = FallbackAnalysis();
        }
        catch (HttpRequestException)
        {
            CurrentAnalysis = FallbackAnalysis();
        }

        // Content filter (451) — skip the joke silently.
        if (analysisResponse is not null && (int)analysisResponse.StatusCode == 451)
        {
            analysisResponse.Dispose();
            try { await drumRollTask; } catch { /* cancellation is fine */ }
            try { await _audioService.StopAllAsync(); } catch { /* non-essential */ }
            return;
        }

        if (analysisResponse is not null && analysisResponse.IsSuccessStatusCode)
        {
            CurrentAnalysis = await analysisResponse.Content.ReadFromJsonAsync(
                ApiJsonContext.Default.JokeAnalysisDto, cancellationToken);
        }
        analysisResponse?.Dispose();

        // Cut the drum roll hard before the speech starts. The JS-side
        // `setTimeout(resolve, 2000)` is wall-clock and can race ahead of the
        // audio clock by a few ms on slower devices — without this explicit
        // stop the speech would begin on top of the drum roll's tail.
        try { await _audioService.StopAllAsync(); } catch { /* non-essential */ }
        await drumRollTask;
        NotifyStateChanged();

        if (CurrentAnalysis?.AiPunchline is not null)
        {
            await _speechService.SpeakAsync($"The Jester guesses: {CurrentAnalysis.AiPunchline}", rate: 0.9, pitch: 1.0);
            // A titter, not a laugh — the audience is reacting to the Jester's guess,
            // and the real laugh is reserved for the punchline itself. Using the full
            // 'laugh' here would spend the routine's biggest beat two phases early.
            try { await _audioService.PlayGiggleAsync(0.35); }
            catch { /* decoration only */ }
        }

        await Task.Delay(TimeSpan.FromSeconds(_settings.PredictionDurationSeconds), cancellationToken);
    }

    /// <summary>
    /// The shrug-line the Jester delivers when the analyze endpoint times out or errors.
    /// Scored as a defeat (IsTriumph=false, zeroed rating) so the running triumph tally
    /// reflects what the audience actually saw: a joke the Jester could not land.
    /// </summary>
    private JokeAnalysisDto FallbackAnalysis()
    {
        // OriginalJoke is a required DTO field; the fallback is rendered but never
        // re-serialized to the server, so a placeholder is acceptable. If a real
        // joke is on stage we reuse it (cheap, accurate shape); otherwise emit the
        // smallest valid DTO the C# required-modifier will accept.
        var original = CurrentJoke ?? new JokeDto { Id = 0 };
        return new JokeAnalysisDto
        {
            OriginalJoke = original,
            AiPunchline = "…the jester has nothing to add.",
            IsTriumph = false,
            Rating = new JokeRatingDto { Commentary = "Analyzer timed out before the punchline could be guessed." },
        };
    }

    private async Task RevealPunchlineAsync(CancellationToken cancellationToken)
    {
        // Flip into the reveal state but DO NOT show the punchline text yet.
        // The fanfare + a brief breathing beat play first; without this guard,
        // the punchline text flashed on screen 2+ seconds before the speech
        // that was supposed to accompany it — the audience read the punchline
        // and then heard it after the joke had already landed.
        CurrentState = PerformanceState.RevealingPunchline;
        PunchlineRevealed = false;
        NotifyStateChanged();

        var isTriumph = CurrentAnalysis?.IsTriumph == true;
        if (isTriumph)
        {
            SessionTriumphs++;
        }
        else
        {
            SessionDefeats++;
        }

        // Run the pre-roll audio in parallel with the breathing beat. We
        // await BOTH (Task.WhenAll) so the speech only starts after the
        // longer of the two — the fanfare (~1.0s) typically wins, the
        // trombone (~1.6s) wins on defeats — and the pre-roll cannot bleed
        // into the speech.
        Task preRoll = isTriumph
            ? _audioService.PlayFanfareAsync(0.5)
            : _audioService.PlayTromboneAsync(0.5);
        var breathingBeat = Task.Delay(
            TimeSpan.FromSeconds(_settings.PunchlineDelaySeconds), cancellationToken);
        await Task.WhenAll(preRoll, breathingBeat).WaitAsync(cancellationToken);

        // Hard-cut any residual pre-roll audio (oscillators finish on their
        // envelope but the bus takes a few ms to fully release under the
        // reverb send; cutting the source guarantees the speech opens on a
        // silent bus).
        try { await _audioService.StopAllAsync(); } catch { /* non-essential */ }

        if (CurrentJoke?.Punchline is not null)
        {
            // NOW the punchline text appears, in lockstep with the speech.
            // NotifyStateChanged first so the UI has the text on screen by the
            // time the first syllable lands; the speech service kicks off
            // immediately after.
            PunchlineRevealed = true;
            NotifyStateChanged();
            await _speechService.SpeakAsync(
                $"The actual punchline is: {CurrentJoke.Punchline}", rate: 0.85, pitch: 1.0);
        }

        // The audience reacts. This is the beat the whole routine builds to and it
        // was silent: the drum roll set it up, the fanfare or trombone called the
        // verdict, the speech delivered the line — and then nothing. A triumph gets
        // the laugh (with its coin burst); a flop gets the rimshot sting, which is
        // the correct comedy grammar for a joke that died and is funnier than
        // silence. Fired after the speech rather than under it so it reads as a
        // reaction to the punchline instead of an interruption of it.
        try
        {
            if (isTriumph) await _audioService.PlayLaughterAsync(0.5);
            else await _audioService.PlayRimshotAsync(0.5);
        }
        catch
        {
            // Reaction audio is decoration — never let it break the routine.
        }

        // Final hold so the player can read the punchline after the speech has
        // finished (the speech's own length is additional time on top of this).
        await Task.Delay(TimeSpan.FromSeconds(_settings.PunchlineDurationSeconds), cancellationToken);
    }

    private async Task TransitionAsync(CancellationToken cancellationToken)
    {
        CurrentState = PerformanceState.Transitioning;
        NotifyStateChanged();
        await Task.Delay(TimeSpan.FromSeconds(_settings.TransitionDurationSeconds), cancellationToken);
    }

    private async Task HandleNetworkErrorAsync(CancellationToken cancellationToken)
    {
        NetworkStatusText = "The courier was lost on the road...";
        ShowNetworkOverlay = true;
        NotifyStateChanged();

        while (ShowNetworkOverlay && !cancellationToken.IsCancellationRequested)
        {
            try { await Task.Delay(TimeSpan.FromMilliseconds(_settings.UserInteractionPollMilliseconds), cancellationToken); }
            catch (OperationCanceledException) { break; }
        }
    }

    private void NotifyStateChanged() => StateChanged?.Invoke();

    public async ValueTask DisposeAsync()
    {
        await StopAsync();
        _cts?.Dispose();
    }
}
