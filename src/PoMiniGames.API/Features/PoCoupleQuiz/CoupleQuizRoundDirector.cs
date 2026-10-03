using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Options;

namespace PoMiniGames.Features.PoCoupleQuiz;

/// <summary>
/// Owns the round lifecycle: start a match, score a round when it completes, reveal the result,
/// then move on or finish. Everything that used to require the host to click a button.
/// </summary>
/// <remarks>
/// <para><b>Why this is not in the hub.</b> A <see cref="Hub{T}"/> instance lives for exactly
/// one invocation, so it cannot own a timer. Rounds now end on either "everybody answered" or
/// "the clock ran out", and only one of those arrives as a hub call. This is a singleton
/// holding a long-lived <see cref="IHubContext{THub,TClient}"/> — the same pattern
/// <c>PoRacerRaceService</c> and <c>PoSportsRaceRegistry</c> use.</para>
///
/// <para><b>What it replaces.</b> The host used to press "Next round", gated on a client-side
/// tally of who had answered (<c>_kingSubmitted</c> / <c>_answersThisRound</c> /
/// <c>_totalNonKingPlayers</c> / a seen-names <c>HashSet</c>) that duplicated state the server
/// already had. Non-hosts watched "Waiting for the host to start the next round…", and a host
/// who closed their tab mid-match stranded everyone else with no way to continue.</para>
///
/// <para><b>Serialization.</b> One <see cref="SemaphoreSlim"/> guards every transition. The
/// last answer and the round deadline genuinely can arrive at the same instant, and scoring a
/// round twice would double every player's points; <see cref="GameSession.LastEvaluatedRound"/>
/// is the idempotency check inside the gate.</para>
/// </remarks>
public sealed class CoupleQuizRoundDirector : IDisposable
{
    /// <summary>Similarity at or above which a guess counts as matching the King's answer.</summary>
    private const float MatchThreshold = 0.5f;

    /// <summary>Points for a guesser who matched the King this round.</summary>
    private const int MatchPoints = 10;

    private readonly IHubContext<CoupleQuizHub, IGameClient> _hub;
    private readonly GameSessionManager _sessions;
    private readonly IQuestionService _questions;
    private readonly IOptionsMonitor<CoupleQuizOptions> _options;
    private readonly ILogger<CoupleQuizRoundDirector> _logger;
    private readonly SemaphoreSlim _gate = new(1, 1);

    public CoupleQuizRoundDirector(
        IHubContext<CoupleQuizHub, IGameClient> hub,
        GameSessionManager sessions,
        IQuestionService questions,
        IOptionsMonitor<CoupleQuizOptions> options,
        ILogger<CoupleQuizRoundDirector> logger)
    {
        _hub = hub;
        _sessions = sessions;
        _questions = questions;
        _options = options;
        _logger = logger;
    }

    private int RoundSeconds => Math.Max(10, _options.CurrentValue.RoundSeconds);
    private int RevealSeconds => Math.Max(2, _options.CurrentValue.RevealSeconds);

    // ── Entry points ────────────────────────────────────────────────────────

    /// <summary>Start a match for the current lobby. No-op if one is already running.</summary>
    public async Task StartGameAsync(CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var session = _sessions.Current;
            if (session is null || session.State == SessionState.InProgress) return;
            if (session.Players.Count < Game.MinimumPlayers)
            {
                await _hub.Clients.All.GameError($"Need at least {Game.MinimumPlayers} players to start.");
                return;
            }

            var first = await _questions.GenerateQuestionAsync(category: null, cancellationToken);
            var game = _sessions.StartGame(first.Text, first.Category.ToString());

            await _hub.Clients.All.GameStarted(new GameStartedPayload(
                KingPlayerName: game.KingPlayer?.Name ?? string.Empty,
                Players: Snapshot(game),
                QuestionText: first.Text,
                QuestionCategory: first.Category.ToString(),
                RoundIndex: game.CurrentRound,
                MaxRounds: game.MaxRounds,
                RoundSeconds: RoundSeconds));

            ArmTimer(session, RoundPhase.Answering, TimeSpan.FromSeconds(RoundSeconds), game.CurrentRound);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>
    /// Record one submission and, if that was the last one outstanding, score the round
    /// immediately rather than waiting for the clock.
    /// </summary>
    public async Task SubmitAnswerAsync(string playerName, string answer, CancellationToken cancellationToken = default)
    {
        int roundToComplete;
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var session = _sessions.Current;
            if (session?.ActiveGame is not { } game) return;
            if (session.Phase != RoundPhase.Answering) return;
            if (!_sessions.RecordAnswer(playerName, answer)) return;

            await _hub.Clients.All.AnswerRecorded(new AnswerRecordedPayload(playerName, game.CurrentRound));

            if (!game.AllPlayersAnswered()) return;
            roundToComplete = game.CurrentRound;
        }
        finally
        {
            _gate.Release();
        }

        await CompleteRoundAsync(roundToComplete, cancellationToken);
    }

