using System.Collections.Concurrent;

namespace PoMiniGames.Features.PoFunQuiz;

/// <summary>
/// In-memory registry of open PoFunQuiz multiplayer games. Sessions do NOT
/// survive restarts; for the consolidation MVP a single-process model is
/// sufficient. The reaper background service is intentionally not included —
/// idle rooms are cleaned up when the host disconnects.
/// </summary>
/// <remarks>
/// <para><b>One lobby, no game codes.</b> Creating and joining are a single
/// <see cref="JoinOrCreateAsync"/>: a player presses one
/// button and lands in the single open lobby, opening it themselves only if nobody is
/// waiting. <see cref="MultiplayerGame.GameId"/> survives as the internal SignalR group
/// key and log correlation id — it is never shown to a player and never typed in.</para>
///
/// <para>A match still gets its own game object once it starts, so a second pair can be
/// matched while the first pair plays. "Single lobby" is about the <em>entry point</em>:
/// at most one game is ever in <see cref="GameState.Waiting"/> with a free seat.</para>
/// </remarks>
public class MultiplayerLobbyService(IOpenAIService ai, ILogger<MultiplayerLobbyService> logger)
{
    private readonly ConcurrentDictionary<string, MultiplayerGame> _games = new();
    private readonly ConcurrentDictionary<string, string> _connectionToGame = new();
    private readonly IOpenAIService _ai = ai;
    private readonly ILogger<MultiplayerLobbyService> _logger = logger;

    // Guards lobby *membership* (open-seat search, player add, player removal). The
    // concurrent dictionaries make the game lookup safe, but MultiplayerGame.Players is a
    // plain List whose "is there a free seat?" check and its Add must be atomic together —
    // without that, two players pressing the single button at the same moment both see the
    // free seat and one silently overflows a 2-player game to 3.
    private readonly Lock _gate = new();

    /// <summary>
    /// Seat this connection in the one open lobby, opening a fresh one if nobody is
    /// waiting. Returns the game plus whether this player opened it (i.e. is the host).
    /// </summary>
    public async Task<(MultiplayerGame Game, bool Created)> JoinOrCreateAsync(
        string connectionId, string playerName, QuestionCategory category, int questionCount, CancellationToken ct)
    {
        // A connection that joins again leaves its previous game first, or that game is
        // orphaned in the registry with nobody left to empty it.
        RemovePlayer(connectionId, out _);

        lock (_gate)
        {
            var open = TryTakeOpenSeat(connectionId, playerName);
            if (open is not null) return (open, false);
        }

        // Nobody waiting → this player opens the lobby, and its questions are generated
        // for the category *they* picked. Deliberately outside the gate: the AI call takes
        // seconds, and holding a lock across it would stall every other player's join.
        var questions = (await _ai.GenerateQuizQuestionsAsync(category, questionCount, ct)).ToList();

        lock (_gate)
        {
            // Someone may have opened a lobby while we were waiting on the AI. Prefer
            // theirs — otherwise two players who pressed the button together end up
            // alone in two separate lobbies, which is the exact failure the single
            // lobby exists to prevent. Our freshly generated questions are discarded.
            var open = TryTakeOpenSeat(connectionId, playerName);
            if (open is not null) return (open, false);

            var game = new MultiplayerGame
            {
                GameId = Guid.NewGuid().ToString("N").Substring(0, 6).ToUpperInvariant(),
                Category = category,
                HostConnectionId = connectionId,
                State = GameState.Waiting,
                Players = new List<MultiplayerPlayer>
                {
                    new() { ConnectionId = connectionId, Name = playerName, PlayerNumber = 1 }
                },
                Questions = questions
            };
            _games[game.GameId] = game;
            _connectionToGame[connectionId] = game.GameId;
            return (game, true);
        }
    }

    /// <summary>
    /// Adds the player to the waiting game with a free seat, or returns null if there
    /// isn't one. Caller must hold <see cref="_gate"/>.
    /// </summary>
    private MultiplayerGame? TryTakeOpenSeat(string connectionId, string playerName)
    {
        var game = _games.Values.FirstOrDefault(g => g.State == GameState.Waiting && g.Players.Count < 2);
        if (game is null) return null;
        // If this connection re-joins, drop the old slot first.
        game.Players.RemoveAll(p => p.ConnectionId == connectionId);
        // Two anonymous players share one "Guest######" identity when they sign in
        // from the same browser, so disambiguate a duplicate name with a suffix.
        var taken = new HashSet<string>(game.Players.Select(p => p.Name), StringComparer.OrdinalIgnoreCase);
        var uniqueName = playerName;
        for (var i = 2; taken.Contains(uniqueName); i++) uniqueName = $"{playerName} ({i})";
        game.Players.Add(new MultiplayerPlayer
        {
            ConnectionId = connectionId,
            Name = uniqueName,
            PlayerNumber = game.Players.Count + 1
        });
        _connectionToGame[connectionId] = game.GameId;
        return game;
    }

