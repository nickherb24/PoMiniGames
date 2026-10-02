using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Azure;
using Azure.Data.Tables;
using PoMiniGames.Infrastructure.Storage;

namespace PoMiniGames.AI;

/// <summary>
/// Durable backing for <see cref="AiTokenBudget"/>'s per-identity daily spend.
/// </summary>
/// <remarks>
/// <para>
/// The budget's ledger is a <c>ConcurrentDictionary</c> in the host process, which makes the
/// 250k/day ceiling only as durable as the process. This app runs on App Service <b>F1</b>, which
/// cannot enable AlwaysOn (see the deploy workflow's smoke-test retries) — so the host is recycled
/// whenever the site goes idle, and every recycle silently reset every caller's allowance to zero.
/// The documented "daily ceiling" was in practice a per-uptime ceiling, which is exactly the bound
/// that does not hold when someone leaves a tab open overnight.
/// </para>
/// <para>
/// <b>Increments, never absolutes.</b> Same argument as the PoBrawl demo-mode Elo board: the write
/// is <c>Spent += delta</c> under an ETag, so two hosts (or a host and a replayed flush) compose
/// instead of one clobbering the other. An absolute write computed from a stale read would lose
/// whatever landed in between, and losing spend is the one direction that costs money.
/// </para>
/// </remarks>
public interface IAiTokenLedgerStore
{
    /// <summary>True when a durable store is actually wired; false means in-memory only.</summary>
    bool IsDurable { get; }

    /// <summary>Tokens <paramref name="identity"/> has already spent on <paramref name="day"/>.</summary>
    Task<long> LoadAsync(DateOnly day, string identity, CancellationToken cancellationToken = default);

    /// <summary>Adds <paramref name="delta"/> to that identity's total for the day.</summary>
    Task IncrementAsync(DateOnly day, string identity, long delta, CancellationToken cancellationToken = default);
}

/// <summary>No-op store for hosts with no storage (tests, storage-down degradation).</summary>
/// <remarks>
/// Returning 0 from <see cref="LoadAsync"/> is the correct degradation: the in-memory ledger is
/// still authoritative for this process, so the ceiling keeps working, it just stops surviving a
/// restart. Refusing calls when the ledger is unreadable would take the AI surface down every time
/// Azurite is not running locally.
/// </remarks>
public sealed class NullAiTokenLedgerStore : IAiTokenLedgerStore
{
    public static readonly NullAiTokenLedgerStore Instance = new();

    public bool IsDurable => false;

    public Task<long> LoadAsync(DateOnly day, string identity, CancellationToken cancellationToken = default)
        => Task.FromResult(0L);

    public Task IncrementAsync(DateOnly day, string identity, long delta, CancellationToken cancellationToken = default)
        => Task.CompletedTask;
}

/// <summary>Azure Table Storage implementation. One row per (UTC day, identity).</summary>
public sealed class TableAiTokenLedgerStore : IAiTokenLedgerStore
{
    /// <summary>Table name. Ensured at startup by <c>StorageInitializer</c>.</summary>
    public const string TableName = "AiTokenLedger";

    private readonly TableServiceClient _serviceClient;
    private readonly ILogger<TableAiTokenLedgerStore> _logger;
    private readonly string _tableName;
    private TableClient? _table;
    private readonly object _tableLock = new();
    private DateTime _lastCreateAttemptUtc = DateTime.MinValue;
    private static readonly TimeSpan CreateBackoff = TimeSpan.FromSeconds(10);

    /// <param name="tableName">
    /// Defaults to the shared AI token ledger. PoJevArena passes its own table so its daily Jev call
    /// cap is a separate counter over the same durable increment-under-ETag mechanism.
    /// </param>
    public TableAiTokenLedgerStore(
        TableServiceClient serviceClient, ILogger<TableAiTokenLedgerStore> logger, string tableName = TableName)
    {
        _serviceClient = serviceClient;
        _logger = logger;
        _tableName = tableName;
    }

    public bool IsDurable => true;

    /// <summary>
    /// One row per identity per day. The partition is the day, so a day's whole ledger is a single
    /// partition scan and an expired day can be dropped wholesale later without touching live rows.
    /// </summary>
    public sealed class LedgerEntity : ITableEntity
    {
        public string PartitionKey { get; set; } = string.Empty;
        public string RowKey { get; set; } = string.Empty;
        public DateTimeOffset? Timestamp { get; set; }
        public ETag ETag { get; set; }

