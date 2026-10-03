using Microsoft.AspNetCore.SignalR;

namespace PoMiniGames.Features.PoFunQuiz;

/// <summary>
/// SignalR hub for PoFunQuiz multiplayer. Two-player trivia battle. Authoritative
/// state lives in <see cref="MultiplayerLobbyService"/> (singleton). Clients are
/// pure views driven by <see cref="IFunQuizClient"/> events.
/// </summary>
/// <remarks>
/// <b>No game codes.</b> Joining is one <see cref="JoinLobby"/> call, and no method takes a
/// <c>gameId</c> argument: the caller's game is resolved from their connection, so a client
/// cannot name a game it isn't in.
/// </remarks>
public class FunQuizHub : Hub<IFunQuizClient>
{
    private readonly MultiplayerLobbyService _lobby;
    private readonly ILogger<FunQuizHub> _logger;

    public FunQuizHub(MultiplayerLobbyService lobby, ILogger<FunQuizHub> logger)
    {
        _lobby = lobby;
        _logger = logger;
    }

    /// <summary>
    /// The only way into multiplayer: seats the caller in the single open lobby, or opens
    /// it for them if nobody is waiting. <paramref name="category"/> and
    /// <paramref name="questionCount"/> apply only when this call opens the lobby — a
    /// joiner plays the quiz the waiting player already has.
    /// </summary>
    public async Task JoinLobby(string playerName, string category, int questionCount = 10)
    {
        if (string.IsNullOrWhiteSpace(playerName))
        {
            await Clients.Caller.LobbyError(new FunQuizLobbyError(string.Empty, "Player name is required."));
            return;
        }
        var cat = Enum.TryParse<QuestionCategory>(category, true, out var c) ? c : QuestionCategory.General;
        questionCount = Math.Clamp(questionCount, 1, 50);

        // Opening a lobby generates its questions, which is a live model call — the one part of
        // this method that can fail for reasons that have nothing to do with the caller (the
        // account is rate limited, the identity's daily token budget is spent, the deployment
        // rejects the request). Letting that escape hands the client SignalR's own generic
        // "An unexpected error occurred invoking 'JoinLobby' on the server", which tells a
        // player nothing and tells us nothing either — the server-side detail only ever reached
        // the log. LobbyError is the channel the page already renders, so use it.
        MultiplayerGame game;
        bool created;
        try
        {
            (game, created) = await _lobby.JoinOrCreateAsync(
                Context.ConnectionId, playerName.Trim(), cat, questionCount, Context.ConnectionAborted);
        }
        catch (OperationCanceledException) when (Context.ConnectionAborted.IsCancellationRequested)
        {
            return; // Player navigated away mid-generation; nothing to report to a gone connection.
        }
        catch (Exception ex)
        {
            _logger.JoinLobbyFailed(ex, playerName, cat);
            await Clients.Caller.LobbyError(new FunQuizLobbyError(
                string.Empty,
                "Couldn't start a quiz right now - the question generator is unavailable. Try again in a minute."));
            return;
        }

        await Groups.AddToGroupAsync(Context.ConnectionId, game.GameId);

        if (created)
        {
            _logger.GameCreated(game.GameId, playerName);
            await Clients.Caller.GameCreated(BuildState(game));
            return;
        }

        _logger.PlayerJoined(game.GameId, playerName);
        await Clients.Caller.GameJoined(BuildState(game));
        // Push the FULL updated state to the host (and any other members), not just a
        // lightweight PlayerJoined notice — the client renders off GameState, and the
        // page never subscribed to PlayerJoined, so the host would otherwise never see
        // the 2nd player arrive (and never get the "Start game" button). Mirrors the
        // GameUpdated broadcast used on disconnect / question advance.
        await Clients.OthersInGroup(game.GameId).GameUpdated(BuildState(game));
    }

    public async Task StartGame()
    {
        var game = _lobby.GetByConnection(Context.ConnectionId);
        if (game is null) return;
        if (!_lobby.StartGame(game.GameId, Context.ConnectionId)) return;
        await Clients.Group(game.GameId).GameStarted(BuildState(game));
    }

