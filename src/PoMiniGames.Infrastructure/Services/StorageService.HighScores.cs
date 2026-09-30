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
/// The descriptor-driven high-score boards: one <see cref="HighScoreDescriptor{T}"/> per game
/// plus the single generic read/write flow every one of them shares.
/// </summary>
/// <remarks>
/// Split out of StorageService.cs on 2026-09-12, which had grown to 1,240 lines and was the
/// largest file in the solution. The seam is the one the class already had: these boards are
/// best-result ratchets expressible as a descriptor, whereas the PoBrawl ladder and fighter
/// Elo in StorageService.PoBrawl.cs are accumulators that a descriptor cannot describe.
/// To add a leaderboard, add a descriptor here — declare RowKeyFields as immutable identity
/// fields only (usually the player, not the score) and use ShouldOverwrite so a worse later
/// run cannot clobber a better one.
/// </remarks>
public partial class StorageService
{
    // ── High scores ───────────────────────────────────────────────────────
    // Each game is one descriptor; the save/get flow below is shared by all of them.

    private static readonly HighScoreDescriptor<MarbleRaceHighScore> MarbleRaceScores = new(
        Table: MarbleRaceTable,
        Partition: MarbleRacePartition,
        Sanitize: e => e with
        {
            // One identity across boards: full display name (legacy rows hold initials).
            PlayerInitials = DisplayName24(e.PlayerInitials),
            UserId = e.UserId ?? "",
            BestScore = MarbleRaceScore.Clamp(e.BestScore),
            AchievedAtUtc = e.AchievedAtUtc == default ? DateTimeOffset.UtcNow : e.AchievedAtUtc,
        },
        ToFields: e => new Dictionary<string, object?>
        {
            ["PlayerInitials"] = e.PlayerInitials,
            ["UserId"] = e.UserId,
            ["IsGuest"] = e.IsGuest,
            ["BestScore"] = e.BestScore,
            // Stored as an ISO-8601 string, not a native DateTimeOffset: legacy rows wrote a
            // string, and a column holding both types breaks GetString on read.
            ["Date"] = e.AchievedAtUtc.ToString("yyyy-MM-ddTHH:mm:ssZ"),
        },
        FromEntity: e => new MarbleRaceHighScore
        {
            PlayerInitials = e.GetString("PlayerInitials") ?? "",
            // Legacy rows predate identity columns: no UserId means it can't be attributed to a
            // real account, so it reads back as a guest row.
            UserId = e.GetString("UserId") ?? "",
            IsGuest = e.GetBoolean("IsGuest") ?? true,
            BestScore = e.GetInt32("BestScore") ?? 0,
            AchievedAtUtc = DateTimeOffset.TryParse(e.GetString("Date"), out var d) ? d : default,
        },
        // Identity is the player — (UserId, IsGuest) rather than the display name, so a guest
        // can't write onto a signed-in player's row by copying their name. Deliberately NOT
        // keyed on BestScore: the client submits on every new personal best, so a session that
        // scored 10 would post 1,2,3…10 and mint ten rows, letting one player fill a board that
        // ranks "highest score wins". One row per player, ratcheted by ShouldOverwrite below.
        RowKeyFields: ["PlayerInitials", "UserId", "IsGuest"],
        // Highest score wins, oldest first as the tiebreaker.
        Rank: s => s.OrderByDescending(x => x.BestScore).ThenBy(x => x.AchievedAtUtc))
    {
        // One row per player means every submission targets the same row, so a later, worse run
        // would otherwise erase a better one. Mirrors the PoBrawl ladder's ratchet.
        ShouldOverwrite = (existing, incoming) =>
            (incoming.TryGetValue("BestScore", out var v) ? v as int? ?? 0 : 0) > (existing.GetInt32("BestScore") ?? -1),
    };

