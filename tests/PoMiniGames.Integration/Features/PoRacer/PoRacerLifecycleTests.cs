using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using PoMiniGames.Features.PoRacer;
using PoMiniGames.Shared.Games;
using Xunit;

namespace PoMiniGames.Integration.Features.PoRacer;

public sealed class PoRacerLifecycleTests
{
    [Fact]
    public async Task ConcurrentJoins_KeepSoloRacesIsolated_AndReuseTheSameRace()
    {
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddSignalR();
        services.AddSingleton<PoRacerLobbyService>();
        services.AddSingleton<PoRacerRaceRegistry>();
        await using var provider = services.BuildServiceProvider();
        var registry = provider.GetRequiredService<PoRacerRaceRegistry>();
        var lobby = provider.GetRequiredService<PoRacerLobbyService>();
        lobby.Open("lobby-a", "Same name", false, "user-a");
        lobby.Open("lobby-b", "Same name", false, "user-b");
        var firstMatch = registry.StartMultiplayer();
        var nextMatch = registry.StartMultiplayer();
        firstMatch.GameCode.Should().NotBe(nextMatch.GameCode);
        firstMatch.BindPlayer("race-a", "user-a").Should().Be(0);
        firstMatch.BindPlayer("race-b", "user-b").Should().Be(1);
        var player = new PoRacerLobbyPlayer("lobby-a", "Same name", false, true, "user-a");
        var attempts = await Task.WhenAll(Enumerable.Range(0, 12).Select(_ => Task.Run(() => registry.Join("solo-a", true, player, "circuit"))));
        attempts.Should().OnlyContain(r => ReferenceEquals(r, attempts[0]));
        var other = registry.Join("solo-b", true, player with { UserId = "user-b" }, "neonskyline");
        other.Should().NotBeSameAs(attempts[0]);
        registry.GetByCode("solo-a").Should().BeSameAs(attempts[0]);
        other.GetStaticWorld().TrackId.Should().Be("neonskyline");
        registry.RegisterConnection("solo-a", "race-a");
        attempts[0].HasExpired(DateTimeOffset.UtcNow.AddMinutes(1)).Should().BeFalse();
        registry.RemoveConnection("race-a");
        attempts[0].HasExpired(DateTimeOffset.UtcNow.AddMinutes(1)).Should().BeTrue();
        registry.CodeFor("race-a").Should().BeNull();
    }

    [Fact]
    public async Task Reconnect_UsesStableIdentity_AndRevokesTheOldConnection()
    {
        await using var race = new PoRacerRaceService("solo-a",
            [new("lobby-a", "Same name", false, true, "user-a"), new("lobby-b", "Same name", true, true, "user-b")],
            NullLogger<PoRacerRaceService>.Instance);
        race.BindPlayer("race-a", "user-a").Should().Be(0);
        race.BindPlayer("race-b", "user-b").Should().Be(1);
        race.BindPlayer("intruder", "unknown").Should().BeNull();
        race.BindPlayer("reconnected-a", "user-a").Should().Be(0);
        race.RemoveConnection("race-a");
        race.SetInput("race-a", new() { Up = true });
        race.SetInput("intruder", new() { Up = true });
        // The same two seats in a shared ("multi-") race, where only user-a ever connects: the
        // stand-in bot drives the seat nobody holds, and never the one somebody does.
        await using var shared = new PoRacerRaceService("multi-a",
            [new("lobby-a", "Same name", false, true, "user-a"), new("lobby-b", "Same name", true, true, "user-b")],
            NullLogger<PoRacerRaceService>.Instance);
        shared.BindPlayer("race-a", "user-a").Should().Be(0);
        shared.Start();
        race.Start();
        await Task.Delay(3100); // The server holds every car during the starting countdown.
        await Task.Delay(120);
        race.Snapshot().Cars[0].Speed.Should().Be(0);
        shared.Snapshot().Cars[0].Speed.Should().Be(0, "a connected driver who is not pressing anything is left alone");
        shared.Snapshot().Cars[1].Speed.Should().BeGreaterThan(0, "a seat with no driver is taken by the stand-in bot");
        race.SetInput("reconnected-a", new() { Up = true });
        await Task.Delay(180);
        race.Snapshot().Cars[0].Speed.Should().BeGreaterThan(0);
        race.Snapshot().Cars[1].Speed.Should().Be(0);
        race.Result.Should().BeNull();
    }

    [Theory]
    [InlineData("circuit")]
    [InlineData("neonskyline")]
    [InlineData("desertdustway")]
    public void BestLapPayload_PreservesLegacyJson_AndCatalogMatchesGeometry(string trackId)
    {
        var dto = System.Text.Json.JsonSerializer.Deserialize<PoRacerScoreDto>("{\"totalTimeSeconds\":42.5}");
        dto!.BestLapSeconds.Should().Be(42.5);
        var json = System.Text.Json.JsonSerializer.Serialize(dto);
        json.Should().Contain("\"totalTimeSeconds\":42.5").And.NotContain("BestLapSeconds");
        var track = PoRacerTrackRegistry.GetTrack(trackId);
        track.DisplayName.Should().Be(PoRacerCatalog.GetTrack(trackId).Name);
        track.Description.Should().Be(PoRacerCatalog.GetTrack(trackId).Description);
    }
}
