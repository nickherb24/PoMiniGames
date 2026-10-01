using FluentAssertions;
using PoMiniGames.Features.PoEcosystem;
using PoMiniGames.Shared.Games.PoEcosystem;
using PoMiniGamesClient.Games.PoEcosystem.Models;

namespace PoMiniGames.Unit.Features.PoEcosystem;

/// <summary>
/// The chronicler's pure edges: request hygiene, reply parsing, and the canned fallbacks.
/// One theory over the three because the Unit tier sits at its ceiling; each row is one
/// contract the endpoint and the mock-mode E2E path rely on.
/// </summary>
/// <remarks>
/// The last two rows (2026-09-30) are the viewer's own pure logic, kept in this theory for
/// the same reason: how a wager is settled from the island's per-year rows, and when a
/// watch alert fires. Both only ever read what the sim reports — the island is observed,
/// never steered — so "what the page concludes from the numbers" is all there is to test.
/// </remarks>
public sealed class EcosystemChronicleServiceTests
{
    private static EcoChronicleRequest Request(int lines = 3) => new(
        Seed: 7, FromYear: 10, ToYear: 20, Tribe: "Moss",
        Counts: [12, 8, 3, 6], Extinct: [false, false, false, false],
        Log: Enumerable.Range(0, lines).Select(i => $"Y1{i}: Fern the rabbit was killed by Ember").ToArray(),
        Almanac: "born 40/20/6/4");

