using FluentAssertions;
using PoMiniGames.Domain.Primitives;
using PoMiniGames.Domain.Services;

namespace PoMiniGames.Unit;

/// <summary>
/// Unit tests for the two server-side judgements every public board depends on:
/// <see cref="ScoreRules"/> (is this score possible?) and
/// <see cref="DisplayNameSanitizer"/> (may this name be shown?).
/// </summary>
public sealed class ScoreRulesTests
{
    [Theory]
    // Time boards: the claimed duration cannot exceed the session that produced it.
    [InlineData("posports", 12.4, 60, ScoreVerdict.Plausible)]
    [InlineData("posports", 12.4, 6, ScoreVerdict.Impossible)]
    [InlineData("posports", 0.2, 60, ScoreVerdict.OutOfRange)]
    [InlineData("posports", 700, 800, ScoreVerdict.OutOfRange)]
    [InlineData("posports", 1.0, 1, ScoreVerdict.TooFast)]
    // Point boards: a rate ceiling, plus the absolute range.
    [InlineData("pomarblerace", 100, 60, ScoreVerdict.Plausible)]
    [InlineData("pomarblerace", 100_001, 2, ScoreVerdict.Impossible)]
    [InlineData("pomarblerace", 1_000_001, 600, ScoreVerdict.OutOfRange)]
    [InlineData("pomarblerace", double.NaN, 60, ScoreVerdict.OutOfRange)]
    // A board with no rules is never judged.
    [InlineData("poecosystem", int.MaxValue, 0, ScoreVerdict.Plausible)]
    public void CheckAgainstSession_JudgesScoreAgainstElapsedTime(
        string game, double score, double elapsedSeconds, ScoreVerdict expected)
    {
        ScoreRules.CheckAgainstSession(GameKey.Parse(game), score, TimeSpan.FromSeconds(elapsedSeconds))
            .Should().Be(expected);
    }

    [Theory]
    [InlineData("Alice", DisplayNameVerdict.Accepted, "Alice")]
    // "ass" is blocked only as a whole token, never as a substring.
    [InlineData("Cassandra", DisplayNameVerdict.Accepted, "Cassandra")]
    // "as" squeezes to the same letters as "ass" but is an ordinary word.
    [InlineData("Cool As Ice", DisplayNameVerdict.Accepted, "Cool As Ice")]
    // Leet is undone for matching only; the stored name keeps it.
    [InlineData("L33T Player", DisplayNameVerdict.Accepted, "L33T Player")]
    [InlineData("  Bob   Smith ", DisplayNameVerdict.Sanitized, "Bob Smith")]
    // Full-width look-alikes fold onto ASCII; zero-width padding is dropped.
    [InlineData("Ａｌｉｃｅ", DisplayNameVerdict.Sanitized, "Alice")]
    [InlineData("Al​ice", DisplayNameVerdict.Sanitized, "Alice")]
    [InlineData("ABCDEFGHIJKLMNOPQRSTUVWXYZ1234", DisplayNameVerdict.Sanitized, "ABCDEFGHIJKLMNOPQRSTUVWX")]
    public void Sanitize_KeepsPublishableNames(string raw, DisplayNameVerdict verdict, string stored)
    {
        var result = DisplayNameSanitizer.Sanitize(raw, "Guest");

        result.Verdict.Should().Be(verdict);
        result.Value.Should().Be(stored);
    }

    [Theory]
    [InlineData(null, "empty")]
    [InlineData("   ", "empty")]
    [InlineData("A", "too-short")]
    [InlineData("---", "no-letters")]
    [InlineData("sh1t", "blocked")]
    [InlineData("f u c k", "blocked")]
    [InlineData("fuuuuck", "blocked")]
    [InlineData("cunt", "blocked")]
    [InlineData("Admin", "reserved")]
    // Listed words that contain a doubled letter, and stretched spellings of them.
    [InlineData("ass", "blocked")]
    [InlineData("asss", "blocked")]
    [InlineData("b00bs", "blocked")]
    [InlineData("root", "reserved")]
    [InlineData("Staff", "reserved")]
    public void Sanitize_RejectsUnpublishableNames_AndReturnsTheFallback(string? raw, string reason)
    {
        var result = DisplayNameSanitizer.Sanitize(raw, "Guest");

        result.Verdict.Should().Be(DisplayNameVerdict.Rejected);
        result.Reason.Should().Be(reason);
        result.Value.Should().Be("Guest");
    }

    [Theory]
    [InlineData(1000, 1000, false, 12)]  // even match, K = 24
    [InlineData(1000, 1000, true, 0)]
    [InlineData(1000, 1400, false, 22)]  // upset win
    [InlineData(1400, 1000, true, -10)]  // a draw against a weaker fighter costs rating
    public void PairwiseElo_Delta_IsZeroSumAndFloored(int sideA, int sideB, bool isDraw, int expected)
    {
        var elo = new PairwiseEloCalculator(new PairwiseEloOptions());

        elo.Delta(sideA, sideB, isDraw).Should().Be(expected);
        // The floor wins over conservation: a fighter at the floor absorbs less than the loss.
        elo.ApplyDelta(105, -12).Should().Be(100);
    }
}