    // World record per PoMarbleRace map: the row IS the map (RowKey = MapId), and only a faster
    // finish replaces it — the same ratchet as the player boards, keyed on the map instead.
    private static readonly HighScoreDescriptor<MarbleRaceMapRecord> MarbleRaceRecords = new(
        Table: MarbleRaceRecordsTable,
        Partition: MarbleRacePartition,
        Sanitize: e => e with
        {
            PlayerName = DisplayName24(e.PlayerName),
            UserId = e.UserId ?? "",
            Seconds = Math.Clamp(e.Seconds, 0, 180),
            AchievedAtUtc = e.AchievedAtUtc == default ? DateTimeOffset.UtcNow : e.AchievedAtUtc,
        },
        ToFields: e => new Dictionary<string, object?>
        {
            ["MapId"] = e.MapId,
            ["Seconds"] = e.Seconds,
            ["PlayerName"] = e.PlayerName,
            ["UserId"] = e.UserId,
            ["IsGuest"] = e.IsGuest,
            ["Date"] = e.AchievedAtUtc.ToString("yyyy-MM-ddTHH:mm:ssZ"),
        },
        FromEntity: e => new MarbleRaceMapRecord
        {
            MapId = e.GetInt32("MapId") ?? 0,
            Seconds = e.GetDouble("Seconds") ?? 0d,
            PlayerName = e.GetString("PlayerName") ?? "",
            UserId = e.GetString("UserId") ?? "",
            IsGuest = e.GetBoolean("IsGuest") ?? true,
            AchievedAtUtc = DateTimeOffset.TryParse(e.GetString("Date"), out var d) ? d : default,
        },
        RowKeyFields: ["MapId"],
        Rank: s => s.OrderBy(x => x.MapId))
    {
        ShouldOverwrite = (existing, incoming) =>
            (incoming.TryGetValue("Seconds", out var v) ? v as double? ?? double.MaxValue : double.MaxValue)
                < (existing.GetDouble("Seconds") ?? double.MaxValue),
    };

    public Task<List<MarbleRaceMapRecord>> GetMarbleRaceMapRecordsAsync() =>
        GetHighScoresAsync(MarbleRaceRecords, 50);

    public Task<MarbleRaceMapRecord> SaveMarbleRaceMapRecordAsync(MarbleRaceMapRecord entry) =>
        SaveHighScoreAsync(MarbleRaceRecords, entry);

    private static readonly HighScoreDescriptor<PoBrawlHighScore> PoBrawlScores = new(
        Table: PoBrawlTable,
        Partition: PoBrawlPartition,
        Sanitize: e => e with
        {
            // One identity across boards: full display name (legacy rows hold initials).
            PlayerInitials = DisplayName24(e.PlayerInitials),
            Character = SanitizeName(e.Character),
            Date = DefaultDate(e.Date),
        },
        ToFields: e => new Dictionary<string, object?>
        {
            ["PlayerInitials"] = e.PlayerInitials,
            ["KoTimeSeconds"] = e.KoTimeSeconds,
            ["Character"] = e.Character,
            ["Date"] = e.Date,
        },
        FromEntity: e => new PoBrawlHighScore
        {
            PlayerInitials = e.GetString("PlayerInitials") ?? "",
            KoTimeSeconds = e.GetDouble("KoTimeSeconds") ?? 0d,
            Character = e.GetString("Character") ?? "",
            Date = e.GetString("Date") ?? "",
        },
        RowKeyFields: ["Character", "KoTimeSeconds", "PlayerInitials"],
        // Fastest KO wins, oldest first as the tiebreaker.
        Rank: s => s.OrderBy(x => x.KoTimeSeconds).ThenBy(x => x.Date));

