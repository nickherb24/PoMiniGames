using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;
using PoMiniGames.Shared.Games;
using PoMiniGamesClient.Models;
using PoMiniGamesClient.Services.Auth;
using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGamesClient.Services.Play;

/// <summary>Where a quick-match online session is, from the player's point of view. Rendered by <c>QuickMatchPanel</c>.</summary>
public enum QuickMatchPhase
{
    Idle,
    Connecting,
    Searching,
    Playing,
    Over,
    Error,
}

/// <summary>
/// The client-side state machine for an online turn game (Connect Five, Tic-Tac-Toe):
/// connect, queue, receive a seat, relay moves, read the server's snapshots, vote for a
/// rematch, record the result. The page keeps only what is board-specific — how a move
/// is drawn and sounded — through the three events below. Until 2026-09-14 both game
/// pages carried this machine inline, ~250 identical lines each.
/// </summary>
public sealed class OnlineTurnSession : IAsyncDisposable
{
    private readonly ApiEndpoints _endpoints;
    private readonly AuthStateService _auth;
    private readonly ToastService _toasts;
    private readonly MatchHistoryService _history;
    private readonly string _hubPath;
    private readonly string _gameKey;
    private readonly string _localName;
    private TurnMatchClient? _client;
    private bool _matchRecorded;

    /// <param name="hubPath">e.g. <c>connectfive/hub</c>.</param>
    /// <param name="gameKey">Match-history key, e.g. <c>connectfive</c>.</param>
    /// <param name="localName">Fallback display name sent with the queue request.</param>
    public OnlineTurnSession(
        ApiEndpoints endpoints, AuthStateService auth, ToastService toasts, MatchHistoryService history,
        string hubPath, string gameKey, string localName)
    {
        _endpoints = endpoints;
        _auth = auth;
        _toasts = toasts;
        _history = history;
        _hubPath = hubPath;
        _gameKey = gameKey;
        _localName = localName;
    }

    /// <summary>Anything below changed; re-render.</summary>
    public event Action? Changed;
    /// <summary>A new game began (first pairing or rematch): clear the board.</summary>
    public event Action<TurnMatchStart>? GameStarted;
    /// <summary>The board is exactly one move behind the server: draw (and sound) this move.</summary>
    public event Action<TurnMatchMove>? MoveApplied;
    /// <summary>The board is further behind (rejoin, missed broadcast): rebuild silently from these cells.</summary>
    public event Action<byte[]>? BoardRebuilt;
    /// <summary>The game ended. Win cells are flat indices into the grid; empty for a draw or forfeit.</summary>
    public event Action<GameResult, int[]>? GameEnded;

    public QuickMatchPhase Phase { get; private set; } = QuickMatchPhase.Idle;
    public TurnMatchStart? Seat { get; private set; }
    public TurnMatchSide MySide { get; private set; } = TurnMatchSide.First;
    public int GameNumber { get; private set; }
    public int MoveCount { get; private set; }
    public TurnMatchSide Turn { get; private set; } = TurnMatchSide.First;
    public TurnMatchEndReason EndReason { get; private set; }
    public GameResult Result { get; private set; } = GameResult.InProgress;
    public string OpponentName { get; private set; } = "Opponent";
    public bool OpponentConnected { get; private set; } = true;
    public bool OpponentGone { get; private set; }
    public bool AwaitingServer { get; private set; }
    public bool Reconnecting { get; private set; }

    public bool IsMyTurn =>
        Phase == QuickMatchPhase.Playing && Result == GameResult.InProgress
        && Turn == MySide && !AwaitingServer && !Reconnecting;

    /// <summary>Display name for a side, marked "(you)" for the local seat; the fallbacks show before pairing.</summary>
    public string SeatName(TurnMatchSide side, string firstFallback, string secondFallback)
    {
        if (Seat is null) return side == TurnMatchSide.First ? firstFallback : secondFallback;
        var seat = side == TurnMatchSide.First ? Seat.First : Seat.Second;
        return side == MySide ? $"{seat.DisplayName} (you)" : seat.DisplayName;
    }

    /// <summary>One status line for the visible turn bar and the screen-reader announcement.</summary>
    public string StatusText => Phase switch
    {
        QuickMatchPhase.Idle or QuickMatchPhase.Connecting => "Connecting…",
        QuickMatchPhase.Searching => "Finding an opponent…",
        QuickMatchPhase.Error => "Connection lost",
        _ when Result == GameResult.Win => EndReason switch
        {
            TurnMatchEndReason.Forfeit => $"{OpponentName} left — you win",
            TurnMatchEndReason.Disconnect => $"{OpponentName} disconnected — you win",
            _ => "You win!",
        },
        _ when Result == GameResult.Loss => $"{OpponentName} wins",
        _ when Result == GameResult.Draw => "Draw",
        _ when Reconnecting => "Reconnecting…",
        _ when !OpponentConnected => $"{OpponentName} is reconnecting…",
        _ when AwaitingServer => "Sending…",
        _ when Turn == MySide => "Your turn",
        _ => $"{OpponentName}'s turn",
    };

    // ── Lifecycle ─────────────────────────────────────────────────────────

    public async Task StartAsync()
    {
        Phase = QuickMatchPhase.Connecting;
        Reconnecting = false;
        Changed?.Invoke();
        try
        {
            if (_client is null)
            {
                _client = new TurnMatchClient(_endpoints, _hubPath);
                _client.MatchStarted += OnMatchStarted;
                _client.StateChanged += OnState;
                _client.ConnectionChanged += OnConnection;
                _client.SeatLost += OnSeatLost;
            }
            await _client.ConnectAsync();
            await FindOpponentAsync();
        }
        catch (Exception)
        {
            Phase = QuickMatchPhase.Error;
            _toasts.Show("Couldn't reach the game server.", ToastType.Error);
            Changed?.Invoke();
        }
    }

