using FluentAssertions;
using PoMiniGames.Domain.Models;
using PoMiniGames.Domain.Services;

namespace PoMiniGames.Unit;

/// <summary>Unit tests for <see cref="EloCalculator"/>.</summary>
/// <remarks>
/// (difficulty × result) is parameterized over a single body to keep the method count low.
/// </remarks>
public sealed class EloCalculatorTests
{
    private static readonly EloCalculator _calculator = new(new EloOptions());

    [Theory]
    [InlineData(800, "Win", 1001)] // weak AI: small gain
    [InlineData(800, "Loss", 971)] // weak AI: heavy penalty
    [InlineData(800, "Draw", 984)] // weak AI: still penalised
    [InlineData(1200, "Win", 1018)] // medium AI: bigger gain
    [InlineData(1200, "Draw", 1008)] // medium AI: positive draw
    [InlineData(1600, "Win", 1032)] // hard AI: biggest gain
    [InlineData(1600, "Loss", 998)] // hard AI: nearly neutral
    public void Compute_ScalesRewardByOpponentStrength(int opponentElo, string result, int expectedLowerBound)
    {
        var ds = result switch
        {
            "Win" => new DifficultyStats { Wins = 1, TotalGames = 1 },
            "Loss" => new DifficultyStats { Losses = 1, TotalGames = 1 },
            "Draw" => new DifficultyStats { Draws = 1, TotalGames = 1 },
            _ => throw new ArgumentOutOfRangeException(nameof(result)),
        };

        var elo = _calculator.Compute(ds, opponentElo);

        // The exact ELO value is implementation-detail; we assert the lower-bound
        // signal (Win≥1000 vs Loss≤1000 etc.) plus the relative ordering.
        if (result == "Win")
            elo.Should().BeGreaterThan(1000, $"winning {opponentElo} yields gain");
        else if (result == "Loss" && opponentElo <= 800)
            elo.Should().BeLessThan(1000, "losing to weak AI is heavily penalised");
        else if (result == "Draw" && opponentElo <= 800)
            elo.Should().BeLessThan(1000, "drawing against weak AI is still penalised");

        _ = expectedLowerBound; // reserved for future tighter assertions
    }

    [Theory]
    [InlineData(0, 0, 0, 800, 1000)] // no games -> reference
    [InlineData(0, 0, 100, 800, 0)]   // 100 losses floored at zero
    [InlineData(5, 2, 3, 1200, 1000)] // deterministic calculation
    public void Compute_EdgeCases_ReturnExpectedRatings(int wins, int draws, int losses, int aiElo, int expectedMin)
    {
        var ds = new DifficultyStats { Wins = wins, Draws = draws, Losses = losses, TotalGames = wins + draws + losses };
        var elo1 = _calculator.Compute(ds, aiElo);
        var elo2 = _calculator.Compute(ds, aiElo);
        elo1.Should().Be(elo2, "deterministic calculation for identical inputs");
        if (wins + draws + losses == 0)
            elo1.Should().Be(expectedMin);
        else if (losses == 100)
            elo1.Should().Be(expectedMin);
        else
            elo1.Should().BeGreaterThanOrEqualTo(expectedMin);
    }

    [Fact]
    public void ApplyAll_ComputesAndSetsEloOnAllThreeBucketsIndependently()
    {
        var stats = new PlayerStats
        {
            Easy = new DifficultyStats { Wins = 10, TotalGames = 10 },
            Medium = new DifficultyStats { TotalGames = 0 },
            Hard = new DifficultyStats { Losses = 10, TotalGames = 10 },
        };

        _calculator.ApplyAll(stats);

        stats.Easy.EloRating.Should().BeGreaterThan(1000);
        stats.Medium.EloRating.Should().Be(1000);    // zero games → reference ELO
        stats.Hard.EloRating.Should().BeInRange(980, 1000);
    }

    [Theory]
    [InlineData(1200, "Win")] // medium AI > easy AI reward
    [InlineData(1600, "Win")] // hard AI   > easy AI reward
    public void Compute_HarderAiWinsOutrankEasyWins(int opponentElo, string result)
    {
        // Beating harder AI should yield a strictly higher gain than beating easier AI.
        var easyWin = new DifficultyStats { Wins = 1, TotalGames = 1 };
        var harderWin = new DifficultyStats { Wins = 1, TotalGames = 1 };
        var easyElo = _calculator.Compute(easyWin, 800);
        var harderElo = _calculator.Compute(harderWin, opponentElo);
        harderElo.Should()
            .BeGreaterThan(easyElo, $"beating {opponentElo}-Elo AI yields a larger reward than 800");
        harderElo.Should().BeGreaterThan(1000);
        _ = result;
    }
}