    private static readonly HighScoreDescriptor<PoVoxelStrikeHighScore> PoVoxelStrikeScores = new(
        Table: PoVoxelStrikeTable,
        Partition: PoVoxelStrikePartition,
        Sanitize: e => e with
        {
            PlayerName = DisplayName24(e.PlayerName),
            UserId = e.UserId ?? "",
            Score = PoVoxelStrikeScore.Clamp(e.Score),
            SurvivalSeconds = Math.Clamp(e.SurvivalSeconds, 0, 14_400),
            Kills = Math.Max(0, e.Kills),
            BruteKills = Math.Max(0, e.BruteKills),
            CrushKills = Math.Max(0, e.CrushKills),
            VoxelsDestroyed = Math.Max(0, e.VoxelsDestroyed),
            AchievedAtUtc = e.AchievedAtUtc == default ? DateTimeOffset.UtcNow : e.AchievedAtUtc,
        },
        ToFields: e => new Dictionary<string, object?>
        {
            ["PlayerName"] = e.PlayerName,
            ["UserId"] = e.UserId,
            ["IsGuest"] = e.IsGuest,
            ["Score"] = e.Score,
            ["SurvivalSeconds"] = e.SurvivalSeconds,
            ["Kills"] = e.Kills,
            ["BruteKills"] = e.BruteKills,
            ["CrushKills"] = e.CrushKills,
            ["VoxelsDestroyed"] = e.VoxelsDestroyed,
            // ISO-8601 string, matching every sibling board's date convention.
            ["Date"] = e.AchievedAtUtc.ToString("yyyy-MM-ddTHH:mm:ssZ"),
        },
        FromEntity: e => new PoVoxelStrikeHighScore
        {
            PlayerName = e.GetString("PlayerName") ?? "",
            UserId = e.GetString("UserId") ?? "",
            IsGuest = e.GetBoolean("IsGuest") ?? true,
            Score = e.GetInt32("Score") ?? 0,
            SurvivalSeconds = e.GetDouble("SurvivalSeconds") ?? 0d,
            Kills = e.GetInt32("Kills") ?? 0,
            BruteKills = e.GetInt32("BruteKills") ?? 0,
            CrushKills = e.GetInt32("CrushKills") ?? 0,
            VoxelsDestroyed = e.GetInt32("VoxelsDestroyed") ?? 0,
            AchievedAtUtc = DateTimeOffset.TryParse(e.GetString("Date"), out var d) ? d : default,
        },
        // Identity is the player (mirrors MarbleRaceScores): one row per (name, account,
        // guest-ness), never keyed on the score — every run submits, and score-keyed rows
        // would let one player fill the whole board.
        RowKeyFields: ["PlayerName", "UserId", "IsGuest"],
        Rank: s => s.OrderByDescending(x => x.Score).ThenBy(x => x.AchievedAtUtc))
    {
        // Best-result ratchet: a later, worse run must not erase a better one.
        ShouldOverwrite = (existing, incoming) =>
            (incoming.TryGetValue("Score", out var v) ? v as int? ?? 0 : 0) > (existing.GetInt32("Score") ?? -1),
    };

    public Task<List<PoVoxelStrikeHighScore>> GetPoVoxelStrikeHighScoresAsync(int limit = 10) =>
        GetHighScoresAsync(PoVoxelStrikeScores, limit);

    public Task<PoVoxelStrikeHighScore> SavePoVoxelStrikeHighScoreAsync(PoVoxelStrikeHighScore entry) =>
        SaveHighScoreAsync(PoVoxelStrikeScores, entry);

    public Task<List<MarbleRaceHighScore>> GetMarbleRaceHighScoresAsync(int limit = 10) =>
        GetHighScoresAsync(MarbleRaceScores, limit);

    public Task<MarbleRaceHighScore> SaveMarbleRaceHighScoreAsync(MarbleRaceHighScore entry) =>
        SaveHighScoreAsync(MarbleRaceScores, entry);

    public Task<List<PoBrawlHighScore>> GetPoBrawlHighScoresAsync(int limit = 10) =>
        GetHighScoresAsync(PoBrawlScores, limit);

    public Task<PoBrawlHighScore> SavePoBrawlHighScoreAsync(PoBrawlHighScore entry) =>
        SaveHighScoreAsync(PoBrawlScores, entry);

