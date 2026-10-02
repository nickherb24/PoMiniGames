using FluentAssertions;
using PoMiniGames.Features.PoCoupleQuiz;

namespace PoMiniGames.Unit.Features.PoCoupleQuiz;

/// <summary>
/// Sanity tests for the deterministic in-memory question service used when
/// <c>UseMockAi=true</c> (Dev/Test only — see the StartupSecretValidator pattern).
/// </summary>
/// <remarks>
/// The CheckSimilarity cases are one theory parameterized over (a, b, expected).
/// </remarks>
public sealed class MockQuestionServiceTests
{
    private readonly MockQuestionService _service = new();

    [Theory]
    [InlineData("pizza", "pizza", 1f)] // identical
    [InlineData("Pizza", "PIZZA", 1f)] // case-insensitive
    [InlineData("  pizza  ", "pizza", 1f)] // whitespace-trimmed
    [InlineData("pizza", "sushi", 0f)] // different
    [InlineData("", "anything", 0f)] // empty lhs
    [InlineData("anything", "", 0f)] // empty rhs
    [InlineData(null, "anything", 0f)] // null lhs
    public async Task CheckSimilarity_AppliesNormalisationRules(string? lhs, string? rhs, float expected)
    {
        var score = await _service.CheckAnswerSimilarityAsync(lhs!, rhs!);
        score.Should().Be(expected);
    }

    [Fact]
    public async Task GenerateQuestion_RespectsExplicitCategory()
    {
        var q = await _service.GenerateQuestionAsync(QuestionCategory.Hobbies);
        q.Category.Should().Be(QuestionCategory.Hobbies);
    }
}
