using System.Collections.Concurrent;
using Microsoft.AspNetCore.SignalR;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoCabinet;

/// <summary>
/// Owns the running PoCabinet multiplayer race on this host (keyed by
/// <see cref="PoCabinetLobbyService.RaceId"/>: one lobby, so at most one race), ticked at
/// 30 Hz by one shared timer, broadcasting a snapshot to the race group after every tick.
///
/// <para>
/// <b>Inputs are queued, one consumed per tick.</b> Each client runs its own car on a fixed
/// 30 Hz step and sends one numbered input per step; the server applies them in order and
/// echoes the last applied number as <see cref="PoCabinetCarState.AckSeq"/>. That is what
/// lets the client replay only the inputs the server has not seen yet. When the network
/// delivers nothing, the last input repeats; when a burst arrives, the queue is trimmed to
/// three so a lag spike cannot turn into permanent input delay.
/// </para>
/// <para>
/// Seats bind to the caller's claim id (<see cref="Join"/>), so a reconnect resumes the same
/// car. Anyone else who joins the group spectates: they get snapshots and no car. When a race
/// ends the result is broadcast as <c>RaceFinished</c> and the lobby reopens for a rematch.
/// </para>
/// </summary>
public sealed class PoCabinetRaceRegistry : IAsyncDisposable
{
    private const int TickHz = 30;
    private const double CountdownSeconds = 3;
    private const int MaxQueuedInputs = 3;
    private static readonly TimeSpan AbandonAfter = TimeSpan.FromSeconds(45);

    private readonly ConcurrentDictionary<string, RaceSession> _races = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string, Binding> _connections = new(StringComparer.Ordinal);
    private readonly IHubContext<PoCabinetRaceHub> _raceHub;
    private readonly IHubContext<PoCabinetLobbyHub> _lobbyHub;
    private readonly PoCabinetLobbyService _lobbies;
    private readonly ILogger<PoCabinetRaceRegistry> _logger;
    private readonly TimeProvider _time;
    private readonly ITimer _timer;
    private int _ticking;
    private bool _disposed;

    public PoCabinetRaceRegistry(
        IHubContext<PoCabinetRaceHub> raceHub,
        IHubContext<PoCabinetLobbyHub> lobbyHub,
        PoCabinetLobbyService lobbies,
        ILogger<PoCabinetRaceRegistry> logger,
        TimeProvider? time = null)
    {
        _raceHub = raceHub;
        _lobbyHub = lobbyHub;
        _lobbies = lobbies;
        _logger = logger;
        _time = time ?? TimeProvider.System;
        var period = TimeSpan.FromSeconds(1.0 / TickHz);
        _timer = _time.CreateTimer(_ => TickAll(), null, period, period);
    }

    public static string RaceGroup(string code) => $"race:{code.ToUpperInvariant()}";

    public const string LobbyGroup = "lobby:" + PoCabinetLobbyService.RaceId;

    /// <summary>Start a race for <paramref name="code"/>, replacing any finished one.</summary>
    public void Create(string code, string trackId, IReadOnlyList<PoCabinetDriver> drivers)
    {
        var sim = new PoCabinetSim(trackId, seed: Random.Shared.Next(), drivers)
        {
            CountdownSeconds = CountdownSeconds,
        };
        var session = new RaceSession(code, sim, _time.GetUtcNow());
        foreach (var d in drivers.Where(d => d.IsPlayer)) session.Queues[d.OwnerId] = new Queue<PoCabinetInput>();
        _races[code] = session;
        _logger.LogInformation("PoCabinet race {Code} created with {Count} cars on {Track}", code, drivers.Count, trackId);
    }

    public bool IsRunning(string code) => _races.ContainsKey(code);

    /// <summary>
    /// Bind a connection to a race and return the join snapshot: current state plus the static
    /// world and, for a seated player, their car id. Null when no such race is running.
    /// </summary>
    public PoCabinetRaceSnapshot? Join(string code, string connectionId, string playerId)
    {
        if (!_races.TryGetValue(code, out var session)) return null;
        lock (session.Gate)
        {
            int? carId = session.Sim.CarIdForOwner(playerId);
            _connections[connectionId] = new Binding(session.Code, carId is null ? null : playerId);
            session.ConnectionCount++;
            session.LastSeen = _time.GetUtcNow();
            var snap = BuildSnapshot(session, dialogue: null);
            snap.Static = PoCabinetTrackGeometry.BuildStaticWorld(session.Sim.TrackId);
            snap.LocalCarId = carId;
            return snap;
        }
    }

    public void Leave(string connectionId)
    {
        if (!_connections.TryRemove(connectionId, out var binding)) return;
        if (_races.TryGetValue(binding.Code, out var session))
        {
            lock (session.Gate)
            {
                session.ConnectionCount = Math.Max(0, session.ConnectionCount - 1);
                session.LastSeen = _time.GetUtcNow();
            }
        }
    }

    /// <summary>Queue one tick of input from a seated connection. Spectators and strangers are ignored.</summary>
    public void SubmitInput(string connectionId, PoCabinetInput input)
    {
        if (input is null) return;
        if (!_connections.TryGetValue(connectionId, out var binding) || binding.PlayerId is null) return;
        if (!_races.TryGetValue(binding.Code, out var session)) return;
        lock (session.Gate)
        {
            if (!session.Queues.TryGetValue(binding.PlayerId, out var queue)) return;
            queue.Enqueue(input);
            // A queue this deep is a burst after a stall — keep the newest few.
            while (queue.Count > MaxQueuedInputs * 2) queue.Dequeue();
            session.LastSeen = _time.GetUtcNow();
        }
    }