    // ── PoRacer High Scores ───────────────────────────────────────────────
    // Server-side identity is authoritative: the client-supplied PlayerName
    // is replaced with the auth-cookie value before persistence. The row
    // is deduped by a hash of the immutable content (name + time + position +
    // minute-bucketed date) so retry-after-timeout collapses onto the same row.
    private static readonly HighScoreDescriptor<PoRacerHighScore> PoRacerScores = new(
        Table: PoRacerTable,
        Partition: PoRacerPartition,
        Sanitize: e => new PoRacerHighScore
        {
            PlayerName = SanitizeName(e.PlayerName),
            UserId = string.IsNullOrWhiteSpace(e.UserId) ? "" : e.UserId,
            TrackId = string.IsNullOrWhiteSpace(e.TrackId) ? "circuit" : e.TrackId.Trim().ToLowerInvariant(),
            TotalTimeSeconds = Math.Clamp(e.TotalTimeSeconds, 0.001, 3600),
            FinalPosition = Math.Clamp(e.FinalPosition, 1, 8),
            IsGuest = e.IsGuest,
            Date = DefaultDate(e.Date),
            GameCode = SanitizeName(e.GameCode),
        },
        ToFields: e => new Dictionary<string, object?>
        {
            ["PlayerName"] = e.PlayerName,
            ["UserId"] = e.UserId,
            ["TrackId"] = e.TrackId,
            ["TotalTimeSeconds"] = e.TotalTimeSeconds,
            ["FinalPosition"] = e.FinalPosition,
            ["IsGuest"] = e.IsGuest,
            ["Date"] = e.Date,
            ["GameCode"] = e.GameCode,
        },
        FromEntity: e => new PoRacerHighScore
        {
            PlayerName = e.GetString("PlayerName") ?? "",
            UserId = e.GetString("UserId") ?? "",
            TrackId = e.GetString("TrackId") ?? "circuit",
            TotalTimeSeconds = e.GetDouble("TotalTimeSeconds") ?? 0d,
            FinalPosition = e.GetInt32("FinalPosition") ?? 0,
            IsGuest = e.GetBoolean("IsGuest") ?? false,
            Date = e.GetString("Date") ?? "",
            GameCode = e.GetString("GameCode") ?? "",
        },
        RowKeyFields: ["FinalPosition", "PlayerName", "TotalTimeSeconds", "UserId", "TrackId"],
        // Lowest race time wins; oldest submission breaks ties.
        Rank: s => s.OrderBy(x => x.TotalTimeSeconds).ThenBy(x => x.Date));

    public static string PoRacerTrackPartition(string? trackId) =>
        string.IsNullOrWhiteSpace(trackId) || trackId.Equals("circuit", StringComparison.OrdinalIgnoreCase)
            ? "poracer_circuit"
            : $"poracer_{trackId.Trim().ToLowerInvariant()}";

    public Task<List<PoRacerHighScore>> GetPoRacerHighScoresAsync(int limit = 10, string? trackId = null)
    {
        if (string.IsNullOrWhiteSpace(trackId) || trackId.Equals("circuit", StringComparison.OrdinalIgnoreCase))
        {
            return GetHighScoresAsync(PoRacerScores, limit, partition: "poracer_circuit", customFilter: "PartitionKey eq 'poracer_circuit' or PartitionKey eq 'poracer'");
        }
        var partition = PoRacerTrackPartition(trackId);
        return GetHighScoresAsync(PoRacerScores, limit, partition: partition);
    }

    public Task<PoRacerHighScore> SavePoRacerHighScoreAsync(PoRacerHighScore entry)
    {
        var partition = PoRacerTrackPartition(entry.TrackId);
        return SaveHighScoreAsync(PoRacerScores, entry, partition: partition, requirePersistence: true);
    }

