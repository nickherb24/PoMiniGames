using Azure.Data.Tables;
using Azure.Storage.Blobs;
using Azure.Identity;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace PoMiniGames.Infrastructure;

/// <summary>
/// Eager, idempotent initialization of the Azure Storage tables and blob containers used by
/// the games consolidated into PoMiniGames. Runs at host startup alongside
/// <see cref="PoMiniGames.Infrastructure.Services.StorageService.Initialize"/>.
/// </summary>
/// <remarks>
/// Pattern: Lazy Singleton (table-only here) + Idempotent Bootstrap. A missing table is the
/// single most common reason for a 500 in a freshly provisioned environment; we ensure
/// everything in one place rather than scattering <c>CreateIfNotExistsAsync</c> calls.
/// Best-effort: a failure logs a warning and lets the app continue. Real failures surface
/// at first use via the existing <c>Table(...)</c> lazy path in
/// <see cref="PoMiniGames.Infrastructure.Services.StorageService"/>.
/// </remarks>
public sealed class StorageInitializer
{
    /// <summary>Tables used by the consolidated games.</summary>
    public static readonly string[] AdditionalTables =
    [
        "PoFunQuizPlayers",
        // PoJoker (demo-only): per-session joke-performance records that back the
        // /api/joker/leaderboard surface (PartitionKey = SessionId).
        "PoJokerPerformances",
        // Per-identity daily AI token spend (PartitionKey = yyyy-MM-dd, RowKey = identity hash).
        // Ensured eagerly because the budget check runs on the first model call of a cold host,
        // and a lazy create there would put a table-creation round trip inside a player's turn.
        // Name must match TableAiTokenLedgerStore.TableName.
        "AiTokenLedger",
        // HybridCache L2. Ensured for the same reason: the first cache read of a cold host is on
        // a request path. Name must match TableDistributedCache.TableName.
        "PoMiniGamesCache",
        // PoEcosystem cloud slots + the public gallery index. Name must match
        // EcosystemWorldStore.TableName.
        "PoEcosystemWorlds",
        // PoJevArena's daily Jev call cap (same shape as AiTokenLedger). Name must match
        // JevCallAllowance.TableName.
        "PoJevArenaCallLedger",
        // PoJevArena public creature library (one partition). Name must match
        // CreatureLibraryStore.TableName.
        "PoJevArenaCreatures",
        // Server-timed race results kept past a recycle. Name must match
        // VerifiedResultStore.TableName.
        "VerifiedResults",
        // Push subscriptions, pending game invites and the VAPID key pair. Name must match
        // InviteStore.TableName.
        "PushInvites",
    ];

    /// <summary>Blob containers used by the consolidated games.</summary>
    public static readonly string[] AdditionalBlobContainers =
    [
        // PoEcosystem world snapshots (gzip'd JSON, one blob per slot). Name must match
        // EcosystemWorldStore.ContainerName.
        "poecosystem-worlds",
    ];

    private readonly TableServiceClient _tableServiceClient;
    private readonly BlobServiceClient? _blobServiceClient;
    private readonly ILogger<StorageInitializer> _logger;

    public StorageInitializer(IConfiguration configuration, ILogger<StorageInitializer> logger)
    {
        _logger = logger;

        var section = configuration.GetSection("PoMiniGames:Storage:TableService");
        var connectionString = section["ConnectionString"];
        var endpoint = section["Endpoint"];
        var accountName = section["AccountName"];

        // Same fast-fail options as StorageExtensions.ResolveTableServiceClient. Without them,
        // a single unreachable backend in this initializer would tie up the host's startup
        // for the SDK's default retry chain (Exponential, 4+ retries, ~30s+ per attempt).
        var tableOptions = new TableClientOptions
        {
            Retry = { MaxRetries = 0, NetworkTimeout = TimeSpan.FromSeconds(2) },
        };

        if (!string.IsNullOrWhiteSpace(connectionString))
        {
            _tableServiceClient = new TableServiceClient(connectionString, tableOptions);
        }
        else if (!string.IsNullOrWhiteSpace(endpoint) || !string.IsNullOrWhiteSpace(accountName))
        {
            var serviceUri = !string.IsNullOrWhiteSpace(endpoint)
                ? new Uri(endpoint!)
                : new Uri($"https://{accountName}.table.core.windows.net");
            _tableServiceClient = new TableServiceClient(serviceUri, new DefaultAzureCredential(), tableOptions);
        }
        else
        {
            _tableServiceClient = new TableServiceClient("UseDevelopmentStorage=true", tableOptions);
        }

        // Blob service: same credential path; falls back to the dev emulator. Lazy-initialized
        // so a missing blob endpoint is non-fatal (PoCoupleQuiz / PoFunQuiz don't need it).
        // Same fast-fail options as the table client for the same reason.
        var blobOptions = new BlobClientOptions
        {
            Retry = { MaxRetries = 0, NetworkTimeout = TimeSpan.FromSeconds(2) },
        };
        var blobConnectionString = section["BlobConnectionString"];
        var blobEndpoint = section["BlobEndpoint"];
        if (!string.IsNullOrWhiteSpace(blobConnectionString))
        {
            _blobServiceClient = new BlobServiceClient(blobConnectionString, blobOptions);
        }
        else if (!string.IsNullOrWhiteSpace(blobEndpoint))
        {
            _blobServiceClient = new BlobServiceClient(new Uri(blobEndpoint), new DefaultAzureCredential(), blobOptions);
        }
        else if (!string.IsNullOrWhiteSpace(accountName))
        {
            _blobServiceClient = new BlobServiceClient(
                new Uri($"https://{accountName}.blob.core.windows.net"),
                new DefaultAzureCredential(),
                blobOptions);
        }
    }

    /// <summary>
    /// Eagerly create every consolidated-game table and blob container. Idempotent —
    /// safe to call on every startup.
    /// </summary>
    public async Task InitializeAsync(CancellationToken cancellationToken = default)
    {
        foreach (var table in AdditionalTables)
        {
            try
            {
                var client = _tableServiceClient.GetTableClient(table);
                await client.CreateIfNotExistsAsync(cancellationToken);
                _logger.LogInformation("Storage table ensured: {Table}", table);
            }
            catch (Exception ex)
            {
                // Best-effort: log and continue. The lazy path in StorageService will retry
                // on first real use.
                _logger.LogWarning(ex, "Failed to ensure storage table {Table}; will retry lazily on first use", table);
            }
        }

        if (_blobServiceClient is not null)
        {
            foreach (var container in AdditionalBlobContainers)
            {
                try
                {
                    var client = _blobServiceClient.GetBlobContainerClient(container);
                    await client.CreateIfNotExistsAsync(cancellationToken: cancellationToken);
                    _logger.LogInformation("Storage blob container ensured: {Container}", container);
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Failed to ensure blob container {Container}; will retry lazily on first use", container);
                }
            }
        }
    }
}
