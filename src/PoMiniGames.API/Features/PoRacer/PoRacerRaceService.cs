using System.Diagnostics;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoRacer;

/// <summary>A serialized 50 Hz simulation loop, broadcasting every 50 ms.</summary>
public sealed class PoRacerRaceService : IAsyncDisposable
{
    private const double TickSeconds = 0.02;
    private readonly object _gate = new();
    private readonly PoRacerSim _sim;
    private readonly ILogger<PoRacerRaceService> _log;
    private readonly Dictionary<string, PoRacerInput> _inputs = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> _owners = new(StringComparer.Ordinal);
    private readonly HashSet<string> _connections = new(StringComparer.Ordinal);
    private readonly CancellationTokenSource _stop = new();
    private Task _loop = Task.CompletedTask;
    private DateTimeOffset _lastOccupied = DateTimeOffset.UtcNow;
    private DateTimeOffset? _finishedAt;
    private PoRacerFinalResult? _result;

    /// <param name="bots">False for a time trial (humans only on the grid).</param>
    /// <param name="botPace">Bot speed scale, the solo difficulty tier.</param>
    /// <param name="botCaution">How much the bots slow for bends (see <see cref="PoRacerSim.DefaultBotCaution"/>).</param>
    public PoRacerRaceService(string code, IReadOnlyList<PoRacerLobbyPlayer> players, ILogger<PoRacerRaceService> log,
        string? trackId = null, bool bots = true, double botPace = 1.0, double botCaution = PoRacerSim.DefaultBotCaution)
    {
        GameCode = code;
        _sim = new PoRacerSim(players, trackId, countdownSeconds: 3, bots, botPace, botCaution);
        _log = log;
        // A shared race: a seat nobody is connected to is driven by the stand-in bot, from the
        // lights (a lobby player who never arrived) or from the moment its driver drops. Solo
        // races are left alone: an idle car there is the driver's own business.
        _shared = code.StartsWith("multi-", StringComparison.Ordinal);
        if (_shared) foreach (var (owner, _) in _sim.Humans.ToArray()) _sim.SetAutopilot(owner, true);
    }

    private readonly bool _shared;

    public string GameCode { get; }
    public string TrackId => _sim.TrackId;
    public event Func<PoRacerRaceSnapshot, Task>? SnapshotReady;
    public event Func<PoRacerFinalResult, Task>? Finished;
    public PoRacerStaticWorld GetStaticWorld() => _sim.Static;
    public void Start() => _loop = RunAsync();

    public int? BindPlayer(string connectionId, string userId)
    {
        lock (_gate)
        {
            var carId = _sim.CarIdForOwner(userId);
            if (carId is null) return null;
            foreach (var old in _owners.Where(p => p.Value == userId).Select(p => p.Key).ToArray()) _owners.Remove(old);
            _inputs.Remove(userId);
            _owners[connectionId] = userId;
            _sim.SetAutopilot(userId, false);
            return carId;
        }
    }

    public void AddConnection(string connectionId)
    {
        lock (_gate) { _connections.Add(connectionId); _lastOccupied = DateTimeOffset.UtcNow; }
    }

    public void RemoveConnection(string connectionId)
    {
        lock (_gate)
        {
            _connections.Remove(connectionId);
            if (_owners.Remove(connectionId, out var owner))
            {
                _inputs.Remove(owner);
                if (_shared) _sim.SetAutopilot(owner, true);
            }
            // Nobody is left to resume a paused solo race; let it run out and expire.
            if (_connections.Count == 0) _sim.SetPaused(false);
            _lastOccupied = DateTimeOffset.UtcNow;
        }
    }

    public void SetInput(string connectionId, PoRacerInput input)
    {
        lock (_gate)
            if (_finishedAt is null && _owners.TryGetValue(connectionId, out var owner)) _inputs[owner] = input;
    }

