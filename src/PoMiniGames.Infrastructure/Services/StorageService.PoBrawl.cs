using System.Text.Json;
using System.Runtime.CompilerServices;
using Azure;
using Azure.Data.Tables;
using Azure.Identity;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using PoMiniGames.Domain.Models;
using PoMiniGames.Domain.Abstractions;
using PoMiniGames.Domain.Primitives;
using PoMiniGames.Domain.Services;
using PoMiniGames.Infrastructure.Storage;

namespace PoMiniGames.Infrastructure.Services;

/// <summary>
/// The two PoBrawl boards that sit outside the descriptor pattern: the presidents ladder and
/// the demo-mode fighter Elo.
/// </summary>
/// <remarks>
/// Split out of StorageService.cs on 2026-09-12. These are deliberately not descriptors —
/// a descriptor expresses a best-result ratchet, and both of these are accumulators that
/// move a stored value in either direction. Both go through TableConcurrency.UpdateWithRetryAsync,
/// and the Elo board applies its change as an <b>increment</b> rather than an absolute computed
/// from the read, because increments commute: two demo matches finishing at once compose
/// instead of one clobbering the other.
/// </remarks>
public partial class StorageService
{
    // ── PoBrawl presidents ladder ─────────────────────────────────────────
    // Unlike the high-score boards (append + dedupe by content hash), the ladder
    // keeps exactly one row per player: RowKey = sanitized player name, and
    // PresidentsBeaten only ever ratchets up. Elo/Date follow the run that set
    // (or matched) the best, so a later worse run can't erase a full clear.

    public async Task<List<PoBrawlLadderEntry>> GetPoBrawlLadderAsync(int limit = 10)
    {
        if (!IsStorageAvailable())
        {
            return [];
        }

        var entries = new List<PoBrawlLadderEntry>();
        try
        {
            await foreach (var e in Table(PoBrawlLadderTable).QueryAsync<TableEntity>(
                filter: $"PartitionKey eq '{PoBrawlLadderPartition}'",
                maxPerPage: 1000))
            {
                entries.Add(new PoBrawlLadderEntry
                {
                    PlayerName = e.GetString("PlayerName") ?? "",
                    PresidentsBeaten = e.GetInt32("PresidentsBeaten") ?? 0,
                    Elo = e.GetInt32("Elo") ?? 0,
                    Date = e.GetString("Date") ?? "",
                });
            }

            // Most presidents beaten first; higher Elo breaks ties, then earliest clear.
            return entries
                .OrderByDescending(x => x.PresidentsBeaten)
                .ThenByDescending(x => x.Elo)
                .ThenBy(x => x.Date)
                .Take(limit)
                .ToList();
        }
        catch (Exception ex)
        {
            MarkUnavailable(ex);
            return [];
        }
    }

    public async Task<PoBrawlLadderEntry> SavePoBrawlLadderAsync(PoBrawlLadderEntry entry)
    {
        var sanitized = entry with
        {
            PlayerName = SanitizeName(entry.PlayerName),
            // Roster-derived, not a literal: a hardcoded 10 truncated every clear past the
            // tenth rung to 10 once the roster grew to 15, so a champion run and a ten-rung
            // run stored the same value and the board could never separate them.
            PresidentsBeaten = Math.Clamp(entry.PresidentsBeaten, 0, PoBrawlRoster.Count),
            Date = DefaultDate(entry.Date),
        };

        if (!IsStorageAvailable())
        {
            return sanitized;
        }

        var rowKey = sanitized.PlayerName.ToLowerInvariant();
        try
        {
            await TableConcurrency.UpdateWithRetryAsync<TableEntity>(
                Table(PoBrawlLadderTable),
                partitionKey: PoBrawlLadderPartition,
                rowKey: rowKey,
                factory: () => new TableEntity(PoBrawlLadderPartition, rowKey),
                mutate: e =>
                {
                    var existingBest = e.GetInt32("PresidentsBeaten") ?? -1;
                    if (sanitized.PresidentsBeaten < existingBest)
                    {
                        return false; // A worse run never overwrites the best.
                    }
                    e["PlayerName"] = sanitized.PlayerName;
                    e["PresidentsBeaten"] = sanitized.PresidentsBeaten;
                    e["Elo"] = sanitized.Elo;
                    e["Date"] = sanitized.Date;
                    return true;
                });
        }
        catch (Exception ex)
        {
            MarkUnavailable(ex);
            // Silent drop on no-fallback path — see SaveHighScoreAsync's matching block.
        }
        return sanitized;
    }

