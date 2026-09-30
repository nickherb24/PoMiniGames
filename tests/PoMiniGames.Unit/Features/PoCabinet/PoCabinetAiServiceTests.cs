using FluentAssertions;
using PoMiniGames.Features.PoCabinet;
using PoMiniGames.Shared.Games;
using Xunit;

namespace PoMiniGames.Unit.Features.PoCabinet;

public class PoCabinetAiServiceTests
{
    /// <summary>
    /// What reaches a speech bubble or a voice: model lines are filtered and capped, a slot the
    /// model left empty (or filled only with filtered lines) falls back to the script, and the
    /// rule-based debrief turns the numbers into the tips they justify.
    /// </summary>
    [Fact]
    public void ModelOutput_IsFilteredCappedAndBackfilled_AndTheFallbackDebriefFollowsTheNumbers()
    {
        var canned = PoCabinetAiService.CannedBanter();
        canned.Mock.Should().BeTrue();
        canned.Lines.Keys.Should().BeEquivalentTo(["sean-s", "steve-b", "bill-b", "mike-p"]);
        canned.Lines.Values.SelectMany(k => k.Keys).Distinct().Should().BeEquivalentTo(PoCabinetAiService.Kinds);

        var longLine = string.Join(' ', Enumerable.Repeat("faster", 40));
        const string json = """
            { "officials": [
              { "id": "sean-s", "preRace": ["  \"No questions on the grid.\"  ", "Vote for me in turn one!"],
                "passed": [], "lead": ["LONG"], "finish": ["That lap never happened."] },
              { "id": "not-an-official", "preRace": ["ignored"], "passed": [], "lead": [], "finish": [] }
            ] }
            """;
        var pool = PoCabinetAiService.MergeBanter(json.Replace("LONG", longLine), canned);

        pool.Mock.Should().BeFalse();
        pool.Lines.Should().NotContainKey("not-an-official");
        pool.Lines["sean-s"]["preRace"].Should().Equal("No questions on the grid.");            // quotes trimmed, politics dropped
        pool.Lines["sean-s"]["lead"].Single().Length.Should().BeLessThanOrEqualTo(PoCabinetAiService.MaxLineChars);
        pool.Lines["sean-s"]["passed"].Should().Equal(canned.Lines["sean-s"]["passed"]);       // empty slot → script
        pool.Lines["mike-p"].Should().BeEquivalentTo(canned.Lines["mike-p"]);                   // missing official → script
        PoCabinetAiService.MergeBanter("not json", canned).Should().BeSameAs(canned);

        var slow = PoCabinetAiService.CannedDebrief(PoCabinetAiService.Clamp(new PoCabinetDebriefRequest(
            "capitol", 4, 5, 26.1, 24.9, [0.1, 0.9, -0.2], FullThrottlePct: 40, BrakePct: 10, TopKmh: 270,
            SlowestKmh: 150, WorstPointPct: 45, WallHits: 2, Laps: 3)));
        slow.Mock.Should().BeTrue();
        slow.Tips.Should().HaveCount(3);
        slow.Tips[0].Should().Contain("Sector 2").And.Contain("0.90");
        slow.Tips[1].Should().Contain("Sector 3").And.Contain("quicker");
        slow.Tips[2].Should().Contain("2 barrier hits");
        slow.Headline.Should().Contain("P4");

        // Out-of-range numbers are clamped before anything is written from them.
        var wild = PoCabinetAiService.Clamp(new PoCabinetDebriefRequest(
            "nowhere", 99, 99, double.NaN, -5, [1, 2], 400, -3, 9999, -1, 500, -2, 50));
        wild.TrackName.Should().Be(PoCabinetCatalog.GetTrack(PoCabinetCatalog.DefaultTrackId).Name);
        wild.Sectors.Should().BeEmpty();
        (wild.Position, wild.FullThrottle, wild.Brake, wild.WorstPoint, wild.WallHits).Should().Be((wild.TotalCars, 100, 0, 100, 0));
    }
}