        /// <summary>Tokens spent by this identity on this day.</summary>
        public long Spent { get; set; }

        /// <summary>
        /// The identity this row belongs to, truncated. Kept only so an operator reading the table
        /// can tell whose row this is — the RowKey is a hash, because an identity string may
        /// contain characters Table Storage forbids in a key.
        /// </summary>
        public string Identity { get; set; } = string.Empty;
    }

    public async Task<long> LoadAsync(DateOnly day, string identity, CancellationToken cancellationToken = default)
    {
        try
        {
            var table = await ResolveTableAsync(cancellationToken);
            if (table is null) return 0;
            var response = await table.GetEntityAsync<LedgerEntity>(
                PartitionFor(day), RowKeyFor(identity), cancellationToken: cancellationToken);
            return response.Value.Spent;
        }
        catch (RequestFailedException ex) when (ex.Status == 404)
        {
            return 0;
        }
        catch (Exception ex)
        {
            // Degrade to in-memory rather than refusing the call: an unreadable ledger must not
            // take the AI surface down. Logged at Warning because a persistently unreadable ledger
            // means the ceiling has quietly stopped being durable.
            _logger.LogWarning(ex, "AI token ledger read failed for day {Day}; falling back to in-memory spend.", day);
            return 0;
        }
    }

    public async Task IncrementAsync(
        DateOnly day, string identity, long delta, CancellationToken cancellationToken = default)
    {
        if (delta <= 0) return;

        try
        {
            var table = await ResolveTableAsync(cancellationToken);
            if (table is null)
            {
                // Storage is down. Throwing hands the delta back to the flusher's re-queue, which
                // is what keeps the spend from being silently forgiven when storage returns.
                throw new InvalidOperationException($"Table {_tableName} is unavailable.");
            }

            await TableConcurrency.UpdateWithRetryAsync<LedgerEntity>(
                table,
                PartitionFor(day),
                RowKeyFor(identity),
                () => new LedgerEntity { Identity = Truncate(identity), Spent = 0 },
                entity =>
                {
                    entity.Spent += delta;
                    return true;
                },
                cancellationToken);
        }
        catch (Exception ex)
        {
            // The flusher re-queues the delta on failure, so this is not a silent loss; it is a
            // deferral. Logged so a storage outage that outlives the process is visible.
            _logger.LogWarning(ex, "AI token ledger write failed for day {Day} (+{Delta} tokens).", day, delta);
            throw;
        }
    }

    /// <summary>
    /// The table client, or null when storage is unreachable. The failure is remembered for
    /// <see cref="CreateBackoff"/> so a host running without storage (no Azurite locally) does not
    /// pay the client's network timeout on every single model call before falling back to the
    /// in-memory ledger. Recovery is automatic on the next attempt after the backoff.
    /// </summary>
    private async Task<TableClient?> ResolveTableAsync(CancellationToken cancellationToken)
    {
        var existing = Volatile.Read(ref _table);
        if (existing is not null) return existing;

        lock (_tableLock)
        {
            if (_table is not null) return _table;
            if (DateTime.UtcNow - _lastCreateAttemptUtc < CreateBackoff) return null;
            _lastCreateAttemptUtc = DateTime.UtcNow;
        }

        var client = _serviceClient.GetTableClient(_tableName);
        await client.CreateIfNotExistsAsync(cancellationToken: cancellationToken);

        lock (_tableLock)
        {
            _table ??= client;
            return _table;
        }
    }

    private static string PartitionFor(DateOnly day) => day.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    /// <summary>
    /// SHA-256 of the identity, hex. Identity strings here are OIDs, guest ids and IP-derived
    /// partitions, any of which may contain <c>/</c>, <c>\</c>, <c>#</c> or <c>?</c> — all illegal
    /// in a Table Storage key. Hashing sidesteps the whole class rather than sanitising, which
    /// would risk two different identities colliding onto one sanitised key and sharing a budget.
    /// </summary>
    private static string RowKeyFor(string identity)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(identity)));

    private static string Truncate(string value)
        => value.Length <= 120 ? value : value[..120];
}
