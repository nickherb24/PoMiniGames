using System.Runtime.Serialization;
using System.Security.Cryptography;
using System.Text;
using Azure;
using Azure.Data.Tables;
using PoMiniGames.Domain.Services;
using PoMiniGames.Infrastructure.Storage;
using PoMiniGames.Shared.Games.PoJevArena;

namespace PoMiniGames.Features.PoJevArena;

public enum LibraryWrite
{
    Ok,
    NotFound,
    Forbidden,
    LimitReached,
    Unavailable,
}

/// <summary>
/// The shared public creature library: every saved creature is public on save, credited to its
/// creator, editable and deletable by that creator only. One partition (<c>lib</c>), so the whole
/// library is one partition scan. Reads degrade to empty and writes report
/// <see cref="LibraryWrite.Unavailable"/> when storage is down — no in-memory fallback (CLAUDE.md,
/// 2026-09-12). Win/loss counters are increments under an ETag, so two matches finishing at once
/// both land.
/// </summary>
public sealed class CreatureLibraryStore(TableServiceClient tables, ILogger<CreatureLibraryStore> logger)
{
    public const string TableName = "PoJevArenaCreatures";
    private const string Partition = "lib";

    /// <summary>
    /// How many rows a listing returns, and how many of the newest rows it considers. Row keys sort
    /// newest-first (see <see cref="NewId"/>), so the partition scan reads the newest creatures first
    /// and the cap keeps the newest <see cref="ScanLimit"/> — "used", "win rate" and name search
    /// rank within that window, which is the trade for one bounded partition scan per listing.
    /// </summary>
    public const int ListLimit = 200;
    private const int ScanLimit = 2_000;

    /// <summary>Creatures need this many matches before their win rate ranks above "new".</summary>
    public const int WinRateMinMatches = 3;

    private readonly TableClient _table = tables.GetTableClient(TableName);
    private int _ensured;

    public sealed class CreatureEntity : ITableEntity
    {
        public string PartitionKey { get; set; } = Partition;
        public string RowKey { get; set; } = string.Empty;
        public DateTimeOffset? Timestamp { get; set; }
        public ETag ETag { get; set; }

        public string Name { get; set; } = string.Empty;
        public int MaxHp { get; set; }
        public double MoveSpeed { get; set; }
        public double Mass { get; set; }

        /// <summary>Comma-joined ability ids, offense first. A list, so a third slot needs no schema change.</summary>
        public string Abilities { get; set; } = string.Empty;

        public string Temperament { get; set; } = string.Empty;
        public string TargetBias { get; set; } = string.Empty;
        public string PanicThreshold { get; set; } = string.Empty;
        public double BuildCost { get; set; }
        public string OwnerKey { get; set; } = string.Empty;
        public string OwnerName { get; set; } = string.Empty;
        public int Deployed { get; set; }
        public int Wins { get; set; }
        public int Losses { get; set; }
        public int Draws { get; set; }

        /// <summary>Head-to-head rating; 0 on rows that predate it, read as <see cref="SeedRating"/>.</summary>
        public int Elo { get; set; }

        public int Kills { get; set; }
        public int Mvps { get; set; }
        public long DamageDealt { get; set; }
        public DateTimeOffset CreatedUtc { get; set; }

        /// <summary>Set by the increment factory: a row that is gone must not be resurrected by a result.</summary>
        [IgnoreDataMember]
        public bool Missing { get; set; }

        public ArenaCreature ToCreature(string? viewerKey) => new(
            RowKey, Name, MaxHp, MoveSpeed, Mass,
            Abilities.Length == 0 ? [] : Abilities.Split(','),
            Temperament, TargetBias, PanicThreshold, BuildCost,
            OwnerName, viewerKey is not null && viewerKey == OwnerKey,
            Deployed, Wins, Losses, Draws, Timestamp ?? CreatedUtc,
            RatingOf(Elo), Kills, Mvps, DamageDealt);
    }

