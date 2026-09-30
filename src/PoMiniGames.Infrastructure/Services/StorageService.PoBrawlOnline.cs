using Azure;
using Azure.Data.Tables;
using Microsoft.Extensions.Logging;
using PoMiniGames.Domain.Models;
using PoMiniGames.Infrastructure.Storage;

namespace PoMiniGames.Infrastructure.Services;

/// <summary>
/// Live 1v1 player Elo for PoBrawl's online mode. Distinct from the demo fighter
/// Elo in <see cref="StorageService.PoBrawl.cs"/>: different table, different row
/// key (principal id, not fighter id), different display-name source, but the same
/// <see cref="Domain.Services.PairwiseEloCalculator"/> arithmetic so the two rating
/// systems cannot drift in their definition of "win".
/// </summary>
/// <remarks>
/// <para>
/// The accumulator shape and the compensation logic mirror the demo board exactly —
/// a rating is an accumulator that moves both ways, every write is a read-modify-write
/// through <see cref="TableConcurrency.UpdateWithRetryAsync"/>, and the delta is
/// applied as an increment rather than an absolute. Two players submitting the same
/// match concurrently compose instead of one clobbering the other.
/// </para>
/// <para>
/// Anonymous guests cannot participate in 1v1 (the lobby is auth-gated), so every row
/// in this table maps to a real principal id. A guest who never signs in never
/// accumulates here.
/// </para>
/// </remarks>
public partial class StorageService
{
    // Shared between this partial and StorageService.PoBrawl.cs (the demo fighter board
    // uses it too). Nested on the outer class so both partials see the same type without
    // having to put it in a shared file.
    private enum MatchResult { Win, Loss, Draw }

    /// <summary>
    /// Top-ranked online PoBrawl players. Same ordering contract as the demo board:
    /// highest Elo first, total matches as the tiebreaker ahead of name, principal id
    /// as the final deterministic tiebreaker.
    /// </summary>
    public async Task<List<PoBrawlPlayerRating>> GetPoBrawlPlayerRatingsAsync(int limit = 10)
    {
        if (!IsStorageAvailable())
        {
            return [];
        }

        var ratings = new List<PoBrawlPlayerRating>();
        try
        {
            await foreach (var e in Table(PoBrawlPlayerEloTable).QueryAsync<TableEntity>(
                filter: $"PartitionKey eq '{PoBrawlPlayerEloPartition}'",
                maxPerPage: 1000))
            {
                ratings.Add(PlayerRatingFrom(e));
            }
            return ratings
                .OrderByDescending(r => r.Elo)
                .ThenByDescending(r => r.Matches)
                .ThenBy(r => r.PrincipalId, StringComparer.Ordinal)
                .Take(limit)
                .ToList();
        }
        catch (Exception ex)
        {
            MarkUnavailable(ex);
            return [];
        }
    }