    /// <summary>Paint the caller's car; true when the roster changed and the group needs it again.</summary>
    public bool SetPaint(string userId, string? colorHex, string? livery)
    {
        lock (_gate) return _finishedAt is null && _sim.SetPaint(userId, colorHex, livery);
    }

    /// <summary>Freeze or resume the race clock. Only a seated driver can, and the hub only asks for solo races.</summary>
    public void SetPaused(string connectionId, bool paused)
    {
        lock (_gate)
            if (_finishedAt is null && _owners.ContainsKey(connectionId)) _sim.SetPaused(paused);
    }

    public PoRacerRaceSnapshot Snapshot()
    {
        lock (_gate) return _sim.Snapshot(GameCode);
    }

    public PoRacerFinalResult? Result { get { lock (_gate) return _result; } }

    /// <summary>Each human's own standing in the finished race, keyed by claim identity. Empty until it ends.</summary>
    public IReadOnlyList<(string UserId, PoRacerFinalEntry Entry)> HumanResults()
    {
        lock (_gate)
        {
            if (_result is null) return [];
            return _sim.Humans
                .Select(h => (h.OwnerId, Entry: _result.Standings.FirstOrDefault(s => s.CarId == h.CarId)))
                .Where(h => h.Entry is not null)
                .Select(h => (h.OwnerId, h.Entry!))
                .ToList();
        }
    }

    public bool HasExpired(DateTimeOffset now)
    {
        lock (_gate)
            return _finishedAt is { } finished ? now - finished > TimeSpan.FromSeconds(30)
                : _connections.Count == 0 && now - _lastOccupied > TimeSpan.FromSeconds(30);
    }

    private async Task RunAsync()
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(20));
        // The sim steps a fixed 20 ms but laps are timed on the wall clock, so the loop has to run
        // as many steps as real time has actually passed. A PeriodicTimer asked for 20 ms fires
        // every ~31 ms on Windows and later still on a busy host; stepping once per fire ran the
        // race in slow motion against its own clock, slow enough on a loaded dev box that no bot
        // finished a lap inside the 180 s cap. Capped so a long stall is dropped, not replayed.
        var clock = Stopwatch.StartNew();
        double owed = 0, last = 0;
        var snapshotElapsed = 0;
        try
        {
            while (await timer.WaitForNextTickAsync(_stop.Token))
            {
                PoRacerFinalResult? result = null;
                PoRacerRaceSnapshot? snapshot = null;
                var now = clock.Elapsed.TotalSeconds;
                owed = Math.Min(owed + now - last, TickSeconds * 5);
                last = now;
                lock (_gate)
                {
                    while (owed >= TickSeconds && result is null)
                    {
                        owed -= TickSeconds;
                        _sim.Tick(TickSeconds, _inputs);
                        snapshotElapsed += 20;
                        if (_sim.AllFinishedOrStopped()) result = _sim.BuildFinalResult(GameCode);
                    }
                    if (snapshotElapsed >= 50 || result is not null)
                    {
                        snapshotElapsed %= 50;
                        snapshot = _sim.Snapshot(GameCode);
                    }
                    if (result is not null) { _result = result; _finishedAt = DateTimeOffset.UtcNow; }
                }
                if (snapshot is not null && SnapshotReady is { } onSnapshot) await onSnapshot(snapshot);
                if (result is not null)
                {
                    if (Finished is { } onFinished) await onFinished(result);
                    break;
                }
            }
        }
        catch (OperationCanceledException) when (_stop.IsCancellationRequested) { }
        catch (Exception ex)
        {
            lock (_gate) _finishedAt = DateTimeOffset.UtcNow;
            _log.LogError(ex, "Race {Code} stopped unexpectedly", GameCode);
        }
    }

    public async ValueTask DisposeAsync()
    {
        await _stop.CancelAsync();
        await _loop;
        SnapshotReady = null;
        Finished = null;
        _stop.Dispose();
    }
}
