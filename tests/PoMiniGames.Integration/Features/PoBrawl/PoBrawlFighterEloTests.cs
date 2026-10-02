using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using PoMiniGames.Domain.Models;

namespace PoMiniGames.Integration;

/// <summary>
/// PoBrawl demo-mode fighter Elo round-trip against a real Azurite container: a recorded
/// CPU-vs-CPU result moves both fighters' ratings in opposite directions by the same amount,
/// a draw is zero-sum too, and the roster allowlist rejects unrateable submissions at the
/// HTTP boundary before they can mint a row. The board is read where the app reads it, the
/// unified <c>/api/leaderboards/pobrawldemo</c> route; <c>POST /api/pobrawl/elo</c> is write only.
/// </summary>
/// <remarks>
/// <para>
/// Every assertion here is <b>relative</b> — deltas between a before and after snapshot —
/// never an absolute rating. The roster is a fixed set of ids, so unlike the player boards
/// this test cannot isolate itself behind a unique row key: it shares the fifteen fighter
/// rows with every other run against the same Azurite volume. Asserting "FDR is 1012" would
/// pass exactly once and then fail forever.
/// </para>
/// <para>
/// This is one test method covering the whole contract on purpose. The Integration tier is
/// at its 50-method ceiling (see <see cref="IntegrationTestCountCeilingTests"/>), and the
/// rule is to consolidate rather than raise the cap.
/// </para>
/// </remarks>
public sealed class PoBrawlFighterEloTests : IClassFixture<TestWebApplicationFactory>
{
    private readonly TestWebApplicationFactory _factory;

    public PoBrawlFighterEloTests(TestWebApplicationFactory factory) => _factory = factory;

    // Two fighters that no other test touches. limit=15 is the whole roster, so the fighters
    // under test show up whether or not they are winning.
    private const string Winner = "fdr";
    private const string Loser = "truman";
    private const string DemoBoard = "/api/leaderboards/pobrawldemo?limit=15";

    private static async Task<GameLeaderboardDto> Board(HttpClient client) =>
        (await client.GetFromJsonAsync<GameLeaderboardDto>(DemoBoard))!;

    /// <summary>Rating by roster display name.</summary>
    private static async Task<int> EloOf(HttpClient client, string name) =>
        (await Board(client)).Entries.FirstOrDefault(e => e.Name == name) is { } row
            ? (int)row.Value
            // A fighter with no recorded match has no row yet; the seed rating is what the
            // server would price its first match against.
            : 1000;

    [Fact]
    public async Task RecordDemoResult_MovesBothRatings_AndRejectsUnrateableFighters()
    {
        if (!_factory.DockerAvailable) return;
        // The POSTs below are state-changing /api/* calls and are refused without
        // the synchroniser token. Armed up front so the validation assertions at the end
        // exercise a real 400 rather than collapsing into a blanket 403.
        var client = await _factory.CreateClient().ArmAntiforgeryAsync();

        // ── A decisive result moves both ratings, zero-sum ────────────────
        // Names, not ids: the board renders the roster display name, resolved server-side.
        var winnerBefore = await EloOf(client, "FDR");
        var loserBefore = await EloOf(client, "Truman");

        var post = await client.PostAsJsonAsync(
            "/api/pobrawl/elo", new { winnerFighterId = Winner, loserFighterId = Loser, isDraw = false });
        post.StatusCode.Should().Be(HttpStatusCode.NoContent);

        var winnerAfter = await EloOf(client, "FDR");
        var loserAfter = await EloOf(client, "Truman");

        var gain = winnerAfter - winnerBefore;
        var drop = loserBefore - loserAfter;

        gain.Should().BePositive("beating a comparable opponent must raise the winner's rating");
        gain.Should().Be(drop,
            "the delta is rounded once and applied as +d/-d, so the rating pool is conserved exactly");

        // ── A draw is zero-sum too ────────────────────────────────────────
        (await client.PostAsJsonAsync(
            "/api/pobrawl/elo", new { winnerFighterId = Winner, loserFighterId = Loser, isDraw = true }))
            .StatusCode.Should().Be(HttpStatusCode.NoContent);

        var winnerDrawn = await EloOf(client, "FDR");
        var loserDrawn = await EloOf(client, "Truman");

        (winnerDrawn - winnerAfter).Should().Be(-(loserDrawn - loserAfter),
            "a draw is zero-sum too — the now higher-rated fighter gives points back");

        // ── The roster allowlist is the row-creation gate ─────────────────
        // An unrateable id must never reach storage: the rating partition is bounded at the
        // roster size precisely because ids are validated here.
        (await client.PostAsJsonAsync(
            "/api/pobrawl/elo", new { winnerFighterId = "notapresident", loserFighterId = Loser, isDraw = false }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);

        // BOB is a real fighter in 1P/2P but never a demo combatant, so he is off the board.
        (await client.PostAsJsonAsync(
            "/api/pobrawl/elo", new { winnerFighterId = "bob", loserFighterId = Loser, isDraw = false }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);

        // A fighter cannot fight itself — one row, two conflicting increments.
        (await client.PostAsJsonAsync(
            "/api/pobrawl/elo", new { winnerFighterId = Winner, loserFighterId = Winner, isDraw = false }))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);

        var board = await Board(client);
        // A row for an off-roster id would render under the id itself (no roster name to resolve).
        board.Entries.Should().NotContain(e => e.Name == "notapresident" || string.Equals(e.Name, "bob", StringComparison.OrdinalIgnoreCase),
            "a rejected submission must not have created a row");
        board.Entries.Should().BeInDescendingOrder(e => e.Value, "the board ranks by rating");

        // ── The unified board's shape ─────────────────────────────────────
        // The /leaderboards page renders the top-3 Brawl Demo trophy case from this, with
        // the right gameKey/title/unit and rank ordered by Elo. The page filters the "XXX"
        // placeholder, but the BFF still emits it so the rank list always fills to the limit.
        var demoBoard = await client.GetFromJsonAsync<System.Text.Json.JsonElement>(
            "/api/leaderboards/pobrawldemo?limit=3");
        demoBoard.GetProperty("gameKey").GetString().Should().Be("pobrawldemo");
        demoBoard.GetProperty("title").GetString().Should().Be("Brawl Demo");
        demoBoard.GetProperty("unit").GetString().Should().Be("ELO");
        demoBoard.GetProperty("higherIsBetter").GetBoolean().Should().BeTrue();

        var demoEntries = demoBoard.GetProperty("entries").EnumerateArray().ToList();
        demoEntries.Should().HaveCount(3, because: "limit=3 caps the unified board at three rows");
        var demoElos = demoEntries.Select(e => e.GetProperty("value").GetDouble()).ToList();
        demoElos.Should().BeInDescendingOrder(because: "highest ELO ranks first");
        demoEntries.Take(2).Select(e => e.GetProperty("name").GetString())
            .Should().BeEquivalentTo(new[] { "FDR", "Truman" },
                because: "the two fighters under test are the only real rows on this pass");

        // Same board must also appear in the all-boards response, alongside the
        // per-player boards, with the same shape.
        var allBoards = await client.GetFromJsonAsync<List<System.Text.Json.JsonElement>>(
            "/api/leaderboards?limit=3");
        var demoBoards = allBoards!.Where(b => b.GetProperty("gameKey").GetString() == "pobrawldemo").ToList();
        demoBoards.Should().ContainSingle(
            because: "the demo board is exactly one of the unified leaderboards");
        demoBoards.Single().GetProperty("title").GetString().Should().Be("Brawl Demo");
    }
}
