using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;

namespace PoMiniGames.Features.PoCoupleQuiz;

/// <summary>
/// SignalR hub for PoCoupleQuiz. Handles the four things a player can actually do — join,
/// ready up, pick the round count (host), submit an answer — and delegates every round
/// transition to <see cref="CoupleQuizRoundDirector"/>.
/// </summary>
/// <remarks>
/// <para>Authoritative state lives in <see cref="GameSessionManager"/> (singleton). Clients are
/// pure views driven by <see cref="IGameClient"/> events.</para>
///
/// <para>The hub has no game codes, so joining is one <see cref="Join"/> call; the round clock is
/// driven by the server, not the host.</para>
///
/// <para>There is exactly one lobby per process, so every broadcast targets
/// <c>Clients.All</c> and no SignalR group is needed.</para>
/// </remarks>
[AllowAnonymous]
public class CoupleQuizHub : Hub<IGameClient>
{
    private readonly GameSessionManager _sessions;
    private readonly CoupleQuizRoundDirector _director;
    private readonly ILogger<CoupleQuizHub> _logger;

    public CoupleQuizHub(
        GameSessionManager sessions,
        CoupleQuizRoundDirector director,
        ILogger<CoupleQuizHub> logger)
    {
        _sessions = sessions;
        _director = director;
        _logger = logger;
    }

    // ── Lobby phase ─────────────────────────────────────────────────────

    public async Task Join(string playerName)
    {
        if (string.IsNullOrWhiteSpace(playerName))
        {
            await Clients.Caller.LobbyError("Player name cannot be empty.");
            return;
        }

        var session = _sessions.Join(Context.ConnectionId, playerName.Trim(), out var created);
        if (created)
        {
            _logger.LobbyOpened(session.HostName);
        }

        var readyNames = ReadyNames(session);
        await Clients.Caller.LobbyJoined(new LobbyEventPayload(
            IsHost: session.HostConnectionId == Context.ConnectionId,
            PlayerName: session.Players.First(p => p.ConnectionId == Context.ConnectionId).Name,
            Players: session.Players.Select(p => p.Name).ToList(),
            ReadyPlayers: readyNames,
            HostName: session.HostName ?? string.Empty,
            MaxRounds: session.MaxRounds));

        await Clients.Others.LobbyUpdated(BuildLobbyUpdatedPayload(session, readyNames));
    }

    public async Task SetReady()
    {
        var state = _sessions.MarkPlayerReady(Context.ConnectionId);
        if (state is null) return;

        await Clients.All.LobbyUpdated(new LobbyUpdatedPayload(
            state.Players, state.ReadyPlayers, state.HostName, state.MaxRounds));

        // Everybody ready and enough players → the match starts itself. This was already the
        // behaviour; what's gone is the redundant host-only "Start game" button that raced it.
        if (state.AllReady)
        {
            await _director.StartGameAsync(Context.ConnectionAborted);
        }
    }

    /// <summary>Host-only: 3, 5 or 7 rounds. Ignored from anyone else, or once a match is live.</summary>
    public async Task SetRounds(int rounds)
    {
        var state = _sessions.SetMaxRounds(Context.ConnectionId, rounds);
        if (state is null) return;
        await Clients.All.LobbyUpdated(new LobbyUpdatedPayload(
            state.Players, state.ReadyPlayers, state.HostName, state.MaxRounds));
    }

    // ── Game phase ──────────────────────────────────────────────────────

    public async Task SubmitAnswer(string answer)
    {
        var session = _sessions.GetSessionByConnection(Context.ConnectionId);
        var me = session?.Players.FirstOrDefault(p => p.ConnectionId == Context.ConnectionId);
        if (me is null) return;

        await _director.SubmitAnswerAsync(me.Name, answer, Context.ConnectionAborted);
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        var session = _sessions.RemovePlayer(Context.ConnectionId, out var sessionEmpty);
        if (session is null || sessionEmpty) return;

        await Clients.All.PlayerDisconnected(BuildLobbyUpdatedPayload(session, ReadyNames(session)));

        // The leaver may have been the last person the round was waiting on.
        await _director.OnPlayerLeftAsync();
    }

    // ── Helpers ─────────────────────────────────────────────────────────

    private static List<string> ReadyNames(GameSession s) =>
        s.Players.Where(p => s.ReadyConnectionIds.Contains(p.ConnectionId)).Select(p => p.Name).ToList();

    private static LobbyUpdatedPayload BuildLobbyUpdatedPayload(GameSession s, List<string> readyNames) =>
        new(s.Players.Select(p => p.Name).ToList(),
            readyNames,
            s.HostName ?? string.Empty,
            s.MaxRounds);
}
