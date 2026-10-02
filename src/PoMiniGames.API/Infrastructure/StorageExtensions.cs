using Azure.Data.Tables;
using Azure.Identity;
using Azure.Storage.Blobs;
using PoMiniGames.Domain.Abstractions;
using PoMiniGames.Infrastructure.HealthChecks;
using PoMiniGames.Infrastructure.Services;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Diagnostics.HealthChecks;

namespace PoMiniGames.Infrastructure;

/// <summary>
/// Registers Azure Storage services and the associated health checks.
/// </summary>
/// <remarks>
/// <para>
/// The host has two consumers of Azure SDK clients:
/// </para>
/// <list type="bullet">
///   <item><see cref="StorageService"/> — constructor-injects <c>IConfiguration</c> and
///         builds its own <see cref="TableServiceClient"/>. This is the historical path.</item>
///   <item>The per-game repositories (<c>TeamsRepository</c>,
///         <c>BlobImageRepository</c>, etc.) — constructor-inject
///         <see cref="TableServiceClient"/> or <see cref="BlobServiceClient"/>
///         directly. This is the consolidation-era path.</item>
/// </list>
/// <para>
/// Both code paths must agree on the same connection target — Azurite in dev /
/// test, a real account via connection string in prod, a real account via
/// managed identity in prod (no shared key). This extension centralises the
/// resolution so a config change in one place propagates to every consumer.
/// </para>
/// <para>
/// Pattern: Factory + Singleton. The factory function is called once per
/// client type; the resulting instance is shared across every DI consumer in
/// the app. Changing the backing store is a one-line edit in
/// <see cref="ResolveTableServiceClient"/> / <see cref="ResolveBlobServiceClient"/>.
/// </para>
/// </remarks>
internal static class StorageExtensions
{
    /// <summary>
    /// Connection-string key used by Azurite (and any other "use the local
    /// emulator" instruction in dev). Mirrors the Azure SDK's own sentinel
    /// value so a developer can paste it directly into the configuration.
    /// </summary>
    public const string AzuriteDevConnectionString = "UseDevelopmentStorage=true";

    public static IServiceCollection AddPoMiniGamesStorage(this IServiceCollection services, IConfiguration configuration)
    {
        var section = configuration.GetSection("PoMiniGames:Storage:TableService");
        var connectionString = section["ConnectionString"];
        var endpoint = section["Endpoint"];
        var accountName = section["AccountName"];

        // Per-game repositories inject these clients directly; the central
        // resolver keeps the prod-vs-dev branching logic in one place.
        services.AddSingleton(sp => ResolveTableServiceClient(
            connectionString, endpoint, accountName, sp.GetService<IHostEnvironment>()));
        services.AddSingleton(_ => ResolveBlobServiceClient(connectionString, endpoint, accountName));

        // Every dependency (IConfiguration, EloCalculator, PairwiseEloCalculator, ILogger)
        // resolves from the container, so this is a plain registration.
        services.AddSingleton<StorageService>();
        services.AddSingleton<IStorageService>(sp => sp.GetRequiredService<StorageService>());

        services.AddHealthChecks()
            .AddCheck<StorageHealthCheck>(
                "Storage",
                // Degraded, not Unhealthy: storage failure means leaderboards/scores are
                // skipped, but the rest of the app keeps serving requests. Reporting
                // Unhealthy would 503 /api/health and trip monitors whenever Azurite is
                // unreachable in dev — a condition the app explicitly tolerates.
                failureStatus: HealthStatus.Degraded,
                tags: new[] { "critical" })
            .AddCheck<AzureTableStorageHealthCheck>(
                "AzureTableStorage",
                failureStatus: HealthStatus.Degraded,
                tags: new[] { "optional" });

        return services;
    }

    private static TableServiceClient ResolveTableServiceClient(
        string? connectionString,
        string? endpoint,
        string? accountName,
        IHostEnvironment? environment)
    {
        // Pin a fast, predictable network timeout on every client. The Azure SDK's default
        // retry chain (Exponential, 4+ retries, network timeout per attempt) drags the total
        // time-to-failure for an unreachable backend to well over 30 seconds — long enough
        // that startup blocks on a single failed `CreateIfNotExistsAsync`. With NetworkTimeout
        // set to 2s and MaxRetries to 0, an unreachable Azurite fails in well under 2s and
        // the graceful-degradation path takes over immediately. Production deploys hit a real
        // account; a 2s network timeout is generous for a healthy endpoint and still bounds
        // the worst-case wait on a flapping backend.
        var options = new TableClientOptions
        {
            Retry = { MaxRetries = 0, NetworkTimeout = TimeSpan.FromSeconds(2) },
        };

        if (!string.IsNullOrWhiteSpace(connectionString))
        {
            return new TableServiceClient(connectionString, options);
        }

        if (!string.IsNullOrWhiteSpace(endpoint) || !string.IsNullOrWhiteSpace(accountName))
        {
            var serviceUri = !string.IsNullOrWhiteSpace(endpoint)
                ? new Uri(endpoint!)
                : new Uri($"https://{accountName}.table.core.windows.net");
            return new TableServiceClient(serviceUri, new DefaultAzureCredential(), options);
        }

        // In production, silently falling through to the emulator turns a missing
        // deployment setting into per-request 500s against a loopback address that isn't
        // there. Say what is missing instead — every azd deploy sets these (infra/resources.bicep).
        if (environment?.IsProduction() == true)
        {
            throw new InvalidOperationException(
                "No table storage configured. Set PoMiniGames:Storage:TableService "
                + "ConnectionString, Endpoint, or AccountName (infra/resources.bicep injects "
                + "Endpoint/AccountName for the managed-identity path).");
        }

        // Default to the Azurite emulator (docker-compose.yml) so local dev
        // works out of the box. UseDevelopmentStorage=true resolves to the
        // well-known dev account on 127.0.0.1; using "localhost" can hit a
        // stalled IPv6 stack.
        return new TableServiceClient(AzuriteDevConnectionString, options);
    }

    private static BlobServiceClient ResolveBlobServiceClient(
        string? connectionString,
        string? endpoint,
        string? accountName)
    {
        // When a real connection string is supplied, the same string works for
        // both Table and Blob services — Azurite shares them.
        if (!string.IsNullOrWhiteSpace(connectionString))
        {
            return new BlobServiceClient(connectionString);
        }

        if (!string.IsNullOrWhiteSpace(accountName))
        {
            var blobUri = new Uri($"https://{accountName}.blob.core.windows.net");
            return new BlobServiceClient(blobUri, new DefaultAzureCredential());
        }

        // Azurite: the well-known dev account on the same loopback host.
        return new BlobServiceClient(AzuriteDevConnectionString);
    }
}
