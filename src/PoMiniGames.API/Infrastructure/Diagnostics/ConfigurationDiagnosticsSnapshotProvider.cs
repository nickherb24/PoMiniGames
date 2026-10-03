using Microsoft.Extensions.Diagnostics.HealthChecks;
using PoMiniGames.Domain.Abstractions;
using PoMiniGames.Shared.Diagnostics;
using PoMiniGames.Shared.Identity;

namespace PoMiniGames.Infrastructure;

public sealed class ConfigurationDiagnosticsSnapshotProvider
{
    private readonly IConfiguration _configuration;
    private readonly IHostEnvironment _environment;
    private readonly HealthCheckService _healthCheckService;

    public ConfigurationDiagnosticsSnapshotProvider(
        IConfiguration configuration,
        IHostEnvironment environment,
        HealthCheckService healthCheckService)
    {
        _configuration = configuration;
        _environment = environment;
        _healthCheckService = healthCheckService;
    }

    public async Task<Dictionary<string, object?>> BuildSnapshotAsync(CancellationToken cancellationToken = default)
    {
        var report = await _healthCheckService.CheckHealthAsync(cancellationToken);

        return new Dictionary<string, object?>
        {
            ["identity"] = new
            {
                solution = PoMiniGamesIdentity.SolutionName,
                appPrefix = PoMiniGamesIdentity.AppPrefix,
                ports = new { http = PoMiniGamesIdentity.HttpPort, https = PoMiniGamesIdentity.HttpsPort }
            },
            ["environment"] = new
            {
                name = _environment.EnvironmentName,
                application = _environment.ApplicationName,
                urls = SecretMasker.MaskMiddle(_configuration["ASPNETCORE_URLS"] ?? _configuration["URLS"]),
            },
            ["storage"] = new
            {
                provider = "AzureTableStorage",
                tableServiceConnection = SecretMasker.MaskMiddle(_configuration["PoMiniGames:Storage:TableService:ConnectionString"]),
                tableServiceEndpoint = SecretMasker.MaskMiddle(_configuration["PoMiniGames:Storage:TableService:Endpoint"]),
                tableServiceAccount = SecretMasker.MaskMiddle(_configuration["PoMiniGames:Storage:TableService:AccountName"]),
                tableServiceTable = _configuration["PoMiniGames:Storage:TableService:TableName"] ?? "(null)",
            },
            ["logging"] = new
            {
                defaultLevel = _configuration["Serilog:MinimumLevel:Default"]
                    ?? _configuration["Logging:LogLevel:Default"]
                    ?? "(null)",
                devLogFile = _environment.IsDevelopment() ? "logs/pominigames-.log" : "(disabled)",
            },
            ["featureFlags"] = new
            {
                enableDiagnostics = _configuration.GetValue("FeatureFlags:EnableDiagnostics", _environment.IsDevelopment()),
            },
            ["integrations"] = new
            {
                keyVaultConfigured = HasConfiguredValue("PoMiniGames:KeyVault:Uri", "KeyVault:Uri"),
                applicationInsightsConfigured = HasConfiguredValue(
                    "PoMiniGames:ApplicationInsights:ConnectionString",
                    "APPLICATIONINSIGHTS_CONNECTION_STRING",
                    "APPINSIGHTS_CONNECTIONSTRING"),
                microsoftAuthConfigured = HasConfiguredValue(
                    "PoMiniGames:MicrosoftAuth:ClientId",
                    "PoMiniGames:MicrosoftAuth:ApiClientId"),
                aiFoundryConfigured = HasConfiguredValue("PoMiniGames:AI:FoundryEndpoint", "PoMiniGames:AI:Endpoint"),
            },
            ["keys"] = new
            {
                keyVaultUri = SecretMasker.MaskMiddle(_configuration["PoMiniGames:KeyVault:Uri"] ?? _configuration["KeyVault:Uri"]),
                applicationInsights = SecretMasker.MaskMiddle(
                    _configuration["PoMiniGames:ApplicationInsights:ConnectionString"]
                    ?? _configuration["APPLICATIONINSIGHTS_CONNECTION_STRING"]
                    ?? _configuration["APPINSIGHTS_CONNECTIONSTRING"]),
                microsoftClientId = SecretMasker.MaskMiddle(_configuration["PoMiniGames:MicrosoftAuth:ClientId"]),
                microsoftApiClientId = SecretMasker.MaskMiddle(_configuration["PoMiniGames:MicrosoftAuth:ApiClientId"]),
                aiFoundryEndpoint = SecretMasker.MaskMiddle(_configuration["PoMiniGames:AI:FoundryEndpoint"] ?? _configuration["PoMiniGames:AI:Endpoint"]),
                aiDefaultDeployment = _configuration["PoMiniGames:AI:DefaultDeployment"] ?? "(null)",
            },
            ["health"] = new
            {
                status = report.Status.ToString(),
                checks = report.Entries.Select(entry => new
                {
                    name = entry.Key,
                    status = entry.Value.Status.ToString(),
                    description = entry.Value.Description,
                    duration = entry.Value.Duration.TotalMilliseconds,
                }).ToArray(),
                totalDuration = report.TotalDuration.TotalMilliseconds,
                checkedAtUtc = DateTimeOffset.UtcNow,
            },
        };
    }

    private bool HasConfiguredValue(params string[] keys)
    {
        foreach (var key in keys)
        {
            if (!string.IsNullOrWhiteSpace(_configuration[key]))
            {
                return true;
            }
        }

        return false;
    }
}