    public async Task RetryAsync()
    {
        await TearDownAsync();
        await StartAsync();
    }

    /// <summary>Queue for a (new) opponent. A finished seat is given up first — the server refuses to queue a seated connection.</summary>
    public async Task FindOpponentAsync()
    {
        if (_client is null) return;
        if (Seat is not null) await _client.LeaveAsync();
        _client.ForgetSeat();
        Seat = null;
        OpponentGone = false;
        OpponentConnected = true;
        EndReason = TurnMatchEndReason.None;
        Result = GameResult.InProgress;
        _matchRecorded = false;
        Phase = QuickMatchPhase.Searching;
        Changed?.Invoke();
        // matchStarted may fire before this returns (the server pairs inside the call), so
        // the phase is only ever advanced by the event, never here.
        await _client.FindMatchAsync(_localName, !_auth.IsAuthenticated);
    }

    public async Task FindOpponentSafeAsync()
    {
        try { await FindOpponentAsync(); }
        catch (Exception)
        {
            Phase = QuickMatchPhase.Error;
            Changed?.Invoke();
        }
    }

    /// <summary>Place a mark. Gravity games pass any row; the server resolves it.</summary>
    public async Task PlaceAsync(int row, int col)
    {
        if (_client is null || !IsMyTurn) return;
        AwaitingServer = true;
        Changed?.Invoke();
        try
        {
            await _client.PlaceAsync(row, col);
        }
        catch (HubException ex)
        {
            _toasts.Show(ex.Message, ToastType.Warning);
        }
        catch (Exception)
        {
            _toasts.Show("That move didn't reach the server — try again.", ToastType.Warning);
        }
        finally
        {
            AwaitingServer = false;
            Changed?.Invoke();
        }
    }

    public async Task TearDownAsync()
    {
        var client = _client;
        if (client is null) return;
        _client = null;
        client.MatchStarted -= OnMatchStarted;
        client.StateChanged -= OnState;
        client.ConnectionChanged -= OnConnection;
        client.SeatLost -= OnSeatLost;
        await client.LeaveAsync();
        await client.DisposeAsync();
    }

    public ValueTask DisposeAsync() => new(TearDownAsync());

    // ── Server events ─────────────────────────────────────────────────────

    private void OnMatchStarted(TurnMatchStart start)
    {
        Seat = start;
        MySide = start.YourSide;
        GameNumber = start.GameNumber;
        OpponentName = (start.YourSide == TurnMatchSide.First ? start.Second : start.First).DisplayName;
        Phase = QuickMatchPhase.Playing;
        OpponentGone = false;
        OpponentConnected = true;
        EndReason = TurnMatchEndReason.None;
        Result = GameResult.InProgress;
        MoveCount = 0;
        Turn = TurnMatchSide.First;
        AwaitingServer = false;
        _matchRecorded = false;
        GameStarted?.Invoke(start);
        Changed?.Invoke();
    }

    private void OnState(TurnMatchState state)
    {
        if (Seat is null || state.MatchId != Seat.MatchId) return;
        var opponent = state.OpponentOf(MySide);
        OpponentName = opponent.DisplayName;
        OpponentConnected = opponent.Connected;

        var sameGame = state.GameNumber == GameNumber;
        if (sameGame && state.MoveCount == MoveCount + 1 && state.LastMove is { } move)
        {
            MoveApplied?.Invoke(move);
        }
        else if (!sameGame || state.MoveCount != MoveCount)
        {
            GameNumber = state.GameNumber;
            Result = GameResult.InProgress;
            BoardRebuilt?.Invoke(state.Cells);
        }
        MoveCount = state.MoveCount;
        Turn = state.Turn;
        EndReason = state.EndReason;

        if (state.Status != TurnMatchStatus.InProgress && Result == GameResult.InProgress)
        {
            Result = state.Status switch
            {
                TurnMatchStatus.Draw => GameResult.Draw,
                TurnMatchStatus.FirstWon => MySide == TurnMatchSide.First ? GameResult.Win : GameResult.Loss,
                _ => MySide == TurnMatchSide.Second ? GameResult.Win : GameResult.Loss,
            };
            Phase = QuickMatchPhase.Over;
            RecordResult();
            GameEnded?.Invoke(Result, state.WinCells);
        }
        if (Phase == QuickMatchPhase.Over && !opponent.Connected) OpponentGone = true;
        Changed?.Invoke();
    }

    private void OnConnection(HubConnectionState state)
    {
        Reconnecting = state == HubConnectionState.Reconnecting;
        if (state == HubConnectionState.Disconnected && Phase is not (QuickMatchPhase.Idle or QuickMatchPhase.Error))
        {
            Phase = QuickMatchPhase.Error;
        }
        Changed?.Invoke();
    }

    private void OnSeatLost()
    {
        _toasts.Show("Your seat expired while you were away — finding a new opponent.", ToastType.Warning);
        Seat = null;
        _ = FindOpponentSafeAsync();
    }

    // Online results go to the head-to-head history as Multiplayer; they never touch the
    // adaptive vs-CPU rating, which is a measure of play against the AI only.
    private void RecordResult()
    {
        if (_matchRecorded) return;
        _matchRecorded = true;
        var outcome = Result switch
        {
            GameResult.Win => MatchOutcome.Win,
            GameResult.Loss => MatchOutcome.Loss,
            _ => MatchOutcome.Draw,
        };
        _ = _history.RecordAsync(_gameKey, MatchMode.Multiplayer, OpponentName, outcome);
    }
}