    public async Task UpdateScore(bool isCorrect, double speedMultiplier, int secondsRemaining)
    {
        var game = _lobby.GetByConnection(Context.ConnectionId);
        if (game is null) return;
        if (!_lobby.UpdateScore(game.GameId, Context.ConnectionId, isCorrect, speedMultiplier, secondsRemaining)) return;
        var player = game.Players.FirstOrDefault(p => p.ConnectionId == Context.ConnectionId);
        if (player is null) return;
        await Clients.Group(game.GameId).ScoreUpdated(new FunQuizScoreUpdate(
            game.GameId, player.Name, player.Score, player.CurrentStreak, player.MaxStreak));
    }

    public async Task PlayerFinished()
    {
        var game = _lobby.GetByConnection(Context.ConnectionId);
        if (game is null) return;
        // Mark this player as finished for the *current* question. When both
        // have finished the question, advance. Once we've burned through every
        // question, declare the winner.
        var me = game.Players.FirstOrDefault(p => p.ConnectionId == Context.ConnectionId);
        if (me is null) return;
        if (me.HasFinished) return; // already submitted for this question
        me.HasFinished = true;
        await Clients.Group(game.GameId).PlayerFinishedQuestion(new FunQuizPlayerFinishedQuestion(
            game.GameId, me.Name, game.Players.Count(p => p.HasFinished), game.Players.Count));

        await AdvanceIfAllFinishedAsync(game);
    }

    /// <summary>
    /// Moves the game on once everyone still in it has answered. "Everyone still in it",
    /// not "both players": when the opponent leaves, the survivor plays the quiz out
    /// instead of waiting forever on an answer that will never come.
    /// </summary>
    private async Task<bool> AdvanceIfAllFinishedAsync(MultiplayerGame game)
    {
        if (game.State != GameState.InProgress || game.Players.Count == 0
            || !game.Players.All(p => p.HasFinished))
        {
            return false;
        }

        if (game.CurrentQuestionIndex >= game.Questions.Count - 1)
        {
            // All questions consumed → declare the final winner.
            _lobby.FinishGame(game.GameId);
            var scores = game.Players.ToDictionary(p => p.Name, p => p.Score);
            var winner = game.Winner;
            var payload = new FunQuizGameFinished(
                game.GameId, scores,
                winner is null ? null : new FunQuizPlayerState(winner.Name, winner.Score, winner.MaxStreak),
                game.IsTie);
            await Clients.Group(game.GameId).GameFinished(payload);
        }
        else
        {
            // Server-driven advance, bypassing the host-only guard on AdvanceQuestion so
            // whichever player answered last can drive the transition. HasFinished is reset
            // inside ForceAdvanceQuestion.
            _lobby.ForceAdvanceQuestion(game.GameId);
            await Clients.Group(game.GameId).GameUpdated(BuildState(game));
        }

        return true;
    }

    public async Task AdvanceQuestion()
    {
        var game = _lobby.GetByConnection(Context.ConnectionId);
        if (game is null) return;
        if (!_lobby.AdvanceQuestion(game.GameId, Context.ConnectionId)) return;
        await Clients.Group(game.GameId).GameUpdated(BuildState(game));
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        var game = _lobby.GetByConnection(Context.ConnectionId);
        _lobby.RemovePlayer(Context.ConnectionId, out var empty);
        if (game is null || empty) return;
        // The survivor may already be waiting on the player who just left.
        if (await AdvanceIfAllFinishedAsync(game)) return;
        await Clients.Group(game.GameId).GameUpdated(BuildState(game));
    }

    private static FunQuizGameState BuildState(MultiplayerGame g) => new(
        g.GameId,
        g.Players.FirstOrDefault(p => p.ConnectionId == g.HostConnectionId)?.Name ?? string.Empty,
        g.State,
        g.Players.Select(p => new FunQuizPlayerState(p.Name, p.Score, p.CurrentStreak)).ToList(),
        g.Questions,
        g.CurrentQuestionIndex,
        g.Category.ToString(),
        SecondsPerQuestion: 30);
}