    private void TickAll()
    {
        if (_disposed || Interlocked.Exchange(ref _ticking, 1) == 1) return;
        try
        {
            foreach (var session in _races.Values)
            {
                try
                {
                    TickOne(session);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex, "PoCabinet tick for {Code} failed", session.Code);
                }
            }
        }
        finally
        {
            Volatile.Write(ref _ticking, 0);
        }
    }

    private void TickOne(RaceSession session)
    {
        PoCabinetRaceSnapshot snapshot;
        PoCabinetFinalResult? result = null;
        bool abandoned;
        lock (session.Gate)
        {
            foreach (var (playerId, queue) in session.Queues)
            {
                while (queue.Count > MaxQueuedInputs) queue.Dequeue();
                if (queue.Count > 0) session.Applied[playerId] = queue.Dequeue();
            }
            session.Sim.Tick(1.0 / TickHz, session.Applied);
            snapshot = BuildSnapshot(session, session.Sim.TakeDialogue());
            abandoned = session.ConnectionCount == 0 && _time.GetUtcNow() - session.LastSeen > AbandonAfter;
            if (session.Sim.IsFinished) result = session.Sim.BuildResult(session.Code);
        }

        var group = _raceHub.Clients.Group(RaceGroup(session.Code));
        _ = group.SendAsync("RaceSnapshot", snapshot);

        if (result is null && !abandoned) return;
        if (!_races.TryRemove(new KeyValuePair<string, RaceSession>(session.Code, session))) return;
        foreach (var (connectionId, binding) in _connections)
        {
            if (string.Equals(binding.Code, session.Code, StringComparison.OrdinalIgnoreCase))
                _connections.TryRemove(connectionId, out _);
        }
        if (result is not null)
        {
            _logger.LogInformation("PoCabinet race {Code} finished", session.Code);
            _ = group.SendAsync("RaceFinished", result);
        }
        else
        {
            _logger.LogInformation("PoCabinet race {Code} abandoned", session.Code);
        }
        _lobbies.MarkRaceFinished();
        var view = _lobbies.View();
        if (view is not null) _ = _lobbyHub.Clients.Group(LobbyGroup).SendAsync("LobbyState", view);
    }

    private static PoCabinetRaceSnapshot BuildSnapshot(RaceSession session, PoCabinetDialogueEvent? dialogue)
    {
        var sim = session.Sim;
        // Rounded on purpose: 30 Hz × 8 cars of full-precision doubles blew the 2 KB frame
        // budget in practice, and a hundredth of a unit is far below one pixel.
        var cars = sim.SnapshotCars().Select(c => new PoCabinetCarState
        {
            Id = c.Id,
            Name = c.Name,
            OfficialId = c.OfficialId,
            Color = c.Color,
            X = Math.Round(c.X, 2),
            Y = Math.Round(c.Y, 2),
            Heading = Math.Round(c.Heading, 4),
            SpeedKmh = Math.Round(c.Speed * PoCabinetPhysics.KmhPerUnit, 1),
            Lap = c.Lap,
            LapProgress = Math.Round(LapFraction(c.Distance, sim.Track.Length), 4),
            Position = c.Position,
            IsPlayer = c.IsPlayer,
            Finished = c.Finished,
            AckSeq = c.AckSeq,
        }).ToList();

        return new PoCabinetRaceSnapshot
        {
            GameCode = session.Code,
            ServerTimeMs = (long)Math.Round((sim.ElapsedRaceTime + sim.CountdownSeconds) * 1000),
            ElapsedRaceTime = Math.Round(Math.Max(0, sim.ElapsedRaceTime), 3),
            Started = sim.Started,
            CountdownSeconds = sim.CountdownRemaining,
            Finished = sim.IsFinished,
            Cars = cars,
            LatestDialogue = dialogue,
        };
    }

    /// <summary>Fraction of the current lap in [0, 1); the grid (negative distance) reads as the end of a lap.</summary>
    private static double LapFraction(double distance, double length)
    {
        double f = distance / length % 1;
        return f < 0 ? f + 1 : f;
    }

    public ValueTask DisposeAsync()
    {
        if (_disposed) return ValueTask.CompletedTask;
        _disposed = true;
        _timer.Dispose();
        _races.Clear();
        _connections.Clear();
        return ValueTask.CompletedTask;
    }

    private sealed record Binding(string Code, string? PlayerId);

    private sealed class RaceSession(string code, PoCabinetSim sim, DateTimeOffset createdAt)
    {
        public string Code { get; } = code;
        public PoCabinetSim Sim { get; } = sim;
        public object Gate { get; } = new();
        public Dictionary<string, Queue<PoCabinetInput>> Queues { get; } = new(StringComparer.Ordinal);
        public Dictionary<string, PoCabinetInput> Applied { get; } = new(StringComparer.Ordinal);
        public int ConnectionCount { get; set; }
        public DateTimeOffset LastSeen { get; set; } = createdAt;
    }
}