    // ── PoSports High Scores ──────────────────────────────────────────────
    // Lowest combined meet time wins. One row per player — identity-keyed like
    // MarbleRace (not score-keyed like PoRacer), because the client submits after
    // every meet: score-keyed rows would let one player fill the whole board.
    // ShouldOverwrite ratchets DOWN — a later, slower meet can't erase a PB.
    private static readonly HighScoreDescriptor<PoSportsHighScore> PoSportsScores = new(
        Table: PoSportsTable,
        Partition: PoSportsPartition,
        Sanitize: e => new PoSportsHighScore
        {
            PlayerName = DisplayName24(e.PlayerName),
            UserId = string.IsNullOrWhiteSpace(e.UserId) ? "" : e.UserId,
            IsGuest = e.IsGuest,
            TotalTimeSeconds = Math.Clamp(e.TotalTimeSeconds, 0.001, 600),
            SprintSeconds = Math.Clamp(e.SprintSeconds, 0, 300),
            HurdlesSeconds = Math.Clamp(e.HurdlesSeconds, 0, 300),
            Character = SanitizeName(e.Character),
            Date = DefaultDate(e.Date),
            GameCode = SanitizeName(e.GameCode),
        },
        ToFields: e => new Dictionary<string, object?>
        {
            ["PlayerName"] = e.PlayerName,
            ["UserId"] = e.UserId,
            ["IsGuest"] = e.IsGuest,
            ["TotalTimeSeconds"] = e.TotalTimeSeconds,
            ["SprintSeconds"] = e.SprintSeconds,
            ["HurdlesSeconds"] = e.HurdlesSeconds,
            ["Character"] = e.Character,
            ["Date"] = e.Date,
            ["GameCode"] = e.GameCode,
        },
        FromEntity: e => new PoSportsHighScore
        {
            PlayerName = e.GetString("PlayerName") ?? "",
            UserId = e.GetString("UserId") ?? "",
            // No identity columns → unattributable, so it reads back as a guest row.
            IsGuest = e.GetBoolean("IsGuest") ?? true,
            TotalTimeSeconds = e.GetDouble("TotalTimeSeconds") ?? 0d,
            SprintSeconds = e.GetDouble("SprintSeconds") ?? 0d,
            HurdlesSeconds = e.GetDouble("HurdlesSeconds") ?? 0d,
            Character = e.GetString("Character") ?? "",
            Date = e.GetString("Date") ?? "",
            GameCode = e.GetString("GameCode") ?? "",
        },
        // Identity is the player, not the score — see the MarbleRace note above.
        RowKeyFields: ["PlayerName", "UserId", "IsGuest"],
        // Fastest meet wins, oldest first as the tiebreaker.
        Rank: s => s.OrderBy(x => x.TotalTimeSeconds).ThenBy(x => x.Date))
    {
        // One row per player: only a strictly faster meet may replace the stored PB.
        ShouldOverwrite = (existing, incoming) =>
            (incoming.TryGetValue("TotalTimeSeconds", out var v) ? v as double? ?? double.MaxValue : double.MaxValue)
                < (existing.GetDouble("TotalTimeSeconds") ?? double.MaxValue),
    };

    public Task<List<PoSportsHighScore>> GetPoSportsHighScoresAsync(int limit = 10) =>
        GetHighScoresAsync(PoSportsScores, limit);

    public Task<PoSportsHighScore> SavePoSportsHighScoreAsync(PoSportsHighScore entry) =>
        SaveHighScoreAsync(PoSportsScores, entry);