    public MultiplayerGame? GetByConnection(string connectionId) =>
        _connectionToGame.TryGetValue(connectionId, out var id) && _games.TryGetValue(id, out var g) ? g : null;

    public void RemovePlayer(string connectionId, out bool sessionEmpty)
    {
        lock (_gate)
        {
            sessionEmpty = false;
            if (!_connectionToGame.TryRemove(connectionId, out var gameId)) return;
            if (!_games.TryGetValue(gameId, out var game)) return;
            game.Players.RemoveAll(p => p.ConnectionId == connectionId);
            if (game.Players.Count == 0)
            {
                _games.TryRemove(gameId, out _);
                sessionEmpty = true;
                return;
            }
            // Host left → promote the remaining player to host.
            if (game.HostConnectionId == connectionId)
            {
                game.HostConnectionId = game.Players[0].ConnectionId;
            }
        }
    }

    public bool StartGame(string gameId, string requesterConnectionId)
    {
        if (!_games.TryGetValue(gameId, out var game)) return false;
        if (game.HostConnectionId != requesterConnectionId) return false;
        if (game.Players.Count < 2) return false;
        game.State = GameState.InProgress;
        game.StartTime = DateTime.UtcNow;
        return true;
    }

    public bool UpdateScore(string gameId, string connectionId, bool isCorrect, double speedMultiplier, int secondsRemaining)
    {
        if (!_games.TryGetValue(gameId, out var game)) return false;
        var player = game.Players.FirstOrDefault(p => p.ConnectionId == connectionId);
        if (player is null) return false;
        if (game.Questions.Count == 0) return false;
        // One scoring call per question, and both bonuses bounded: these arrive from the client.
        if (player.HasFinished) return false;
        speedMultiplier = double.IsFinite(speedMultiplier) ? Math.Clamp(speedMultiplier, 1.0, 2.0) : 1.0;
        secondsRemaining = Math.Clamp(secondsRemaining, 0, 30);
        var basePoints = game.Questions[Math.Min(game.CurrentQuestionIndex, game.Questions.Count - 1)].BasePoints;
        if (isCorrect)
        {
            player.ScoreState.ApplyCorrectAnswer(basePoints, speedMultiplier);
            player.ScoreState.SetTimeBonus(player.ScoreState.TimeBonus + (int)Math.Round((double)secondsRemaining * 10));
        }
        else
        {
            player.ScoreState.ResetStreak();
        }
        player.Score = player.ScoreState.TotalScore;
        return true;
    }

    public bool AdvanceQuestion(string gameId, string requesterConnectionId)
    {
        if (!_games.TryGetValue(gameId, out var game)) return false;
        if (game.HostConnectionId != requesterConnectionId) return false;
        game.CurrentQuestionIndex++;
        // Reset per-question flags so a player
        // who already answered can submit their next answer for the new
        // question. Without this, PlayerFinished() in the hub returns early
        // after the first question because HasFinished was set permanently.
        foreach (var p in game.Players) p.HasFinished = false;
        return true;
    }

    /// <summary>
    /// Server-driven advance — used by the hub when both players have
    /// finished a question and the game state machine wants to move on.
    /// Bypasses the host-only guard on <see cref="AdvanceQuestion"/> so the
    /// transition fires regardless of which player submitted last.
    /// </summary>
    public bool ForceAdvanceQuestion(string gameId)
    {
        if (!_games.TryGetValue(gameId, out var game)) return false;
        if (game.CurrentQuestionIndex >= game.Questions.Count - 1) return false;
        game.CurrentQuestionIndex++;
        foreach (var p in game.Players) p.HasFinished = false;
        return true;
    }

    public bool FinishGame(string gameId)
    {
        if (!_games.TryGetValue(gameId, out var game)) return false;
        game.State = GameState.Finished;
        game.EndTime = DateTime.UtcNow;
        return true;
    }
}

public class MultiplayerPlayer
{
    public string ConnectionId { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public int PlayerNumber { get; set; }
    public int Score { get; set; }
    public PlayerScoreState ScoreState { get; } = new();
    public int CurrentStreak => ScoreState.CurrentStreak;
    public int MaxStreak => ScoreState.MaxStreak;
    public bool HasFinished { get; set; }
}

public class MultiplayerGame
{
    public string GameId { get; set; } = string.Empty;
    public string HostConnectionId { get; set; } = string.Empty;
    public QuestionCategory Category { get; set; } = QuestionCategory.General;
    public List<QuizQuestion> Questions { get; set; } = new();
    public List<MultiplayerPlayer> Players { get; set; } = new();
    public GameState State { get; set; } = GameState.Waiting;
    public int CurrentQuestionIndex { get; set; }
    public DateTime? StartTime { get; set; }
    public DateTime? EndTime { get; set; }
    public bool IsComplete => State == GameState.Finished || CurrentQuestionIndex >= Questions.Count;
    public MultiplayerPlayer? Winner =>
        Players.Count == 0 || IsTie ? null :
        Players.OrderByDescending(p => p.Score).First();
    public bool IsTie => Players.Count == 2 && Players[0].Score == Players[1].Score;
}
