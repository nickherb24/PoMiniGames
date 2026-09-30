using FluentAssertions;
using PoMiniGames.Domain.Models;
using PoMiniGames.Features.PoMarbleRace;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Unit;

/// <summary>
/// Unit tests for <see cref="MarbleRaceScore"/> — the type that makes an out-of-range PoMarbleRace
/// score unrepresentable rather than merely rejected at one endpoint — and for
/// <see cref="MarbleRaceRunVerifier"/>, which recomputes a run total from its races.
/// </summary>
/// <remarks>
/// TryCreate and Clamp share one theory (2026-09-30, to free the Unit slot the verifier uses):
/// same rows, with the clamp result as a column.
/// </remarks>
public sealed class MarbleRaceScoreTests
{
    [Theory]
    [InlineData(0, true, 0)]                            // a scoreless run is legitimate
    [InlineData(1, true, 1)]
    [InlineData(42, true, 42)]
    [InlineData(1_000_000, true, 1_000_000)]            // the ceiling itself is valid
    [InlineData(-1, false, 0)]                          // negative
    [InlineData(-5, false, 0)]
    [InlineData(1_000_001, false, 1_000_000)]           // just past the ceiling
    [InlineData(int.MaxValue, false, 1_000_000)]        // the tampered submission that would own the board forever
    [InlineData(int.MinValue, false, 0)]
    public void TryCreate_ChecksTheRange_AndClampBoundsIt(int value, bool accepted, int clamped)
    {
        MarbleRaceScore.TryCreate(value, out var score).Should().Be(accepted);
        score.Value.Should().Be(accepted ? value : 0, accepted ? "an accepted score keeps its value" : "a rejected score must not leak a usable value to the caller");
        MarbleRaceScore.Clamp(value).Value.Should().Be(clamped);
    }

    // Races are "place:seconds:lead" triples. Expected -1 means the run is refused.
    [Theory]
    [InlineData(2, "1:40:0", 10)]                       // 1st, not dominant: 10 × 1
    [InlineData(2, "1:40:2", 14)]                       // dominant win: (10 + 4) × 1
    [InlineData(2, "10:40:0|3:40:0|5:40:0", 25)]        // 1×1 + 8×1.5 + 6×2 — the streak multiplier
    [InlineData(2, "10:40:0|10:40:0|10:40:0|10:40:0|10:40:0|10:40:0", 14)] // 1+2+2+3+3+3: the multiplier caps at 3×
    [InlineData(2, "9:40:0|8:40:0", 7)]                 // 2 + round(3 × 1.5 = 4.5) rounds half up, like JS
    [InlineData(2, "11:40:0", -1)]                      // a miss ends a run, so it cannot be inside one
    [InlineData(2, "1:5:0", -1)]                        // faster than any marble can cover the course
    [InlineData(2, "1:181:0", -1)]                      // past the race timeout
    [InlineData(9, "1:40:0", -1)]                       // no such map
    [InlineData(2, "", -1)]                             // no races, no verified run
    public void RunVerifier_RecomputesTheTotal_OrRefusesTheRun(int mapId, string races, int expected)
    {
        MarbleRaceRunRace[] parsed = races.Length == 0 ? [] : races.Split('|').Select(r =>
        {
            var p = r.Split(':');
            return new MarbleRaceRunRace(int.Parse(p[0]), double.Parse(p[1]), double.Parse(p[2]));
        }).ToArray();

        MarbleRaceRunVerifier.Score(mapId, parsed).Should().Be(expected < 0 ? (int?)null : expected);
    }
}
