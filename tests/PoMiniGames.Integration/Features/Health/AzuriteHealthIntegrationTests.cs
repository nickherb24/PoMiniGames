using System.Net;
using System.Text.Json.Nodes;
using Testcontainers.Azurite;
using FluentAssertions;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;

namespace PoMiniGames.Integration;

/// <summary>
/// Verifies the API can check Azure Table Storage health against a real Azurite container.
/// </summary>
public sealed class AzuriteHealthIntegrationTests : IAsyncLifetime
{
    private AzuriteContainer? _azurite;

    private bool _dockerAvailable = true;

    public async Task InitializeAsync()
    {
        try
        {
            _azurite = new AzuriteBuilder("mcr.microsoft.com/azure-storage/azurite:3.33.0")
                .Build();

            await _azurite.StartAsync();
        }
        catch (Exception)
        {
            _dockerAvailable = false;
        }
    }

    public Task DisposeAsync() => _azurite is null ? Task.CompletedTask : _azurite.DisposeAsync().AsTask();

    [Fact]
    public async Task RootHealthEndpoint_ReturnsHealthy_WhenAzuriteTableIsConfigured()
    {
        if (!_dockerAvailable)
        {
            return;
        }

        var connectionString = _azurite!.GetConnectionString();

        using var baseFactory = new TestWebApplicationFactory();
        using var factory = baseFactory.WithWebHostBuilder(builder =>
        {
            // Tests run under the "Test" environment.
            builder.UseEnvironment("Test");
            builder.ConfigureAppConfiguration((_, cfg) =>
            {
                cfg.AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["PoMiniGames:Storage:TableService:ConnectionString"] = connectionString,
                    ["PoMiniGames:Storage:TableService:TableName"] = "pominigames",
                });
            });
        });

        using var client = factory.CreateClient();
        var response = await client.GetAsync("/health");

        response.StatusCode.Should().Be(HttpStatusCode.OK);

        var json = JsonNode.Parse(await response.Content.ReadAsStringAsync());
        json.Should().NotBeNull();

        var checks = json!["checks"]!.AsArray();
        var tableCheck = checks
            .Select(node => new
            {
                Name = node?["name"]?.GetValue<string>(),
                Status = node?["status"]?.GetValue<string>(),
            })
            .FirstOrDefault(node => string.Equals(node.Name, "AzureTableStorage", StringComparison.Ordinal));

        tableCheck.Should().NotBeNull();
        tableCheck!.Status.Should().Be("Healthy");
    }
}
