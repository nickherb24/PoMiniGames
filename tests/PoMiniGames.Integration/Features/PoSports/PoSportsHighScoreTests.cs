using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using PoMiniGames.Domain.Models;
using PoMiniGames.Features.PoSports;
using PoMiniGames.TestUtilities;

namespace PoMiniGames.Integration;

/// <summary>
/// PoSports score round-trip against a real Azurite container (via
/// <see cref="TestWebApplicationFactory"/>): save → get returns it, the per-player
/// ratchet rejects slower meets and accepts faster ones, the stored time is the
/// server's replay of the key log rather than the posted claim, and validation
/// rejects malformed submissions at the HTTP boundary.
/// </summary>
public sealed class PoSportsHighScoreTests : IClassFixture<TestWebApplicationFactory>
{
    private readonly TestWebApplicationFactory _factory;

    public PoSportsHighScoreTests(TestWebApplicationFactory factory) => _factory = factory;

    /// <summary>What the server will time a <see cref="PoSportsRunProofs.Steady"/> log at, to the stored precision.</summary>
    private static double ReplayedTotal(int ticksPerKey)
    {
        var run = PoSportsRunVerifier.Replay(PoSportsRunProofs.Steady(ticksPerKey))!;
        return Math.Round(run.TotalSeconds, 2);
    }

    /// <summary>An honest submit: a steady key log plus the times it really produces.</summary>
    private static PoSportsHighScore Meet(string player, int ticksPerKey, string character = "kim")
    {
        var inputs = PoSportsRunProofs.Steady(ticksPerKey);
        var run = PoSportsRunVerifier.Replay(inputs)!;
        return new()
        {
            PlayerName = player,
            SprintSeconds = run.SprintSeconds,
            HurdlesSeconds = run.HurdlesSeconds,
            TotalTimeSeconds = run.TotalSeconds,
            Character = character,
            Date = "2026-07-21T12:00:00Z",
            Inputs = inputs,
        };
    }

    [Fact]
    public async Task SaveGetAndRatchet_RoundTrip()
    {
        if (!_factory.DockerAvailable) return;
        // Every POST below is a state-changing /api/* call and is refused
        // without the synchroniser token.
        var client = await _factory.CreateClient().ArmAntiforgeryAsync();

        // Save → get returns the row.
        var post = await client.PostAsJsonAsync("/api/posports/highscores", Meet("Ratchet Runner", 6));
        post.StatusCode.Should().Be(HttpStatusCode.Created);

        var board = await client.GetFromJsonAsync<List<PoSportsHighScore>>("/api/posports/highscores");
        var row = board!.Single(s => s.PlayerName == "Ratchet Runner");
        row.TotalTimeSeconds.Should().BeApproximately(ReplayedTotal(6), 0.001);
        row.Inputs.Should().BeNull("the key log is a request-only proof, never a stored column");

        // A slower meet must NOT overwrite the PB…
        (await client.PostAsJsonAsync("/api/posports/highscores", Meet("Ratchet Runner", 9)))
            .StatusCode.Should().Be(HttpStatusCode.Created);
        board = await client.GetFromJsonAsync<List<PoSportsHighScore>>("/api/posports/highscores");
        board!.Single(s => s.PlayerName == "Ratchet Runner").TotalTimeSeconds.Should().BeApproximately(ReplayedTotal(6), 0.001);

        // …nor may a claim the keys do not back: the same slow log, posted as a 5-second
        // meet. The server stores what the log replays to, which is still slower than the PB.
        var forged = Meet("Ratchet Runner", 9);
        forged.SprintSeconds = 2;
        forged.HurdlesSeconds = 3;
        forged.TotalTimeSeconds = 5;
        (await client.PostAsJsonAsync("/api/posports/highscores", forged))
            .StatusCode.Should().Be(HttpStatusCode.Created);
        board = await client.GetFromJsonAsync<List<PoSportsHighScore>>("/api/posports/highscores");
        board!.Single(s => s.PlayerName == "Ratchet Runner").TotalTimeSeconds.Should().BeApproximately(ReplayedTotal(6), 0.001);

        // A faster one must.
        (await client.PostAsJsonAsync("/api/posports/highscores", Meet("Ratchet Runner", 3)))
            .StatusCode.Should().Be(HttpStatusCode.Created);
        board = await client.GetFromJsonAsync<List<PoSportsHighScore>>("/api/posports/highscores");
        var rows = board!.Where(s => s.PlayerName == "Ratchet Runner").ToList();
        rows.Should().HaveCount(1, "the descriptor keys one row per player");
        rows[0].TotalTimeSeconds.Should().BeApproximately(ReplayedTotal(3), 0.001);
    }

    [Fact]
    public async Task Post_RejectsMalformedSubmissions()
    {
        if (!_factory.DockerAvailable) return;
        // Armed so these assertions still exercise the *validation* rejection (400) rather than
        // collapsing into a blanket antiforgery 403 that would pass for the wrong reason.
        var client = await _factory.CreateClient().ArmAntiforgeryAsync();

        // Legs that don't sum to the total.
        var mismatched = Meet("Cheater", 6);
        mismatched.TotalTimeSeconds = 25;
        (await client.PostAsJsonAsync("/api/posports/highscores", mismatched))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);

        // Unknown character.
        (await client.PostAsJsonAsync("/api/posports/highscores", Meet("Modder", 6, character: "gizmo")))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);

        // Name too long.
        (await client.PostAsJsonAsync("/api/posports/highscores", Meet(new string('x', 40), 6)))
            .StatusCode.Should().Be(HttpStatusCode.BadRequest);

        // Well-formed times with no key log behind them: nothing to verify, nothing stored.
        var unproven = Meet("No Proof", 6);
        unproven.Inputs = null;
        (await client.PostAsJsonAsync("/api/posports/highscores", unproven))
            .StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
    }
}