    [Theory]
    [InlineData("sanitize")]
    [InlineData("parse")]
    [InlineData("mock")]
    [InlineData("contracts")]
    [InlineData("compress_log")]
    [InlineData("batch_thought")]
    [InlineData("treaty")]
    [InlineData("lore_culture")]
    [InlineData("wager")]
    [InlineData("alerts")]
    public void Chronicler_PureEdges_HoldTheirContracts(string edge)
    {
        switch (edge)
        {
            case "contracts":
                {
                    // Multi-tribe telemetry and building contracts serialize cleanly with the source-generated context
                    var tribe = new TribeStateDto(
                        Id: 0,
                        Name: "Amber Clan",
                        BannerColor: "#d48806",
                        Tech: TechTier.Primitive,
                        Population: 8,
                        Warriors: 2,
                        Wood: 50,
                        Stone: 20,
                        Food: 120,
                        CenterX: 10.5f,
                        CenterZ: 15.2f,
                        TerritoryRadius: 28.0f,
                        Relations: [0, 1, 2]);

                    var building = new BuildingStateDto(
                        Id: 1,
                        TribeId: 0,
                        Kind: BuildingKind.Hut,
                        X: 12.0f,
                        Z: 14.5f,
                        Progress: 1.0f,
                        Health: 100.0f,
                        IsComplete: true);

                    var telemetry = new EcosystemTelemetryDeltaDto(
                        Year: 3,
                        Day: 4,
                        Tick: 1200,
                        Tribes: [tribe],
                        Buildings: [building],
                        RabbitCount: 35,
                        WolfCount: 5,
                        TotalHumanCount: 8,
                        IsYearMilestone: false);

                    var json = System.Text.Json.JsonSerializer.Serialize(telemetry, PoEcosystemJsonContext.Default.EcosystemTelemetryDeltaDto);
                    json.Should().NotBeNullOrWhiteSpace();

                    var restored = System.Text.Json.JsonSerializer.Deserialize(json, PoEcosystemJsonContext.Default.EcosystemTelemetryDeltaDto);
                    restored.Should().NotBeNull();
                    restored!.Tribes.Should().HaveCount(1);
                    restored.Tribes[0].Name.Should().Be("Amber Clan");
                    restored.Tribes[0].Tech.Should().Be(TechTier.Primitive);
                    restored.Buildings.Should().HaveCount(1);
                    restored.Buildings[0].Kind.Should().Be(BuildingKind.Hut);
                    break;
                }
            case "sanitize":
                {
                    // Over-long logs and lines are clipped, counts are padded to four, the tribe is
                    // letters only, and the span never runs backwards — the model is paid per token.
                    var oversized = Request(lines: EcosystemChronicleService.MaxLogLines + 50) with
                    {
                        Tribe = "<b>Mo ss</b>",
                        Counts = [5],
                        Extinct = [true],
                        FromYear = 30,
                        ToYear = 20,
                        Log = [new string('x', EcosystemChronicleService.MaxLogLineChars + 100), "", "Y1: kept"],
                    };
                    var clean = EcosystemChronicleService.Sanitize(oversized);
                    clean.Log.Should().HaveCount(2, "blank lines are dropped");
                    clean.Log[0].Length.Should().Be(EcosystemChronicleService.MaxLogLineChars);
                    clean.Tribe.Should().Be("bMossb");
                    clean.Counts.Should().Equal(5, 0, 0, 0);
                    clean.Extinct.Should().Equal(true, false, false, false);
                    clean.ToYear.Should().BeGreaterThanOrEqualTo(clean.FromYear);
                    EcosystemChronicleService.Sanitize(Request(EcosystemChronicleService.MaxLogLines + 50)).Log
                        .Should().HaveCount(EcosystemChronicleService.MaxLogLines, "the newest lines win");
                    break;
                }
            case "parse":
                {
                    // A schema-shaped reply survives being wrapped in prose or a code fence; an
                    // empty saga is a failed generation, not a blank page.
                    var wrapped = "Here you go:\n```json\n{\"title\":\"The Moss Years\",\"saga\":\"Fern fell to Ember.\",\"epigraph\":\"So it goes.\"}\n```";
                    var parsed = EcosystemChronicleService.ParseChronicle(wrapped);
                    parsed.Should().NotBeNull();
                    parsed!.Title.Should().Be("The Moss Years");
                    parsed.Saga.Should().Be("Fern fell to Ember.");
                    parsed.Epigraph.Should().Be("So it goes.");
                    parsed.Mock.Should().BeFalse();
                    EcosystemChronicleService.ParseChronicle("{\"title\":\"x\",\"saga\":\"   \",\"epigraph\":\"\"}").Should().BeNull();
                    EcosystemChronicleService.ParseChronicle("not json at all").Should().BeNull();
                    break;
                }
            case "mock":
                {
                    // The canned saga is deterministic and built from the request, and the canned
                    // thought is JSON the browser's nudge parser (sim/thoughts/nudges.js) accepts.
                    var a = EcosystemChronicleService.MockChronicle(Request());
                    var b = EcosystemChronicleService.MockChronicle(Request());
                    a.Saga.Should().Be(b.Saga);
                    a.Mock.Should().BeTrue();
                    a.Title.Should().Contain("Moss").And.Contain("10").And.Contain("20");
                    a.Saga.Should().Contain("Fern the rabbit").And.Contain("12 rabbits");

                    var thought = EcosystemChronicleService.MockThought("Fern, adult female rabbit");
                    using var doc = System.Text.Json.JsonDocument.Parse(thought);
                    doc.RootElement.GetProperty("thought").GetString().Should().NotBeNullOrWhiteSpace();
                    new[] { "boldness", "sociability", "curiosity", "greed", "diligence" }.Should().Contain(doc.RootElement.GetProperty("trait").GetString());
                    doc.RootElement.GetProperty("delta").GetDouble().Should().BeInRange(-0.25, 0.25);
                    EcosystemChronicleService.MockThought("Fern, adult female rabbit").Should().Be(thought, "same prompt, same line");
                    break;
                }
            case "compress_log":
                {
                    string[] rawLog =
                    [
                        "Y10: Fern ate clover",
                        "Y10: Hazel drank lake water",
                        "Y11: Pip the rabbit was born to Fern",
                        "Y12: Timber the wolf hunted a deer",
                        "Y13: Amber Clan built a Granary",
                        "Y14: Amber Clan discovered Toolcraft tech",
                        "Y15: Skirmish erupted at River Crossing with Cobalt Clan",
                    ];
                    var compressed = EcosystemChronicleService.CompressLog(rawLog);
                    compressed.Should().NotContain("ate clover");
                    compressed.Should().NotContain("drank lake water");
                    compressed.Should().Contain("1 births");
                    compressed.Should().Contain("1 predation casualties");
                    compressed.Should().Contain("1 structures built");
                    compressed.Should().Contain("1 tech discoveries");
                    compressed.Should().Contain("1 skirmishes/conflicts");
                    break;
                }
            case "batch_thought":
                {
                    var items = new List<EcoThoughtPromptItem>
                    {
                        new(1, "Rabbit", "Hazel", 0.8f, 0.2f, 1.0f, "forage", "food 10m"),
                        new(2, "Wolf", "Shadow", 0.5f, 0.1f, 0.9f, "hunt", "prey 15m"),
                    };
                    var batchReq = new EcoThoughtBatchRequest(items);
                    var mockBatch = EcosystemChronicleService.MockBatchThought(batchReq);
                    mockBatch.Results.Should().HaveCount(2);
                    mockBatch.Mock.Should().BeTrue();
                    mockBatch.Results[0].Id.Should().Be(1);
                    mockBatch.Results[0].Thought.Should().Contain("Hazel");

                    var rawJson = "[{\"id\": 1, \"thought\": \"Clover smells sweet.\", \"trait\": \"curiosity\", \"delta\": 0.1}]";
                    var parsed = EcosystemChronicleService.ParseBatchThoughts(rawJson);
                    parsed.Should().NotBeNull();
                    parsed!.Results.Should().HaveCount(1);
                    parsed.Results[0].Trait.Should().Be("curiosity");
                    break;
                }
            case "treaty":
                {
                    var tribeA = new TribeStateDto(1, "Amber Clan", "#d48806", TechTier.Toolcraft, 20, 5, 100, 50, 80, 0, 0, 20, [0, 0, 0]);
                    var tribeB = new TribeStateDto(2, "Cobalt Clan", "#1890ff", TechTier.Primitive, 15, 3, 60, 30, 40, 50, 50, 18, [0, 0, 0]);
                    var treatyReq = new EcoTreatyRequest(42, 15, tribeA, tribeB, "border skirmish over river fishing grounds");
                    var mockTreaty = EcosystemChronicleService.MockTreaty(treatyReq);
                    mockTreaty.Should().NotBeNull();
                    mockTreaty.Mock.Should().BeTrue();
                    mockTreaty.Title.Should().Contain("Amber Clan").And.Contain("Cobalt Clan");
                    mockTreaty.PeaceYears.Should().BeGreaterThan(0);

                    var parsedTreaty = EcosystemChronicleService.ParseTreaty("{\"title\":\"Peace Accord\",\"narrative\":\"Tribes laid down arms.\",\"action\":\"PeaceTreaty\",\"demandedResource\":\"Stone\",\"resourceAmount\":25,\"peaceYears\":4}");
                    parsedTreaty.Should().NotBeNull();
                    parsedTreaty!.Action.Should().Be("PeaceTreaty");
                    parsedTreaty.DemandedResource.Should().Be("Stone");
                    parsedTreaty.ResourceAmount.Should().Be(25);
                    break;
                }
            case "lore_culture":
                {
                    var loreReq = new EcoMilestoneLoreRequest(77, 25, "FirstGranary", "Amber Clan", "Completed the first stone storehouse");
                    var mockLore = EcosystemChronicleService.MockLore(loreReq);
                    mockLore.Should().NotBeNull();
                    mockLore.Mock.Should().BeTrue();
                    mockLore.OralLegend.Should().Contain("Amber Clan");

                    var parsedLore = EcosystemChronicleService.ParseLore("{\"epithet\":\"The Stone Age Dawn\",\"oralLegend\":\"When the storehouses rose, winter held no fear.\"}");
                    parsedLore.Should().NotBeNull();
                    parsedLore!.Epithet.Should().Be("The Stone Age Dawn");
                    break;
                }
            case "wager":
                {
                    // Rows are [year, rabbits, deer, wolves, humans, tech, H'×1000], one per year.
                    static int[][] Years(int to, Func<int, int[]> row) => Enumerable.Range(0, to + 1).Select(y => new[] { y }.Concat(row(y)).ToArray()).ToArray();
                    var extinct = EcoWagers.All.Single(q => q.Id == "extinct");
                    var alive = EcoWagers.All.Single(q => q.Id == "alive10");
                    var tech = EcoWagers.All.Single(q => q.Id == "tech20");

                    // Wolves die out in year 7: settled the moment the row says so, long before year 30.
                    var wolvesGone = Years(12, y => [40 + y, 20, y >= 7 ? 0 : 6, 18, Math.Min(4, y / 5), 900]);
                    EcoWagers.Outcome(extinct, wolvesGone).Should().Be(2);
                    EcoWagers.Outcome(alive, wolvesGone).Should().Be(0, "50 + 20 + 0 + 18 = 88 at year 10 is under 100");
                    EcoWagers.Outcome(tech, wolvesGone).Should().BeNull("year 20 has not been lived yet");

                    // Nobody dies out: unknown until year 30, then "none of them".
                    EcoWagers.Outcome(extinct, Years(29, _ => [100, 60, 12, 30, 2, 900])).Should().BeNull();
                    var thriving = Years(30, _ => [100, 60, 12, 30, 2, 900]);
                    EcoWagers.Outcome(extinct, thriving).Should().Be(4);
                    EcoWagers.Outcome(alive, thriving).Should().Be(2, "202 alive is the 175–249 bucket");
                    EcoWagers.Outcome(tech, thriving).Should().Be(2);
                    EcoWagers.Outcome(extinct, []).Should().BeNull();

                    // The book scores each bet once, however often the history is re-sent.
                    var book = new EcoWagerBook();
                    book.Open(seed: 99);
                    book.Pick("extinct", 4);
                    book.Pick("alive10", 0);
                    var before = (book.Record.Points, book.Record.Right, book.Record.Settled);
                    book.Settle(thriving).Should().HaveCount(2);
                    book.Settle(thriving).Should().BeEmpty("a settled bet is not scored twice");
                    (book.Record.Points - before.Points).Should().Be(extinct.Points, "one right, one wrong");
                    (book.Record.Right - before.Right).Should().Be(1);
                    (book.Record.Settled - before.Settled).Should().Be(2);
                    break;
                }
            case "alerts":
                {
                    static EcoStats Stats(int wolves) => new(
                        Tick: 1, Speed: 1, Year: 1, Day: 1, DayFraction: 0.5, Alive: 60 + wolves, Huts: 3,
                        Counts: [40, 20, wolves, 0], Extinct: [false, false, false, false], LastStanding: -1, Silent: false,
                        Carcasses: 0, SimLag: 0, LlmEnabled: false, Llm: new EcoLlmCounters(0, 0, 0), PopHistory: [],
                        NaturalEvents: new EcoNaturalEvents(0, 0, 0));

                    var rule = new EcoAlertRule(Species: 2, Below: true, Value: 5);
                    rule.Describe().Should().Be("Wolves below 5");
                    rule.Holds(Stats(4)).Should().BeTrue();
                    rule.Holds(Stats(5)).Should().BeFalse();
                    new EcoAlertRule(-1, Below: false, Value: 64).Holds(Stats(5)).Should().BeTrue("65 creatures alive is above 64");

                    // An alert is an edge, not a level: once when it starts to hold, again only
                    // after it has stopped holding — and never for the state a world opens in.
                    var book = new EcoAlertBook();
                    foreach (var old in book.Rules.ToArray()) book.Remove(old);
                    book.Add(rule).Should().BeTrue();
                    book.Add(rule).Should().BeFalse("the same rule twice is one rule");
                    book.ResetWorld();
                    book.Observe(Stats(3)).Should().BeEmpty("what holds on a world's first message is not news");
                    book.Observe(Stats(8)).Should().BeEmpty();
                    book.Observe(Stats(4)).Should().ContainSingle();
                    book.Observe(Stats(2)).Should().BeEmpty("still holding");
                    book.Observe(Stats(9)).Should().BeEmpty();
                    book.Observe(Stats(1)).Should().ContainSingle("it re-armed when the wolves recovered");
                    break;
                }
        }
    }
}