    /// <summary>
    /// Creature ratings: PoBrawl's head-to-head Elo, own instance with default tuning (seed 1000,
    /// K 24, floor 100), because that calculator's DI registration is bound to PoBrawl's section.
    /// A creature is priced against the average rating of the ten it faced, so fighting beside
    /// strong teammates earns less than a raw win rate credits it with.
    /// </summary>
    private static readonly PairwiseEloCalculator Ratings = new(new PairwiseEloOptions());

    public static int SeedRating => Ratings.SeedElo;

    private static int RatingOf(int stored) => stored == 0 ? Ratings.SeedElo : stored;

    /// <summary>Hash of the claim id (first 24 hex chars, the PoEcosystem convention); raw ids never hit a key.</summary>
    public static string OwnerKeyFor(string userId) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(userId)))[..24].ToLowerInvariant();

    /// <returns>The listing, or null when storage failed (the endpoint answers 503, the page says "offline").</returns>
    public async Task<ArenaCreature[]?> ListAsync(string? viewerKey, string? sort, string? query, CancellationToken ct = default)
    {
        try
        {
            await EnsureAsync(ct);
            var rows = new List<CreatureEntity>();
            await foreach (var row in _table.QueryAsync<CreatureEntity>(e => e.PartitionKey == Partition, cancellationToken: ct))
            {
                rows.Add(row);
                if (rows.Count >= ScanLimit) break;
            }

            IEnumerable<CreatureEntity> filtered = rows;
            if (!string.IsNullOrWhiteSpace(query))
            {
                var q = query.Trim();
                filtered = filtered.Where(r => r.Name.Contains(q, StringComparison.OrdinalIgnoreCase));
            }

            filtered = sort switch
            {
                "used" => filtered.OrderByDescending(r => r.Deployed).ThenByDescending(r => r.CreatedUtc),
                "winrate" => filtered
                    .OrderByDescending(r => r.Deployed >= WinRateMinMatches)
                    .ThenByDescending(r => r.Deployed == 0 ? 0 : (r.Wins + 0.5 * r.Draws) / r.Deployed)
                    .ThenByDescending(r => r.Deployed),
                "rating" => filtered
                    .OrderByDescending(r => r.Deployed >= WinRateMinMatches)
                    .ThenByDescending(r => RatingOf(r.Elo))
                    .ThenByDescending(r => r.Deployed),
                _ => filtered.OrderByDescending(r => r.CreatedUtc),
            };

            return filtered.Take(ListLimit).Select(r => r.ToCreature(viewerKey)).ToArray();
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LibraryFailed(ex, "list");
            return null;
        }
    }

    /// <summary>Resolves roster ids to frozen creatures; null when storage is down, missing ids are simply absent.</summary>
    public async Task<Dictionary<string, ArenaCreature>?> GetManyAsync(IEnumerable<string> ids, CancellationToken ct = default)
    {
        try
        {
            await EnsureAsync(ct);
            var found = new Dictionary<string, ArenaCreature>(StringComparer.Ordinal);
            foreach (var id in ids.Distinct(StringComparer.Ordinal))
            {
                var row = await _table.GetEntityIfExistsAsync<CreatureEntity>(Partition, id, cancellationToken: ct);
                if (row.HasValue && row.Value is { } entity) found[id] = entity.ToCreature(null);
            }
            return found;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LibraryFailed(ex, "get");
            return null;
        }
    }

    public async Task<(LibraryWrite Result, ArenaCreature? Creature)> CreateAsync(
        string ownerKey, string ownerName, ArenaCreature creature, CancellationToken ct = default)
    {
        try
        {
            await EnsureAsync(ct);
            var owned = 0;
            await foreach (var _ in _table.QueryAsync<CreatureEntity>(
                e => e.PartitionKey == Partition && e.OwnerKey == ownerKey, select: ["RowKey"], cancellationToken: ct))
            {
                if (++owned >= PoJevArenaRules.MaxCreaturesPerOwner) return (LibraryWrite.LimitReached, null);
            }

            var entity = new CreatureEntity
            {
                RowKey = NewId(),
                OwnerKey = ownerKey,
                OwnerName = ownerName,
                CreatedUtc = DateTimeOffset.UtcNow,
            };
            Apply(entity, creature);
            await _table.AddEntityAsync(entity, ct);
            return (LibraryWrite.Ok, entity.ToCreature(ownerKey));
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LibraryFailed(ex, "create");
            return (LibraryWrite.Unavailable, null);
        }
    }

    public async Task<(LibraryWrite Result, ArenaCreature? Creature)> UpdateAsync(
        string ownerKey, string id, ArenaCreature creature, CancellationToken ct = default)
    {
        try
        {
            await EnsureAsync(ct);
            for (var attempt = 1; ; attempt++)
            {
                var row = await _table.GetEntityIfExistsAsync<CreatureEntity>(Partition, id, cancellationToken: ct);
                if (!row.HasValue || row.Value is not { } entity) return (LibraryWrite.NotFound, null);
                if (entity.OwnerKey != ownerKey) return (LibraryWrite.Forbidden, null);

                // Stats survive an edit; only the design changes. If-Match so a result increment
                // that lands between the read and the write is re-read, never overwritten.
                Apply(entity, creature);
                try
                {
                    await _table.UpdateEntityAsync(entity, entity.ETag, TableUpdateMode.Replace, ct);
                    return (LibraryWrite.Ok, entity.ToCreature(ownerKey));
                }
                catch (RequestFailedException ex) when (ex.Status == 412 && attempt < 4)
                {
                }
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LibraryFailed(ex, "update");
            return (LibraryWrite.Unavailable, null);
        }
    }

    public async Task<LibraryWrite> DeleteAsync(string ownerKey, string id, CancellationToken ct = default)
    {
        try
        {
            await EnsureAsync(ct);
            var row = await _table.GetEntityIfExistsAsync<CreatureEntity>(Partition, id, cancellationToken: ct);
            if (!row.HasValue || row.Value is not { } entity) return LibraryWrite.NotFound;
            if (entity.OwnerKey != ownerKey) return LibraryWrite.Forbidden;

            await _table.DeleteEntityAsync(Partition, id, entity.ETag, ct);
            return LibraryWrite.Ok;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LibraryFailed(ex, "delete");
            return LibraryWrite.Unavailable;
        }
    }

    /// <summary>
    /// Applies one finished match: each distinct library creature on a team gets deployed + 1,
    /// exactly one of wins/losses/draws + 1, a rating change against the other team's average, and
    /// its units' kills/damage (plus an MVP) added to its career. Presets carry no stats; deleted
    /// creatures are skipped. <paramref name="units"/> slots are Blue 0-9, Red 10-19.
    /// </summary>
    public async Task<bool> ApplyResultAsync(
        IEnumerable<ArenaCreature> blue, IEnumerable<ArenaCreature> red, string winner,
        ArenaUnitStats[]? units = null, int mvp = -1, CancellationToken ct = default)
    {
        try
        {
            await EnsureAsync(ct);
            var b = blue.ToArray();
            var r = red.ToArray();
            var roster = b.Concat(r).ToArray();
            var career = new Dictionary<string, (int Kills, long Damage, int Mvps)>(StringComparer.Ordinal);
            foreach (var u in units ?? [])
            {
                if (u is null || u.Slot < 0 || u.Slot >= roster.Length) continue;
                var id = roster[u.Slot].Id;
                var (k, d, m) = career.GetValueOrDefault(id);
                // Clamped rather than rejected: like the winner, these are the client's word, and a
                // bound keeps one forged report from dwarfing a career.
                career[id] = (k + Math.Clamp(u.Kills, 0, PoJevArenaCatalog.TeamSize),
                    d + (long)Math.Clamp(double.IsFinite(u.Damage) ? u.Damage : 0, 0, 20_000),
                    m + (u.Slot == mvp ? 1 : 0));
            }

            var updates = Team(b, AverageRating(r), winner == "blue", winner == "draw")
                .Concat(Team(r, AverageRating(b), winner == "red", winner == "draw"));
            await Task.WhenAll(updates.Select(u => IncrementAsync(u.Id, u.Won, u.Drew, u.RatingDelta, career.GetValueOrDefault(u.Id), ct)));
            return true;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LibraryFailed(ex, "result");
            return false;
        }

        static IEnumerable<(string Id, bool Won, bool Drew, int RatingDelta)> Team(ArenaCreature[] team, int opponents, bool won, bool drew) =>
            team.Where(c => !c.IsPreset).DistinctBy(c => c.Id, StringComparer.Ordinal)
                .Select(c => (c.Id, won, drew, RatingDelta(RatingOf(c.Rating), opponents, won, drew)));
    }

    /// <summary>A team's strength for pricing: presets and unrated rows count as the seed.</summary>
    private static int AverageRating(ArenaCreature[] team) =>
        team.Length == 0 ? Ratings.SeedElo : (int)Math.Round(team.Average(c => c.IsPreset ? Ratings.SeedElo : RatingOf(c.Rating)));

    private static int RatingDelta(int mine, int theirs, bool won, bool drew) =>
        drew ? Ratings.Delta(mine, theirs, isDraw: true)
        : won ? Ratings.Delta(mine, theirs, isDraw: false)
        : -Ratings.Delta(theirs, mine, isDraw: false);

    // The rating moves as an increment on whatever is stored at write time (PairwiseEloCalculator's
    // contract), so two matches finishing at once compose instead of one overwriting the other.
    private Task IncrementAsync(string id, bool won, bool drew, int ratingDelta, (int Kills, long Damage, int Mvps) career, CancellationToken ct) =>
        TableConcurrency.UpdateWithRetryAsync<CreatureEntity>(
            _table, Partition, id,
            () => new CreatureEntity { Missing = true },
            entity =>
            {
                if (entity.Missing) return false;
                entity.Deployed++;
                if (drew) entity.Draws++;
                else if (won) entity.Wins++;
                else entity.Losses++;
                entity.Elo = Ratings.ApplyDelta(RatingOf(entity.Elo), ratingDelta);
                entity.Kills += career.Kills;
                entity.DamageDealt += career.Damage;
                entity.Mvps += career.Mvps;
                return true;
            },
            ct);

    private static void Apply(CreatureEntity entity, ArenaCreature creature)
    {
        entity.Name = creature.Name;
        entity.MaxHp = creature.MaxHp;
        entity.MoveSpeed = creature.MoveSpeed;
        entity.Mass = creature.Mass;
        entity.Abilities = string.Join(',', creature.Abilities);
        entity.Temperament = creature.Temperament;
        entity.TargetBias = creature.TargetBias;
        entity.PanicThreshold = creature.PanicThreshold;
        entity.BuildCost = creature.BuildCost;
    }

    /// <summary>
    /// Inverted UTC ticks (19 digits) plus 4 random hex chars: Table Storage returns a partition in
    /// RowKey order, so this makes every scan newest-first; the suffix breaks same-tick ties. Never
    /// collides with <c>preset:</c> ids.
    /// </summary>
    private static string NewId() =>
        (DateTime.MaxValue.Ticks - DateTime.UtcNow.Ticks).ToString("D19", System.Globalization.CultureInfo.InvariantCulture)
        + Convert.ToHexString(RandomNumberGenerator.GetBytes(2)).ToLowerInvariant();

    private async Task EnsureAsync(CancellationToken ct)
    {
        if (Volatile.Read(ref _ensured) == 1) return;
        await _table.CreateIfNotExistsAsync(ct);
        Volatile.Write(ref _ensured, 1);
    }
}
