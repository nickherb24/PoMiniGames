namespace PoMiniGames.Features.PoCoupleQuiz;

/// <summary>
/// In-memory implementation of <see cref="GameSessionManager"/>. Holds exactly one
/// <see cref="GameSession"/> plus a connection-to-player map so the SignalR hub can
/// identify a caller by connection id.
/// </summary>
/// <remarks>
/// <para>Pattern: Singleton + Active-Record. The session is mutated in place; this class is
/// the only writer. Where the old implementation leaned on <c>ConcurrentDictionary</c>'s
/// atomicity for a table of lobbies, one session needs a plain lock — the interesting
/// operations (join, record answer, advance) are multi-field and were never atomic under
/// the dictionary either.</para>
/// <para>Locking is deliberately coarse: every operation here is a handful of list/set
/// mutations with no I/O. The AI calls that DO take time happen in
/// <see cref="CoupleQuizRoundDirector"/>, outside this lock.</para>
/// </remarks>
public sealed class GameSessionManager
{
    private readonly Lock _gate = new();
    private GameSession? _session;

    /// <summary>The current lobby, or null when nobody is in one.</summary>
    public GameSession? Current
    {
        get { lock (_gate) { return _session; } }
    }

    /// <summary>Join the lobby, creating it if this is the first player. Never fails.</summary>
    public GameSession Join(string connectionId, string playerName, out bool created)
    {
        lock (_gate)
        {
            if (_session is null)
            {
                created = true;
                _session = new GameSession
                {
                    HostConnectionId = connectionId,
                    State = SessionState.Waiting,
                    Players = [new LobbyPlayer(playerName, connectionId)],
                };
                return _session;
            }

            created = false;

            // Already in? Re-joining from the same connection is a no-op rather than a
            // second seat at the table.
            if (_session.Players.Any(p => p.ConnectionId == connectionId)) return _session;

            // Two anonymous players share one "Guest######" identity when they sign in from
            // the same browser (shared session cookie), so the same name can join twice. The
            // name is the identity key for round scoring, so a collision would collapse both
            // players into one. Disambiguate with a numeric suffix.
            _session.Players.Add(new LobbyPlayer(EnsureUniqueName(_session, playerName), connectionId));
            return _session;
        }
    }

    /// <summary>Drop a player. Returns the session (null if the caller wasn't in one).</summary>
    public GameSession? RemovePlayer(string connectionId, out bool sessionEmpty)
    {
        sessionEmpty = false;
        lock (_gate)
        {
            if (_session is null) return null;
            if (_session.Players.All(p => p.ConnectionId != connectionId)) return null;

            var session = _session;
            session.Players.RemoveAll(p => p.ConnectionId == connectionId);
            session.ReadyConnectionIds.Remove(connectionId);

            if (session.Players.Count == 0)
            {
                session.DisarmTimer();
                _session = null;
                sessionEmpty = true;
                return session;
            }

            // If the host left, promote the next player.
            if (session.HostConnectionId == connectionId)
            {
                session.HostConnectionId = session.Players[0].ConnectionId;
            }

            // A player leaving mid-match also leaves the Game's roster, or the round can
            // never complete: AllPlayersAnswered waits on a name nobody will submit, and
            // the rotating King seat could land on an empty chair.
            session.ActiveGame?.Players.RemoveAll(
                p => session.Players.All(lp => lp.Name != p.Name));

            return session;
        }
    }

    public GameSession? GetSessionByConnection(string connectionId)
    {
        lock (_gate)
        {
            return _session is not null && _session.Players.Any(p => p.ConnectionId == connectionId)
                ? _session
                : null;
        }
    }

    /// <summary>Begin a match with the given first question. Throws if there is no lobby.</summary>
    public Game StartGame(string questionText, string category)
    {
        lock (_gate)
        {
            var session = _session ?? throw new InvalidOperationException("No PoCoupleQuiz lobby to start.");

            var game = new Game { MaxRounds = session.MaxRounds };
            foreach (var p in session.Players)
            {
                game.AddPlayer(new Player { Name = p.Name });
            }

            game.CurrentQuestion = new GameQuestion
            {
                Text = questionText,
                Category = Enum.TryParse<QuestionCategory>(category, out var cat) ? cat : QuestionCategory.Preferences
            };
            game.CurrentRound = 0;

            session.ActiveGame = game;
            session.State = SessionState.InProgress;
            session.Phase = RoundPhase.Answering;
            session.LastEvaluatedRound = -1;
            session.ReadyConnectionIds.Clear();

            return game;
        }
    }