    // ── PoBrawl demo-mode fighter Elo ─────────────────────────────────────
    // One row per fighter, RowKey = canonical fighter id, so the partition is bounded at
    // PoBrawlRoster.Count rows for all time. Unlike every board above, this is not a
    // "best result wins" ratchet: a rating is an accumulator that moves both ways, so
    // every write is a read-modify-write through TableConcurrency and there is no
    // ShouldOverwrite veto to express.

    public async Task<List<PoBrawlFighterRating>> GetPoBrawlFighterRatingsAsync(int limit = 10)
    {
        if (!IsStorageAvailable())
        {
            return [];
        }

        var ratings = new List<PoBrawlFighterRating>();
        try
        {
            await foreach (var e in Table(PoBrawlEloTable).QueryAsync<TableEntity>(
                filter: $"PartitionKey eq '{PoBrawlEloPartition}'",
                maxPerPage: 1000))
            {
                ratings.Add(FighterRatingFrom(e));
            }

            // Highest rating first. Matches played breaks ties ahead of the name so a fighter
            // with a real sample outranks one sitting on its seed rating, and the id is the
            // final tiebreaker to keep the order stable between reads.
            return ratings
                .OrderByDescending(r => r.Elo)
                .ThenByDescending(r => r.Matches)
                .ThenBy(r => r.FighterId, StringComparer.Ordinal)
                .Take(limit)
                .ToList();
        }
        catch (Exception ex)
        {
            MarkUnavailable(ex);
            return [];
        }
    }

    public async Task RecordPoBrawlDemoResultAsync(
        string winnerFighterId, string loserFighterId, bool isDraw)
    {
        var winnerId = PoBrawlRoster.Canonicalize(winnerFighterId)
            ?? throw new ArgumentException($"'{winnerFighterId}' is not a rateable PoBrawl fighter.", nameof(winnerFighterId));
        var loserId = PoBrawlRoster.Canonicalize(loserFighterId)
            ?? throw new ArgumentException($"'{loserFighterId}' is not a rateable PoBrawl fighter.", nameof(loserFighterId));

        if (string.Equals(winnerId, loserId, StringComparison.Ordinal))
        {
            throw new ArgumentException("A fighter cannot fight itself.", nameof(loserFighterId));
        }

        if (!IsStorageAvailable())
        {
            // Storage is down: the match is dropped. A demo sample is cheap to lose.
            return;
        }

        var table = Table(PoBrawlEloTable);

        try
        {
            // Snapshot both ratings to price the match. Read together: they are distinct rows that
            // cannot be read atomically in any case, so sequencing them buys nothing — which is
            // exactly why the delta is applied as an increment below rather than as an absolute.
            var before = await Task.WhenAll(
                ReadFighterEloAsync(table, winnerId),
                ReadFighterEloAsync(table, loserId));

            var delta = _fighterElo.Delta(before[0], before[1], isDraw);
            var stamp = DateTime.UtcNow.ToString("o");

            // Two distinct rows, each with its own optimistic-concurrency loop. The increments
            // commute, so these COULD run together — but they must not. A rating change is
            // zero-sum by construction (+delta / -delta), and PairwiseEloCalculator documents the
            // pool as conserved exactly; running them under Task.WhenAll lets one side land while
            // the other throws (503, timeout, or the 412 loop exhausting its attempts), which
            // silently drains or inflates the pool with no record that it happened. Sequencing
            // them means a failure on the first aborts before the second is ever attempted.
            // The residual window — first write commits, second fails — is unavoidable without a
            // cross-partition transaction Table Storage does not offer, so it is compensated below.
            try
            {
                await ApplyFighterDeltaAsync(table, winnerId, delta, isDraw ? MatchResult.Draw : MatchResult.Win, stamp);
                await ApplyFighterDeltaAsync(table, loserId, -delta, isDraw ? MatchResult.Draw : MatchResult.Loss, stamp);
            }
            catch
            {
                // Undo the half-applied match so the pool stays conserved. The compensation is
                // itself an increment, so it composes with any concurrent match the same way the
                // forward write does. If the compensation ALSO fails — almost always because
                // storage just went down — the residual half-applied row sits there until a
                // later match compensates naturally; we still mark storage unavailable so the
                // graceful-degradation path takes over for subsequent calls.
                try
                {
                    await ApplyFighterDeltaAsync(
                        table, winnerId, -delta, isDraw ? MatchResult.Draw : MatchResult.Win, stamp, undo: true);
                }
                catch (Exception compensationFailure)
                {
                    MarkUnavailable(compensationFailure);
                    _logger.LogError(
                        compensationFailure,
                        "PoBrawl Elo: failed to compensate a half-applied demo match for {WinnerId}; the rating pool is off by {Delta}.",
                        winnerId, delta);
                    return;
                }
                // Compensation succeeded but the forward path failed — fall through to the
                // outer catch, which marks storage unavailable.
                throw;
            }
        }
        catch (Exception ex)
        {
            // Anything that escaped the inner compensation (mid-match storage failure,
            // unanticipated SDK error, etc.) lands here. Mark storage unavailable so the
            // graceful-degradation path takes over; the demo loop keeps running.
            MarkUnavailable(ex);
        }
    }

