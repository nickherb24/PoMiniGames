using FluentAssertions;
using PoMiniGames.Shared.Games.PoJoker;

namespace PoMiniGames.Unit.Features.PoJoker;

/// <summary>
/// Tests for the PoJoker shared DTOs / settings — pure logic, no I/O.
/// </summary>
/// <remarks>
/// The PerformanceState ordering check is an inline-data theory; the
/// PerformanceSettings validation is parameterized across positive/negative cases.
/// </remarks>
public sealed class JokerModelsTests
{
    private static JokeDto TwoPart() => new()
    {
        Id = 1,
        Type = "twopart",
        Setup = "Why did the chicken cross the road?",
        Punchline = "To get to the other side."
    };

    [Theory]
    [InlineData("twopart", "", "Why did the chicken cross the road?", "To get to the other side.",
                "Why did the chicken cross the road?", "Why did the chicken cross the road?\nTo get to the other side.")]
    [InlineData("single", "I'm reading a book about anti-gravity. It's impossible to put down.", "", "",
                "I'm reading a book about anti-gravity. It's impossible to put down.",
                "I'm reading a book about anti-gravity. It's impossible to put down.")]
    public void JokeDto_DisplayText_AndFullText_AreCorrect(
        string type, string joke, string setup, string punchline,
        string expectedDisplay, string expectedFull)
    {
        var dto = new JokeDto { Id = 1, Type = type, Joke = joke, Setup = setup, Punchline = punchline };
        dto.DisplayText.Should().Be(expectedDisplay);
        dto.FullText.Should().Be(expectedFull);
    }

    [Theory]
    [InlineData(8, 2, 6, 4, 5.0)] // (8+2+6+4)/4
    [InlineData(10, 10, 10, 10, 10.0)]
    [InlineData(1, 2, 3, 4, 2.5)]
    public void JokeRatingDto_Average_IsMeanOfFourDimensions(
        int cleverness, int rudeness, int complexity, int difficulty, double expected)
    {
        var rating = new JokeRatingDto
        {
            Cleverness = cleverness,
            Rudeness = rudeness,
            Complexity = complexity,
            Difficulty = difficulty,
        };
        rating.Average.Should().Be(expected);
    }

    [Theory]
    [InlineData(-1, true)]   // negative setup duration
    [InlineData(0, false)]  // default setup duration is allowed
    [InlineData(int.MaxValue, false)] // huge but positive is allowed by validation
    public void PerformanceSettings_Validate_HandlesNegativeValues(int setupDurationSeconds, bool expectThrow)
    {
        var settings = new PerformanceSettings { SetupDurationSeconds = setupDurationSeconds };
        var act = () => settings.Validate();
        if (expectThrow) act.Should().Throw<InvalidOperationException>();
        else act.Should().NotThrow();
    }

    [Fact]
    public void PerformanceState_FollowsMonotonicOrdering()
    {
        // The orchestrator relies on monotonic ordering (CurrentState >= ShowingSetup, etc.).
        ((int)PerformanceState.Idle).Should().BeLessThan((int)PerformanceState.Fetching);
        ((int)PerformanceState.Fetching).Should().BeLessThan((int)PerformanceState.ShowingSetup);
        ((int)PerformanceState.ShowingSetup).Should().BeLessThan((int)PerformanceState.ShowingAiGuess);
        ((int)PerformanceState.ShowingAiGuess).Should().BeLessThan((int)PerformanceState.RevealingPunchline);
        ((int)PerformanceState.RevealingPunchline).Should().BeLessThan((int)PerformanceState.Transitioning);
        ((int)PerformanceState.Transitioning).Should().BeLessThan((int)PerformanceState.Complete);
    }
}