    /// <summary>
    /// A player left. If the round was only waiting on them, it can complete now — otherwise
    /// the remaining players sit on a question nobody will ever finish.
    /// </summary>
    public async Task OnPlayerLeftAsync(CancellationToken cancellationToken = default)
    {
        int roundToComplete;
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var session = _sessions.Current;
            if (session?.ActiveGame is not { } game) return;
            if (session.Phase != RoundPhase.Answering) return;
            if (game.Players.Count < Game.MinimumPlayers)
            {
                // Not a game any more. Park the lobby rather than leaving a half-match live.
                session.DisarmTimer();
                _sessions.ResetToLobby();
                await BroadcastLobbyAsync();
                return;
            }
            if (!game.AllPlayersAnswered()) return;
            roundToComplete = game.CurrentRound;
        }
        finally
        {
            _gate.Release();
        }

        await CompleteRoundAsync(roundToComplete, cancellationToken);
    }

    public async Task BroadcastLobbyAsync()
    {
        if (_sessions.GetLobbyReadyState() is not { } state) return;
        await _hub.Clients.All.LobbyUpdated(new LobbyUpdatedPayload(
            state.Players, state.ReadyPlayers, state.HostName, state.MaxRounds));
    }

    // ── Round transitions ───────────────────────────────────────────────────

    /// <summary>
    /// Score <paramref name="roundIndex"/> and show the result. Idempotent: whichever of
    /// "last answer in" and "deadline reached" gets here second returns without doing anything.
    /// </summary>
    private async Task CompleteRoundAsync(int roundIndex, CancellationToken cancellationToken)
    {
        GameQuestion question;
        List<Player> guessers;

        await _gate.WaitAsync(cancellationToken);
        try
        {
            var session = _sessions.Current;
            if (session?.ActiveGame is not { } game || game.CurrentQuestion is not { } q) return;
            if (game.CurrentRound != roundIndex) return;
            if (session.LastEvaluatedRound >= roundIndex) return;

            session.LastEvaluatedRound = roundIndex;
            session.DisarmTimer();
            question = q;
            guessers = game.Players.Where(p => !game.IsKing(p.Name)).ToList();
        }
        finally
        {
            _gate.Release();
        }

        // Scoring calls the AI once per guess, so it happens OUTSIDE the gate — a slow model
        // must not block a player's submission on another lobby event.
        var points = new Dictionary<string, int>();
        if (question.KingPlayerAnswer is { } secret)
        {
            foreach (var p in guessers)
            {
                if (!question.PlayerAnswers.TryGetValue(p.Name, out var guess)) continue;
                // The round is already marked evaluated and its timer disarmed, so a throw
                // here would leave it with no result and nothing to retry it. A guess that
                // cannot be scored scores zero and the round still completes.
                double similarity;
                try
                {
                    similarity = await _questions.CheckAnswerSimilarityAsync(secret, guess, cancellationToken);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    _logger.RoundAdvanceFailed(ex);
                    similarity = 0;
                }
                points[p.Name] = similarity >= MatchThreshold ? MatchPoints : 0;
            }
        }

        await _gate.WaitAsync(cancellationToken);
        try
        {
            var session = _sessions.Current;
            if (session?.ActiveGame is not { } game || game.CurrentRound != roundIndex) return;

            _sessions.ApplyRoundScores(points);
            session.Phase = RoundPhase.Revealing;

            await _hub.Clients.All.RoundResult(new RoundResultPayload(
                RoundIndex: roundIndex,
                // The King may have run out of time without typing anything. Say so rather
                // than rendering an empty <strong> the players have to interpret.
                KingAnswer: question.KingPlayerAnswer ?? "(no answer)",
                MatchedPlayers: points.Where(kv => kv.Value > 0).Select(kv => kv.Key).ToList(),
                Scores: game.GetScoreboard(),
                PlayerAnswers: new Dictionary<string, string>(question.PlayerAnswers),
                Players: Snapshot(game)));

            ArmTimer(session, RoundPhase.Revealing, TimeSpan.FromSeconds(RevealSeconds), roundIndex);
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Move past the revealed result: next question, or game over.</summary>
    private async Task AdvanceAsync(int fromRound, CancellationToken cancellationToken)
    {
        Question? next = null;
        await _gate.WaitAsync(cancellationToken);
        try
        {
            var session = _sessions.Current;
            if (session?.ActiveGame is not { } current) return;
            if (session.Phase != RoundPhase.Revealing || current.CurrentRound != fromRound) return;

            var game = _sessions.AdvanceRound();
            if (game.IsGameOver)
            {
                _sessions.FinishGame();
                await _hub.Clients.All.GameOver(new GameOverPayload(
                    FinalScores: game.GetScoreboard(),
                    Players: Snapshot(game)));
                return;
            }
        }
        finally
        {
            _gate.Release();
        }

        // Generating the next question is an AI call — again, outside the gate.
        try
        {
            next = await _questions.GenerateQuestionAsync(category: null, cancellationToken);
        }
        catch (Exception ex)
        {
            _logger.RoundAdvanceFailed(ex);
        }

        await _gate.WaitAsync(cancellationToken);
        try
        {
            var session = _sessions.Current;
            if (session?.ActiveGame is not { } game || session.State != SessionState.InProgress) return;

            if (next is null)
            {
                // No question means no round. End the match on the scores earned so far
                // instead of stranding everyone on a blank prompt.
                _sessions.FinishGame();
                await _hub.Clients.All.GameError("Could not fetch the next question — ending the match here.");
                await _hub.Clients.All.GameOver(new GameOverPayload(
                    FinalScores: game.GetScoreboard(),
                    Players: Snapshot(game)));
                return;
            }

            if (game.CurrentQuestion is { } q)
            {
                q.Text = next.Text;
                q.Category = next.Category;
                q.KingPlayerAnswer = null;
                q.PlayerAnswers.Clear();
            }

            await _hub.Clients.All.RoundStarted(new RoundStartedPayload(
                RoundIndex: game.CurrentRound,
                MaxRounds: game.MaxRounds,
                KingPlayerName: game.KingPlayer?.Name ?? string.Empty,
                Players: Snapshot(game),
                QuestionText: next.Text,
                QuestionCategory: next.Category.ToString(),
                RoundSeconds: RoundSeconds));

            ArmTimer(session, RoundPhase.Answering, TimeSpan.FromSeconds(RoundSeconds), game.CurrentRound);
        }
        finally
        {
            _gate.Release();
        }
    }

    // ── Timer plumbing ──────────────────────────────────────────────────────

    /// <summary>
    /// Arm the session's single-shot timer for the current phase. Callers already hold the gate;
    /// the callback re-enters through <see cref="CompleteRoundAsync"/> / <see cref="AdvanceAsync"/>,
    /// both of which take it themselves.
    /// </summary>
    private void ArmTimer(GameSession session, RoundPhase phase, TimeSpan delay, int roundIndex)
    {
        session.DisarmTimer();
        session.PhaseTimer = new Timer(_ => _ = FireAsync(phase, roundIndex), null, delay, Timeout.InfiniteTimeSpan);
    }

    private async Task FireAsync(RoundPhase phase, int roundIndex)
    {
        try
        {
            if (phase == RoundPhase.Answering)
            {
                await CompleteRoundAsync(roundIndex, CancellationToken.None);
            }
            else
            {
                await AdvanceAsync(roundIndex, CancellationToken.None);
            }
        }
        catch (Exception ex)
        {
            // A throw on a timer thread is an unobserved task that would take the process
            // down on some hosts. Log and leave the lobby recoverable instead.
            _logger.RoundTimerFailed(ex);
        }
    }

    private static List<GamePlayerState> Snapshot(Game game) =>
        game.Players.Select(p => new GamePlayerState(p.Name, game.IsKing(p.Name), p.Score)).ToList();

    public void Dispose() => _gate.Dispose();
}
