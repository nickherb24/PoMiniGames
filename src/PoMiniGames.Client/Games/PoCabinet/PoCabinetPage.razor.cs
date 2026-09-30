using System.Text.Json;
using Microsoft.AspNetCore.Components;
using Microsoft.JSInterop;
using PoMiniGames.Shared.Games;
using PoMiniGamesClient.Models;
using PoMiniGamesClient.Services.Play;

namespace PoMiniGamesClient.Games.PoCabinet;

/// <summary>
/// Code-behind for <see cref="PoCabinetPage"/>. The page lifecycle is:
/// <list type="number">
///   <item><b>Start</b> — track, paint, settings. 1p/2p/demo go to <see cref="Phase.Loading"/>;
///         multiplayer joins the one lobby (first in hosts; there are no codes).</item>
///   <item><b>Lobby</b> — <see cref="PoCabinetLobby"/>; its <c>RaceStarting</c> hand-off calls
///         <see cref="BeginWireModeAsync"/> directly. (It used to navigate to this same page with
///         a query string, which Blazor treats as a parameter change on the live component —
///         <c>OnInitializedAsync</c> never re-ran, so no multiplayer race ever started.)</item>
///   <item><b>Loading → Racing</b> — mount the scene against the static world
///         (<see cref="PoCabinetTrackGeometry"/>, or the server's copy online), then hand the
///         frame loop to <c>js/pocabinet/race.js</c>: it simulates solo races, predicts the
///         local car online, renders every car and records the race.</item>
///   <item><b>Finished</b> — results over the still-running scene, with the telemetry chart
///         (best lap vs personal best), and <b>Replay</b> of the recording with clip export.</item>
/// </list>
/// <para>
/// The page is the HUD, not the renderer: it receives a snapshot per tick (from race.js for
/// solo races, from the server for multiplayer) and derives lap/sector timing, countdown
/// beeps, dialogue and the finish from it. Cars, camera, minimap and engine audio are
/// race.js's job, per frame, with no interop round trip.
/// </para>
/// </summary>
public partial class PoCabinetPageBase : ComponentBase, IAsyncDisposable
{
    [Inject] private IJSRuntime JS { get; set; } = default!;
    [Inject] private PlayerNameService PlayerNameSvc { get; set; } = default!;
    [Inject] private GameResultService GameResults { get; set; } = default!;
    [Inject] private PoCabinetSession Session { get; set; } = default!;
    [Inject] private PoCabinetCareerState Career { get; set; } = default!;
    [Inject] private PoMiniGamesClient.Services.Auth.AuthStateService AuthState { get; set; } = default!;

    [Parameter] public string? ModeSegment { get; set; }

    protected enum Phase { Start, Lobby, Loading, Racing, Finished, Replay }

    /// <summary>One results row: name plus a short detail (finish time, "You", "AI official").</summary>
    protected sealed record StandingRow(string Name, string Detail, bool IsLocal);

    protected GameMode Mode => GameModes.Parse(ModeSegment);

    protected string _playerName = "Player";
    protected Phase _phase = Phase.Start;
    protected string? _trackId = PoCabinetCatalog.DefaultTrackId;
    protected string? _livery = "Stripe";
    protected string? _color = "Indigo";

    protected int _lap = 1;
    protected int _position = 1;
    protected int _totalLaps = PoCabinetCatalog.TotalLaps;
    protected int _totalCars = 5;
    protected double _speedKmh;
    protected double _lapSeconds;
    protected string? _announcement;
    protected string? _status;

    protected PoCabinetUiSettings Settings { get; } = new();

    protected bool _paused;
    protected int? _pingMs;
    protected int _countdownDisplay;
    protected bool _showGo;
    protected List<StandingRow>? _finalStandings;
    protected bool _isPersonalBest;
    protected double _previousBest = -1;
    /// <summary>Online: the local car is home but the server has not called the race yet.</summary>
    protected bool _awaitingFinal;

    protected double?[] _sectorTimes = new double?[3];
    protected double?[] _lastLapSectorTimes = new double?[3];
    protected readonly double[] _sessionBestSectors = [double.MaxValue, double.MaxValue, double.MaxValue];
    protected readonly double[] _storedBestSectors = [double.MaxValue, double.MaxValue, double.MaxValue];
    protected double _storedBestLap;
    protected List<double> _lapTimes = new();
    protected double _lastLapSeconds;
    protected double _bestLapSession;
    protected int _sectorIndex;
    protected double _sectorStart;
    private bool _lineAligned;
    private double _prevProgress;
    private int _lastCountdown = -1;
    private double _goUntilElapsed;
    private string _envKey = "auto|auto";

    protected PoCabinetRaceSnapshot? _lastSnapshot;

    // Telemetry + replay (race.js owns the data; these are the view model).
    protected string? _telemetrySummary;
    protected bool _hasReferenceLap;
    private bool _telemetryDrawn;
    protected double _replayT;
    protected double _replayDuration;
    protected bool _replayPlaying;
    protected string _replayCamera = "chase";
    protected double _replaySpeed = 1;
    protected bool _recordingClip;

    protected bool Pausable => !IsMultiplayerMode && _phase == Phase.Racing;

    protected bool IsMultiplayerMode => Mode == GameMode.Multiplayer;

    protected bool IsSpectating => IsMultiplayerMode && _gameCode is not null && _localCarId is null;

    protected string PlayerColorHex => PoCabinetPaintShop.HexFor(_color);

