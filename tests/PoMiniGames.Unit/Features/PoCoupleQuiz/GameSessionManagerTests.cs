using FluentAssertions;
using PoMiniGames.Features.PoCoupleQuiz;

namespace PoMiniGames.Unit.Features.PoCoupleQuiz;

/// <summary>
/// Unit tests for the in-memory game session manager — the authoritative
/// state holder for the single PoCoupleQuiz lobby (state does NOT survive restarts).
/// </summary>
/// <remarks>
/// <para>Held at 11 methods (8 <c>[Fact]</c>s + 3 <c>[Theory]</c>s) to stay inside the
/// test-count cap. Host-only enforcement is asserted against <c>SetMaxRounds</c>, the one
/// host-gated setting.</para>
/// <para>The scoreboard test asserts the King is INCLUDED. See
/// <see cref="Game.CurrentKingPlayerIndex"/> for why excluding the King is wrong.</para>
/// </remarks>
public sealed class GameSessionManagerTests
{
    /// <summary>A lobby with the given names, in join order. The first is the host.</summary>
    private static GameSessionManager LobbyOf(params string[] names)
    {
        var mgr = new GameSessionManager();
        for (var i = 0; i < names.Length; i++)
        {
            mgr.Join($"conn{i + 1}", names[i], out _);
        }
        return mgr;
    }

    // ─── Lobby membership ───────────────────────────────────────────────

    [Fact]
    public void Join_OpensOneLobby_ReusesIt_AndDisambiguatesNames()
    {
        var mgr = new GameSessionManager();

        var first = mgr.Join("conn1", "Alice", out var created);
        created.Should().BeTrue();
        first.HostConnectionId.Should().Be("conn1");
        first.State.Should().Be(SessionState.Waiting);
        first.MaxRounds.Should().Be(Game.DefaultRounds);

        var second = mgr.Join("conn2", "Bob", out var createdAgain);
        createdAgain.Should().BeFalse();
        second.Should().BeSameAs(first, "there is exactly one lobby per process");

        // Two guests from one browser share a "Guest######" identity, and the name is the
        // scoring key — a collision would collapse both players into one row.
        var third = mgr.Join("conn3", "bob", out _);
        third.Players.Select(p => p.Name).Should().Equal("Alice", "Bob", "bob (2)");
    }

    [Theory]
    [InlineData("conn2", "conn1")] // non-host leaves → host unchanged
    [InlineData("conn1", "conn2")] // host leaves → conn2 promoted
    public void RemovePlayer_PromotesANewHostWhenTheHostLeaves(string leaverConn, string expectedHostConn)
    {
        var mgr = LobbyOf("Alice", "Bob");

        mgr.RemovePlayer(leaverConn, out var sessionEmpty);

        sessionEmpty.Should().BeFalse();
        mgr.Current.Should().NotBeNull();
        mgr.Current!.HostConnectionId.Should().Be(expectedHostConn);
    }

    [Fact]
    public void RemovePlayer_PrunesTheLiveRoster_AndClosesTheLobbyWhenTheLastPlayerLeaves()
    {
        var mgr = LobbyOf("Alice", "Bob", "Carla");
        var game = mgr.StartGame("Q?", "Hobbies");

        // A leaver must also leave the Game's roster, or AllPlayersAnswered waits forever on
        // a name nobody will submit and the rotating King seat can land on an empty chair.
        mgr.RemovePlayer("conn2", out var empty);
        empty.Should().BeFalse();
        game.Players.Select(p => p.Name).Should().Equal("Alice", "Carla");

        mgr.RemovePlayer("conn1", out _);
        mgr.RemovePlayer("conn3", out var nowEmpty);
        nowEmpty.Should().BeTrue();
        mgr.Current.Should().BeNull();
    }

    // ─── Game lifecycle ─────────────────────────────────────────────────

    [Fact]
    public void GameLifecycle_StartAndAdvanceRound_IncrementsRoundAndRotatesKing()
    {
        var empty = new GameSessionManager();
        var act = () => empty.StartGame("Q?", "Hobbies");
        act.Should().Throw<InvalidOperationException>();

        var mgr = LobbyOf("Alice", "Bob");
        mgr.SetMaxRounds("conn1", 7);

        var game = mgr.StartGame("What is Alice's favorite color?", "Preferences");

        game.MaxRounds.Should().Be(7);
        game.Players.Should().HaveCount(2);
        game.KingPlayer!.Name.Should().Be("Alice", "round 0 puts the first player in the King seat");
        mgr.Current!.State.Should().Be(SessionState.InProgress);

        var next = mgr.AdvanceRound();

        next.CurrentRound.Should().Be(1);
        next.KingPlayer!.Name.Should().Be("Bob", "the King seat moves round the table every round");
    }

