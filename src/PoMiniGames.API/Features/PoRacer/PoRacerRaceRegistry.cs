using Microsoft.AspNetCore.SignalR;
using PoMiniGames.Infrastructure;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoRacer;

/// <summary>A human's result in a race this server ran: the only lap a score submit may store.</summary>
public sealed record PoRacerVerifiedLap(string TrackId, double BestLapSeconds, int Position, DateTimeOffset FinishedAtUtc);

/// <summary>Owns races, broadcast subscriptions, connection bindings, expiry and the laps it timed.</summary>
public sealed class PoRacerRaceRegistry : IAsyncDisposable
{
    private readonly Dictionary<string, PoRacerRaceService> _races = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, string> _connections = new(StringComparer.Ordinal);
    private readonly object _gate = new();
    private readonly PoRacerLobbyService _lobby;
    private readonly IHubContext<PoRacerRaceHub> _hub;
    private readonly ILoggerFactory _logs;
    private readonly CancellationTokenSource _shutdown = new();
    private readonly Task _expiry;
    private readonly VerifiedResultStore? _store;

    public PoRacerRaceRegistry(PoRacerLobbyService lobby, IHubContext<PoRacerRaceHub> hub, ILoggerFactory logs,
        VerifiedResultStore? store = null)
    {
        _lobby = lobby;
        _hub = hub;
        _logs = logs;
        _store = store;
        _expiry = ExpireAsync();
    }

    /// <summary>The lobby's race, on the track the host's seat picked.</summary>
    public PoRacerRaceService StartMultiplayer()
    {
        var players = _lobby.Players;
        var track = players.FirstOrDefault(p => p.ConnectionId == _lobby.HostConnectionId)?.TrackId;
        return GetOrCreate(_lobby.CreateRaceCode(), players.DistinctBy(p => p.UserId).ToArray(), track);
    }

    public PoRacerRaceService Join(string code, bool asPlayer, PoRacerLobbyPlayer player, string? trackId, PoRacerJoinOptions? options = null)
    {
        if (code.StartsWith("multi-", StringComparison.Ordinal))
            return GetByCode(code) ?? throw new HubException("The race has ended. Return to the lobby.");
        if (!asPlayer) return GetOrCreate("DEMO", [], trackId, carCount: PoRacerCatalog.SoloCarCount);
        if (!code.StartsWith("solo-", StringComparison.Ordinal) || code.Length > 48)
            throw new HubException("Invalid race code.");
        // Solo only: a time trial is the same race with no bots, and the tier sets how fast the
        // bots are and, mostly, how much they lift for corners. Measured over an all-bot race on
        // the oval: easy laps in about 27 s (the bots as they always were, and what demo and
        // online races still use), medium in 21, hard in about 16. The pads and the drift payout
        // take a second off a clean human lap (14-15 s) and impact damage puts a little on the
        // bots', so hard lifts less to stay a race.
        var (pace, caution) = options?.Difficulty switch
        {
            "easy" => (1.0, PoRacerSim.DefaultBotCaution),
            "hard" => (1.07, 0.20),
            _ => (1.03, 0.42),
        };
        return GetOrCreate(code, [player], trackId, bots: options?.Mode != "trial", pace, caution,
            carCount: PoRacerCatalog.SoloCarCount);
    }