    public bool RecordAnswer(string playerName, string answer)
    {
        lock (_gate)
        {
            if (_session?.ActiveGame is not { } game || game.CurrentQuestion is not { } question) return false;

            // The King's submission is the round's secret answer; everyone else's is a guess.
            if (game.IsKing(playerName))
            {
                question.KingPlayerAnswer = answer;
            }
            else
            {
                question.PlayerAnswers[playerName] = answer;
            }
            return true;
        }
    }

    public Game AdvanceRound()
    {
        lock (_gate)
        {
            if (_session?.ActiveGame is not { } game)
            {
                throw new InvalidOperationException("Cannot advance round: there is no active PoCoupleQuiz game.");
            }

            game.CurrentRound++;
            _session.Phase = RoundPhase.Answering;
            _session.ReadyConnectionIds.Clear();
            return game;
        }
    }

    public void ApplyRoundScores(Dictionary<string, int> pointsEarned)
    {
        lock (_gate)
        {
            if (_session?.ActiveGame is not { } game) return;
            foreach (var player in game.Players)
            {
                if (pointsEarned.TryGetValue(player.Name, out var pts))
                {
                    player.Score += pts;
                    player.TotalCorrectGuesses += pts > 0 ? 1 : 0;
                }
                player.TotalRoundsPlayed++;
            }
        }
    }

    public void FinishGame()
    {
        lock (_gate)
        {
            if (_session is null) return;
            _session.State = SessionState.Finished;
            _session.DisarmTimer();
        }
    }

    public LobbyReadyState? MarkPlayerReady(string connectionId)
    {
        lock (_gate)
        {
            if (_session is null) return null;
            _session.ReadyConnectionIds.Add(connectionId);
            return BuildReadyState(_session);
        }
    }

    public LobbyReadyState? GetLobbyReadyState()
    {
        lock (_gate)
        {
            return _session is null ? null : BuildReadyState(_session);
        }
    }

    /// <summary>Host-only. Sets how many rounds the next match runs for (3, 5 or 7).</summary>
    public LobbyReadyState? SetMaxRounds(string connectionId, int rounds)
    {
        lock (_gate)
        {
            if (_session is null) return null;
            // Host-only, and only while waiting. Previously the round count belonged to
            // whoever happened to create the lobby, so a joiner picked a value, saw it
            // silently discarded, and got no hint why.
            if (_session.HostConnectionId != connectionId) return null;
            if (_session.State != SessionState.Waiting) return null;
            if (!Game.AllowedRounds.Contains(rounds)) return null;

            _session.MaxRounds = rounds;
            return BuildReadyState(_session);
        }
    }

    /// <summary>Return a finished lobby to the waiting state so the same players can go again.</summary>
    public LobbyReadyState? ResetToLobby()
    {
        lock (_gate)
        {
            if (_session is null) return null;
            _session.DisarmTimer();
            _session.State = SessionState.Waiting;
            _session.ActiveGame = null;
            _session.Phase = RoundPhase.Answering;
            _session.LastEvaluatedRound = -1;
            _session.ReadyConnectionIds.Clear();
            return BuildReadyState(_session);
        }
    }

    private static LobbyReadyState BuildReadyState(GameSession s) => new(
        s.Players.Select(p => p.Name).ToList(),
        s.Players.Where(p => s.ReadyConnectionIds.Contains(p.ConnectionId)).Select(p => p.Name).ToList(),
        s.HostName ?? string.Empty,
        s.MaxRounds,
        s.Players.Count >= Game.MinimumPlayers && s.ReadyConnectionIds.Count >= s.Players.Count,
        Game.MinimumPlayers);

    // Ensure a joining player's name is unique within the lobby (case-insensitive).
    // Shared "Guest######" identities collide otherwise; append " (2)", " (3)", …
    private static string EnsureUniqueName(GameSession session, string requested)
    {
        var taken = new HashSet<string>(session.Players.Select(p => p.Name), StringComparer.OrdinalIgnoreCase);
        if (!taken.Contains(requested)) return requested;
        for (var i = 2; ; i++)
        {
            var candidate = $"{requested} ({i})";
            if (!taken.Contains(candidate)) return candidate;
        }
    }
}
