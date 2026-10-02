using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.Routing;
using Microsoft.JSInterop;
using PoMiniGames.Shared.Games;
using PoMiniGamesClient.Models;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGamesClient.Games.PoRacer;

public partial class PoRacerPage
{
    /// <summary>
    /// The online race in the address (<c>?code=</c>), read from the URL by <see cref="ApplyRouteAsync"/>.
    /// Not a [SupplyParameterFromQuery] parameter: see that method for why the page cannot wait
    /// for the framework to set it.
    /// </summary>
    private string? MatchCode { get; set; }
    private enum RacePhase { Start, Racing, Finished }
    private enum RaceMode { Solo, Online, Demo }
    /// <summary>Numbers per car in a pushed snapshot; js/poracer/index.js STRIDE reads the same fourteen.</summary>
    private const int Stride = 14;
    private RacePhase _phase;
    private RaceMode _mode;
    private PoRacerSession? _session;
    private LobbyClient<PoRacerLobbyPlayer>? _lobby;
    private readonly CancellationTokenSource _lifetime = new();
    private CancellationTokenSource? _connecting;
    private DotNetObjectReference<PoRacerPage>? _reference;
    private ElementReference _resumeButton;
    private bool _disposed, _engineReady, _isStarting, _isDemo, _trial, _pauseOpen, _focusResume, _showResults;
    // The opening card (GameIntro) gates everything: no lobby seat is taken and no race is
    // joined until it is dismissed. _reopenIntro is the card coming back on purpose (Back to
    // start, a failed start, leaving the lobby), where a "don't show this again" must not
    // dismiss it the moment it opens; _routed tells the first route apart from a later one.
    private bool _introDone, _reopenIntro, _routed;
    private string _playerName = "", _selectedTrackId = PoRacerCatalog.DefaultTrackId, _difficulty = "medium";
    private string? _error, _connectionStatus, _submitStatus;
    private string _announcement = "", _gameCode = "";
    // What the race in progress actually is. The start card can change underneath it (the
    // server picks an online race's track), and results must describe the race that was run.
    private string _raceTrackId = PoRacerCatalog.DefaultTrackId;
    private bool _raceTrial, _raceOnline;
    private double _previousBest;
    private int? _localCarId;
    private int _totalLaps = PoRacerCatalog.TotalLaps;
    private double _elapsed;
    private int _countdown, _countdownMs, _hudKey;
    private bool _raceStarted;
    private IReadOnlyList<PoRacerCarState> _cars = [];
    private IReadOnlyList<PoRacerCarInfo> _roster = [];
    private Dictionary<string, double> _bests = [];
    private PoRacerCarState? Player => _cars.FirstOrDefault(c => c.Id == _localCarId);
    private PoRacerCarCustomization _customization = PoRacerCarCustomization.Default;
    private PoRacerFinalResult? _result;
    private PoRacerScoreDto? _score;
    private bool _submitting;

    /// <summary>Start lamps lit, 0-5: one per half second, all five held for the last half second.</summary>
    private int Lit => _raceStarted ? 0 : Math.Clamp((3000 - _countdownMs) / 500, 0, 5);
    /// <summary>Only a solo race can stop its clock; a shared one keeps running under the menu.</summary>
    private bool CanPause => !_isDemo && !_raceOnline;
    private string LobbyTrackId =>
        _lobby?.State?.Players.FirstOrDefault(p => p.ConnectionId == _lobby.State.HostConnectionId)?.TrackId ?? PoRacerCatalog.DefaultTrackId;

    protected override void OnInitialized()
    {
        _playerName = PlayerNameService.GetPlayerName();
        _selectedTrackId = PoRacerCatalog.GetTrack(LocalStorageService.GetItem<string>("PoRacer.SelectedTrack")).Id;
        _customization = PoRacerPreferences.LoadCustomization();
        _difficulty = PoRacerPreferences.LoadDifficulty();
        _trial = PoRacerPreferences.LoadTrial();
        _bests = PoRacerPreferences.LoadBests();
        GameStats.SaveLastPlayedGame("poracer");
        Nav.LocationChanged += OnLocationChanged;
    }

    protected override Task OnInitializedAsync() => ApplyRouteAsync();

    private void OnLocationChanged(object? sender, LocationChangedEventArgs e) => _ = InvokeAsync(ApplyRouteAsync);

