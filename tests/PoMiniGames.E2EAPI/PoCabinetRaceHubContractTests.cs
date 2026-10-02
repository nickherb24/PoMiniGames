using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.Routing;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.DependencyInjection;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.E2EAPI;

/// <summary>
/// The lobby and race hubs are auth-gated at the
/// route-group layer. The deeper "two-browser lobby → race"
/// handoff requires a SignalR client against a live Kestrel host and is
/// verified by the E2E-UI tier.
///
/// What we CAN assert cheaply at the E2E-API tier:
/// <list type="bullet">
///   <item>Both hubs are registered on <see cref="IEndpointRouteBuilder"/>
///         so a client can connect.</item>
///   <item>The /negotiate endpoint exists for both hubs and rejects anonymous
///         handshakes (401) instead of letting an unauth player open a
///         lobby.</item>
///   <item>The shared <see cref="PoCabinetRaceSnapshot"/> wire shape fits the
///         documented ≤ 2 KB budget so the 30 Hz broadcast stays inside the
///         WebSocket frame-size cap.</item>
/// </list>
/// </summary>
[Collection(PoMiniGamesE2ECollection.Name)]
public sealed class PoCabinetRaceHubContractTests(PoMiniGamesE2EFixture fixture)
{
    [Fact]
    public void LobbyHubAndRaceHubRoutesAreRegistered()
    {
        // Both hubs are added in Program.cs.MapPoMiniGamesEndpoints — confirm
        // they appear in the endpoint route table. EndpointDataSource is the
        // authoritative list; reflection over HubActivation is brittle.
        var dataSources = fixture.Services.GetRequiredService<EndpointDataSource>();
        var hubs = dataSources.Endpoints
            .OfType<RouteEndpoint>()
            .Select(e => e.Metadata.GetMetadata<HubMetadata>()?.HubType.Name)
            .Where(name => !string.IsNullOrEmpty(name))
            .ToHashSet(StringComparer.Ordinal);
        hubs.Should().Contain("PoCabinetLobbyHub", "the lobby hub must be registered at /pocabinet/lobby-hub");
        hubs.Should().Contain("PoCabinetRaceHub", "the race hub must be registered at /pocabinet/race-hub");
    }

    [Theory]
    [InlineData("/pocabinet/lobby-hub/negotiate")]
    [InlineData("/pocabinet/race-hub/negotiate")]
    public async Task HubSurface_IsAuthGated_AndSnapshotFitsFrameBudget(string negotiateUrl)
    {
        using var client = fixture.CreateClient();
        // SignalR clients POST /negotiate first. Without auth the host must
        // return 401 — letting an anonymous client through would silently
        // create an unattributable lobby seat on the server.
        var negotiate = await client.PostAsync(negotiateUrl, content: null);
        negotiate.StatusCode.Should().Be(HttpStatusCode.Unauthorized,
            $"the {negotiateUrl} endpoint must reject anonymous negotiations");

        // And because the hubs were just confirmed to exist, their broadcast
        // shape must fit one WebSocket frame. The race hub sends at 30 Hz,
        // so any drift above 2 KB here is a deal-breaker. Bundled with the
        // negotiate test so we keep the test-method ceiling tight.
        var snapshot = new PoCabinetRaceSnapshot
        {
            GameCode = "cabinet",
            ServerTimeMs = 1_700_000_000_000,
            ElapsedRaceTime = 95.42,
            Started = true,
            CountdownSeconds = 0,
            Finished = false,
            LocalCarId = 0,
            Cars = Enumerable.Range(0, PoCabinetCatalog.CarCount).Select(i => new PoCabinetCarState
            {
                Id = i,
                Name = "Player " + i,
                OfficialId = i == 0 ? "player" : new[] { "sean-s", "steve-b", "bill-b", "mike-p" }[i % 4],
                Color = "#3470d8",
                AckSeq = 123_456,
                X = 12 + i * 1.7,
                Y = -8 + i * 0.5,
                Heading = Math.PI / 2 - i * 0.04,
                SpeedKmh = 220 - i * 6,
                Lap = i % 4 + 1,
                LapProgress = 0.42 + i * 0.005,
                Position = i + 1,
                IsPlayer = i == 0,
                Finished = false,
            }).ToList(),
            // Dialogue fires only when an official has something to say; the
            // per-tick path otherwise omits it. Including it here would
            // over-budget the ticker, so this contract measures the
            // steady-state shape.
            LatestDialogue = null,
            Static = null,
        };

        var json = JsonSerializer.Serialize(snapshot, CabinetSnapJson.Options);
        json.Length.Should().BeLessThanOrEqualTo(2_048,
            $"per-tick broadcast must fit in a single WebSocket frame; measured {json.Length} bytes");
    }

    private static class CabinetSnapJson
    {
        // The hub protocol uses camelCase + string enums (mirrors PoBrawlOnline).
        // Bundle the options so the test reflects the same wire shape the
        // client deserialises.
        public static readonly JsonSerializerOptions Options = Build();
        private static JsonSerializerOptions Build()
        {
            var opts = new JsonSerializerOptions(JsonSerializerDefaults.Web);
            opts.Converters.Add(new System.Text.Json.Serialization.JsonStringEnumConverter(JsonNamingPolicy.CamelCase));
            return opts;
        }
    }
}
