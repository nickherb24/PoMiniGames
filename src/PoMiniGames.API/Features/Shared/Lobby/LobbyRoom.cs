using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.Shared.Lobby;

/// <summary>
/// The single global ready/start room every lobby game uses. First arrival becomes host,
/// later arrivals join until the cap, everyone but the host readies up, the host starts,
/// and the room resets when the game ends or the room drains. Racer, Sports, Voxel Strike
/// and Brawl share this one state machine, with its stale-start recovery and
/// host-migration rules.
/// </summary>
/// <remarks>
/// <para>
/// A game subclass supplies three things: how to build its player record on join
/// (<see cref="OpenCore"/>'s factory — a character, a fighter, a seat number), how to
/// flip that record's ready flag (<see cref="WithReady"/>, because records are immutable),
/// and optionally a stricter <see cref="CanStart"/> gate. Anything else it keeps (a
/// character lock, an identity map) it guards with <see cref="WithLock"/>.
/// </para>
/// <para>
/// Process-local like every other live-play registry. If the host restarts, players
/// re-join — a lobby has no reason to outlast its process.
/// </para>
/// </remarks>
public abstract class LobbyRoom<TPlayer> where TPlayer : class, ILobbyPlayer
{
    /// <summary>
    /// A started game that never produced an End() (everyone dropped mid-game) is treated
    /// as stale after this long, so the next visitor is not locked out by a dead flag.
    /// </summary>
    public const long StaleAfterMs = 90_000;

    private readonly Dictionary<string, TPlayer> _players = new(StringComparer.Ordinal);
    private readonly object _lock = new();
    private readonly string _inProgressMessage;
    private string _hostConnectionId = "";
    private long _startedAtMs;

    protected LobbyRoom(string gameCode, int maxPlayers, string inProgressMessage)
    {
        GameCode = gameCode;
        MaxPlayers = maxPlayers;
        _inProgressMessage = inProgressMessage;
    }

    /// <summary>Fixed code surfaced in <see cref="LobbyState{TPlayer}.GameCode"/>; no codes are user-visible.</summary>
    public string GameCode { get; protected set; }

    public int MaxPlayers { get; }

    /// <summary>Return the same seat with its ready flag set. Records are immutable, so the subclass owns the <c>with</c>.</summary>
    protected abstract TPlayer WithReady(TPlayer player, bool ready);

    /// <summary>
    /// The start gate. Default: someone is here and every non-host seat is ready (the host
    /// starts instead of readying). Games that need more — a picked character, a full room —
    /// tighten it here.
    /// </summary>
    protected virtual bool CanStart(IReadOnlyList<TPlayer> players, string hostConnectionId) =>
        players.Count > 0 && players.All(p => p.ConnectionId == hostConnectionId || p.IsReady);

    /// <summary>Called under the lock after a seat is removed, for per-game side tables.</summary>
    protected virtual void OnLeft(string connectionId)
    {
    }

    public LobbyState<TPlayer> State
    {
        get
        {
            lock (_lock)
            {
                return new LobbyState<TPlayer>(
                    Players: Ordered(),
                    HostConnectionId: string.IsNullOrEmpty(_hostConnectionId) ? null : _hostConnectionId,
                    GameCode: GameCode,
                    MaxPlayers: MaxPlayers,
                    LastUpdatedUtc: DateTimeOffset.UtcNow);
            }
        }
    }

    public IReadOnlyList<TPlayer> Players
    {
        get { lock (_lock) return Ordered(); }
    }

    public string? HostConnectionId
    {
        get { lock (_lock) return string.IsNullOrEmpty(_hostConnectionId) ? null : _hostConnectionId; }
    }

    public bool IsStarted
    {
        get { lock (_lock) return _startedAtMs > 0; }
    }

    public bool IsEmpty
    {
        get { lock (_lock) return _players.Count == 0; }
    }

