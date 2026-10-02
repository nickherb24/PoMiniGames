using FluentAssertions;
using PoMiniGames.Features.PoJoker.Storage;

namespace PoMiniGames.Unit.Features.PoJoker;

/// <summary>
/// Ranking rules for the PoJoker "best jokes" board.
/// </summary>
/// <remarks>
/// One test method by design: the Integration tier is at its 50-method ceiling and Unit is near
/// its 100, so the whole reduce is asserted in a single Fact rather than split per rule. Each
/// block below is an independent claim — keep them labelled.
/// </remarks>
public sealed class TopJokeRankingTests
{
    private static JokePerformanceEntity Row(
        int jokeId, int humor, int cleverness, int originality,
        string setup = "Why did the chicken cross the road?",
        string punchline = "To get to the other side.",
        bool nsfw = false, bool racist = false, bool sexist = false, bool @explicit = false,
        string type = "twopart", string text = "") =>
        new()
        {
            JokeId = jokeId,
            JokeType = type,
            JokeSetup = setup,
            JokePunchline = punchline,
            JokeText = text,
            // Humour is stored in Difficulty and originality in Complexity — see TopJokeRanking.Score.
            RatingDifficulty = humor,
            RatingCleverness = cleverness,
            RatingComplexity = originality,
            // Hardcoded by AiJesterService for every joke; must not influence the ranking.
            RatingRudeness = 1,
            FlagNsfw = nsfw,
            FlagRacist = racist,
            FlagSexist = sexist,
            FlagExplicit = @explicit,
        };

    [Fact]
    public void Rank_ScoresOnThreeDimensions_CollapsesDuplicates_AndDropsIneligibleRows()
    {
        var rows = new[]
        {
            // Same joke twice under ONE id: the better telling wins and the worse one must not
            // also occupy a slot.
            Row(jokeId: 1, humor: 4, cleverness: 4, originality: 4, setup: "Knock knock"),
            Row(jokeId: 1, humor: 9, cleverness: 9, originality: 9, setup: "Knock knock"),

            Row(jokeId: 2, humor: 6, cleverness: 6, originality: 6),

            // Unrated (pre-rating rows, or a failed rating call) — unranked, not zero-rated.
            Row(jokeId: 3, humor: 0, cleverness: 0, originality: 0),

            // Flagged content must never reach a public, anonymous-readable board however
            // highly the model rated it.
            Row(jokeId: 4, humor: 10, cleverness: 10, originality: 10, nsfw: true),
            Row(jokeId: 5, humor: 10, cleverness: 10, originality: 10, racist: true),
            Row(jokeId: 6, humor: 10, cleverness: 10, originality: 10, sexist: true),
            Row(jokeId: 7, humor: 10, cleverness: 10, originality: 10, @explicit: true),

            // Rated but textless — nothing to show in the row.
            Row(jokeId: 8, humor: 9, cleverness: 9, originality: 9, setup: "   "),
        };

        var board = TopJokeRanking.Rank(rows, top: 10);

        board.Select(j => j.JokeId).Should().Equal([1, 2],
            because: "only rated, unflagged, non-empty jokes rank, one row per joke");

        var best = board.Single(j => j.JokeId == 1);
        best.Score.Should().Be(9.0, because: "a joke keeps its highest-scoring telling");
        best.FullText.Should().Be("Knock knock — To get to the other side.",
            because: "the hover text carries the punchline the clipped row omits");
    }

    [Fact]
    public void Rank_CollapsesTheSameJokeArrivingUnderDifferentIds()
    {
        // Regression: on a real board "Why do programmers prefer dark mode?" held ranks 1, 3
        // and 4 at once, each row carrying a different JokeId. The same joke reaches storage
        // under several ids (re-fetched across sessions, rewritten by the sanitiser, or stored
        // as the id-0 fallback), so dedup keys on the normalised setup, not the id.
        // Byte-identical raw text under different ids collapses too (same setup at ranks 1
        // and 3, 6.0 and 5.0).
        var rows = new[]
        {
            Row(jokeId: 11, humor: 4, cleverness: 4, originality: 4, setup: "Why do programmers prefer dark mode?"),
            Row(jokeId: 22, humor: 9, cleverness: 9, originality: 9, setup: "why do programmers prefer dark mode"),
            Row(jokeId: 33, humor: 6, cleverness: 6, originality: 6, setup: "Why  do programmers   prefer dark mode?!"),
            // Identical raw text, yet another id, lower score — must not occupy a slot.
            Row(jokeId: 44, humor: 5, cleverness: 5, originality: 5, setup: "Why do programmers prefer dark mode?"),
            Row(jokeId: 55, humor: 7, cleverness: 7, originality: 7, setup: "A genuinely different joke"),
        };

        var board = TopJokeRanking.Rank(rows, top: 10);

        board.Should().HaveCount(2, because: "case, spacing, punctuation or a plain regeneration must not split one joke into several rows");
        board[0].Score.Should().Be(9.0, because: "the best telling of the collapsed joke survives");
        board.Select(j => j.Setup).Should().OnlyHaveUniqueItems();
    }

    [Fact]
    public void Rank_IgnoresRudeness_OrdersByScore_BreaksTiesDeterministically_AndHonoursTop()
    {
        // Score is the mean of the three real dimensions, NOT RatingAverage — which divides by
        // four to include the hardcoded Rudeness and would yield 2.5 here instead of 3.
        TopJokeRanking.Score(Row(1, humor: 3, cleverness: 3, originality: 3)).Should().Be(3.0);

        var rows = new[]
        {
            // Distinct setups: the dedup collapses shared text regardless of
            // id, so these four must not lean on the Row() helper's default setup or the
            // board they assert on would fold into a single slot.
            Row(jokeId: 30, humor: 5, cleverness: 5, originality: 5, setup: "Joke A"),   // 5.0
            Row(jokeId: 10, humor: 8, cleverness: 8, originality: 8, setup: "Joke B"),   // 8.0
            Row(jokeId: 20, humor: 8, cleverness: 8, originality: 8, setup: "Joke C"),   // 8.0 — ties with 10
            Row(jokeId: 40, humor: 1, cleverness: 1, originality: 1, setup: "Joke D"),   // 1.0
        };

        TopJokeRanking.Rank(rows, top: 10).Select(j => j.JokeId)
            .Should().Equal([10, 20, 30, 40],
                because: "highest score first, ties broken by joke id so the board is stable across requests");

        TopJokeRanking.Rank(rows, top: 2).Select(j => j.JokeId)
            .Should().Equal([10, 20], because: "the board is capped at the requested size");

        // A one-liner has no separate punchline; its whole text is the setup.
        var single = TopJokeRanking
            .Rank([Row(99, 7, 7, 7, setup: "", punchline: "", type: "single", text: "I only know 25 letters — I don't know y.")], top: 1)
            .Single();
        single.Setup.Should().Be("I only know 25 letters — I don't know y.");
        single.Punchline.Should().BeEmpty();
        single.FullText.Should().Be(single.Setup, because: "there is no punchline to append");
    }
}
