using System.Net;
using System.Net.Http.Json;
using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using PoMiniGames.Infrastructure.Services;
using PoMiniGames.Shared.Games;
using Xunit;

namespace PoMiniGames.Integration.Features.PoRacer;

public sealed class PoRacerScoreTests(TestWebApplicationFactory factory) : IClassFixture<TestWebApplicationFactory>
{
    [Fact]
    public async Task BestLap_RetryIsIdempotent_AndInvalidTrackIsRejected()
    {
        factory.DockerAvailable.Should().BeTrue("this persistence test requires Azurite");
        using var client = await factory.CreateClient().ArmAntiforgeryAsync();
        // The body claims a 5 s lap for a race this server never ran: refused, nothing stored.
        var code = "solo-" + Guid.NewGuid().ToString("N");
        var score = new PoRacerScoreDto { PlayerDisplayName = "Forged", BestLapSeconds = 5, FinalPosition = 1, TrackId = "circuit", GameCode = code };
        (await client.PostAsJsonAsync("/api/poracer/scores", score)).StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        // Once the race is on record for this identity, the stored lap is the server's 42.125 s
        // in second place, whatever the body says, and a retry lands on the same row.
        var timed = 42.125 + Random.Shared.Next(1, 900) / 1000.0;
        factory.Services.GetRequiredService<PoMiniGames.Features.PoRacer.PoRacerRaceRegistry>()
            .Remember("test-user", code, new(TrackId: "circuit", BestLapSeconds: timed, Position: 2, FinishedAtUtc: DateTimeOffset.UtcNow));
        (await client.PostAsJsonAsync("/api/poracer/scores", score)).StatusCode.Should().Be(HttpStatusCode.Created);
        (await client.PostAsJsonAsync("/api/poracer/scores", score)).StatusCode.Should().Be(HttpStatusCode.Created);
        var storage = factory.Services.GetRequiredService<StorageService>();
        var rows = await storage.GetPoRacerHighScoresAsync(1000, "circuit");
        rows.Should().NotContain(r => r.TotalTimeSeconds == 5);
        var row = rows.Where(r => r.TotalTimeSeconds == timed).Should().ContainSingle().Subject;
        row.PlayerName.Should().NotBe("Forged");
        row.FinalPosition.Should().Be(2);
        score.TrackId = "removed-track";
        (await client.PostAsJsonAsync("/api/poracer/scores", score)).StatusCode.Should().Be(HttpStatusCode.BadRequest);
        score.TrackId = "circuit";
        score.BestLapSeconds = 0;
        (await client.PostAsJsonAsync("/api/poracer/scores", score)).StatusCode.Should().Be(HttpStatusCode.BadRequest);
    }
}
