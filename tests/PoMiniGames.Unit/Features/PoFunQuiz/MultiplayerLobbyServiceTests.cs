using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using PoMiniGames.Features.PoFunQuiz;

namespace PoMiniGames.Unit.Features.PoFunQuiz;

/// <summary>
/// Unit tests for the PoFunQuiz in-memory multiplayer lobby. Uses the
/// <see cref="MockOpenAIService"/>-style static question generator indirectly through
/// <see cref="MultiplayerLobbyService"/> with a stub <see cref="IOpenAIService"/>.
/// </summary>
/// <remarks>
/// <para>Player lifecycle (Join/Remove) is one theory; scoring updates are another.</para>
///
/// <para>There are no game codes, so create and join are one
/// <see cref="MultiplayerLobbyService.JoinOrCreateAsync"/>: you cannot name a game, and the
/// second caller lands in the *same* lobby as the first rather than opening their own.</para>
/// </remarks>
public sealed class MultiplayerLobbyServiceTests
{
    private sealed class StubAi : IOpenAIService
    {
        public Task<IReadOnlyList<QuizQuestion>> GenerateQuizQuestionsAsync(QuestionCategory category, int count, CancellationToken cancellationToken = default) =>
            Task.FromResult<IReadOnlyList<QuizQuestion>>(MockOpenAIService.GenerateQuestions(category, count));
    }

    private MultiplayerLobbyService NewLobby() => new(new StubAi(), NullLogger<MultiplayerLobbyService>.Instance);

    private Task<(MultiplayerGame Game, bool Created)> JoinAsync(
        MultiplayerLobbyService lobby, string conn, string name, QuestionCategory category = QuestionCategory.General, int questions = 5) =>
        lobby.JoinOrCreateAsync(conn, name, category, questions, default);

    [Theory]
    [InlineData("conn1", "Alice", 1)]
    [InlineData("conn7", "Eve", 1)]
    public async Task FirstPlayer_OpensLobby_AndIsHostPlayerOne(string hostConn, string hostName, int expectedPlayerNumber)
    {
        var lobby = NewLobby();
        var (game, created) = await JoinAsync(lobby, hostConn, hostName);
        created.Should().BeTrue(because: "an empty lobby is opened by whoever arrives first");
        game.GameId.Should().NotBeNullOrEmpty();
        game.HostConnectionId.Should().Be(hostConn);
        game.Players.Should().ContainSingle(p => p.Name == hostName && p.PlayerNumber == expectedPlayerNumber);
        game.State.Should().Be(GameState.Waiting);
    }

    [Theory]
    [InlineData("conn2", "Bob", 2)]
    [InlineData("conn5", "Dan", 2)]
    public async Task SecondPlayer_JoinsTheOpenLobby_AsPlayerNumberTwo(string conn, string name, int expectedNumber)
    {
        var lobby = NewLobby();
        var (hosted, _) = await JoinAsync(lobby, "conn1", "Alice");
        var (joined, created) = await JoinAsync(lobby, conn, name);
        created.Should().BeFalse(because: "there is one lobby — the second player must land in it, not open another");
        joined.GameId.Should().Be(hosted.GameId);
        joined.Players.Should().HaveCount(2);
        joined.Players[1].Name.Should().Be(name);
        joined.Players[1].PlayerNumber.Should().Be(expectedNumber);
    }

    [Theory]
    [InlineData(true, 1)] // one correct answer → streak=1, baseScore > 0
    [InlineData(false, 0)] // wrong answer       → streak=0, baseScore stays 0
    [InlineData(true, 2)] // two correct        → streak=2, baseScore doubles
    [InlineData(true, 3)] // three correct      → streak=3 (tier 3+ bonus kicks in)
    public async Task UpdateScore_UpdatesBaseAndStreak(bool firstCorrect, int consecutiveCorrect)
    {
        var lobby = NewLobby();
        var (game, _) = await JoinAsync(lobby, "conn1", "Alice");
        lobby.UpdateScore(game.GameId, "conn1", isCorrect: firstCorrect, speedMultiplier: 1.0, secondsRemaining: 30);

        for (int i = 1; i < consecutiveCorrect; i++)
        {
            lobby.UpdateScore(game.GameId, "conn1", isCorrect: true, 1.0, 30);
        }

        var player = lobby.GetByConnection("conn1")!.Players[0];

        if (firstCorrect)
        {
            player.ScoreState.BaseScore.Should().BeGreaterThan(0);
            player.CurrentStreak.Should().Be(consecutiveCorrect);
            // Streak bonus tiers: 2→1, 3+→2, 5+→3.
            var expectedBonus = consecutiveCorrect switch
            {
                >= 5 => 3,
                >= 3 => 2,
                >= 2 => 1,
                _ => 0,
            };
            player.ScoreState.StreakBonus.Should().Be(expectedBonus);
        }
        else
        {
            // Wrong answer resets the streak counter immediately.
            player.CurrentStreak.Should().Be(0);
        }
    }

