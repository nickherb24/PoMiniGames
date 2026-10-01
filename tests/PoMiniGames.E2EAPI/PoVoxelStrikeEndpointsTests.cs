using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using PoMiniGames.TestUtilities;

namespace PoMiniGames.E2EAPI;

/// <summary>
/// BFF contract for the PoVoxelStrike slice at the anonymous surface this tier covers
/// (authed ratchet semantics follow the Marble/PoSports descriptor pattern; the descriptor
/// itself is structurally guarded by the Unit tier's reflective HighScoreDescriptorTests):
/// the asset routes are anonymous and content-addressed, the run routes are auth-gated,
/// and the unified leaderboard exposes the Voxel Strike board anonymously.
/// </summary>
[Collection(PoMiniGamesE2ECollection.Name)]
public class PoVoxelStrikeEndpointsTests
{
    private readonly PoMiniGamesE2EFixture _factory;

    public PoVoxelStrikeEndpointsTests(PoMiniGamesE2EFixture factory) => _factory = factory;

    [Fact]
    public async Task AssetRoutes_ServeTheManifestAnonymously_AndPinTheHashShape()
    {
        using var client = _factory.CreateClient();

        // Manifest: anonymous 200 with a JSON array (startup ingestion may still be
        // converting, so the array being populated is not part of the contract here).
        var manifest = await client.GetAsync("/api/povoxelstrike/assets");
        manifest.StatusCode.Should().Be(HttpStatusCode.OK);
        using var doc = JsonDocument.Parse(await manifest.Content.ReadAsStringAsync());
        doc.RootElement.ValueKind.Should().Be(JsonValueKind.Array);

        // The hash is the only client-supplied path component that nears the filesystem:
        // anything that is not 64 lowercase hex must be rejected before the handler (400),
        // and a well-formed but unknown hash is a 404 — never a traversal, never a 500.
        (await client.GetAsync("/api/povoxelstrike/assets/not-a-hash"))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await client.GetAsync($"/api/povoxelstrike/assets/{new string('a', 64)}"))
            .StatusCode.Should().Be(HttpStatusCode.NotFound);

        // When ingestion has produced assets (the repo drop folder ships samples), the
        // payload must be the immutable content-addressed binary: PVX1 magic + a
        // cache-forever header, so the client Cache API layer never revalidates.
        var entries = doc.RootElement.EnumerateArray().ToList();
        if (entries.Count > 0)
        {
            var url = entries[0].GetProperty("url").GetString();
            var payload = await client.GetAsync("/" + url);
            payload.StatusCode.Should().Be(HttpStatusCode.OK);
            payload.Headers.CacheControl!.ToString().Should().Contain("immutable");
            var bytes = await payload.Content.ReadAsByteArrayAsync();
            bytes.Take(4).Should().Equal("PVX1"u8.ToArray());

            // Voxel painter (#9) — every manifest entry carries a materials array. The
            // shape is additive and backwards-compatible: assets without a sidecar ship
            // a one-element table with the default "concrete" constants. Entries with a
            // sidecar expose the author's names + per-material physics overrides.
            var first = entries[0];
            first.TryGetProperty("materials", out var materials).Should().BeTrue(
                "every manifest entry must include a materials[] (default or override)");
            materials.ValueKind.Should().Be(JsonValueKind.Array);
            var firstMaterial = materials.EnumerateArray().First();
            firstMaterial.GetProperty("materialId").GetInt32().Should().BeGreaterThan(0);
            firstMaterial.GetProperty("displayName").GetString().Should().NotBeNullOrEmpty();
            firstMaterial.GetProperty("density").GetDouble().Should().BeGreaterThan(0);
            firstMaterial.GetProperty("compressiveStrength").GetDouble().Should().BeGreaterThan(0);
            firstMaterial.GetProperty("tensileStrength").GetDouble().Should().BeGreaterThan(0);
        }
    }

    [Fact]
    public async Task RunRoutes_AreAuthGated_AndPriceAWinByItsFlag()
    {
        using var client = _factory.CreateClient();

        // Score READ and WRITE both sit inside the authenticated game API group —
        // anonymous requests must bounce, never 404 (the route exists) and never 200.
        var get = await client.GetAsync("/api/povoxelstrike/highscores");
        get.StatusCode.Should().BeOneOf(HttpStatusCode.Unauthorized, HttpStatusCode.Redirect, HttpStatusCode.Found);

        var post = await client.PostAsJsonAsync("/api/povoxelstrike/highscores", new
        {
            score = 100,
            survivalSeconds = 12.5,
            kills = 2,
            bruteKills = 0,
            crushKills = 1,
            voxelsDestroyed = 500,
        });
        post.StatusCode.Should().BeOneOf(HttpStatusCode.Unauthorized, HttpStatusCode.Redirect, HttpStatusCode.Found);

        // Signed in. A siege won at 60 s scores 600 on the clock plus the chalice bonus
        // (25,000 − 40/s = 22,600). The plausibility ceiling had no term for that bonus, so
        // with the roaming enemies off (no kills, no slack) every win was a 400 and never
        // reached the board. The Won flag is what prices it — and only the flag: the same
        // score without it is still implausible. (Same method as the auth gate above rather
        // than its own, because this tier is one fact from its ceiling.)
        var login = await client.GetAsync($"/auth/login/fake?displayName=Siege{Guid.NewGuid().ToString("N")[..8]}");
        login.IsSuccessStatusCode.Should().BeTrue("guest login must succeed under the Test environment");
        await client.ArmAntiforgeryAsync();

        object Run(bool won) => new
        {
            score = 23_200,
            survivalSeconds = 60.0,
            kills = 0,
            bruteKills = 0,
            crushKills = 0,
            voxelsDestroyed = 0,
            won,
            day = "not-a-date", // a bad Daily Siege date is ignored, never a reason to refuse the run
        };

        var win = await client.PostAsJsonAsync("/api/povoxelstrike/highscores", Run(won: true));
        win.StatusCode.Should().Be(HttpStatusCode.Created, await win.Content.ReadAsStringAsync());
        using var saved = JsonDocument.Parse(await win.Content.ReadAsStringAsync());
        saved.RootElement.GetProperty("won").GetBoolean().Should().BeTrue();

        var unflagged = await client.PostAsJsonAsync("/api/povoxelstrike/highscores", Run(won: false));
        unflagged.StatusCode.Should().Be(HttpStatusCode.BadRequest);
        (await unflagged.Content.ReadAsStringAsync()).Should().Contain("not plausible");

        (await client.GetAsync("/api/povoxelstrike/highscores?day=2026-13-45"))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest, "a Daily Siege board is addressed by a real date");
    }

    [Fact]
    public async Task UnifiedLeaderboard_ServesTheVoxelStrikeBoard_Anonymously()
    {
        using var client = _factory.CreateClient();

        var response = await client.GetAsync("/api/leaderboards/povoxelstrike");

        response.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await response.Content.ReadAsStringAsync();
        body.Should().Contain("povoxelstrike").And.Contain("Voxel Strike",
            because: "the Voxel Strike board must be part of the unified leaderboard read-model");
    }
}
