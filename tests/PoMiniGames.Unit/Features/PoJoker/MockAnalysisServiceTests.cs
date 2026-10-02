using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using PoMiniGames.Features.PoJoker;
using PoMiniGames.Shared.Games.PoJoker;

namespace PoMiniGames.Unit.Features.PoJoker;

/// <summary>
/// Sanity tests for the deterministic-shape mock analysis service used as the non-Production
/// fallback when PoJoker:AzureOpenAI is unconfigured (mirrors the PoCoupleQuiz mock pattern).
/// </summary>
/// <remarks>
/// Three facts, each testing a distinct public-surface behaviour (analyse, explain,
/// cancellation).
/// </remarks>
public sealed class MockAnalysisServiceTests
{
    private readonly MockAnalysisService _service = new(NullLogger<MockAnalysisService>.Instance);

    private static JokeDto SampleJoke() => new()
    {
        Id = 42,
        Category = "Programming",
        Type = "twopart",
        Setup = "Why do programmers prefer dark mode?",
        Punchline = "Because light attracts bugs."
    };

    [Fact]
    public async Task AnalyzeJokeAsync_ReturnsPunchline_AndRatingInValidRanges()
    {
        var (analysis, rating) = await _service.AnalyzeJokeAsync(SampleJoke());

        analysis.AiPunchline.Should().NotBeNullOrWhiteSpace();
        analysis.OriginalJoke.Id.Should().Be(42);
        analysis.Confidence.Should().BeInRange(0.0, 1.0);
        analysis.SimilarityScore.Should().BeInRange(0.0, 1.0);

        rating.Cleverness.Should().BeInRange(1, 10);
        rating.Rudeness.Should().BeInRange(1, 10);
        rating.Complexity.Should().BeInRange(1, 10);
        rating.Difficulty.Should().BeInRange(1, 10);
    }

    [Fact]
    public async Task AnalyzeJokeAsync_HonoursCancellation()
    {
        using var cts = new CancellationTokenSource();
        cts.Cancel();

        var act = async () => await _service.AnalyzeJokeAsync(SampleJoke(), cts.Token);
        await act.Should().ThrowAsync<OperationCanceledException>();
    }
}