    // ── PoCabinet High Scores (T5) ────────────────────────────────────────────
    // TrackId partitions the leaderboard: Capitol best-lap never competes with
    // Mar-a-Lago best-lap. Identity-keyed on (player + track) — one row per
    // (player, track), ratcheted by ShouldOverwrite to only accept a faster lap.
    private static readonly HighScoreDescriptor<PoCabinetHighScore> PoCabinetScores = new(
        Table: PoCabinetTable,
        Partition: PoCabinetPartition,
        Sanitize: e => new PoCabinetHighScore
        {
            PlayerName = DisplayName24(e.PlayerName),
            UserId = string.IsNullOrWhiteSpace(e.UserId) ? "" : e.UserId,
            // T5 (2026-09-17): an unknown track id defaults to "capitol" per the spec —
            // the OpenAPI contract pins this fallback. Future tracks added to the catalog
            // will fall through to default as well until the descriptor is updated.
            TrackId = string.IsNullOrWhiteSpace(e.TrackId) ? "capitol" : e.TrackId.Trim().ToLowerInvariant(),
            BestLapSeconds = double.IsFinite(e.BestLapSeconds) ? Math.Clamp(e.BestLapSeconds, 0.001, 3600) : 0,
            FinalPosition = e.FinalPosition is >= 1 and <= 9 ? e.FinalPosition : 1,
            IsGuest = e.IsGuest,
            Date = DefaultDate(e.Date),
            GameCode = SanitizeName(e.GameCode),
        },
        ToFields: e => new Dictionary<string, object?>
        {
            ["PlayerName"] = e.PlayerName,
            ["UserId"] = e.UserId,
            ["TrackId"] = e.TrackId,
            ["BestLapSeconds"] = e.BestLapSeconds,
            ["FinalPosition"] = e.FinalPosition,
            ["IsGuest"] = e.IsGuest,
            ["Date"] = e.Date,
            ["GameCode"] = e.GameCode,
        },
        FromEntity: e => new PoCabinetHighScore
        {
            PlayerName = e.GetString("PlayerName") ?? "",
            UserId = e.GetString("UserId") ?? "",
            TrackId = e.GetString("TrackId") ?? "capitol",
            BestLapSeconds = e.GetDouble("BestLapSeconds") ?? 0d,
            FinalPosition = e.GetInt32("FinalPosition") ?? 0,
            IsGuest = e.GetBoolean("IsGuest") ?? false,
            Date = e.GetString("Date") ?? "",
            GameCode = e.GetString("GameCode") ?? "",
        },
        RowKeyFields: ["PlayerName", "UserId", "IsGuest", "TrackId"],
        // Fastest lap wins, oldest first as the tiebreaker (so the first 1:23.45 stays on top
        // when someone later matches it).
        Rank: s => s.OrderBy(x => x.BestLapSeconds).ThenBy(x => x.Date))
    {
        // One row per (player, track): only a strictly faster lap may replace the stored PB.
        ShouldOverwrite = (existing, incoming) =>
            (incoming.TryGetValue("BestLapSeconds", out var v) ? v as double? ?? double.MaxValue : double.MaxValue)
                < (existing.GetDouble("BestLapSeconds") ?? double.MaxValue),
    };

    public Task<List<PoCabinetHighScore>> GetPoCabinetHighScoresAsync(int limit = 10, string? trackId = null)
    {
        if (string.IsNullOrWhiteSpace(trackId))
        {
            return GetHighScoresAsync(PoCabinetScores, limit);
        }
        var partition = string.Equals(trackId, "capitol", StringComparison.OrdinalIgnoreCase)
            ? PoCabinetPartition
            : $"pocabinet_{trackId.Trim().ToLowerInvariant()}";
        return GetHighScoresAsync(PoCabinetScores, limit, partition: partition);
    }

    public Task<PoCabinetHighScore> SavePoCabinetHighScoreAsync(PoCabinetHighScore entry)
    {
        var partition = string.Equals(entry.TrackId, "capitol", StringComparison.OrdinalIgnoreCase)
            ? PoCabinetPartition
            : $"pocabinet_{entry.TrackId.Trim().ToLowerInvariant()}";
        return SaveHighScoreAsync(PoCabinetScores, entry, partition: partition, requirePersistence: true);
    }


    // The one shared high-score read: scan the game's partition, rebuild entries, rank, take.
    private async Task<List<T>> GetHighScoresAsync<T>(HighScoreDescriptor<T> descriptor, int limit, string? partition = null, string? customFilter = null)
    {
        // Storage is down: an empty board is the honest answer. There is no in-memory
        // shadow copy to read from any more (see the class header).
        if (!IsStorageAvailable()) return [];

        var scores = new List<T>();
        var filter = customFilter ?? $"PartitionKey eq '{partition ?? descriptor.Partition}'";
        try
        {
            await foreach (var e in Table(descriptor.Table).QueryAsync<TableEntity>(
                filter: filter,
                maxPerPage: 1000))
            {
                scores.Add(descriptor.FromEntity(e));
            }

            return descriptor.Rank(scores).Take(limit).ToList();
        }
        catch (Exception ex)
        {
            MarkUnavailable(ex);
            return [];
        }
    }