    /// <summary>
    /// Read the mode and the race code off the address. The four routes are one component with
    /// no route parameters, so moving between /1player, /multi and /demo changes nothing the
    /// framework would call OnParametersSet for (a query parameter is only re-supplied when
    /// the query string itself changes). The tabs therefore did nothing at all in-app; this
    /// listens for the navigation itself.
    /// </summary>
    private async Task ApplyRouteAsync()
    {
        var uri = new Uri(Nav.Uri);
        // On the way out to another page: this component is about to be disposed.
        if (_disposed || !uri.AbsolutePath.StartsWith("/poracer", StringComparison.OrdinalIgnoreCase)) return;
        MatchCode = System.Web.HttpUtility.ParseQueryString(uri.Query)["code"];
        var mode = uri.AbsolutePath.Contains("/poracer/demo", StringComparison.OrdinalIgnoreCase) ? RaceMode.Demo
            : uri.AbsolutePath.Contains("/poracer/multi", StringComparison.OrdinalIgnoreCase) || !string.IsNullOrWhiteSpace(MatchCode) ? RaceMode.Online
            : RaceMode.Solo;
        var changed = mode != _mode;
        _mode = mode;
        // Another mode of this page, reached in place (leaving the lobby lands on the solo
        // card): that mode's own card opens.
        if (changed && _routed) ReopenIntro();
        _routed = true;
        _isDemo = mode == RaceMode.Demo;
        if (_engineReady && changed && _phase != RacePhase.Start) await ResetAsync();
        await SyncModeAsync();
        if (!_disposed) StateHasChanged();
    }

    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        if (_focusResume)
        {
            _focusResume = false;
            try { await _resumeButton.FocusAsync(); } catch (JSException) { /* the menu closed again before it rendered */ }
        }
        if (!firstRender) return;
        _reference = DotNetObjectReference.Create(this);
        try
        {
            _engineReady = await JS.InvokeAsync<bool>("loadEngine", "poracer");
            if (!_engineReady) { _error = "The track could not load. Reload this page to try again."; StateHasChanged(); return; }
            await JS.InvokeVoidAsync("PoRacer.start", "racerCanvas", _reference);
            StateHasChanged();
            await SyncModeAsync();
        }
        catch (JSException)
        {
            _error = "The track could not load. Reload this page to try again.";
            StateHasChanged();
        }
    }

    /// <summary>
    /// Bring the connections in line with the tab being shown: the Online tab holds a lobby seat
    /// (until its race starts); a solo race, a demo and a joined online race start.
    /// </summary>
    private async Task SyncModeAsync()
    {
        var wantsLobby = _introDone && _mode == RaceMode.Online && string.IsNullOrWhiteSpace(MatchCode) && _phase == RacePhase.Start;
        if (wantsLobby) await OpenLobbyAsync(); else await CloseLobbyAsync();
        if (!_introDone || !_engineReady || _phase != RacePhase.Start || _isStarting) return;
        if (_isDemo) Kiosk.SetCurrent("poracer-demo");
        // Everything but the lobby races as soon as the card is gone and the track is loaded,
        // whichever comes second.
        if (!wantsLobby) await StartRaceAsync();
    }

    // ── Online lobby ──────────────────────────────────────────────────────

    private async Task OpenLobbyAsync()
    {
        if (_lobby is not null || _disposed) return;
        var lobby = _lobby = new LobbyClient<PoRacerLobbyPlayer>(Endpoints, "poracer/lobby-hub");
        lobby.StateChanged += _ => InvokeAsync(StateHasChanged);
        lobby.ConnectionChanged += _ => InvokeAsync(StateHasChanged);
        lobby.EventReceived += ev => ToastService.Show(ev.Message, ev.Kind == "left" ? ToastType.Warning : ToastType.Info);
        // The code goes in the address so a reload during the race rejoins it (seats are bound
        // to the claim identity) instead of landing back in a lobby that has already started.
        lobby.GameStarted += code => InvokeAsync(() => Nav.NavigateTo($"/poracer/multi?code={Uri.EscapeDataString(code)}"));
        try
        {
            await lobby.ConnectAndJoinAsync(AuthState.User?.DisplayName ?? "Player", !AuthState.IsAuthenticated);
        }
        catch (Exception ex) when (ex is HttpRequestException or InvalidOperationException or Microsoft.AspNetCore.SignalR.HubException or OperationCanceledException)
        {
            ToastService.Show("Server unavailable. Please try again shortly.", ToastType.Error);
        }
        if (!_disposed) StateHasChanged();
    }

    private async Task CloseLobbyAsync()
    {
        if (_lobby is not { } lobby) return;
        _lobby = null;
        await lobby.DisposeAsync();
    }

    private Task PickLobbyTrackAsync(string trackId) => _lobby?.SendAsync("PickTrack", trackId) ?? Task.CompletedTask;

    private async Task LeaveLobbyAsync()
    {
        if (_lobby is { } lobby) await lobby.LeaveLobbyAsync();
        Nav.NavigateTo("/poracer/1player");
    }

    // ── Start card ────────────────────────────────────────────────────────

    private string IntroObjective => _mode switch
    {
        RaceMode.Demo => $"Eight bots, {PoRacerCatalog.TotalLaps} laps, nothing to drive.",
        RaceMode.Online => "Race the room: up to 8 drivers, bots in the empty seats. Your best lap goes on the board.",
        _ => $"{PoRacerCatalog.TotalLaps} laps round the circuit. Finish first, and set a lap worth keeping: your best one goes on the board.",
    };

    private string? IntroStartLabel => _mode switch
    {
        RaceMode.Demo => null,
        RaceMode.Online => string.IsNullOrWhiteSpace(MatchCode) ? "Join lobby" : "Join race",
        _ => "Start race",
    };

    private async Task OnIntroStartAsync()
    {
        _introDone = true;
        _reopenIntro = false;
        StateHasChanged();
        await SyncModeAsync();
    }

    private void ReopenIntro()
    {
        _introDone = false;
        _reopenIntro = true;
    }

    private void SelectTrack(string trackId)
    {
        _selectedTrackId = PoRacerCatalog.GetTrack(trackId).Id;
        LocalStorageService.SetItem("PoRacer.SelectedTrack", _selectedTrackId);
    }

    private void SetTrial(bool trial) => PoRacerPreferences.SaveTrial(_trial = trial);

    private void SetDifficulty(string tier) => PoRacerPreferences.SaveDifficulty(_difficulty = tier);

    private async Task StartRaceAsync()
    {
        if (_isStarting || !_engineReady || _disposed) return;
        _isStarting = true;
        _error = null;
        _connecting = CancellationTokenSource.CreateLinkedTokenSource(_lifetime.Token);
        _connecting.CancelAfter(TimeSpan.FromSeconds(10));
        var session = new PoRacerSession(Endpoints);
        _session = session;
        session.Joined += snapshot => InvokeAsync(() => ApplyJoinAsync(snapshot));
        session.SnapshotReceived += snapshot => InvokeAsync(() => ApplySnapshotAsync(snapshot));
        session.RosterChanged += roster => InvokeAsync(() => ApplyRosterAsync(roster));
        session.Finished += result => InvokeAsync(() => FinishAsync(result));
        session.StatusChanged += status => InvokeAsync(() => { if (!_disposed) { _connectionStatus = status; StateHasChanged(); } });
        try
        {
            _raceOnline = !_isDemo && !string.IsNullOrWhiteSpace(MatchCode);
            _raceTrial = !_isDemo && !_raceOnline && _trial;
            _raceTrackId = _selectedTrackId;
            _gameCode = _isDemo ? "DEMO" : _raceOnline ? MatchCode! : "solo-" + Guid.NewGuid().ToString("N");
            await JS.InvokeVoidAsync("PoRacer.start", "racerCanvas", _reference);
            var options = new PoRacerJoinOptions
            {
                Mode = _raceTrial ? "trial" : "race",
                Difficulty = _difficulty,
                ColorHex = _customization.ColorHex,
                Livery = _customization.LiveryPattern,
            };
            await session.ConnectAsync(_gameCode, !_isDemo, _selectedTrackId, options, _connecting.Token);
            if (_result is null) _phase = RacePhase.Racing;
            await JS.InvokeVoidAsync("PoRacer.setInputEnabled", !_isDemo && _result is null);
        }
        catch (OperationCanceledException)
        {
            if (!_disposed) _error = "The connection timed out. Try starting the race again.";
            await session.DisposeAsync();
            if (ReferenceEquals(_session, session)) _session = null;
        }
        catch (Exception ex) when (ex is HttpRequestException or InvalidOperationException or Microsoft.AspNetCore.SignalR.HubException)
        {
            _error = "Could not join this race. Try again from the Online tab.";
            await session.DisposeAsync();
            if (ReferenceEquals(_session, session)) _session = null;
        }
        finally
        {
            _connecting?.Dispose();
            _connecting = null;
            _isStarting = false;
            // The start failed: the card comes back, with the reason on it.
            if (_error is not null && _phase == RacePhase.Start) ReopenIntro();
            if (!_disposed) StateHasChanged();
        }
    }

    // ── Race ──────────────────────────────────────────────────────────────

    private async Task ApplyJoinAsync(PoRacerRaceSnapshot snapshot)
    {
        if (_disposed) return;
        _localCarId = snapshot.LocalCarId;
        if (snapshot.Static is { } world)
        {
            _raceTrackId = world.TrackId;
            _totalLaps = world.TotalLaps;
            await JS.InvokeVoidAsync("PoRacer.setStatic", world.CenterXY, world.TrackWidth, world.WallsXY,
                world.BoostPads, world.SurfaceZones, world.Theme, world.TotalLaps);
            await ApplyRosterAsync(world.Roster);
        }
        await ApplySnapshotAsync(snapshot);
    }

    private async Task ApplyRosterAsync(IReadOnlyList<PoRacerCarInfo> roster)
    {
        if (_disposed) return;
        _roster = roster;
        await JS.InvokeVoidAsync("PoRacer.setRoster", roster, _localCarId);
        StateHasChanged();
    }

    private async Task ApplySnapshotAsync(PoRacerRaceSnapshot snapshot)
    {
        if (_disposed) return;
        _cars = snapshot.Cars;
        _elapsed = snapshot.ElapsedRaceTime;
        _countdown = snapshot.CountdownSeconds;
        _countdownMs = snapshot.CountdownMs;
        _raceStarted = snapshot.Started;

        // One flat array instead of eight objects: this crosses the interop boundary twenty
        // times a second. Names and paint went once, in the roster.
        var flat = new double[_cars.Count * Stride];
        for (var i = 0; i < _cars.Count; i++)
        {
            var c = _cars[i];
            var o = i * Stride;
            flat[o] = c.X; flat[o + 1] = c.Y; flat[o + 2] = c.Heading; flat[o + 3] = c.Speed;
            flat[o + 4] = c.BoostGlow; flat[o + 5] = c.SkidIntensity; flat[o + 6] = c.Damage;
            flat[o + 7] = c.Surface == "sand" ? 1 : 0;
            flat[o + 8] = c.Position; flat[o + 9] = c.Lap; flat[o + 10] = c.Finished ? 1 : 0;
            flat[o + 11] = c.Drafting ? 1 : 0; flat[o + 12] = c.Drift; flat[o + 13] = c.BoostTimer;
        }
        var me = Player;
        var running = snapshot.Started && !snapshot.Paused && !snapshot.Finished;
        await JS.InvokeVoidAsync("PoRacer.push", snapshot.ServerTimeMs, snapshot.ElapsedRaceTime,
            me?.CurrentLapSeconds ?? 0, snapshot.CountdownMs, running, flat);
        if (_raceStarted) await UpdateAudioAsync();

        // Speed and the two running clocks are written by the engine straight into the HUD,
        // so the page only has to render when something a person would call a change happens:
        // a lamp, a place, a lap, a lap time. That is a handful of renders a lap, not 20 Hz.
        var key = new HashCode();
        key.Add(_raceStarted); key.Add(Lit); key.Add(_countdown); key.Add(_elapsed < 0.9);
        foreach (var c in _cars) { key.Add(c.Position); key.Add(c.Lap); key.Add(c.Finished); }
        key.Add(me?.LastLapSeconds); key.Add(me?.BestLapSeconds);
        var hud = key.ToHashCode();
        if (hud == _hudKey) return;
        _hudKey = hud;
        StateHasChanged();
    }

    private async Task TogglePauseAsync()
    {
        if (_phase != RacePhase.Racing || _disposed) return;
        _pauseOpen = !_pauseOpen;
        _focusResume = _pauseOpen;
        await JS.InvokeVoidAsync("PoRacer.setInputEnabled", !_pauseOpen && !_isDemo);
        if (CanPause && _session is { } session) await session.SetPausedAsync(_pauseOpen);
        StateHasChanged();
    }

    [JSInvokable]
    public Task OnPauseKey() => InvokeAsync(TogglePauseAsync);

    private async Task FinishAsync(PoRacerFinalResult result)
    {
        if (_disposed || _result is not null) return;
        _result = result;
        _phase = RacePhase.Finished;
        _pauseOpen = false;
        await JS.InvokeVoidAsync("PoRacer.setInputEnabled", false);
        if (_isDemo)
        {
            Kiosk.MarkFinished();
            StateHasChanged();
            return;
        }
        // The chequered wipe and the camera pulling back over the circuit run while the
        // result is recorded and the lap is saved; the results arrive when both are done.
        var hold = Task.Delay(await JS.InvokeAsync<int>("PoRacer.finish"), _lifetime.Token);
        StateHasChanged();

        var mine = result.Standings.FirstOrDefault(s => s.CarId == _localCarId);
        if (mine is not null)
        {
            // A time trial has no one to beat, so it moves no win/loss record.
            if (!_raceTrial)
            {
                var tier = _raceOnline ? Difficulty.Medium : Enum.Parse<Difficulty>(_difficulty, ignoreCase: true);
                await GameResults.RecordAsync("poracer", _playerName, tier, mine.Position == 1 ? GameResult.Win : GameResult.Loss);
            }
            if (double.IsFinite(mine.BestLapSeconds) && mine.BestLapSeconds > 0)
            {
                _previousBest = PoRacerPreferences.SaveBest(_raceTrackId, mine.BestLapSeconds);
                _bests = PoRacerPreferences.LoadBests();
                // The server stores the lap it timed for this race code; these numbers only
                // have to pass validation and tell it which race is meant.
                _score = new PoRacerScoreDto
                {
                    BestLapSeconds = mine.BestLapSeconds,
                    FinalPosition = mine.Position,
                    TrackId = _raceTrackId,
                    GameCode = _gameCode,
                    AchievedAtUtc = result.FinishedAtUtc
                };
            }
            await SubmitScoreAsync();
        }
        try { await hold; } catch (OperationCanceledException) { return; }
        // Restarted (or left) during the hold: these results belong to a race that is gone.
        if (_disposed || !ReferenceEquals(_result, result)) return;
        await JS.InvokeVoidAsync("PoRacer.reveal", _reference);
    }

    /// <summary>Called by the engine from inside its View Transition, so the results are the "after" picture.</summary>
    [JSInvokable]
    public void RevealResults()
    {
        if (_disposed || _result is null) return;
        _showResults = true;
        StateHasChanged();
    }

    private async Task SubmitScoreAsync()
    {
        if (_submitting || _score is null || _submitStatus is "Saved" or "Queued") return;
        _submitting = true;
        _submitStatus = "Saving";
        StateHasChanged();
        try
        {
            var submitted = await Api.SubmitPoRacerScoreAsync(_score, _lifetime.Token);
            if (submitted.IsSaved) _submitStatus = "Saved";
            else if (submitted.ShouldRetry)
            {
                ScoreSync.EnqueuePoRacer(_score);
                _submitStatus = "Queued";
            }
            else _submitStatus = "Rejected";
        }
        catch (OperationCanceledException) when (_lifetime.IsCancellationRequested)
        {
            ScoreSync.EnqueuePoRacer(_score);
        }
        finally { _submitting = false; if (!_disposed) StateHasChanged(); }
    }

    [JSInvokable]
    public Task OnInputChange(bool up, bool down, bool left, bool right, bool space, double steer, double throttle, double brake) =>
        _session?.SendInputAsync(new PoRacerInput
        {
            Up = up,
            Down = down,
            Left = left,
            Right = right,
            Space = space,
            Steer = steer,
            Throttle = throttle,
            Brake = brake,
        }) ?? Task.CompletedTask;

    /// <summary>Back to the start card: drop the race connection and every trace of the race on this page.</summary>
    private async Task ResetAsync()
    {
        _connecting?.Cancel();
        if (_session is { } session) { _session = null; await session.DisposeAsync(); }
        await JS.InvokeVoidAsync("PoRacer.stop");
        _phase = RacePhase.Start;
        _cars = [];
        _roster = [];
        _result = null;
        _score = null;
        _submitStatus = null;
        _localCarId = null;
        _elapsed = 0;
        _countdown = _countdownMs = _hudKey = 0;
        _raceStarted = _pauseOpen = _showResults = false;
        _previousBest = 0;
        _connectionStatus = null;
        _announcement = "";
        _lastLap = _lastPosition = 0;
    }

    private async Task RestartRaceAsync()
    {
        if (_isStarting) { _connecting?.Cancel(); return; }
        await ResetAsync();
        // An online race is left through the lobby it came from: dropping the code from the
        // address re-renders this page on its lobby, which takes a seat again. Solo and
        // demo reopen the opening card (a demo then starts itself again).
        if (!string.IsNullOrWhiteSpace(MatchCode)) Nav.NavigateTo("/poracer/multi");
        else ReopenIntro();
        StateHasChanged();
    }

    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        _disposed = true;
        Nav.LocationChanged -= OnLocationChanged;
        await _lifetime.CancelAsync();
        await CloseLobbyAsync();
        if (!_isStarting && _session is { } session) await session.DisposeAsync();
        try { await JS.InvokeVoidAsync("PoRacer.stop"); } catch (Exception ex) when (ex is JSDisconnectedException or JSException) { }
        _reference?.Dispose();
        _lifetime.Dispose();
    }
}
