using Azure;
using Azure.Data.Tables;
using PoMiniGames.Features.MatchHistory;

namespace PoMiniGames.Features.Account;

/// <summary>Who the export/delete is for. Both halves are needed — the tables disagree on keying.</summary>
/// <param name="UserId">Stable claim id. Empty for a guest.</param>
/// <param name="DisplayName">The name the boards render, and the key several tables use.</param>
public readonly record struct PlayerDataSubject(string UserId, string DisplayName)
{
    public bool HasClaimIdentity => !string.IsNullOrEmpty(UserId);
}

/// <summary>One stored row, flattened for the export document.</summary>
public sealed record PlayerDataRow(string PartitionKey, string RowKey, Dictionary<string, string?> Fields);

/// <summary>Everything this platform holds about one player.</summary>
public sealed record PlayerDataExport(
    DateTimeOffset GeneratedAtUtc,
    string DisplayName,
    bool IsGuest,
    int TotalRows,
    Dictionary<string, List<PlayerDataRow>> Tables);

/// <summary>Per-table deletion counts, so the caller can see what actually went.</summary>
public sealed record PlayerDataDeletion(DateTimeOffset DeletedAtUtc, int TotalRows, Dictionary<string, int> Tables);

/// <summary>
/// The backing store could not be reached, so neither the export nor the erase can be trusted.
/// </summary>
/// <remarks>
/// This exists because the rest of the app's storage policy is exactly wrong for these two
/// operations. Everywhere else, an unreachable Table Storage degrades to an empty list — a
/// leaderboard renders blank, a score is dropped — which is the right trade for a game. Here it
/// would mean telling a player "you have no data" or "there was nothing to erase" when the truth
/// is that nobody looked. Both are lies, and the second one is the kind a person makes decisions
/// on. So this propagates to a 503 instead.
/// </remarks>
public sealed class PlayerDataUnavailableException(string table, Exception inner)
    : Exception($"Player data store unreachable while reading '{table}'.", inner);

/// <summary>
/// Reads and erases everything stored about one player, across every table that holds
/// player-attributable rows.
/// </summary>
/// <remarks>
/// <para>
/// <b>Why this is a scan and not a keyed lookup.</b> The boards key rows three different ways:
/// <c>PlayerStats</c> and the PoBrawl ladder use the display name as the RowKey, the descriptor
/// boards derive an opaque content hash from their identity fields (see
/// <c>StorageService.DeterministicRowKey</c>), and match history partitions on a normalised
/// owner. There is no single key to look a player up by, so each partition is scanned and rows
/// are matched on their content. Partitions are small (one row per player on the ratchet
/// boards) and this runs twice in a player's lifetime, so the cost is irrelevant.
/// </para>
/// <para>
/// <b>Matching is deliberately conservative.</b> When a row carries a <c>UserId</c> and the
/// caller has a claim identity, the UserId is the ONLY thing that counts — a display-name match
/// is ignored. Falling back to the name in that case would let a signed-in player delete the
/// rows of a guest who picked the same name. The name fallback applies only to rows that have
/// no UserId to compare (name-keyed tables, and rows written before identity was stamped).
/// </para>
/// <para>
/// <c>PoBrawlFighterRatings</c> is excluded on purpose: those rows rate CPU fighters from
/// demo-mode matches, not players, so they are not the caller's data and erasing them would
/// corrupt a shared board.
/// </para>
/// </remarks>
public sealed class PlayerDataService(TableServiceClient tableServiceClient, ILogger<PlayerDataService> logger)
{
    /// <param name="Table">Table name as created by StorageService.</param>
    /// <param name="Partitions">Partitions to scan. Null means "every partition" (PlayerStats
    /// partitions by game, so the caller's rows are spread across all of them).</param>
    /// <param name="NameFields">Fields holding the player's display name, in priority order.</param>
    /// <param name="RowKeyIsName">True when the RowKey itself is the (sanitised) display name.</param>
    private sealed record PlayerTable(
        string Table,
        string[]? Partitions,
        string[] NameFields,
        bool RowKeyIsName = false);