    private PoRacerRaceService GetOrCreate(string code, IReadOnlyList<PoRacerLobbyPlayer> players, string? trackId,
        bool bots = true, double botPace = 1.0, double botCaution = PoRacerSim.DefaultBotCaution,
        int carCount = PoRacerCatalog.CarCount)
    {
        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_shutdown.IsCancellationRequested, this);
            if (_races.TryGetValue(code, out var existing)) return existing;
            if (_races.Count >= 64) throw new HubException("The race grid is busy. Try again shortly.");
            var race = new PoRacerRaceService(code, players, _logs.CreateLogger<PoRacerRaceService>(), trackId,
                bots, botPace, botCaution, carCount);
            race.SnapshotReady += snapshot => BroadcastAsync(code, "raceSnapshot", snapshot);
            race.Finished += result =>
            {
                Remember(race);
                return BroadcastAsync(code, "raceFinished", result);
            };
            _races.Add(code, race);
            race.Start();
            return race;
        }
    }

    // ── Server-timed laps ────────────────────────────────────────────────
    // The sim runs here, so the lap a score submit is allowed to store is the one this process
    // timed, not the one the browser reports. A race is disposed 30 s after it ends; its humans'
    // laps are kept for an hour so a parked score (PendingScoreStore) can still be backed when the
    // connection returns. The dictionary is the fast path; every lap is also written through to
    // VerifiedResultStore, because on F1 the host recycles when idle and a lap held only in memory
    // would mean a score parked across a recycle was refused for good.
    private static readonly TimeSpan VerifiedFor = TimeSpan.FromHours(1);
    private const string StoreGame = "poracer";
    private readonly Dictionary<(string UserId, string Code), PoRacerVerifiedLap> _verified = [];

    private void Remember(PoRacerRaceService race)
    {
        var now = DateTimeOffset.UtcNow;
        foreach (var (userId, entry) in race.HumanResults())
            if (entry.BestLapSeconds > 0)
                Remember(userId, race.GameCode, new(race.TrackId, entry.BestLapSeconds, entry.Position, now));
    }

    /// <summary>Back a lap for an identity and race code. Public for the storage tests, which cannot run three laps.</summary>
    public void Remember(string userId, string code, PoRacerVerifiedLap lap)
    {
        code = code.ToLowerInvariant();
        lock (_gate) _verified[(userId, code)] = lap;
        // Not awaited: the race loop must not wait on storage, and the store logs its own failures.
        _ = _store?.SaveAsync(StoreGame, StoreKey(userId, code), lap);
    }

    /// <summary>
    /// The lap this server timed for that identity in that race, if it is still remembered: by this
    /// process, or by the durable store when the race ran before a recycle.
    /// </summary>
    public async Task<PoRacerVerifiedLap?> VerifiedLapAsync(string userId, string? code, CancellationToken ct = default)
    {
        code = (code ?? "").ToLowerInvariant();
        PoRacerVerifiedLap? lap;
        lock (_gate) _verified.TryGetValue((userId, code), out lap);
        if (lap is null && _store is not null)
            lap = await _store.FindAsync<PoRacerVerifiedLap>(StoreGame, StoreKey(userId, code), VerifiedFor, ct: ct);
        return lap is not null && DateTimeOffset.UtcNow - lap.FinishedAtUtc <= VerifiedFor ? lap : null;
    }

    private static string StoreKey(string userId, string code) => userId + "|" + code;

    private async Task BroadcastAsync<T>(string code, string method, T message)
    {
        try { await _hub.Clients.Group(RaceGroup(code)).SendAsync(method, message, _shutdown.Token); }
        catch (OperationCanceledException) when (_shutdown.IsCancellationRequested) { }
        catch (Exception ex) { _logs.CreateLogger<PoRacerRaceRegistry>().LogWarning(ex, "Race broadcast failed: {Code}", code); }
    }

    public PoRacerRaceService? GetByCode(string code)
    {
        lock (_gate) return _races.GetValueOrDefault(code);
    }

    public void RegisterConnection(string code, string connectionId)
    {
        lock (_gate)
        {
            if (_connections.TryGetValue(connectionId, out var oldCode) &&
                !string.Equals(oldCode, code, StringComparison.OrdinalIgnoreCase) && _races.TryGetValue(oldCode, out var old))
                old.RemoveConnection(connectionId);
            _connections[connectionId] = code;
            _races[code].AddConnection(connectionId);
        }
    }

    public void RemoveConnection(string connectionId)
    {
        lock (_gate)
            if (_connections.Remove(connectionId, out var code) && _races.TryGetValue(code, out var race))
                race.RemoveConnection(connectionId);
    }

    public string? CodeFor(string connectionId)
    {
        lock (_gate) return _connections.GetValueOrDefault(connectionId);
    }

    public static string RaceGroup(string code) => "poracer-race-" + code.ToUpperInvariant();

    private async Task ExpireAsync()
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(5));
        try
        {
            while (await timer.WaitForNextTickAsync(_shutdown.Token))
            {
                List<PoRacerRaceService> expired;
                lock (_gate)
                {
                    expired = _races.Values.Where(r => r.HasExpired(DateTimeOffset.UtcNow)).ToList();
                    foreach (var race in expired)
                    {
                        _races.Remove(race.GameCode);
                        foreach (var connection in _connections.Where(c => string.Equals(c.Value, race.GameCode, StringComparison.OrdinalIgnoreCase)).Select(c => c.Key).ToArray())
                            _connections.Remove(connection);
                        if (race.GameCode == _lobby.GameCode) _lobby.End();
                    }
                    var cutoff = DateTimeOffset.UtcNow - VerifiedFor;
                    foreach (var stale in _verified.Where(v => v.Value.FinishedAtUtc < cutoff).Select(v => v.Key).ToArray())
                        _verified.Remove(stale);
                }
                foreach (var race in expired) await race.DisposeAsync();
            }
        }
        catch (OperationCanceledException) when (_shutdown.IsCancellationRequested) { }
    }

    public async ValueTask DisposeAsync()
    {
        await _shutdown.CancelAsync();
        await _expiry;
        List<PoRacerRaceService> races;
        lock (_gate)
        {
            races = _races.Values.ToList();
            _races.Clear();
            _connections.Clear();
        }
        foreach (var race in races) await race.DisposeAsync();
        _shutdown.Dispose();
    }
}
