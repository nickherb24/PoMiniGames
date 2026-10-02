using FluentAssertions;
using PoMiniGames.Features.PoFunQuiz;

namespace PoMiniGames.Unit.Features.PoFunQuiz;

/// <summary>
/// Tests for the PoFunQuiz domain models — pure logic, no I/O.
/// </summary>
/// <remarks>
/// Streak accumulation is one theory parameterized over (consecutive correct count,
/// expected streak bonus); session scoring is another.
/// </remarks>
public sealed class FunQuizModelsTests
{
    [Theory]
    [InlineData(DifficultyLevel.Easy, 1)]
    [InlineData(DifficultyLevel.Medium, 2)]
    [InlineData(DifficultyLevel.Hard, 3)]
    public void QuizQuestion_BasePoints_MapsDifficulty(DifficultyLevel difficulty, int expected)
    {
        new QuizQuestion { Difficulty = difficulty }.BasePoints.Should().Be(expected);
    }

    [Theory]
    [InlineData(0, 0)] // no streak yet
    [InlineData(1, 0)] // 1 correct → no streak bonus
    [InlineData(2, 1)] // streak of 2 → +1 (tier 2+)
    [InlineData(3, 2)] // streak of 3 → +2 (tier 3+)
    [InlineData(4, 2)] // streak of 4 → +2 (still tier 3+, not yet 5+)
    [InlineData(5, 3)] // streak of 5 → +3 (tier 5+)
    public void PlayerScoreState_StreakBonus_AccumulatesPerCorrectAnswer(int consecutiveCorrect, int expectedStreak)
    {
        var s = new PlayerScoreState();
        for (int i = 0; i < consecutiveCorrect; i++)
        {
            s.ApplyCorrectAnswer(basePoints: 2, speedMultiplier: 1.0);
        }
        s.StreakBonus.Should().Be(expectedStreak);
        s.BaseScore.Should().Be(consecutiveCorrect * 2);
        // CurrentStreak is independent: always equals consecutiveCorrect.
        s.CurrentStreak.Should().Be(consecutiveCorrect);
    }

    [Theory]
    [InlineData(1.0, 0)] // baseline speed → no bonus
    [InlineData(2.0, 2)] // 2 × (2 - 1) = 2
    [InlineData(1.5, 1)] // 2 × (1.5 - 1) = 1
    [InlineData(0.5, 0)] // below baseline → no bonus (clamped at 0)
    public void PlayerScoreState_SpeedBonus_AddsExtraPoints(double speedMultiplier, int expectedBonus)
    {
        var s = new PlayerScoreState();
        s.ApplyCorrectAnswer(basePoints: 2, speedMultiplier: speedMultiplier);
        s.SpeedBonus.Should().Be(expectedBonus);
    }

    [Theory]
    [InlineData(10, 10, true, null)]    // tie
    [InlineData(15, 8, false, "A")]     // P1 wins
    [InlineData(8, 15, false, "B")]     // P2 wins
    [InlineData(0, 0, true, null)]    // zero-tie
    public void GameSession_ScoreAndWinner_ResolvesTie(
        int p1Score, int p2Score, bool expectTie, string? expectedWinnerName)
    {
        var session = new GameSession
        {
            Player1 = new Player { Name = "A" },
            Player2 = new Player { Name = "B" },
        };
        session.Player1State.SetBaseScore(p1Score);
        session.Player2State.SetBaseScore(p2Score);
        session.IsTie.Should().Be(expectTie);
        session.Winner?.Name.Should().Be(expectedWinnerName);
    }

    [Theory]
    [InlineData(0, 0, 0)]         // zero until EndTime set
    [InlineData(1000, 46000, 45)]      // 45s span
    [InlineData(5000, 5000, 0)]       // same instant
    public void GameSession_Duration_RespectsStartAndEndTime(int startMs, int endMs, int expectedSeconds)
    {
        var session = new GameSession();
        session.StartTime = DateTime.UtcNow.AddMilliseconds(startMs);
        session.EndTime = DateTime.UtcNow.AddMilliseconds(endMs);
        session.Duration.Should().BeCloseTo(TimeSpan.FromSeconds(expectedSeconds), TimeSpan.FromMilliseconds(50));
    }

    [Theory]
    [InlineData(QuestionCategory.Science, 12)]
    [InlineData(QuestionCategory.General, 5)]
    [InlineData(QuestionCategory.History, 8)]
    public void MockOpenAIService_ReturnsRequestedCount(QuestionCategory category, int count)
    {
        var q = MockOpenAIService.GenerateQuestions(category, count);
        q.Should().HaveCount(count);
        q.Should().AllSatisfy(question =>
        {
            question.Text.Should().NotBeNullOrWhiteSpace();
            question.Options.Should().HaveCount(4);
            question.CorrectOptionIndex.Should().BeInRange(0, 3);
        });
    }
}
