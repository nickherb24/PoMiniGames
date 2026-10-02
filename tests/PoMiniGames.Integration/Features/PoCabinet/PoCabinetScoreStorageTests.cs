using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using PoMiniGames.Domain.Models;
using PoMiniGames.Features.Auth;
using PoMiniGames.Features.PoCabinet;
using PoMiniGames.TestUtilities;

namespace PoMiniGames.Integration.Features.PoCabinet;

/// <summary>
/// PoCabinet score round-trip against a real Azurite container through the full HTTP
/// path. Four claims:
/// <list type="number">
///   <item>Only verified laps are stored: a bare claim with no input log is refused (422),
///         and a proof's stored time is the server's replay, whatever the claim says.</item>
///   <item>A best lap submitted on <c>capitol</c> survives a fresh
///         <c>GET /api/pocabinet/scores?track=capitol</c> on the same host. Cross-Azurite
///         session round-trip — the row lives in the table the descriptor declared.</item>
///   <item>Track partitioning is real: the same player on Capitol and Mar-a-Lago
///         gets two distinct rows; a Capitol submission does not appear in the
///         Mar-a-Lago board.</item>
///   <item>ETag-update overwrite is ratcheting: a worse later lap does not erase a
///         better PB, and a faster lap does.</item>
/// </list>
/// <para>
/// <b>Test identity.</b> The test signs in as a fresh FakeAuth user per run, and the server
/// overwrites the wire-supplied <c>PlayerDisplayName</c> with the resolved
/// identity. The assertions match on that resolved name,
/// not the randomized wire name — the wire name is the issue PoRacer had to
/// fix for the same reason (see PoRacerScoreEndpoints.cs header comment).
/// </para>
/// One method, four claims. The Integration tier is at its 50 cap (per
/// <see cref="IntegrationTestCountCeilingTests"/>) and the rule is to consolidate
/// rather than raise.
/// </summary>
public sealed class PoCabinetScoreStorageTests : IClassFixture<TestWebApplicationFactory>
{
    private readonly TestWebApplicationFactory _factory;

    public PoCabinetScoreStorageTests(TestWebApplicationFactory factory) => _factory = factory;

    [Fact]
    public async Task SubmitAndReadRoundTrips_TrackPartitionsHold_AndOverwriteIsRatcheting()
    {
        if (!_factory.DockerAvailable) return;
        // The POSTs below are state-changing /api/* calls and are refused without
        // the synchroniser token. Arm up front so the ratcheting assertions at the end
        // exercise a real 200 rather than collapsing into a blanket 403.
        // A fresh identity per run: this tier writes to the developer's local Azurite, and a
        // PB left behind by an earlier run under a shared "test-user" would out-ratchet this
        // run's first lap. The token is bound to identity, so arm after switching.
        var resolvedPlayer = $"pocab-int-{Guid.NewGuid():N}"[..24];
        var raw = _factory.CreateClient();
        raw.DefaultRequestHeaders.Remove(FakeAuthHandler.UserHeader);
        raw.DefaultRequestHeaders.Add(FakeAuthHandler.UserHeader, resolvedPlayer);
        var client = await raw.ArmAntiforgeryAsync();

        // The server resolves identity from FakeAuth, never the wire player name; the wire
        // name differs on purpose so a match can only come from the resolved identity.
        var wirePlayer = $"pocabinet-int-{Guid.NewGuid():N}";
        // Laps are server-timed from their input logs (PoCabinetLapVerifier), so each submit
        // carries a real browser-recorded proof and the claim is only logged. The fixtures'
        // own times drive the assertions: clean ≈ 26.62 s, messy ≈ 24.79 s (faster), wild ≈
        // 29.28 s (slower), all on Capitol; maralago-clean ≈ 29.54 s. (The generator checks
        // that ordering before it writes the file.)
        PoCabinetScoreDto Submit(string proofName, int position)
        {
            var proof = PoCabinetLapProofs.Get(proofName);
            return new PoCabinetScoreDto
            {
                PlayerDisplayName = wirePlayer,
                TrackId = proof.TrackId,
                BestLapSeconds = proof.JsBestLap,
                FinalPosition = position,
                AchievedAtUtc = DateTimeOffset.UtcNow,
                IsGuest = true,
                GameCode = "SOLO",
                Inputs = proof.Inputs,
                Wet = proof.Wet,
            };
        }
        double Lap(string proofName) => Math.Round(PoCabinetLapProofs.Get(proofName).JsBestLap, 3);
        async Task<double> StoredAsync(string track) =>
            (await client.GetFromJsonAsync<List<PoCabinetHighScore>>($"/api/pocabinet/scores?track={track}"))!
                .First(s => s.PlayerName == resolvedPlayer).BestLapSeconds;

        // ── No proof: a bare claimed time is refused, not stored ─────────────
        var bare = Submit("capitol-clean", 1);
        bare.Inputs = null;
        bare.BestLapSeconds = 1.0;
        (await client.PostAsJsonAsync("/api/pocabinet/scores", bare)).StatusCode
            .Should().Be(HttpStatusCode.UnprocessableEntity, "a solo lap with no input log can't be verified");

        // ── Submit a Capitol best lap; the claim is a lie, the stored time is the replay's ─
        var lying = Submit("capitol-clean", 1);
        lying.BestLapSeconds = 5.0;
        var firstPost = await client.PostAsJsonAsync("/api/pocabinet/scores", lying);
        firstPost.StatusCode.Should().Be(HttpStatusCode.Created);
        (await StoredAsync("capitol")).Should().BeApproximately(Lap("capitol-clean"), 0.001,
            "the server stores the lap it re-timed, and resolves identity from auth, not the wire name");

        // ── Mar-a-Lago lap for the same player (no partition leak) ─────────
        (await client.PostAsJsonAsync("/api/pocabinet/scores", Submit("maralago-clean", 2))).StatusCode
            .Should().Be(HttpStatusCode.Created);
        (await StoredAsync("maralago")).Should().BeApproximately(Lap("maralago-clean"), 0.001);
        var marBoard = await client.GetFromJsonAsync<List<PoCabinetHighScore>>("/api/pocabinet/scores?track=maralago");
        var capitolLap = Lap("capitol-clean");
        marBoard!.Should().NotContain(s => Math.Abs(s.BestLapSeconds - capitolLap) < 0.001,
            "the Capitol lap must not appear on the Mar-a-Lago board");

        // ── A worse later Capitol lap must NOT overwrite the PB ────────────
        (await client.PostAsJsonAsync("/api/pocabinet/scores", Submit("capitol-wild", 4))).StatusCode
            .Should().Be(HttpStatusCode.Created);
        (await StoredAsync("capitol")).Should().BeApproximately(Lap("capitol-clean"), 0.001,
            "a worse lap must not erase a stored PB");

        // ── A faster Capitol lap overwrites the PB ─────────────────────────
        (await client.PostAsJsonAsync("/api/pocabinet/scores", Submit("capitol-messy", 1))).StatusCode
            .Should().Be(HttpStatusCode.Created);
        (await StoredAsync("capitol")).Should().BeApproximately(Lap("capitol-messy"), 0.001,
            "a faster lap must replace the stored PB");
    }
}
