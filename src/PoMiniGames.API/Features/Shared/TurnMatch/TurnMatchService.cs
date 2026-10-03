using Microsoft.AspNetCore.SignalR;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.Shared.TurnMatch;

/// <summary>
/// Process-local quick-match queue and authoritative match state for a two-seat,
/// turn-based grid game (ConnectFive, TicTacToe). One instance per hub type: the
/// service owns every board, a client sends a cell, the service validates the seat,
/// the turn and the placement through its <see cref="GridGameRules"/>, and hands
/// back the snapshot both seats render.
/// </summary>
/// <remarks>
/// <para>
/// There is no lobby, host or ready check. A turn-based two-seat game needs none of
/// that: the first two arrivals are paired, who moves first is drawn at random, and
/// a rematch swaps the seats. That is deliberately less machinery than the
/// PoBrawl/PoRacer lobbies carry, because there is nothing to pick before play.
/// </para>
/// <para>
/// Seats are bound to a <b>seat token</b>, not a connection id. SignalR's automatic
/// reconnect hands the client a new connection id, so a 30 s WebSocket drop would
/// otherwise orphan the seat. A dropped seat is kept for <see cref="DisconnectGrace"/>
/// and the opponent is told it is waiting; if the token never comes back the match is
/// forfeited to whoever stayed. That timer is the one path where the service, not
/// the hub, broadcasts — hence the <see cref="IHubContext{THub}"/> dependency.
/// </para>
/// <para>
/// Process-local like every other live-play registry in the host: a restart drops
/// the matches, and a game that takes two minutes has no reason to outlive it.
/// </para>
/// </remarks>
public sealed class TurnMatchService<THub> where THub : Hub
{
    /// <summary>How long a dropped seat is held before the match is forfeited to the opponent.</summary>
    public static readonly TimeSpan DisconnectGrace = TimeSpan.FromSeconds(30);

    private readonly GridGameRules _rules;
    private readonly IHubContext<THub> _hub;
    private readonly ILogger _log;
    private readonly string _gameName;
    private readonly object _lock = new();

    private readonly List<Waiting> _queue = new();
    private readonly Dictionary<string, Match> _byConnection = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Match> _byToken = new(StringComparer.Ordinal);

    public TurnMatchService(GridGameRules rules, IHubContext<THub> hub, ILogger<TurnMatchService<THub>> log)
    {
        _rules = rules;
        _hub = hub;
        _log = log;
        _gameName = typeof(THub).Name.Replace("Hub", "", StringComparison.Ordinal);
    }

    public GridGameRules Rules => _rules;

    public string GroupFor(string matchId) => $"{_gameName}-match-{matchId}";

    /// <summary>Number of connections waiting to be paired. Diagnostics only.</summary>
    public int WaitingCount { get { lock (_lock) return _queue.Count; } }

    // ── Queue ───────────────────────────────────────────────────────────

    /// <summary>
    /// Join the quick-match queue. Returns the pairing when this arrival completed one,
    /// else null. A connection already seated or already waiting is left as it is.
    /// </summary>
    public Pairing? Enqueue(string connectionId, string principalId, string displayName, bool isGuest)
    {
        lock (_lock)
        {
            if (_byConnection.ContainsKey(connectionId)) return null;
            if (_queue.Any(w => w.ConnectionId == connectionId)) return null;

            var arrival = new Waiting(connectionId, SanitizePrincipal(principalId), Features.Shared.PlayerNames.Sanitize(displayName), isGuest);
            if (_queue.Count == 0)
            {
                _queue.Add(arrival);
                return null;
            }

            var partner = _queue[0];
            _queue.RemoveAt(0);

            // Who moves first is drawn, not "first arrival": the queue order is
            // invisible to both players, so a fixed rule would just be an unexplained
            // advantage for whoever the server happened to see first.
            var partnerFirst = Random.Shared.Next(2) == 0;
            var first = partnerFirst ? partner : arrival;
            var second = partnerFirst ? arrival : partner;

            var match = new Match(_rules, Guid.NewGuid().ToString("N"),
                new Seat(first, TurnMatchSide.First), new Seat(second, TurnMatchSide.Second));
            _byConnection[first.ConnectionId] = match;
            _byConnection[second.ConnectionId] = match;
            _byToken[match.First.Token] = match;
            _byToken[match.Second.Token] = match;

            _log.LogInformation("{Game}: paired {First} (first) vs {Second} (second) as match {MatchId}",
                _gameName, first.DisplayName, second.DisplayName, match.MatchId);
            return match.Pairing();
        }
    }