    private static readonly PlayerTable[] Sources =
    [
        // RowKey is the player name; partitions are game keys, so scan them all.
        new("PlayerStats", null, [], RowKeyIsName: true),

        new("MarbleRaceHighScores", ["marblerace"], ["PlayerInitials"]),
        new("PoBrawlHighScores", ["pobrawl"], ["PlayerInitials"]),
        new("PoRacerHighScores", ["poracer"], ["PlayerName"]),
        new("PoSportsHighScores", ["posports"], ["PlayerName"]),
        new("PoVoxelStrikeHighScores", ["povoxelstrike"], ["PlayerName"]),

        // The ladder keeps one row per player keyed by sanitised name (see StorageService).
        new("PoBrawlLadder", ["pobrawlladder"], ["PlayerName", "PlayerInitials"], RowKeyIsName: true),

        // The 1P ladder run (PoBrawlProgressStore): one row per claim identity, matched on UserId.
        new("PoBrawlProgress", ["p"], []),
    ];

    /// <summary>Assembles the full export document.</summary>
    public async Task<PlayerDataExport> ExportAsync(PlayerDataSubject subject, bool isGuest, CancellationToken ct = default)
    {
        var tables = new Dictionary<string, List<PlayerDataRow>>(StringComparer.Ordinal);
        var total = 0;

        foreach (var source in Sources)
        {
            var rows = (await CollectAsync(source, subject, ct))
                .Select(entity => new PlayerDataRow(
                    entity.PartitionKey,
                    entity.RowKey,
                    entity.ToDictionary(kv => kv.Key, kv => kv.Value?.ToString())))
                .ToList();

            if (rows.Count > 0)
            {
                tables[source.Table] = rows;
                total += rows.Count;
            }
        }

        var matches = await ScanMatchHistoryAsync(subject, ct);
        if (matches.Count > 0)
        {
            tables["MatchHistory"] = matches
                .Select(e => new PlayerDataRow(
                    e.PartitionKey, e.RowKey,
                    e.ToDictionary(kv => kv.Key, kv => kv.Value?.ToString())))
                .ToList();
            total += matches.Count;
        }

        return new PlayerDataExport(DateTimeOffset.UtcNow, subject.DisplayName, isGuest, total, tables);
    }

    /// <summary>Erases every row the export would have returned. Irreversible.</summary>
    public async Task<PlayerDataDeletion> DeleteAsync(PlayerDataSubject subject, CancellationToken ct = default)
    {
        var counts = new Dictionary<string, int>(StringComparer.Ordinal);
        var total = 0;

        foreach (var source in Sources)
        {
            var client = tableServiceClient.GetTableClient(source.Table);
            var doomed = await CollectAsync(source, subject, ct);
            var deleted = await DeleteRowsAsync(client, doomed, ct);
            if (deleted > 0)
            {
                counts[source.Table] = deleted;
                total += deleted;
            }
        }

        var matchClient = tableServiceClient.GetTableClient("MatchHistory");
        var matchRows = await ScanMatchHistoryAsync(subject, ct);
        var matchesDeleted = await DeleteRowsAsync(matchClient, matchRows, ct);
        if (matchesDeleted > 0)
        {
            counts["MatchHistory"] = matchesDeleted;
            total += matchesDeleted;
        }

        return new PlayerDataDeletion(DateTimeOffset.UtcNow, total, counts);
    }