    // The one shared high-score write: normalise, map to a row, upsert idempotently.
    // The RowKey is derived deterministically from the row's content so a duplicate
    // HTTP request or a retry-after-timeout collapses onto the same row instead of
    // inflating the leaderboard with a second identical entry. Ranking is done in
    // memory (see GetHighScoresAsync), so RowKey ordering is irrelevant to correctness.
    private async Task<T> SaveHighScoreAsync<T>(HighScoreDescriptor<T> descriptor, T entry, string? partition = null, bool requirePersistence = false)
    {
        // Always sanitize first so the caller still gets a normalised entry back even when
        // storage is down — the endpoint's 201 Created response shape stays unchanged.
        var sanitized = descriptor.Sanitize(entry);

        // Storage is down: the write does not land. The sanitized entry still goes back so
        // the endpoint's response shape is unchanged, and the client's PendingScoreStore
        // holds the score in localStorage until ScoreSyncService can flush it for real.
        if (!IsStorageAvailable())
        {
            if (requirePersistence) throw new IOException("Score storage is unavailable.");
            return sanitized;
        }

        var fields = descriptor.ToFields(sanitized);

        // §9.1 chaos-engineering hardening: hash the row's identity fields only (submitter,
        // score, game-specific measurements). Including timestamps here would mean two
        // near-simultaneous submissions of the same score produce two distinct rows — a
        // duplicate the leaderboard then has to dedupe at read time, and a vector for cheap
        // score-flooding via bursty retries.
        var rowKey = DeterministicRowKey(fields, descriptor.RowKeyFields);
        var effectivePartition = partition ?? descriptor.Partition;

        // Concurrency-safe upsert: read existing, merge, write with ETag. Bounded retry on
        // 412/409 (see TableConcurrency).
        try
        {
            await TableConcurrency.UpdateWithRetryAsync<TableEntity>(
                Table(descriptor.Table),
                partitionKey: effectivePartition,
                rowKey: rowKey,
                factory: () => new TableEntity(effectivePartition, rowKey),
                mutate: e =>
                {
                    if (descriptor.ShouldOverwrite is not null && !descriptor.ShouldOverwrite(e, fields))
                    {
                        return false;
                    }

                    var changed = false;
                    foreach (var (key, value) in fields)
                    {
                        if (!e.TryGetValue(key, out var existing) || !Equals(existing, value))
                        {
                            e[key] = value;
                            changed = true;
                        }
                    }
                    return changed;
                });
        }
        catch (Exception ex)
        {
            MarkUnavailable(ex);
            if (requirePersistence) throw new IOException("Score storage is unavailable.", ex);
            // Returning the sanitized entry keeps the response shape stable so the client
            // doesn't have to special-case "Azurite down" — the write did not land, and the
            // client's PendingScoreStore is what holds the score until it does.
        }
        return sanitized;
    }

    // Stable content hash over the row's identity fields → idempotent, retry-safe RowKey.
    // Sorted ordinal so a descriptor's RowKeyFields order can never affect the hash.
    private static string DeterministicRowKey(IDictionary<string, object?> fields, IReadOnlyList<string> rowKeyFields)
    {
        var canonical = string.Join("", rowKeyFields
            .OrderBy(s => s, StringComparer.Ordinal)
            .Select(k => fields.TryGetValue(k, out var v) ? $"{k}={Convert.ToString(v, System.Globalization.CultureInfo.InvariantCulture)}" : $"{k}="));
        var hash = System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(canonical));
        return Convert.ToHexStringLower(hash);
    }
}