    /// <summary>
    /// Seat the caller. If the room is empty they become host; a re-join with the same
    /// connection id refreshes the seat (the factory receives the previous record so a game
    /// can carry a seat number or identity across). Refused while a game is running or the
    /// room is full.
    /// </summary>
    /// <param name="create">Builds the seat: sanitized display name, the previous record for
    /// this connection (or null), and the other seats in order.</param>
    protected (LobbyState<TPlayer> state, string message) OpenCore(
        string connectionId, string displayName, bool isGuest,
        Func<string, TPlayer?, IReadOnlyList<TPlayer>, TPlayer> create)
    {
        lock (_lock)
        {
            var name = SanitizeName(displayName);
            if (_startedAtMs > 0 && (NowMs() - _startedAtMs) > StaleAfterMs && _players.Count == 0)
            {
                _startedAtMs = 0;
            }
            if (_startedAtMs > 0)
            {
                return (State, _inProgressMessage);
            }
            if (_players.Count >= MaxPlayers && !_players.ContainsKey(connectionId))
            {
                return (State, "Lobby is full");
            }
            _players.Remove(connectionId, out var existing);
            if (_hostConnectionId == connectionId) _hostConnectionId = "";
            var seat = create(name, existing, Ordered());
            _players[connectionId] = seat;
            if (string.IsNullOrEmpty(_hostConnectionId))
            {
                _hostConnectionId = connectionId;
            }
            _ = isGuest; // carried in the record by the factory; kept in the signature so every Open reads alike
            return (State, $"{name} joined");
        }
    }

    public void SetReady(string connectionId, bool ready)
    {
        lock (_lock)
        {
            if (!_players.TryGetValue(connectionId, out var existing)) return;
            _players[connectionId] = WithReady(existing, ready);
        }
    }

    /// <summary>
    /// Flip the caller's ready flag under the lock and report the value actually stored.
    /// Callers must announce THIS value: a read-then-SetReady pair outside the lock races
    /// two rapid toggles and broadcasts the pre-toggle state.
    /// </summary>
    public (bool ok, bool isReady, string message) ToggleReady(string connectionId)
    {
        lock (_lock)
        {
            if (!_players.TryGetValue(connectionId, out var existing)) return (false, false, "");
            var toggled = WithReady(existing, !existing.IsReady);
            _players[connectionId] = toggled;
            return (true, toggled.IsReady, $"{toggled.DisplayName} is {(toggled.IsReady ? "ready" : "not ready")}");
        }
    }

    public (bool ok, string message) Leave(string connectionId)
    {
        lock (_lock)
        {
            OnLeft(connectionId);
            if (!_players.Remove(connectionId, out var removed)) return (true, "");
            if (_hostConnectionId == connectionId)
            {
                _hostConnectionId = _players.Keys.OrderBy(k => k, StringComparer.Ordinal).FirstOrDefault() ?? "";
            }
            // When the room drains, clear the started flag so the next visitor isn't locked
            // out by a game everyone disconnected from before it could End().
            if (_players.Count == 0)
            {
                _startedAtMs = 0;
            }
            return (true, $"{removed.DisplayName} left");
        }
    }

    /// <summary>Host-only. Sets the started flag atomically so a second Start cannot race past the first.</summary>
    public bool TryStart(string connectionId)
    {
        lock (_lock)
        {
            if (_startedAtMs > 0) return false;
            if (_hostConnectionId != connectionId) return false;
            if (!CanStart(Ordered(), _hostConnectionId)) return false;
            _startedAtMs = NowMs();
            return true;
        }
    }

    /// <summary>The game is over: clear the started flag and every ready flag so the next round needs a fresh Ready.</summary>
    public void End()
    {
        lock (_lock)
        {
            _startedAtMs = 0;
            foreach (var key in _players.Keys.ToList())
            {
                _players[key] = WithReady(_players[key], false);
            }
        }
    }

    /// <summary>Run a per-game operation against the seat table under the room lock.</summary>
    protected TResult WithLock<TResult>(Func<IDictionary<string, TPlayer>, TResult> operation)
    {
        lock (_lock) return operation(_players);
    }

    private List<TPlayer> Ordered() =>
        _players.Values.OrderBy(p => p.ConnectionId, StringComparer.Ordinal).ToList();

    private static long NowMs() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    /// <summary>The shared display-name rule; see <see cref="PlayerNames.Sanitize"/>.</summary>
    public static string SanitizeName(string raw) => PlayerNames.Sanitize(raw);
}