    public void Dequeue(string connectionId)
    {
        lock (_lock) _queue.RemoveAll(w => w.ConnectionId == connectionId);
    }

    // ── Play ────────────────────────────────────────────────────────────

    /// <summary>
    /// Place a mark for the seat behind <paramref name="connectionId"/>. Gravity games
    /// resolve the row themselves. Throws <see cref="InvalidOperationException"/> with
    /// a player-readable message on any rejected move; the hub relays it as a
    /// <see cref="HubException"/>.
    /// </summary>
    public TurnMatchState Place(string connectionId, int row, int col)
    {
        lock (_lock)
        {
            var match = RequireMatch(connectionId);
            var seat = match.SeatFor(connectionId);
            if (match.Status != TurnMatchStatus.InProgress) throw new InvalidOperationException("The game is over.");
            if (seat.Side != match.Turn) throw new InvalidOperationException("It is not your turn.");

            var landing = _rules.ResolveRow(match.Cells, row, col);
            if (landing < 0) throw new InvalidOperationException("You can't play there.");

            var mark = (byte)seat.Side;
            match.Cells[landing * _rules.Cols + col] = mark;
            match.MoveCount++;
            match.LastMove = new TurnMatchMove(landing, col, seat.Side);

            var line = _rules.FindWin(match.Cells, mark);
            if (line is not null)
            {
                match.Finish(seat.Side == TurnMatchSide.First ? TurnMatchStatus.FirstWon : TurnMatchStatus.SecondWon,
                    TurnMatchEndReason.Line, line);
            }
            else if (_rules.IsFull(match.Cells))
            {
                match.Finish(TurnMatchStatus.Draw, TurnMatchEndReason.BoardFull, []);
            }
            else
            {
                match.Turn = Other(match.Turn);
            }
            return match.Snapshot();
        }
    }

    /// <summary>
    /// Vote for a rematch. When both seats have voted the board resets, seats swap and
    /// the game number increments; the returned pairing carries each seat's new start
    /// record so the hub can tell them their side. Null pairing = still waiting.
    /// </summary>
    public (TurnMatchState State, Pairing? Rematch) RequestRematch(string connectionId)
    {
        lock (_lock)
        {
            var match = RequireMatch(connectionId);
            if (match.Status == TurnMatchStatus.InProgress) throw new InvalidOperationException("The game is still in progress.");
            var seat = match.SeatFor(connectionId);
            seat.WantsRematch = true;
            if (!match.First.WantsRematch || !match.Second.WantsRematch) return (match.Snapshot(), null);

            match.ResetForRematch();
            _log.LogInformation("{Game}: match {MatchId} rematch, game {GameNumber}", _gameName, match.MatchId, match.GameNumber);
            return (match.Snapshot(), match.Pairing());
        }
    }

    /// <summary>
    /// Explicit leave. An in-progress game is forfeited to the opponent; a finished
    /// one just loses the seat. Returns the state to broadcast, or null when the
    /// connection was not seated (a queued connection is simply dequeued).
    /// </summary>
    public TurnMatchState? Leave(string connectionId)
    {
        lock (_lock)
        {
            _queue.RemoveAll(w => w.ConnectionId == connectionId);
            if (!_byConnection.TryGetValue(connectionId, out var match)) return null;
            var seat = match.SeatFor(connectionId);
            if (match.Status == TurnMatchStatus.InProgress)
            {
                match.Finish(WinnerAgainst(seat.Side), TurnMatchEndReason.Forfeit, []);
            }
            Unseat(match, seat);
            return match.Snapshot();
        }
    }