    protected int ReplayPermille => _replayDuration > 0 ? (int)Math.Round(_replayT / _replayDuration * 1000) : 0;

    protected string ReplaySpeedValue => _replaySpeed.ToString(System.Globalization.CultureInfo.InvariantCulture);

    protected string PingClass => (_pingMs ?? 999) switch
    {
        < 90 => "pocabinet-ping--good",
        < 220 => "pocabinet-ping--fair",
        _ => "pocabinet-ping--poor",
    };

    protected static string ConfettiColor(int i) => (i % 5) switch
    {
        0 => "#c6a35a",
        1 => "#3470d8",
        2 => "#2ecc71",
        3 => "#c1253b",
        _ => "#ffffff",
    };

    protected static int ConfettiX(int i) => i * 41 % 100;

    protected static string ConfettiDelay(int i) =>
        (1.8 + i % 5 * 0.45).ToString("F2", System.Globalization.CultureInfo.InvariantCulture) + "s";

    protected RenderFragment TitleContent => builder => builder.AddMarkupContent(0, "🏛️ Cabinet");

    protected bool HasAnyCareerProgress =>
        Career.Current.CompletedStages.Count > 0
        || Career.Current.TrophyUnlocked
        || Career.Current.GoldLiveryUnlocked;

    private IJSObjectReference? _sceneHandle;
    private IJSObjectReference? _cockpitHandle;
    private IJSObjectReference? _dialogueHandle;
    private IJSObjectReference? _minimapHandle;
    private IJSObjectReference? _envHandle;
    private string? _currentDialogueOfficialId;
    private string? _lastDialogueKey;
    protected ElementReference _canvas;
    protected ElementReference _minimapCanvas;
    private DotNetObjectReference<PoCabinetPageBase>? _selfRef;
    private string? _gameCode;
    private int? _localCarId;
    private PoCabinetStaticWorld? _world;
    private PoCabinetFinalResult? _finalResult;
    private bool _wiredSessionHandlers;
    private bool _mountStarted;
    private bool _submitted;
    private double _submittedBestLap;
    private int _lastLapCount;
    private double _lastLapTime;
    private long _lastHudRender;
    private GameMode? _lastMode;

    protected override async Task OnInitializedAsync()
    {
        await Career.LoadAsync();
        _selfRef = DotNetObjectReference.Create(this);
        try
        {
            // Read the stored prefs straight from localStorage: window.PoCabinet does not
            // exist until the engine module is imported (at race start), and asking it first
            // used to throw, silently fall back to defaults — assists off, whatever the player
            // had chosen. Importing the engine here instead would delay the first render.
            var raw = await JS.InvokeAsync<string?>("localStorage.getItem", "pocabinet.settings.v1");
            if (!string.IsNullOrWhiteSpace(raw))
            {
                using var doc = JsonDocument.Parse(raw);
                Settings.LoadFrom(doc.RootElement);
            }
            _envKey = $"{Settings.Weather}|{Settings.TimeOfDay}";
        }
        catch { /* storage unavailable or corrupt — defaults are fine */ }
    }

    /// <summary>
    /// A mode switch mid-race (same component, new route parameter) tears the race down.
    /// (The <c>?lobby=</c> / <c>?code=</c> invite deep links went with the join codes, 2026-09-29.)
    /// </summary>
    protected override async Task OnParametersSetAsync()
    {
        if (_lastMode is { } previous && previous != Mode && _phase != Phase.Start)
        {
            await TeardownRaceAsync();
            _phase = Phase.Start;
        }
        _lastMode = Mode;
    }

    /// <summary>
    /// Demo auto-starts on first paint. Every mode mounts in two render passes: the Loading
    /// phase renders the race section (so the canvas exists), and only the NEXT pass mounts
    /// the engine into it. The Finished pass draws the telemetry chart once its canvas exists.
    /// </summary>
    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        if (Mode == GameMode.Demo && firstRender && _phase == Phase.Start)
        {
            _playerName = PlayerNameSvc.GetOrReadInitialName();
            _phase = Phase.Loading;
            await InvokeAsync(StateHasChanged);
            return;
        }

        if (_phase == Phase.Loading && !_mountStarted)
        {
            _mountStarted = true;
            try
            {
                if (IsMultiplayerMode && _gameCode is not null)
                    await JoinWireRaceAsync(_gameCode);
                else
                    await BeginSoloAsync();
            }
            finally
            {
                _mountStarted = false;
            }
        }

