using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Azure;
using Azure.Data.Tables;

namespace PoMiniGames.Infrastructure;

/// <summary>
/// Durable copy of the results a race registry timed itself, so the proof behind a score submit
/// outlives the process that produced it.
/// </summary>
/// <remarks>
/// <para>
/// PoRacer and PoCabinet multiplayer both store only the lap the server's own sim timed, and both
/// kept that lap in a dictionary. On App Service F1 (no AlwaysOn, so idle means recycle) the
/// dictionary went with the process: a score parked by <c>PendingScoreStore</c> while the player
/// was offline came back to a host that had forgotten the race and was refused with 422, for good.
/// </para>
/// <para>
/// The registries stay the fast path and the authority while the process lives; this is only read
/// on a miss. It never throws: a failed write leaves the result in memory as before, a failed read
/// is a miss, and the submit is then refused exactly as it was before this existed.
/// </para>
/// </remarks>
public sealed class VerifiedResultStore(TableServiceClient tables, ILogger<VerifiedResultStore> logger)
{
    /// <summary>Table name. Ensured at startup by <see cref="StorageInitializer"/>.</summary>
    public const string TableName = "VerifiedResults";

    private readonly TableClient _table = tables.GetTableClient(TableName);
    private bool _ensured;

    /// <summary>Remember <paramref name="value"/> for <paramref name="game"/> under <paramref name="key"/>.</summary>
    public async Task SaveAsync<T>(string game, string key, T value, CancellationToken ct = default)
    {
        try
        {
            await EnsureTableAsync(ct);
            // ponytail: rows are never swept, only ignored once older than the caller's lifetime
            // (and deleted when read). One small row per human per race; add a purge by Timestamp
            // if the table ever matters.
            await _table.UpsertEntityAsync(
                new TableEntity(game, RowKeyFor(key))
                {
                    ["Json"] = JsonSerializer.Serialize(value),
                    ["SavedAtUtc"] = DateTimeOffset.UtcNow,
                },
                TableUpdateMode.Replace, ct);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Verified result for {Game} was not persisted; it stays in memory only.", game);
        }
    }

    /// <summary>
    /// The result saved under that key, or default when there is none, it is older than
    /// <paramref name="lifetime"/>, or storage is unreachable. <paramref name="take"/> deletes the
    /// row once read, for results that back exactly one submit.
    /// </summary>
    public async Task<T?> FindAsync<T>(string game, string key, TimeSpan lifetime, bool take = false, CancellationToken ct = default)
    {
        try
        {
            await EnsureTableAsync(ct);
            var row = await _table.GetEntityIfExistsAsync<TableEntity>(game, RowKeyFor(key), cancellationToken: ct);
            if (!row.HasValue || row.Value is not { } entity) return default;

            var expired = DateTimeOffset.UtcNow - (entity.GetDateTimeOffset("SavedAtUtc") ?? DateTimeOffset.MinValue) > lifetime;
            if (take || expired) await _table.DeleteEntityAsync(entity.PartitionKey, entity.RowKey, ETag.All, ct);
            return expired ? default : JsonSerializer.Deserialize<T>(entity.GetString("Json") ?? "null");
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Verified result lookup for {Game} failed; treating it as not found.", game);
            return default;
        }
    }

    /// <summary>Forget a result that has been spent from memory, so a recycle cannot spend it again.</summary>
    public async Task RemoveAsync(string game, string key, CancellationToken ct = default)
    {
        try
        {
            await EnsureTableAsync(ct);
            await _table.DeleteEntityAsync(game, RowKeyFor(key), ETag.All, ct);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Verified result for {Game} could not be removed.", game);
        }
    }

    private async Task EnsureTableAsync(CancellationToken ct)
    {
        if (_ensured) return;
        await _table.CreateIfNotExistsAsync(ct);
        _ensured = true;
    }

    // Hashed for the same reason the token ledger hashes: a claim id or race code may hold
    // characters Table Storage forbids in a key.
    private static string RowKeyFor(string key) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key)));
}