    /// <summary>
    /// Records one online 1v1 match and increments both players' ratings. The Elo
    /// arithmetic is identical to the demo board — same calculator, same floor, same
    /// zero-sum property — so a player who fights both CPU opponents and humans
    /// carries a single coherent rating concept. The match record itself lives in
    /// MatchHistory (see MatchHistoryEndpoints); this method only moves the rating.
    /// The self-fight guard lives in the only caller, PoBrawlOnlineMatchEndpoints, which
    /// answers it with a 400.
    /// </summary>
    public async Task RecordPoBrawlOnlineMatchAsync(
        string winnerPrincipalId, string loserPrincipalId,
        string winnerDisplayName, string loserDisplayName,
        bool isDraw)
    {
        if (string.IsNullOrWhiteSpace(winnerPrincipalId))
            throw new ArgumentException("Winner principal id is required.", nameof(winnerPrincipalId));
        if (string.IsNullOrWhiteSpace(loserPrincipalId))
            throw new ArgumentException("Loser principal id is required.", nameof(loserPrincipalId));

        if (!IsStorageAvailable())
        {
            return;
        }

        var table = Table(PoBrawlPlayerEloTable);

        try
        {
            // Snapshot both ratings to price the match. The read is two point lookups,
            // not atomic, but it doesn't need to be — the write applies its delta as
            // an increment, so the window is benign. See the demo board's remarks.
            var before = await Task.WhenAll(
                ReadPlayerEloAsync(table, winnerPrincipalId),
                ReadPlayerEloAsync(table, loserPrincipalId));

            var delta = _fighterElo.Delta(before[0], before[1], isDraw);
            var stamp = DateTime.UtcNow.ToString("o");

            // Sequential zero-sum writes, mirroring the demo board. Concurrent writes
            // would let one side land while the other fails, silently draining or
            // inflating the pool with no record. The compensation on the forward
            // failure covers the residual half-applied window.
            try
            {
                await ApplyPlayerDeltaAsync(table, winnerPrincipalId, winnerDisplayName, delta,
                    isDraw ? MatchResult.Draw : MatchResult.Win, stamp);
                await ApplyPlayerDeltaAsync(table, loserPrincipalId, loserDisplayName, -delta,
                    isDraw ? MatchResult.Draw : MatchResult.Loss, stamp);
            }
            catch
            {
                try
                {
                    await ApplyPlayerDeltaAsync(table, winnerPrincipalId, winnerDisplayName, -delta,
                        isDraw ? MatchResult.Draw : MatchResult.Win, stamp, undo: true);
                }
                catch (Exception compensationFailure)
                {
                    MarkUnavailable(compensationFailure);
                    _logger.LogError(
                        compensationFailure,
                        "PoBrawl online Elo: failed to compensate a half-applied match for {PrincipalId}; the rating pool is off by {Delta}.",
                        winnerPrincipalId, delta);
                    return;
                }
                throw;
            }
        }
        catch (Exception ex)
        {
            MarkUnavailable(ex);
        }
    }

    private async Task<int> ReadPlayerEloAsync(TableClient table, string principalId)
    {
        try
        {
            var entity = await table.GetEntityAsync<TableEntity>(PoBrawlPlayerEloPartition, principalId);
            return entity.Value.GetInt32("Elo") ?? _fighterElo.SeedElo;
        }
        catch (RequestFailedException ex) when (ex.Status == 404)
        {
            return _fighterElo.SeedElo;
        }
    }

    private Task ApplyPlayerDeltaAsync(
        TableClient table, string principalId, string displayName, int delta,
        MatchResult result, string stamp, bool undo = false) =>
        TableConcurrency.UpdateWithRetryAsync<TableEntity>(
            table,
            partitionKey: PoBrawlPlayerEloPartition,
            rowKey: principalId,
            factory: () => new TableEntity(PoBrawlPlayerEloPartition, principalId),
            mutate: e =>
            {
                var current = e.GetInt32("Elo") ?? _fighterElo.SeedElo;
                var step = undo ? -1 : 1;
                e["PrincipalId"] = principalId;
                // Display name refreshed on every write so a rename (rare, but the
                // claim identity can change) shows immediately on the next board read.
                e["DisplayName"] = displayName;
                e["Elo"] = _fighterElo.ApplyDelta(current, delta);
                e["Wins"] = Math.Max(0, (e.GetInt32("Wins") ?? 0) + (result == MatchResult.Win ? step : 0));
                e["Losses"] = Math.Max(0, (e.GetInt32("Losses") ?? 0) + (result == MatchResult.Loss ? step : 0));
                e["Draws"] = Math.Max(0, (e.GetInt32("Draws") ?? 0) + (result == MatchResult.Draw ? step : 0));
                e["LastUpdated"] = stamp;
                return true;
            });

    private PoBrawlPlayerRating PlayerRatingFrom(TableEntity e) => new()
    {
        PrincipalId = e.GetString("PrincipalId") ?? e.RowKey,
        // Echo the stored name on read; the next write will refresh it. The demo board
        // resolves from a roster; this board doesn't have one — principals are an open
        // set — so the stored value is the source of truth.
        DisplayName = e.GetString("DisplayName") ?? e.RowKey,
        Elo = e.GetInt32("Elo") ?? _fighterElo.SeedElo,
        Wins = e.GetInt32("Wins") ?? 0,
        Losses = e.GetInt32("Losses") ?? 0,
        Draws = e.GetInt32("Draws") ?? 0,
        LastUpdated = e.GetString("LastUpdated") ?? "",
    };
}