    /// <summary>
    /// Transport disconnect. Unlike <see cref="Leave"/> the seat is kept: the token can
    /// <see cref="Rejoin"/> inside <see cref="DisconnectGrace"/>. Returns the state to
    /// broadcast so the opponent sees the seat go dark, or null when nothing changed.
    /// </summary>
    public TurnMatchState? Disconnected(string connectionId)
    {
        lock (_lock)
        {
            _queue.RemoveAll(w => w.ConnectionId == connectionId);
            if (!_byConnection.TryGetValue(connectionId, out var match)) return null;
            var seat = match.SeatFor(connectionId);
            _byConnection.Remove(connectionId);
            seat.Connected = false;
            seat.ConnectionId = "";
            seat.DisconnectEpoch++;

            if (match.Status != TurnMatchStatus.InProgress)
            {
                // Nothing to forfeit; drop the match once nobody is left holding a seat.
                if (!match.First.Connected && !match.Second.Connected) Forget(match);
                return match.Snapshot();
            }

            _ = ForfeitAfterGraceAsync(match, seat, seat.DisconnectEpoch);
            return match.Snapshot();
        }
    }

    /// <summary>
    /// Re-bind a seat to a fresh connection after a reconnect. Null when the token is
    /// unknown (the match was forfeited or the host restarted), in which case the client
    /// should go back to the queue.
    /// </summary>
    public TurnMatchRejoinResult? Rejoin(string connectionId, string seatToken)
    {
        lock (_lock)
        {
            if (string.IsNullOrEmpty(seatToken) || !_byToken.TryGetValue(seatToken, out var match)) return null;
            var seat = match.First.Token == seatToken ? match.First : match.Second;
            if (!string.IsNullOrEmpty(seat.ConnectionId)) _byConnection.Remove(seat.ConnectionId);
            seat.ConnectionId = connectionId;
            seat.Connected = true;
            seat.DisconnectEpoch++; // invalidates any pending forfeit timer
            _byConnection[connectionId] = match;
            return new TurnMatchRejoinResult(match.StartFor(seat), match.Snapshot());
        }
    }

    // ── Internals ───────────────────────────────────────────────────────