    [Fact]
    public void RoundCompletion_RoutesTheKingToTheSecret_WaitsForGuesses_AndAppliesScores()
    {
        var mgr = LobbyOf("Alice", "Bob", "Carla"); // Alice is King for round 0
        var game = mgr.StartGame("Q?", "Hobbies");
        var q = game.CurrentQuestion!;

        game.AllPlayersAnswered().Should().BeFalse();

        mgr.RecordAnswer("Bob", "pizza").Should().BeTrue();
        mgr.RecordAnswer("Carla", "sushi").Should().BeTrue();
        game.AllPlayersAnswered().Should().BeFalse("the King has not locked a secret yet");

        mgr.RecordAnswer("Alice", "pizza").Should().BeTrue();
        game.AllPlayersAnswered().Should().BeTrue();

        // The live question is reused in place across rounds. It used to be element 0 of a
        // list that never grew while AllPlayersAnswered indexed that list by round number,
        // so completion silently reported false from round 1 onward.
        mgr.AdvanceRound();
        game.CurrentQuestion.Should().BeSameAs(q);

        q.KingPlayerAnswer.Should().Be("pizza");
        q.PlayerAnswers.Should().ContainKey("Bob").WhoseValue.Should().Be("pizza");
        q.PlayerAnswers.Should().NotContainKey("Alice", "the King's submission is the secret, not a guess");

        // Verify score application updates player stats
        mgr.ApplyRoundScores(new Dictionary<string, int> { ["Bob"] = 10 });
        var bob = game.Players.First(p => p.Name == "Bob");
        bob.Score.Should().Be(10);
        bob.TotalCorrectGuesses.Should().Be(1);
        bob.TotalRoundsPlayed.Should().Be(1);
    }

    // ─── Lobby orchestration ────────────────────────────────────────────

    [Fact]
    public void ReadyState_NeedsEnoughPlayers_AndResetToLobbyKeepsThem()
    {
        var mgr = LobbyOf("Alice");

        // One ready player out of one is NOT a startable match. The old BuildReadyState
        // reported AllReady here and left the minimum-player check to every caller.
        mgr.MarkPlayerReady("conn1")!.AllReady.Should().BeFalse();

        mgr.Join("conn2", "Bob", out _);
        mgr.MarkPlayerReady("conn2");
        var ready = mgr.GetLobbyReadyState()!;
        ready.AllReady.Should().BeTrue();
        ready.ReadyPlayers.Should().BeEquivalentTo(new[] { "Alice", "Bob" });

        mgr.StartGame("Q?", "Hobbies");
        mgr.FinishGame();
        var reset = mgr.ResetToLobby()!;

        reset.Players.Should().Equal("Alice", "Bob");
        reset.ReadyPlayers.Should().BeEmpty();
        mgr.Current!.State.Should().Be(SessionState.Waiting);
        mgr.Current.ActiveGame.Should().BeNull();
    }

    [Theory]
    [InlineData("conn1", 7, true)]  // host, legal value
    [InlineData("conn2", 7, false)] // non-host
    [InlineData("conn1", 4, false)] // host, value not on the menu
    public void SetMaxRounds_IsHostOnlyAndValidated(string actingConn, int rounds, bool expectApplied)
    {
        var mgr = LobbyOf("Alice", "Bob");

        var updated = mgr.SetMaxRounds(actingConn, rounds);

        if (expectApplied)
        {
            updated.Should().NotBeNull();
            updated!.MaxRounds.Should().Be(rounds);
        }
        else
        {
            updated.Should().BeNull();
            mgr.Current!.MaxRounds.Should().Be(Game.DefaultRounds);
        }
    }

    // ─── Game scoring ───────────────────────────────────────────────────

    [Fact]
    public void Game_ScoreboardIncludesEveryPlayer()
    {
        // Previously the scoreboard EXCLUDED the King. Combined with a King seat pinned to
        // index 0 for the whole match, that meant one player in a two-player couple game
        // was a permanent non-competitor: no score, no match-history row, no profile result.
        var game = new Game();
        game.AddPlayer(new Player { Name = "Alice", Score = 20 });
        game.AddPlayer(new Player { Name = "Bob", Score = 8 });
        game.AddPlayer(new Player { Name = "Carla", Score = 12 });

        game.IsKing("Alice").Should().BeTrue("round 0's King is player 0");

        var board = game.GetScoreboard();
        board.Keys.Should().Equal("Alice", "Carla", "Bob");
        board.Values.Should().Equal(20, 12, 8);
    }

    [Theory]
    [InlineData(0, "Alice")]
    [InlineData(1, "Bob")]
    [InlineData(2, "Carla")]
    [InlineData(3, "Alice")] // wraps
    public void Game_KingRotatesEveryRound(int round, string expectedKing)
    {
        var game = new Game { CurrentRound = round };
        game.AddPlayer(new Player { Name = "Alice" });
        game.AddPlayer(new Player { Name = "Bob" });
        game.AddPlayer(new Player { Name = "Carla" });

        game.KingPlayer!.Name.Should().Be(expectedKing);
    }
}