        if (_phase == Phase.Finished && !_telemetryDrawn && !IsSpectating)
        {
            _telemetryDrawn = true;
            try
            {
                var res = await JS.InvokeAsync<JsonElement>("PoCabinet.showTelemetry", "pocabinetTelemetry");
                if (res.ValueKind == JsonValueKind.Object)
                {
                    _telemetrySummary = res.TryGetProperty("summary", out var s) ? s.GetString() : null;
                    _hasReferenceLap = res.TryGetProperty("hasReference", out var r) && r.ValueKind == JsonValueKind.True;
                }
            }
            catch { _telemetrySummary = null; }
            await InvokeAsync(StateHasChanged);
        }
    }

    protected Task OnTrackChanged(string trackId)
    {
        _trackId = trackId;
        return Task.CompletedTask;
    }

    protected Task OnPaintChanged((string Livery, string Color) sel)
    {
        _livery = sel.Livery;
        _color = sel.Color;
        return Task.CompletedTask;
    }

    /// <summary>Start button: multiplayer joins the lobby; everything else races.</summary>
    protected async Task StartRaceAsync()
    {
        _playerName = PlayerNameSvc.GetOrReadInitialName();
        _status = null;
        await UnlockAudioAsync();
        if (IsMultiplayerMode)
        {
            _phase = Phase.Lobby;
            await InvokeAsync(StateHasChanged);
            return;
        }
        _phase = Phase.Loading;
        await InvokeAsync(StateHasChanged);
    }

    protected Task OnLobbyRaceStartingAsync((string Code, string TrackId) start)
    {
        _trackId = start.TrackId;
        return BeginWireModeAsync(start.Code);
    }

    protected Task LeaveLobbyAsync()
    {
        _phase = Phase.Start;
        return InvokeAsync(StateHasChanged);
    }

    private async Task UnlockAudioAsync()
    {
        // Web Audio needs a user gesture to unlock the context — this click is it.
        try
        {
            await JS.InvokeVoidAsync("PoCabinet.initAudio");
            await JS.InvokeVoidAsync("PoCabinet.setAudioSuspended", false);
        }
        catch { /* audio is a bonus, never a gate */ }
    }

    protected async Task ResetCareerAsync()
    {
        await Career.ResetAsync();
    }

    /// <summary>Mount the scene and start the in-browser race (1p, 2p, demo).</summary>
    private async Task BeginSoloAsync()
    {
        try
        {
            var trackId = _trackId ?? PoCabinetCatalog.DefaultTrackId;
            _gameCode = null;
            _localCarId = null;
            ResetTelemetry();
            _world = PoCabinetTrackGeometry.BuildStaticWorld(trackId);
            await LoadStoredRecordsAsync(trackId);
            await EnsureEngineAsync();
            await MountSceneAsync(_world);
            _status = null;
            _phase = Phase.Racing;
            await InvokeAsync(StateHasChanged);
            await JS.InvokeVoidAsync("PoCabinet.startRace", _selfRef, _sceneHandle, _cockpitHandle, _minimapHandle, new
            {
                mode = Mode == GameMode.Demo ? "demo" : "solo",
                world = _world,
                playerName = _playerName,
                color = PlayerColorHex,
                settings = Settings.ToJs(),
            });
        }
        catch (Exception ex)
        {
            try { await JS.InvokeVoidAsync("console.error", "pocabinet BeginSoloAsync failed: " + ex); } catch { }
            await TeardownRaceAsync();
            _status = $"Could not start the race: {ex.Message}";
            _phase = Phase.Start;
            await InvokeAsync(StateHasChanged);
        }
    }

    /// <summary>
    /// Enter a multiplayer race (from the lobby hand-off or its Watch button). Records state only; the hub join and mount wait for the Loading
    /// render in <see cref="OnAfterRenderAsync"/>, when the canvas exists.
    /// </summary>
    public Task BeginWireModeAsync(string gameCode)
    {
        _gameCode = gameCode;
        _localCarId = null;
        _phase = Phase.Loading;
        _status = null;
        return InvokeAsync(StateHasChanged);
    }

    private async Task JoinWireRaceAsync(string gameCode)
    {
        try
        {
            ResetTelemetry();
            await EnsureEngineAsync();
            WireSessionHandlers();
            var snap = await Session.JoinRaceAsync(gameCode);
            _localCarId = snap.LocalCarId;
            _world = snap.Static ?? PoCabinetTrackGeometry.BuildStaticWorld(_trackId);
            _trackId = _world.TrackId;
            _totalLaps = _world.TotalLaps;
            await LoadStoredRecordsAsync(_world.TrackId);
            await MountSceneAsync(_world);
            await JS.InvokeVoidAsync("PoCabinet.startRace", _selfRef, _sceneHandle, _cockpitHandle, _minimapHandle, new
            {
                mode = "net",
                world = _world,
                localCarId = snap.LocalCarId,
                initialSnapshot = snap,
                settings = Settings.ToJs(),
            });
            Session.StartPingLoop();
            _phase = Phase.Racing;
            ApplySnapshot(snap, forceRender: true);
        }
        catch (Exception ex)
        {
            try { await JS.InvokeVoidAsync("console.error", "pocabinet JoinWireRaceAsync failed: " + ex); } catch { }
            await TeardownRaceAsync();
            _status = $"Could not join the race: {ex.Message}";
            _phase = Session.Lobby is not null ? Phase.Lobby : Phase.Start;
            await InvokeAsync(StateHasChanged);
        }
    }

    private void WireSessionHandlers()
    {
        if (_wiredSessionHandlers) return;
        _wiredSessionHandlers = true;
        Session.SnapshotReceived += OnWireSnapshotAsync;
        Session.RaceFinished += OnWireRaceFinishedAsync;
        Session.StatusChanged += OnSessionStatusAsync;
        Session.PingMeasured += OnPingAsync;
    }

    private void UnwireSessionHandlers()
    {
        if (!_wiredSessionHandlers) return;
        _wiredSessionHandlers = false;
        Session.SnapshotReceived -= OnWireSnapshotAsync;
        Session.RaceFinished -= OnWireRaceFinishedAsync;
        Session.StatusChanged -= OnSessionStatusAsync;
        Session.PingMeasured -= OnPingAsync;
    }

    private Task OnSessionStatusAsync(string? msg)
    {
        _status = msg;
        return InvokeAsync(StateHasChanged);
    }

    private Task OnPingAsync(double ms)
    {
        _pingMs = (int)Math.Round(ms);
        return InvokeAsync(StateHasChanged);
    }

    private Task OnWireSnapshotAsync(PoCabinetRaceSnapshot snap)
    {
        if (_phase is not (Phase.Racing or Phase.Finished) || !string.Equals(snap.GameCode, _gameCode, StringComparison.OrdinalIgnoreCase))
            return Task.CompletedTask;
        Fire("PoCabinet.pushServerSnapshot", snap);
        if (_phase == Phase.Racing) ApplySnapshot(snap);
        return Task.CompletedTask;
    }

    private async Task OnWireRaceFinishedAsync(PoCabinetFinalResult result)
    {
        if (!string.Equals(result.GameCode, _gameCode, StringComparison.OrdinalIgnoreCase)) return;
        _finalResult = result;
        _awaitingFinal = false;
        _finalStandings = result.Standings.Select(e => new StandingRow(
            e.Name,
            // The server calls the race once every human is home, so unfinished officials
            // were simply still lapping — "DNF" read as if they had crashed out.
            e.Finished && e.TotalTimeSeconds > 0 ? FormatLapTime(e.TotalTimeSeconds) : e.IsPlayer ? "did not finish" : "AI official · still on track",
            e.CarId == _localCarId)).ToList();
        var mine = result.Standings.FirstOrDefault(e => e.CarId == _localCarId);
        if (mine is not null) _position = mine.Position;
        if (_phase == Phase.Racing) EnterFinished();
        if (mine is not null && mine.BestLapSeconds > 0) await SubmitFinalAsync(mine.BestLapSeconds);
        await InvokeAsync(StateHasChanged);
    }

    private async Task EnsureEngineAsync()
    {
        var ready = await JS.InvokeAsync<bool>("loadEngine", "pocabinet");
        if (!ready) throw new InvalidOperationException("pocabinet engine failed to load");
    }

    /// <summary>
    /// Mount the scene, cockpit, dialogue bubble, minimap and environment against the static
    /// world. The environment resolves before race.js starts so its rain-grip factor is in
    /// place for the first solo tick.
    /// </summary>
    private async Task MountSceneAsync(PoCabinetStaticWorld world)
    {
        await TeardownSceneAsync();
        // IJSRuntime does not marshal ElementReference as a live DOM element, so the mounts
        // resolve their canvases by id.
        _sceneHandle = await JS.InvokeAsync<IJSObjectReference>("PoCabinet.mount", "pocabinetCanvas", world);
        _cockpitHandle = await JS.InvokeAsync<IJSObjectReference>("PoCabinet.mountCockpit", _sceneHandle);
        _dialogueHandle = await JS.InvokeAsync<IJSObjectReference>("PoCabinet.mountDialogue", "pocabinetDialogueLayer", "sean-s");
        _currentDialogueOfficialId = "sean-s";
        try { await JS.InvokeVoidAsync("PoCabinet.applySettings", _sceneHandle, Settings.ToJs()); }
        catch { /* settings are cosmetic */ }
        await MountMinimapAsync();
        try { _envHandle = await JS.InvokeAsync<IJSObjectReference>("PoCabinet.mountEnvironment", _sceneHandle); }
        catch { _envHandle = null; }
    }

    private async Task MountMinimapAsync()
    {
        if (_world is null) return;
        try
        {
            if (_minimapHandle is not null) await JS.InvokeVoidAsync("PoCabinet.unmountMinimap", _minimapHandle);
            _minimapHandle = await JS.InvokeAsync<IJSObjectReference>("PoCabinet.mountMinimap",
                "pocabinetMinimap", _world, new { accent = _world.Atmosphere.AccentHex, colorSafe = Settings.ColorSafe });
        }
        catch { _minimapHandle = null; }
    }

    /// <summary>race.js pushes one of these per tick in solo modes (the server does, online).</summary>
    [JSInvokable]
    public Task OnSoloSnapshotAsync(PoCabinetRaceSnapshot snap)
    {
        if (_phase == Phase.Racing) ApplySnapshot(snap);
        return Task.CompletedTask;
    }

    /// <summary>race.js, online: one numbered input per 30 Hz tick, forwarded to the race hub.</summary>
    [JSInvokable]
    public Task OnNetInputAsync(int seq, double throttle, double brake, double steer) =>
        Session.SendInputAsync(new PoCabinetInput { Seq = seq, Throttle = throttle, Brake = brake, Steer = steer });

    private PoCabinetCarState? FindLocal(PoCabinetRaceSnapshot snap)
    {
        var cars = snap.Cars ?? Array.Empty<PoCabinetCarState>();
        if (IsMultiplayerMode) return _localCarId is { } id ? cars.FirstOrDefault(c => c.Id == id) : null;
        return snap.LocalCarId is { } sid ? cars.FirstOrDefault(c => c.Id == sid) : cars.FirstOrDefault(c => c.IsPlayer);
    }

    private void ApplySnapshot(PoCabinetRaceSnapshot snap, bool forceRender = false)
    {
        _lastSnapshot = snap;

        // Countdown beeps; the 1 → 0 transition raises the GO ping and flashes "GO!".
        if (snap.CountdownSeconds != _lastCountdown)
        {
            var previous = _lastCountdown;
            _lastCountdown = snap.CountdownSeconds;
            if (snap.CountdownSeconds > 0)
            {
                _countdownDisplay = snap.CountdownSeconds;
                Fire("PoCabinet.countdownBeep", false);
            }
            else if (previous > 0)
            {
                _countdownDisplay = 0;
                _goUntilElapsed = snap.ElapsedRaceTime + 1.2;
                Fire("PoCabinet.countdownBeep", true);
            }
            forceRender = true;
        }
        _showGo = _goUntilElapsed > 0 && snap.ElapsedRaceTime <= _goUntilElapsed;

        var cars = snap.Cars ?? Array.Empty<PoCabinetCarState>();
        _totalCars = cars.Count > 0 ? cars.Count : _totalCars;
        var localCar = FindLocal(snap);
        if (localCar is not null)
        {
            _speedKmh = localCar.SpeedKmh;
            if (_lastLapCount > 0 && localCar.Lap > _lastLapCount)
            {
                var lapTime = snap.ElapsedRaceTime - _lastLapTime;
                if (lapTime > 0 && (_bestLapSession <= 0 || lapTime < _bestLapSession)) _bestLapSession = lapTime;
                CloseLapTelemetry(lapTime, snap.ElapsedRaceTime);
                if (lapTime > 0) Fire("PoCabinet.lapChime");
                forceRender = true;
            }
            _lastLapCount = localCar.Lap;
            _lap = localCar.Lap;
            _position = localCar.Position;
            _lapSeconds = snap.ElapsedRaceTime;
            if (snap.BestLapSeconds is { } reported && reported > 0 && (_bestLapSession <= 0 || reported < _bestLapSession))
            {
                _bestLapSession = reported;
            }
            if (snap.Started && !snap.Finished && !localCar.Finished)
            {
                TrackSectorProgress(localCar.LapProgress, snap.ElapsedRaceTime);
            }
        }
        else if (cars.Count > 0)
        {
            // Spectating: the HUD follows the leader.
            var leader = cars.OrderBy(c => c.Position).First();
            _lap = leader.Lap;
            _position = leader.Position;
            _speedKmh = leader.SpeedKmh;
            _lapSeconds = snap.ElapsedRaceTime;
        }

        if (snap.LatestDialogue is { } d && !string.IsNullOrEmpty(d.Text))
        {
            var key = $"{d.OfficialId}|{d.RaceTick}";
            if (!string.Equals(key, _lastDialogueKey, StringComparison.Ordinal))
            {
                _lastDialogueKey = key;
                _announcement = d.Text;
                _ = ShowDialogueAsync(d);
                forceRender = true;
            }
        }

        var localDone = IsMultiplayerMode ? localCar?.Finished == true : snap.Finished;
        if ((localDone || (IsMultiplayerMode && snap.Finished)) && _phase == Phase.Racing)
        {
            _finalStandings ??= cars.OrderBy(c => c.Position)
                .Select(c => new StandingRow(c.Name, c.Id == localCar?.Id ? "You" : c.IsPlayer ? "Player" : "AI official", c.Id == localCar?.Id))
                .ToList();
            _awaitingFinal = IsMultiplayerMode && _finalResult is null;
            EnterFinished();
            if (!IsMultiplayerMode) _ = InvokeAsync(() => SubmitFinalAsync(snap.BestLapSeconds ?? 0));
            forceRender = true;
        }

        var now = Environment.TickCount64;
        if (forceRender || now - _lastHudRender >= 66)
        {
            _lastHudRender = now;
            InvokeAsync(StateHasChanged);
        }
    }

    private void EnterFinished()
    {
        _phase = Phase.Finished;
        _telemetryDrawn = false;
        Fire("PoCabinet.fanfare", _position <= 3 && !IsSpectating);
    }

    private async Task ShowDialogueAsync(PoCabinetDialogueEvent d)
    {
        try
        {
            if (!string.Equals(d.OfficialId, _currentDialogueOfficialId, StringComparison.Ordinal))
            {
                if (_dialogueHandle is not null) await JS.InvokeVoidAsync("PoCabinet.unmountDialogue", _dialogueHandle);
                _dialogueHandle = await JS.InvokeAsync<IJSObjectReference>("PoCabinet.mountDialogue", "pocabinetDialogueLayer", d.OfficialId);
                _currentDialogueOfficialId = d.OfficialId;
            }
            if (_dialogueHandle is not null)
            {
                await JS.InvokeVoidAsync("PoCabinet.showDialogue", _dialogueHandle, d.Text, 2400);
                await JS.InvokeVoidAsync("PoCabinet.blip");
            }
        }
        catch { /* dialogue is flavour */ }
    }

    /// <summary>
    /// Record the result: personal records (best lap + sectors), the leaderboard submit, and —
    /// in the 1-player championship only — career progress. Runs once per race.
    /// </summary>
    private async Task SubmitFinalAsync(double lapSeconds)
    {
        if (_submitted || IsSpectating) return;
        _submitted = true;
        _submittedBestLap = lapSeconds;
        try
        {
            var trackId = _trackId ?? PoCabinetCatalog.DefaultTrackId;
            try
            {
                var res = await JS.InvokeAsync<JsonElement>("PoCabinet.recordTrackResult", trackId, lapSeconds, BestSectorArray());
                if (res.ValueKind == JsonValueKind.Object)
                {
                    if (res.TryGetProperty("isPb", out var pb) && pb.ValueKind == JsonValueKind.True) _isPersonalBest = true;
                    if (res.TryGetProperty("previousBest", out var prev) && prev.ValueKind == JsonValueKind.Number) _previousBest = prev.GetDouble();
                }
            }
            catch { /* records are a bonus */ }

            if (lapSeconds <= 0 || Mode == GameMode.Demo)
            {
                _status = Mode == GameMode.Demo ? null : "Race finished (no complete lap recorded).";
                await InvokeAsync(StateHasChanged);
                return;
            }
            var outcome = _position <= 3 ? GameResult.Win : GameResult.Loss;
            var req = new PoCabinetHighScoreRequest(
                TrackId: trackId,
                BestLapSeconds: lapSeconds,
                FinalPosition: Math.Clamp(_position, 1, 9),
                IsGuest: !(AuthState?.IsAuthenticated == true),
                GameCode: _gameCode ?? "SOLO");
            await GameResults.RecordAndSubmitPoCabinetAsync(_playerName, outcome, req);

            if (Mode == GameMode.OnePlayer)
            {
                var stageIndex = StageIndexFor(trackId);
                if (stageIndex >= 0) await Career.RecordStageResultAsync(stageIndex, _position, isFinalRace: stageIndex == 2);
            }
            _status = $"Race saved — position {_position}/{_totalCars}.";
        }
        catch (Exception ex)
        {
            _status = $"Score submit failed: {ex.Message}";
        }
        await InvokeAsync(StateHasChanged);
    }

    // ─── Telemetry: sectors, laps, personal records ──────────────────────────

    private void ResetTelemetry()
    {
        _sectorIndex = 0;
        _sectorStart = 0;
        _lineAligned = false;
        _prevProgress = 0;
        _sectorTimes = new double?[3];
        _lastLapSectorTimes = new double?[3];
        _sessionBestSectors.AsSpan().Fill(double.MaxValue);
        _lapTimes = new List<double>();
        _lastLapSeconds = 0;
        _bestLapSession = 0;
        _lastLapCount = 0;
        _lastLapTime = 0;
        _lastCountdown = -1;
        _goUntilElapsed = 0;
        _showGo = false;
        _countdownDisplay = 0;
        _finalStandings = null;
        _finalResult = null;
        _awaitingFinal = false;
        _isPersonalBest = false;
        _previousBest = -1;
        _pingMs = null;
        _submitted = false;
        _submittedBestLap = 0;
        _telemetryDrawn = false;
        _telemetrySummary = null;
        _hasReferenceLap = false;
        _lastDialogueKey = null;
        _announcement = null;
        _lap = 1;
        _position = 1;
        _speedKmh = 0;
        _lapSeconds = 0;
    }

    private async Task LoadStoredRecordsAsync(string trackId)
    {
        _storedBestSectors.AsSpan().Fill(double.MaxValue);
        _storedBestLap = 0;
        try
        {
            var rec = await JS.InvokeAsync<JsonElement>("PoCabinet.getRecords", trackId);
            if (rec.ValueKind != JsonValueKind.Object) return;
            if (rec.TryGetProperty("bestLap", out var bl) && bl.ValueKind == JsonValueKind.Number)
            {
                var v = bl.GetDouble();
                if (v > 0) _storedBestLap = v;
            }
            if (rec.TryGetProperty("sectors", out var secs) && secs.ValueKind == JsonValueKind.Array)
            {
                var i = 0;
                foreach (var s in secs.EnumerateArray())
                {
                    if (i >= 3) break;
                    if (s.ValueKind == JsonValueKind.Number)
                    {
                        var v = s.GetDouble();
                        if (v > 0) _storedBestSectors[i] = v;
                    }
                    i++;
                }
            }
        }
        catch { /* first race ever, or storage unavailable — defaults hold */ }
    }

    private void TrackSectorProgress(double progress, double elapsed)
    {
        // Sector boundaries are thirds of the lap: the lap line sits at progress 0, so the
        // thirds only line up once the first line crossing has happened. The standing-start
        // lap records just its closing stint in CloseLapTelemetry.
        if (!_lineAligned) return;
        while (_sectorIndex < 2)
        {
            var boundary = (_sectorIndex + 1) / 3.0;
            if (!CrossedBoundary(_prevProgress, progress, boundary)) break;
            RecordSector(elapsed - _sectorStart, _sectorIndex);
            _sectorIndex++;
            _sectorStart = elapsed;
        }
        _prevProgress = progress;
    }

    private static bool CrossedBoundary(double prev, double cur, double boundary)
    {
        if (prev <= cur) return prev < boundary && boundary <= cur;
        return boundary > prev || boundary <= cur; // wrapped this step
    }

    private void CloseLapTelemetry(double lapTime, double elapsed)
    {
        RecordSector(lapTime - (_sectorTimes[0] ?? 0) - (_sectorTimes[1] ?? 0), 2);
        _lastLapSectorTimes = (double?[])_sectorTimes.Clone();
        _sectorTimes = new double?[3];
        _sectorIndex = 0;
        _sectorStart = elapsed;
        _lineAligned = true;
        _prevProgress = 0;
        if (lapTime > 0)
        {
            _lastLapSeconds = lapTime;
            _lapTimes.Add(lapTime);
        }
        _lastLapTime = elapsed;
    }

    private void RecordSector(double seconds, int index)
    {
        if (seconds <= 0 || index < 0 || index > 2) return;
        _sectorTimes[index] = seconds;
        if (seconds < _sessionBestSectors[index]) _sessionBestSectors[index] = seconds;
    }

    protected string SectorClass(int index)
    {
        if (index < 0 || index > 2) return "";
        var t = _sectorTimes[index];
        if (t is null) return "";
        if (t.Value <= _storedBestSectors[index]) return "pocabinet-sector--pb";
        if (t.Value <= _sessionBestSectors[index]) return "pocabinet-sector--session";
        return "";
    }

    protected string SectorClassFor(double? t, int index)
    {
        if (t is null || index < 0 || index > 2) return "";
        if (t.Value <= _storedBestSectors[index]) return "pocabinet-sector--pb";
        if (t.Value <= _sessionBestSectors[index]) return "pocabinet-sector--session";
        return "";
    }

    private double[] BestSectorArray() => new[]
    {
        _sessionBestSectors[0] < 3600 ? Math.Round(_sessionBestSectors[0], 2) : 0,
        _sessionBestSectors[1] < 3600 ? Math.Round(_sessionBestSectors[1], 2) : 0,
        _sessionBestSectors[2] < 3600 ? Math.Round(_sessionBestSectors[2], 2) : 0,
    };

    // ─── Camera, pause, leaving the race ─────────────────────────────────────

    protected Task CycleCameraAsync() => SafeJsAsync("PoCabinet.cycleCamera");

    [JSInvokable]
    public Task OnTogglePause() => TogglePauseAsync();

    protected async Task TogglePauseAsync()
    {
        if (!Pausable) return;
        if (_paused) await ResumeRaceAsync();
        else await PauseRaceAsync();
    }

    protected async Task PauseRaceAsync()
    {
        if (_paused || !Pausable) return;
        _paused = true;
        await SafeJsAsync("PoCabinet.pauseRace");
        await SafeJsAsync("PoCabinet.setAudioSuspended", true);
        await InvokeAsync(StateHasChanged);
    }

    protected async Task ResumeRaceAsync()
    {
        if (!_paused) return;
        _paused = false;
        await SafeJsAsync("PoCabinet.resumeRace");
        await SafeJsAsync("PoCabinet.setAudioSuspended", false);
        await InvokeAsync(StateHasChanged);
    }

    protected async Task QuitToMenuAsync()
    {
        await TeardownRaceAsync();
        _phase = Phase.Start;
        await InvokeAsync(StateHasChanged);
    }

    protected async Task BackToStartAsync()
    {
        await TeardownRaceAsync();
        if (IsMultiplayerMode) await Session.LeaveLobbyAsync();
        _phase = Phase.Start;
        await InvokeAsync(StateHasChanged);
    }

    protected async Task RaceAgainAsync()
    {
        await TeardownRaceAsync();
        await StartRaceAsync();
    }

    /// <summary>Rematch: the lobby reopened when the race ended; rejoining it is idempotent.</summary>
    protected async Task BackToLobbyAsync()
    {
        var wasOnline = _gameCode is not null;
        await TeardownRaceAsync();
        _phase = wasOnline ? Phase.Lobby : Phase.Start;
        await InvokeAsync(StateHasChanged);
    }

    /// <summary>Stop the race driver and unmount every engine handle; the canvas is about to leave the DOM.</summary>
    private async Task TeardownRaceAsync()
    {
        _paused = false;
        await SafeJsAsync("PoCabinet.stopRace");
        await SafeJsAsync("PoCabinet.setAudioSuspended", true);
        await TeardownSceneAsync();
        if (_gameCode is not null) Session.LeaveRace();
        UnwireSessionHandlers();
        _gameCode = null;
        _localCarId = null;
        _recordingClip = false;
    }

    private async Task TeardownSceneAsync()
    {
        try
        {
            if (_envHandle is not null) await JS.InvokeVoidAsync("PoCabinet.unmountEnvironment", _envHandle);
            if (_minimapHandle is not null) await JS.InvokeVoidAsync("PoCabinet.unmountMinimap", _minimapHandle);
            if (_dialogueHandle is not null) await JS.InvokeVoidAsync("PoCabinet.unmountDialogue", _dialogueHandle);
            if (_cockpitHandle is not null) await JS.InvokeVoidAsync("PoCabinet.unmountCockpit", _cockpitHandle);
            if (_sceneHandle is not null) await JS.InvokeVoidAsync("PoCabinet.unmount", _sceneHandle);
        }
        catch { /* engine may already be torn down */ }
        foreach (var h in new[] { _envHandle, _minimapHandle, _dialogueHandle, _cockpitHandle, _sceneHandle })
        {
            if (h is null) continue;
            try { await h.DisposeAsync(); } catch { /* already gone */ }
        }
        _envHandle = _minimapHandle = _dialogueHandle = _cockpitHandle = _sceneHandle = null;
    }

    // ─── Replay ──────────────────────────────────────────────────────────────

    protected async Task StartReplayAsync()
    {
        try
        {
            if (await JS.InvokeAsync<bool>("PoCabinet.startReplay"))
            {
                _phase = Phase.Replay;
                _replayPlaying = true;
                _replayCamera = "chase";
                _replaySpeed = 1;
            }
            else
            {
                _status = "Nothing was recorded to replay.";
            }
        }
        catch (Exception ex)
        {
            _status = $"Replay unavailable: {ex.Message}";
        }
        await InvokeAsync(StateHasChanged);
    }

    [JSInvokable]
    public Task OnReplayStateAsync(double t, double duration, bool playing, string camera, double speed)
    {
        _replayT = t;
        _replayDuration = duration;
        _replayPlaying = playing;
        _replayCamera = camera;
        _replaySpeed = speed;
        return InvokeAsync(StateHasChanged);
    }

    protected Task ToggleReplayAsync() => SafeJsAsync("PoCabinet.replayCommand", "toggle", null);

    protected Task SeekReplayAsync(ChangeEventArgs e) =>
        SafeJsAsync("PoCabinet.replayCommand", "seek", ParseDouble(e.Value?.ToString()) / 1000.0);

    protected Task SetReplaySpeedAsync(ChangeEventArgs e) =>
        SafeJsAsync("PoCabinet.replayCommand", "speed", ParseDouble(e.Value?.ToString()));

    protected Task SetReplayCameraAsync(ChangeEventArgs e) =>
        SafeJsAsync("PoCabinet.replayCommand", "camera", e.Value?.ToString() ?? "chase");

    protected async Task ExitReplayAsync()
    {
        await SafeJsAsync("PoCabinet.stopReplay");
        _phase = Phase.Finished;
        _telemetryDrawn = false;
        await InvokeAsync(StateHasChanged);
    }

    /// <summary>Record the best lap from the replay (chase cam) and share or download it.</summary>
    protected async Task RecordClipAsync()
    {
        _recordingClip = true;
        _status = null;
        await InvokeAsync(StateHasChanged);
        try
        {
            var outcome = await JS.InvokeAsync<string>("PoCabinet.recordClip");
            _status = outcome switch
            {
                "shared" => "Clip shared.",
                "downloaded" => "Clip saved to your downloads.",
                _ => "This browser can't record video clips.",
            };
        }
        catch (Exception ex)
        {
            _status = $"Could not record the clip: {ex.Message}";
        }
        _recordingClip = false;
        await InvokeAsync(StateHasChanged);
    }

    // ─── Settings ────────────────────────────────────────────────────────────

    protected async Task OnSettingsChangedAsync()
    {
        try
        {
            // A change made on the start screen can come before any race imported the engine;
            // without it the save below threw and the change was silently lost.
            await EnsureEngineAsync();
            await JS.InvokeVoidAsync("PoCabinet.saveSettings", Settings.ToJs());
            if (_sceneHandle is not null) await JS.InvokeVoidAsync("PoCabinet.applySettings", _sceneHandle, Settings.ToJs());
        }
        catch { /* cosmetic */ }

        // The colour-safe palette is baked into the minimap at mount.
        if (_minimapHandle is not null) await MountMinimapAsync();

        var envKey = $"{Settings.Weather}|{Settings.TimeOfDay}";
        if (!string.Equals(envKey, _envKey, StringComparison.Ordinal))
        {
            _envKey = envKey;
            if (_sceneHandle is not null)
            {
                try { if (_envHandle is not null) await JS.InvokeVoidAsync("PoCabinet.unmountEnvironment", _envHandle); } catch { }
                try { _envHandle = await JS.InvokeAsync<IJSObjectReference>("PoCabinet.mountEnvironment", _sceneHandle); }
                catch { _envHandle = null; }
            }
        }
        await InvokeAsync(StateHasChanged);
    }

    // ─── Share ───────────────────────────────────────────────────────────────

    protected async Task ShareResultAsync()
    {
        var trackId = _trackId ?? PoCabinetCatalog.DefaultTrackId;
        try
        {
            var outcome = await JS.InvokeAsync<string>("PoCabinet.shareResult", new
            {
                playerName = _playerName,
                trackName = PoCabinetCatalog.GetTrack(trackId).Name,
                position = _position,
                totalCars = _totalCars,
                bestLapSeconds = _submittedBestLap > 0 ? _submittedBestLap : _bestLapSession,
                isPb = _isPersonalBest,
                accent = _world?.Atmosphere.AccentHex ?? "#c6a35a",
            });
            _status = outcome switch
            {
                "shared" => "Result card shared.",
                "downloaded" => "Result card downloaded.",
                _ => "Sharing unavailable — the card was downloaded instead.",
            };
        }
        catch (Exception ex)
        {
            _status = $"Could not create the result card: {ex.Message}";
        }
        await InvokeAsync(StateHasChanged);
    }

    private static int StageIndexFor(string trackId) => trackId switch
    {
        "capitol" => 0,
        "maralago" => 1,
        "pressbriefing" => 2,
        _ => -1,
    };

    protected static string FormatLapTime(double seconds)
    {
        if (double.IsNaN(seconds) || seconds < 0) return "0:00.0";
        var minutes = (int)(seconds / 60);
        var rest = seconds - minutes * 60;
        return $"{minutes}:{rest:00.0}";
    }

    private static double ParseDouble(string? raw) =>
        double.TryParse(raw, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var d) ? d : 0;

    /// <summary>Fire-and-forget interop for cues that must never stall the HUD.</summary>
    private void Fire(string identifier, params object?[] args) => _ = SafeJsAsync(identifier, args);

    private async Task SafeJsAsync(string identifier, params object?[] args)
    {
        try { await JS.InvokeVoidAsync(identifier, args); }
        catch { /* engine torn down or interop unavailable — cues are best-effort */ }
    }

    public async ValueTask DisposeAsync()
    {
        await TeardownRaceAsync();
        _selfRef?.Dispose();
        GC.SuppressFinalize(this);
    }
}