    private async Task ForfeitAfterGraceAsync(Match match, Seat seat, int epoch)
    {
        try
        {
            await Task.Delay(DisconnectGrace);
            TurnMatchState? state = null;
            lock (_lock)
            {
                // The seat came back (epoch moved) or the game already ended some other way.
                if (seat.DisconnectEpoch != epoch || seat.Connected) return;
                if (match.Status == TurnMatchStatus.InProgress)
                {
                    match.Finish(WinnerAgainst(seat.Side), TurnMatchEndReason.Disconnect, []);
                    state = match.Snapshot();
                }
                Unseat(match, seat);
            }
            if (state is not null)
            {
                _log.LogInformation("{Game}: match {MatchId} forfeited by disconnect ({Side})", _gameName, match.MatchId, seat.Side);
                await _hub.Clients.Group(GroupFor(match.MatchId)).SendAsync("state", state);
            }
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "{Game}: disconnect-forfeit broadcast failed for match {MatchId}", _gameName, match.MatchId);
        }
    }

    private void Unseat(Match match, Seat seat)
    {
        if (!string.IsNullOrEmpty(seat.ConnectionId)) _byConnection.Remove(seat.ConnectionId);
        _byToken.Remove(seat.Token);
        seat.ConnectionId = "";
        seat.Connected = false;
        seat.DisconnectEpoch++;
        var other = seat == match.First ? match.Second : match.First;
        if (!other.Connected) Forget(match);
    }

    private void Forget(Match match)
    {
        _byToken.Remove(match.First.Token);
        _byToken.Remove(match.Second.Token);
        if (!string.IsNullOrEmpty(match.First.ConnectionId)) _byConnection.Remove(match.First.ConnectionId);
        if (!string.IsNullOrEmpty(match.Second.ConnectionId)) _byConnection.Remove(match.Second.ConnectionId);
    }

    private Match RequireMatch(string connectionId) =>
        _byConnection.TryGetValue(connectionId, out var match)
            ? match
            : throw new InvalidOperationException("You are not in a match.");

    private static TurnMatchSide Other(TurnMatchSide s) =>
        s == TurnMatchSide.First ? TurnMatchSide.Second : TurnMatchSide.First;

    private static TurnMatchStatus WinnerAgainst(TurnMatchSide loser) =>
        loser == TurnMatchSide.First ? TurnMatchStatus.SecondWon : TurnMatchStatus.FirstWon;

    private static string SanitizePrincipal(string raw) =>
        string.IsNullOrWhiteSpace(raw) ? "anon" : raw.Trim().ToLowerInvariant();

    /// <summary>
    /// What the hub needs to announce a game start: each seat's connection id with its
    /// private start record, plus the shared board. Connection ids are exposed here and
    /// nowhere else, because the hub has to address the private records individually.
    /// </summary>
    public sealed record Pairing(
        string MatchId,
        IReadOnlyList<(string ConnectionId, TurnMatchStart Start)> Connections,
        TurnMatchState State);

    private sealed record Waiting(string ConnectionId, string PrincipalId, string DisplayName, bool IsGuest);

    private sealed class Seat
    {
        public Seat(Waiting from, TurnMatchSide side)
        {
            ConnectionId = from.ConnectionId;
            PrincipalId = from.PrincipalId;
            DisplayName = from.DisplayName;
            IsGuest = from.IsGuest;
            Side = side;
            Token = Guid.NewGuid().ToString("N");
            Connected = true;
        }

        public string ConnectionId { get; set; }
        public string PrincipalId { get; }
        public string DisplayName { get; }
        public bool IsGuest { get; }
        public string Token { get; }
        public TurnMatchSide Side { get; set; }
        public bool Connected { get; set; }
        public bool WantsRematch { get; set; }
        /// <summary>Bumped on every connect/disconnect so a stale grace timer can tell it lost the race.</summary>
        public int DisconnectEpoch { get; set; }

        public TurnMatchSeat Public() => new(DisplayName, IsGuest, Side, Connected, WantsRematch);
    }

    private sealed class Match
    {
        private readonly GridGameRules _rules;

        public Match(GridGameRules rules, string matchId, Seat first, Seat second)
        {
            _rules = rules;
            MatchId = matchId;
            First = first;
            Second = second;
            Cells = new byte[rules.CellCount];
        }

        public string MatchId { get; }
        public int GameNumber { get; private set; } = 1;
        public Seat First { get; private set; }
        public Seat Second { get; private set; }
        public byte[] Cells { get; private set; }
        public int MoveCount { get; set; }
        public TurnMatchSide Turn { get; set; } = TurnMatchSide.First;
        public TurnMatchStatus Status { get; private set; } = TurnMatchStatus.InProgress;
        public TurnMatchEndReason EndReason { get; private set; } = TurnMatchEndReason.None;
        public TurnMatchMove? LastMove { get; set; }
        public int[] WinCells { get; private set; } = [];

        public Seat SeatFor(string connectionId) =>
            First.ConnectionId == connectionId ? First
            : Second.ConnectionId == connectionId ? Second
            : throw new InvalidOperationException("You are not seated in this match.");

        public void Finish(TurnMatchStatus status, TurnMatchEndReason reason, int[] winCells)
        {
            Status = status;
            EndReason = reason;
            WinCells = winCells;
        }

        /// <summary>Fresh board, seats swapped so the other player opens. Both seats keep their tokens.</summary>
        public void ResetForRematch()
        {
            (First, Second) = (Second, First);
            First.Side = TurnMatchSide.First;
            Second.Side = TurnMatchSide.Second;
            First.WantsRematch = false;
            Second.WantsRematch = false;
            Cells = new byte[_rules.CellCount];
            MoveCount = 0;
            Turn = TurnMatchSide.First;
            Status = TurnMatchStatus.InProgress;
            EndReason = TurnMatchEndReason.None;
            LastMove = null;
            WinCells = [];
            GameNumber++;
        }

        public TurnMatchStart StartFor(Seat seat) =>
            new(MatchId, GameNumber, seat.Token, seat.Side, First.Public(), Second.Public());

        public Pairing Pairing() =>
            new(MatchId, [(First.ConnectionId, StartFor(First)), (Second.ConnectionId, StartFor(Second))], Snapshot());

        public TurnMatchState Snapshot() =>
            new(MatchId, GameNumber, (byte[])Cells.Clone(), MoveCount, Turn, Status, EndReason, LastMove,
                (int[])WinCells.Clone(), First.Public(), Second.Public(), DateTimeOffset.UtcNow);
    }
}