    [Theory]
    [InlineData("conn2", false)] // non-host cannot start
    [InlineData("conn1", true)]  // host can start (with 2 players)
    public async Task StartGame_RequiresHostAndTwoPlayers(string actingConn, bool expectSuccess)
    {
        var lobby = NewLobby();
        var (game, _) = await JoinAsync(lobby, "conn1", "Alice");
        await JoinAsync(lobby, "conn2", "Bob");

        var result = lobby.StartGame(game.GameId, actingConn);
        result.Should().Be(expectSuccess);

        if (expectSuccess)
        {
            lobby.GetByConnection("conn1")!.State.Should().Be(GameState.InProgress);
        }
    }

    [Fact]
    public async Task ThirdPlayer_OpensAFreshLobby_RatherThanOverfillingAFullOne()
    {
        var lobby = NewLobby();
        var (first, _) = await JoinAsync(lobby, "conn1", "Alice");
        await JoinAsync(lobby, "conn2", "Bob");

        // The pair is full. The next arrival must not become a third player in a
        // 2-player game — they open the next lobby and wait there.
        var (third, created) = await JoinAsync(lobby, "conn3", "Carla");

        created.Should().BeTrue();
        third.GameId.Should().NotBe(first.GameId);
        first.Players.Should().HaveCount(2);
        third.Players.Should().ContainSingle(p => p.Name == "Carla");
    }

    [Theory]
    [InlineData("conn1", "conn2", "conn2")] // host leaves → conn2 promotes
    [InlineData("conn2", "conn1", "conn1")] // non-host leaves → host unchanged
    public async Task RemovePlayer_PromotesNewHostOrKeepsSession(string leaver, string expectedNewHost, string otherPlayer)
    {
        var lobby = NewLobby();
        await JoinAsync(lobby, "conn1", "Alice");
        await JoinAsync(lobby, "conn2", "Bob");

        lobby.RemovePlayer(leaver, out _);

        var remaining = lobby.GetByConnection(otherPlayer);
        remaining.Should().NotBeNull();
        remaining!.HostConnectionId.Should().Be(expectedNewHost);
    }

    [Fact]
    public async Task RemoveLastPlayer_DeletesSession()
    {
        var lobby = NewLobby();
        await JoinAsync(lobby, "conn1", "Alice");
        lobby.RemovePlayer("conn1", out var sessionEmpty);
        sessionEmpty.Should().BeTrue();
        lobby.GetByConnection("conn1").Should().BeNull();
    }

    [Fact]
    public async Task Survivor_Rejoin_And_ClientBonuses_AreAllBounded()
    {
        var lobby = NewLobby();
        var (first, _) = await JoinAsync(lobby, "conn1", "Alice");
        await JoinAsync(lobby, "conn2", "Bob");
        lobby.StartGame(first.GameId, "conn1");

        // A tampered client cannot buy points with the two values it supplies.
        lobby.UpdateScore(first.GameId, "conn1", isCorrect: true, speedMultiplier: 1e9, secondsRemaining: int.MaxValue);
        var alice = first.Players[0];
        alice.ScoreState.SpeedBonus.Should().BeLessThanOrEqualTo(first.Questions[0].BasePoints);
        alice.ScoreState.TimeBonus.Should().BeLessThanOrEqualTo(300);

        // Bob leaves mid-match: the survivor is the winner, not an index-out-of-range.
        lobby.RemovePlayer("conn2", out _);
        first.Winner.Should().BeSameAs(alice);
        first.IsTie.Should().BeFalse();

        // Alice queues again on the same connection: she leaves the old game rather than orphaning it.
        var (second, created) = await JoinAsync(lobby, "conn1", "Alice");
        created.Should().BeTrue();
        second.GameId.Should().NotBe(first.GameId);
        first.Players.Should().BeEmpty();
    }

    [Theory]
    [InlineData(1, 5)] // after AdvanceQuestion on Q1, both players' HasFinished should be reset
    [InlineData(2, 5)] // and on subsequent questions as well
    [InlineData(4, 5)] // only the very last question must NOT auto-advance (the hub finalizes it instead)
    public async Task AdvanceQuestion_ResetsHasFinished_ExceptOnLastQuestion(int currentQuestion, int totalQuestions)
    {
        var lobby = NewLobby();
        var (game, _) = await JoinAsync(lobby, "conn1", "Alice", questions: totalQuestions);
        await JoinAsync(lobby, "conn2", "Bob", questions: totalQuestions);

        // Hop the game to the desired question index by direct field-mutation
        // (acceptable here: we are testing the AdvanceQuestion behavior in
        // isolation, not the entire state machine).
        var g = lobby.GetByConnection("conn1")!;
        g.CurrentQuestionIndex = currentQuestion;

        // Pretend both players answered the previous question.
        foreach (var p in g.Players) p.HasFinished = true;

        lobby.AdvanceQuestion(game.GameId, "conn1");

        var fresh = lobby.GetByConnection("conn1")!;
        // AdvanceQuestion only increments the index when there is room; on the
        // last question the lobby stays put so the hub can finalize. Either
        // way the reset flag is what we're really validating.
        if (currentQuestion < totalQuestions - 1)
        {
            fresh.CurrentQuestionIndex.Should().Be(currentQuestion + 1);
        }

        foreach (var p in fresh.Players)
        {
            p.HasFinished.Should().BeFalse(
                because: "AdvanceQuestion must clear per-question submission flags so the same player can answer the next question");
        }
    }
}