    // MatchResult lives on StorageService.PoBrawlOnline.cs now (was here); both partials
    // see it because they share the same class. Keeping the declaration with the more
    // recent file matches the convention of "newer partial owns shared nested types".

    /// <summary>
    /// Current stored rating for a fighter, or the configured seed when it has never fought.
    /// </summary>
    private async Task<int> ReadFighterEloAsync(TableClient table, string fighterId)
    {
        try
        {
            var entity = await table.GetEntityAsync<TableEntity>(PoBrawlEloPartition, fighterId);
            return entity.Value.GetInt32("Elo") ?? _fighterElo.SeedElo;
        }
        catch (RequestFailedException ex) when (ex.Status == 404)
        {
            return _fighterElo.SeedElo;
        }
    }

    /// <summary>
    /// Adds <paramref name="delta"/> to a fighter's stored rating and bumps its record.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The mutation reads the rating from the entity the concurrency loop just fetched, so a
    /// retry after a 412 re-applies the increment to the winner's value rather than replaying
    /// a stale absolute. This is what makes two concurrent demo matches compose instead of
    /// one clobbering the other.
    /// </para>
    /// <para>
    /// <paramref name="undo"/> rolls the same match back: the caller passes the negated delta
    /// and the original <paramref name="result"/>, and the record counter for that result is
    /// decremented instead of incremented, so a compensated match leaves no trace in either the
    /// rating or the win/loss/draw tally. The rating itself can still come back a point short if
    /// the roll-back would push the fighter under <c>FloorElo</c> — the floor deliberately wins
    /// over conservation, exactly as PairwiseEloCalculator documents for the forward path.
    /// </para>
    /// </remarks>
    private Task ApplyFighterDeltaAsync(
        TableClient table, string fighterId, int delta, MatchResult result, string stamp, bool undo = false) =>
        TableConcurrency.UpdateWithRetryAsync<TableEntity>(
            table,
            partitionKey: PoBrawlEloPartition,
            rowKey: fighterId,
            factory: () => new TableEntity(PoBrawlEloPartition, fighterId),
            mutate: e =>
            {
                var current = e.GetInt32("Elo") ?? _fighterElo.SeedElo;
                var step = undo ? -1 : 1;
                e["FighterId"] = fighterId;
                // Resolved server-side every write, so a roster rename lands on the next match
                // instead of leaving the board showing a name nobody uses any more.
                e["DisplayName"] = PoBrawlRoster.DisplayName(fighterId);
                e["Elo"] = _fighterElo.ApplyDelta(current, delta);
                // Max(0, …) so a roll-back can never drive a counter negative if the row it is
                // undoing was itself lost to a concurrent rewrite.
                e["Wins"] = Math.Max(0, (e.GetInt32("Wins") ?? 0) + (result == MatchResult.Win ? step : 0));
                e["Losses"] = Math.Max(0, (e.GetInt32("Losses") ?? 0) + (result == MatchResult.Loss ? step : 0));
                e["Draws"] = Math.Max(0, (e.GetInt32("Draws") ?? 0) + (result == MatchResult.Draw ? step : 0));
                e["LastUpdated"] = stamp;
                return true;
            });

    private PoBrawlFighterRating FighterRatingFrom(TableEntity e)
    {
        var id = e.GetString("FighterId") ?? e.RowKey;
        return new PoBrawlFighterRating
        {
            FighterId = id,
            // Prefer the live roster name over the stored one so a rename shows immediately
            // on read; the stored column is the fallback for an id the roster has dropped.
            DisplayName = PoBrawlRoster.IsRateable(id)
                ? PoBrawlRoster.DisplayName(id)
                : e.GetString("DisplayName") ?? id,
            // Seed, not zero: a row can only exist if ApplyFighterDeltaAsync wrote the column,
            // so this is the same unreachable-fallback contract ReadFighterEloAsync uses, and
            // the two must not disagree about what "no rating stored" means.
            Elo = e.GetInt32("Elo") ?? _fighterElo.SeedElo,
            Wins = e.GetInt32("Wins") ?? 0,
            Losses = e.GetInt32("Losses") ?? 0,
            Draws = e.GetInt32("Draws") ?? 0,
            LastUpdated = e.GetString("LastUpdated") ?? "",
        };
    }
}