    /// <summary>
    /// Collects the caller's rows from one source.
    /// </summary>
    /// <remarks>
    /// Buffered rather than streamed. An iterator cannot wrap its own enumeration in a try/catch
    /// that also yields, so the streaming version could only guard the first MoveNext — which is
    /// how an unreachable Azurite surfaced as a 500 instead of a 503. Partitions here are small
    /// (one row per player on the ratchet boards), so buffering costs nothing that matters.
    /// </remarks>
    private async Task<List<TableEntity>> CollectAsync(
        PlayerTable source, PlayerDataSubject subject, CancellationToken ct)
    {
        var client = tableServiceClient.GetTableClient(source.Table);
        var filter = source.Partitions is null
            ? null
            : string.Join(" or ", source.Partitions.Select(p => $"PartitionKey eq '{p.Replace("'", "''")}'"));

        var rows = new List<TableEntity>();
        try
        {
            await foreach (var entity in client.QueryAsync<TableEntity>(
                               filter: filter, maxPerPage: 1000, cancellationToken: ct))
            {
                if (Matches(entity, subject, source))
                {
                    rows.Add(entity);
                }
            }
        }
        catch (RequestFailedException ex) when (ex.Status == 404)
        {
            // A board this deployment has never written to has no table. That is genuinely
            // "no rows", not a failure — and it is the ONLY exception that means that.
            return rows;
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            // Anything else — connection refused, the SDK's 2s network timeout surfacing as a
            // TaskCanceledException, a 5xx — means the store was not read. Say so.
            throw new PlayerDataUnavailableException(source.Table, ex);
        }

        return rows;
    }

    private async Task<List<TableEntity>> ScanMatchHistoryAsync(PlayerDataSubject subject, CancellationToken ct)
    {
        var rows = new List<TableEntity>();
        if (string.IsNullOrWhiteSpace(subject.DisplayName))
        {
            return rows;
        }

        var client = tableServiceClient.GetTableClient("MatchHistory");
        var owner = MatchHistoryRepository.OwnerKey(subject.DisplayName);

        // Two partitions per owner: the records themselves, and the idempotency markers the
        // repository writes alongside them. Deleting the records but leaving the markers would
        // make a future replay of the same MatchId silently vanish.
        foreach (var partition in new[] { owner, $"dedup:{owner}" })
        {
            try
            {
                await foreach (var entity in client.QueryAsync<TableEntity>(
                                   filter: $"PartitionKey eq '{partition.Replace("'", "''")}'",
                                   maxPerPage: 1000,
                                   cancellationToken: ct))
                {
                    rows.Add(entity);
                }
            }
            catch (RequestFailedException ex) when (ex.Status == 404)
            {
                // Table not created yet — nothing recorded, nothing to export or erase.
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
            {
                throw new PlayerDataUnavailableException("MatchHistory", ex);
            }
        }

        return rows;
    }

    /// <summary>
    /// Row-ownership test. See the class remarks for why a UserId match suppresses the name
    /// fallback rather than sitting alongside it.
    /// </summary>
    private static bool Matches(TableEntity entity, PlayerDataSubject subject, PlayerTable source)
    {
        var rowUserId = entity.GetString("UserId");
        if (!string.IsNullOrEmpty(rowUserId))
        {
            return subject.HasClaimIdentity
                && string.Equals(rowUserId, subject.UserId, StringComparison.Ordinal);
        }

        if (string.IsNullOrWhiteSpace(subject.DisplayName))
        {
            return false;
        }

        if (source.RowKeyIsName
            && string.Equals(entity.RowKey, PoMiniGames.Infrastructure.Services.StorageService.NormalizePlayerKey(subject.DisplayName),
                             StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        foreach (var field in source.NameFields)
        {
            var value = entity.GetString(field);
            if (!string.IsNullOrEmpty(value)
                && string.Equals(value, subject.DisplayName, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }

    private async Task<int> DeleteRowsAsync(TableClient client, IReadOnlyList<TableEntity> rows, CancellationToken ct)
    {
        var deleted = 0;
        foreach (var row in rows)
        {
            try
            {
                // Unconditional delete (ETag.All): a concurrent score write between the scan and
                // this call must not leave a row behind on a deletion the player asked for.
                await client.DeleteEntityAsync(row.PartitionKey, row.RowKey, ETag.All, ct);
                deleted++;
            }
            catch (RequestFailedException ex) when (ex.Status == 404)
            {
                // Already gone — a repeated delete is a no-op, not a failure.
            }
            catch (RequestFailedException ex)
            {
                // Report what did go rather than failing the whole erase on one stubborn row;
                // the caller can run it again and the count will tell them it converged.
                AccountLog.RowDeleteFailed(logger, client.Name, row.RowKey, ex.Status);
            }
        }

        return deleted;
    }
}

internal static partial class AccountLog
{
    [LoggerMessage(Level = LogLevel.Warning,
        Message = "Account erase could not delete row table={Table} rowKey={RowKey} status={Status}")]
    public static partial void RowDeleteFailed(ILogger logger, string table, string rowKey, int status);

    [LoggerMessage(Level = LogLevel.Information,
        Message = "Account data {Operation} guest={IsGuest} rows={Rows}")]
    public static partial void Completed(ILogger logger, string operation, bool isGuest, int rows);
}
