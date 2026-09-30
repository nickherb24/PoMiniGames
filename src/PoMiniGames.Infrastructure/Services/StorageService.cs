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
/// Azure Table Storage-backed storage service. In development this points at the
/// Azurite emulator (connection string "UseDevelopmentStorage=true"); in production it
/// uses a real Azure Storage account via a connection string or managed identity.
/// </summary>
public partial class StorageService : IStorageService
{
    private const string PlayerStatsTable = "PlayerStats";
    private const string MarbleRaceTable = "MarbleRaceHighScores";
    private const string MarbleRaceRecordsTable = "MarbleRaceMapRecords";
    private const string PoBrawlTable = "PoBrawlHighScores";
    private const string PoBrawlLadderTable = "PoBrawlLadder";
    private const string PoBrawlEloTable = "PoBrawlFighterRatings";
    // §PoBrawlOnline (2026-09-14): the player-Elo table for live 1v1 over SignalR.
    // Distinct from PoBrawlEloTable (which rates fighters from CPU-vs-CPU demo) —
    // see PoBrawlPlayerRating's remarks for why a single table cannot serve both.
    private const string PoBrawlPlayerEloTable = "PoBrawlPlayerRatings";
    private const string PoRacerTable = "PoRacerHighScores";
    private const string PoSportsTable = "PoSportsHighScores";
    private const string PoVoxelStrikeTable = "PoVoxelStrikeHighScores";
    private const string PoCabinetTable = "PoCabinetHighScores";

    // High scores share a single partition per game so a leaderboard is one partition scan.
    private const string MarbleRacePartition = "marblerace";
    private const string PoBrawlPartition = "pobrawl";
    private const string PoBrawlLadderPartition = "pobrawlladder";
    private const string PoBrawlEloPartition = "pobrawlelo";
    private const string PoBrawlPlayerEloPartition = "pobrawlplayerelo";
    private const string PoRacerPartition = "poracer";
    private const string PoSportsPartition = "posports";
    private const string PoVoxelStrikePartition = "povoxelstrike";
    private const string PoCabinetPartition = "pocabinet";

    private readonly TableServiceClient _serviceClient;
    private readonly EloCalculator _eloCalculator;
    private readonly PairwiseEloCalculator _fighterElo;
    private readonly ILogger<StorageService> _logger;
    private readonly HashSet<string> _ensuredTables = new();
    private readonly object _ensureLock = new();

    // Storage availability tracking for graceful degradation. When storage is unreachable
    // (Azurite down, missing endpoint, etc.) every public method short-circuits with an
    // empty result or a no-op write so the rest of the app keeps working — leaderboards
    // render empty, score submissions are silently dropped, the games themselves are
    // untouched. The flag flips to false on the first failed call and stays false until a
    // throttled background probe (see IsStorageAvailable) confirms storage is reachable
    // again, at which point the service auto-recovers without any external intervention.
    private volatile bool _isStorageAvailable = true;
    private DateTime _lastProbeAttemptUtc = DateTime.MinValue;
    private readonly TimeSpan _probeBackoff = TimeSpan.FromSeconds(10);
    private readonly object _probeLock = new();
    // Table names are alphanumeric-only and must start with a letter (3-63 chars). The
    // underscore-wrapped sentinel this used to hold was rejected by the service with a
    // 400 "resource name contains invalid characters", so the probe could never succeed:
    // the first /health hit flipped storage to unavailable and the recovery probe, using
    // the same name, could never flip it back. Keep this a legal table name.
    private const string HealthProbeTableName = "PoMiniGamesStorageHealthProbe";

    // NOTE (2026-09-11): there is deliberately no in-memory fallback here any more.
    // StorageService used to hand off to an InMemoryStorageService whenever Table Storage
    // was unreachable, which meant a storage outage in Production silently redirected every
    // score into process memory — and on F1 (no AlwaysOn, so idle means recycle) that memory
    // is gone minutes later. It duplicated, worse, a durability mechanism the client already
    // has: PendingScoreStore parks a failed submit in localStorage and ScoreSyncService
    // flushes it when the API comes back. Unreachable storage now takes the path this class
    // already implemented for it — reads return empty, writes are skipped, the health check
    // reports Degraded, and the client keeps the score until the write actually lands.

    internal static readonly HashSet<char> _invalidChars =
        Path.GetInvalidFileNameChars()
            .Concat(new[] { '\'', '"', ';', '\\', '/', '#', '?', '\t', '\n', '\r' })
            .ToHashSet();

    public StorageService(
        IConfiguration configuration,
        EloCalculator eloCalculator,
        PairwiseEloCalculator fighterElo,
        ILogger<StorageService>? logger = null)
    {
        _eloCalculator = eloCalculator;
        _fighterElo = fighterElo;
        // Optional so the test harnesses that construct this service by hand keep working;
        // the container always supplies one.
        _logger = logger ?? NullLogger<StorageService>.Instance;

        var section = configuration.GetSection("PoMiniGames:Storage:TableService");
        var connectionString = section["ConnectionString"];
        var endpoint = section["Endpoint"];
        var accountName = section["AccountName"];

        // Fast-fail options: a 2s network timeout with no retries means a single unreachable
        // backend (e.g., Docker not running so Azurite is not listening) surfaces within a
        // couple of seconds per call rather than the SDK's default ~30s retry chain. The
        // graceful-degradation path (MarkUnavailable + the in-memory fallback) takes over
        // from there; the rest of the app never sees the wait.
        var options = new TableClientOptions
        {
            Retry = { MaxRetries = 0, NetworkTimeout = TimeSpan.FromSeconds(2) },
        };

        if (!string.IsNullOrWhiteSpace(connectionString))
        {
            _serviceClient = new TableServiceClient(connectionString, options);
        }
        else if (!string.IsNullOrWhiteSpace(endpoint) || !string.IsNullOrWhiteSpace(accountName))
        {
            var serviceUri = !string.IsNullOrWhiteSpace(endpoint)
                ? new Uri(endpoint!)
                : new Uri($"https://{accountName}.table.core.windows.net");
            _serviceClient = new TableServiceClient(serviceUri, new DefaultAzureCredential(), options);
        }
        else
        {
            // Default to the Azurite emulator so local dev works out of the box.
            _serviceClient = new TableServiceClient("UseDevelopmentStorage=true", options);
        }
    }

    /// <summary>
    /// Best-effort eager creation of all tables at startup. If storage is briefly unreachable
    /// the app still starts; tables are also ensured lazily on first use (see <see cref="Table"/>).
    /// </summary>
    public void Initialize()
    {
        Exception? firstFailure = null;
        foreach (var table in new[] { PlayerStatsTable, MarbleRaceTable, MarbleRaceRecordsTable, PoBrawlTable, PoBrawlLadderTable, PoBrawlEloTable, PoBrawlPlayerEloTable, PoRacerTable, PoSportsTable, PoVoxelStrikeTable })
        {
            try { Table(table); }
            catch (Exception ex)
            {
                firstFailure ??= ex;
                /* ensured lazily on first use */
            }
        }

        // If any table failed to ensure, flip the availability flag up front so the first
        // real request short-circuits instead of waiting for the throttled re-probe.
        if (firstFailure is not null)
        {
            MarkUnavailable(firstFailure);
        }
    }

    // Returns the client, creating the table once per name (cached).
    private TableClient Table(string name)
    {
        var client = _serviceClient.GetTableClient(name);
        bool firstTime;
        lock (_ensureLock)
        {
            firstTime = _ensuredTables.Add(name);
        }
        if (firstTime)
        {
            client.CreateIfNotExists();
        }
        return client;
    }

    // ── Storage availability probe ───────────────────────────────────────
    // Used by every public method to decide whether to attempt the call, and by the
    // storage health check to report the actual state to /api/health. Probing is bounded
    // by a 500 ms cancellation token so neither request threads nor the health endpoint
    // hang when storage is unreachable.

    /// <summary>
    /// True if the most recent probe succeeded, or the most recent call succeeded. When
    /// false, callers MUST short-circuit with their empty/no-op fallback. Re-probes are
    /// throttled by <see cref="_probeBackoff"/> so a down storage isn't hammered.
    /// </summary>
    private bool IsStorageAvailable()
    {
        if (_isStorageAvailable) return true;

        // Throttle re-probes while we're in the "unavailable" state so a downed Azurite
        // doesn't get one probe per request.
        if (DateTime.UtcNow - _lastProbeAttemptUtc < _probeBackoff) return false;

        lock (_probeLock)
        {
            if (_isStorageAvailable) return true;
            if (DateTime.UtcNow - _lastProbeAttemptUtc < _probeBackoff) return false;
            _lastProbeAttemptUtc = DateTime.UtcNow;

            try
            {
                using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(500));
                _serviceClient.GetTableClient(HealthProbeTableName)
                    .CreateIfNotExistsAsync(cts.Token)
                    .GetAwaiter()
                    .GetResult();
                _isStorageAvailable = true;
                _logger.LogInformation("Azure Table Storage is reachable again; high score functionality restored.");
                return true;
            }
            catch
            {
                // Stay unavailable. The next call after _probeBackoff will probe again.
                return false;
            }
        }
    }

    /// <summary>
    /// Marks the storage backend as unreachable. Idempotent: the warning is logged only
    /// on the healthy→unavailable transition so a long outage doesn't flood the log.
    /// </summary>
    private void MarkUnavailable(Exception ex)
    {
        if (_isStorageAvailable)
        {
            _logger.LogWarning(ex,
                "Azure Table Storage is unreachable. Scores and leaderboards will be skipped until storage recovers. Will retry periodically.");
        }
        _isStorageAvailable = false;
        _lastProbeAttemptUtc = DateTime.UtcNow;
    }

    /// <summary>
    /// Public probe used by the storage health check. Performs a short, bounded call so
    /// /api/health responds quickly when storage is unreachable, and restores the
    /// internal flag if the probe succeeds.
    /// </summary>
    public bool IsStorageHealthy()
    {
        try
        {
            using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(500));
            _serviceClient.GetTableClient(HealthProbeTableName)
                .CreateIfNotExistsAsync(cts.Token)
                .GetAwaiter()
                .GetResult();
            if (!_isStorageAvailable)
            {
                _isStorageAvailable = true;
                _logger.LogInformation("Azure Table Storage is reachable; high score functionality restored.");
            }
            return true;
        }
        catch (Exception ex)
        {
            MarkUnavailable(ex);
            return false;
        }
    }

    // ── Player stats ──────────────────────────────────────────────────────

    /// <summary>
    /// Streams every player-stats row in the table as an async sequence. The previous
    /// <c>List&lt;PlayerStatsDto&gt;</c> shape materialised the full table in memory; for
    /// the public <c>/api/statistics</c> endpoint the JSON response is also streamed
    /// (see <c>PlayerStatsEndpoints.MapGetAllPlayerStatistics</c>) so the network and
    /// the heap pressure track the page size, not the row count.
    /// </summary>
    public async IAsyncEnumerable<PlayerStatsDto> GetAllPlayerStatsAsync(
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        // Stream from a list rather than yield inside the storage try block: C# forbids
        // `yield` inside a try/catch, so the iteration lives in a non-yielding helper. The
        // list is fully populated before any item is yielded, which trades a touch of
        // memory for the ability to catch storage failures cleanly — the failure case is
        // an empty list anyway, so the memory cost only appears when storage is healthy.
        var rows = await ReadAllPlayerStatsAsync(cancellationToken).ConfigureAwait(false);
        foreach (var row in rows)
        {
            yield return row;
        }
    }

    private async Task<List<PlayerStatsDto>> ReadAllPlayerStatsAsync(CancellationToken cancellationToken)
    {
        if (!IsStorageAvailable())
        {
            return [];
        }

        var rows = new List<PlayerStatsDto>();
        try
        {
            var table = Table(PlayerStatsTable);
            await foreach (var entity in table.QueryAsync<TableEntity>(maxPerPage: 1000, cancellationToken: cancellationToken))
            {
                var json = entity.GetString("StatsJson");
                if (string.IsNullOrEmpty(json)) continue;
                var stats = JsonSerializer.Deserialize<PlayerStats>(json);
                if (stats is null) continue;
                rows.Add(new PlayerStatsDto
                {
                    Game = entity.PartitionKey,
                    Name = entity.RowKey,
                    Stats = stats,
                });
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            MarkUnavailable(ex);
            rows.Clear();
        }
        return rows;
    }

    public async Task<PlayerStats?> GetPlayerStatsAsync(string game, string playerName)
    {
        var sanitizedGame = SanitizeName(game);
        var sanitizedName = SanitizeName(playerName);
        if (string.IsNullOrWhiteSpace(sanitizedGame) || string.IsNullOrWhiteSpace(sanitizedName))
        {
            return null;
        }

        if (!IsStorageAvailable())
        {
            return null;
        }

        try
        {
            var response = await Table(PlayerStatsTable).GetEntityAsync<TableEntity>(sanitizedGame, sanitizedName);
            var json = response.Value.GetString("StatsJson");
            return json is null ? null : JsonSerializer.Deserialize<PlayerStats>(json);
        }
        catch (RequestFailedException ex) when (ex.Status == 404)
        {
            return null;
        }
        catch (Exception ex)
        {
            MarkUnavailable(ex);
            return null;
        }
    }

    public async Task SavePlayerStatsAsync(string game, string playerName, PlayerStats stats)
    {
        var sanitizedGame = SanitizeName(game);
        var sanitizedName = SanitizeName(playerName);

        if (string.IsNullOrWhiteSpace(sanitizedGame))
        {
            throw new ArgumentException("Game cannot be empty", nameof(game));
        }

        if (string.IsNullOrWhiteSpace(sanitizedName))
        {
            throw new ArgumentException("Player name cannot be empty", nameof(playerName));
        }

        // Storage unreachable: drop the write silently so the caller's endpoint still
        // returns success and the app keeps working. The next call after the re-probe
        // backoff will attempt storage again. When an in-memory fallback is wired in,
        // we still try that — a session-only cache is better than a hard skip because
        // it lets the user's own scores and leaderboard renders stay coherent for the
        // page-load that submitted them.
        if (!IsStorageAvailable())
        {
            return;
        }

        // §9: clamp client-supplied values into their legitimate ranges before they touch
        // storage. EloRating is client-authoritative for adaptive games but must stay within
        // the same band the client clamps to (100–3000); the ceiling here rejects a tampered
        // int.MaxValue that would otherwise own the leaderboard.
        ClampStats(stats);

        BackfillLegacyElo(stats);
        stats.UpdatedAt = DateTime.UtcNow;

        // §1/§2: read-modify-write under optimistic concurrency. The client sends ABSOLUTE
        // totals, so a blind replace lets a stale client regress another writer's counters.
        // We merge against the stored row — monotonic counters take the max, non-monotonic
        // fields (WinStreak, EloRating) take the latest value — so a concurrent finish can
        // never lose accumulated wins/games.
        var partition = sanitizedGame;
        var rowKey = sanitizedName;
        try
        {
            await TableConcurrency.UpdateWithRetryAsync<TableEntity>(
                Table(PlayerStatsTable),
                partitionKey: partition,
                rowKey: rowKey,
                factory: () => new TableEntity(partition, rowKey),
                mutate: e =>
                {
                    var existingJson = e.GetString("StatsJson");
                    var merged = stats;
                    if (!string.IsNullOrEmpty(existingJson))
                    {
                        var existing = JsonSerializer.Deserialize<PlayerStats>(existingJson);
                        if (existing is not null) merged = MergeStats(existing, stats);
                    }
                    var mergedJson = JsonSerializer.Serialize(merged);
                    if (existingJson == mergedJson) return false; // idempotent no-op
                    e["StatsJson"] = mergedJson;
                    e["UpdatedAt"] = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ");
                    return true;
                });
        }
        catch (Exception ex)
        {
            MarkUnavailable(ex);
            // Silent drop — matches the high-score save path's policy. The endpoint
            // already validated the payload, so the failure is purely a transport issue.
        }
    }

    // §9: clamp each difficulty bucket into its legitimate range. Counters are non-negative;
    // EloRating is bounded to [0, 3000] (the adaptive client's own clamp ceiling).
    private static void ClampStats(PlayerStats stats)
    {
        foreach (var b in new[] { stats.Easy, stats.Medium, stats.Hard })
        {
            b.Wins = Math.Max(0, b.Wins);
            b.Losses = Math.Max(0, b.Losses);
            b.Draws = Math.Max(0, b.Draws);
            b.TotalGames = Math.Max(0, b.TotalGames);
            b.WinStreak = Math.Max(0, b.WinStreak);
            b.EloRating = Math.Clamp(b.EloRating, 0, 3000);
        }
    }

    // Backfill ELO only when the client sent none (legacy clients that never computed a
    // rating — detected as "played games but every bucket's EloRating is 0"). Clients that
    // DO send ratings — the adaptive-ELO games (ConnectFive/TicTacToe) mirror their evolving
    // skill rating into the bucket — must not have them overwritten by the legacy W/L
    // formula. Single definition shared by the save and leaderboard-read paths so the
    // legacy-record rule cannot drift between them.
    private void BackfillLegacyElo(PlayerStats stats)
    {
        if (stats.TotalGames > 0 &&
            stats.Easy.EloRating == 0 && stats.Medium.EloRating == 0 && stats.Hard.EloRating == 0)
        {
            _eloCalculator.ApplyAll(stats);
        }
    }

    // §2: merge two absolute snapshots. Monotonic counters take the max so a stale write can't
    // regress totals; WinStreak/EloRating take the incoming (latest) value.
    private static PlayerStats MergeStats(PlayerStats existing, PlayerStats incoming)
    {
        static DifficultyStats Merge(DifficultyStats e, DifficultyStats i) => new()
        {
            Wins = Math.Max(e.Wins, i.Wins),
            Losses = Math.Max(e.Losses, i.Losses),
            Draws = Math.Max(e.Draws, i.Draws),
            TotalGames = Math.Max(e.TotalGames, i.TotalGames),
            WinStreak = i.WinStreak,
            EloRating = i.EloRating,
        };
        return new PlayerStats
        {
            PlayerId = string.IsNullOrEmpty(incoming.PlayerId) ? existing.PlayerId : incoming.PlayerId,
            PlayerName = string.IsNullOrEmpty(incoming.PlayerName) ? existing.PlayerName : incoming.PlayerName,
            Easy = Merge(existing.Easy, incoming.Easy),
            Medium = Merge(existing.Medium, incoming.Medium),
            Hard = Merge(existing.Hard, incoming.Hard),
            CreatedAt = existing.CreatedAt == default ? incoming.CreatedAt : existing.CreatedAt,
            UpdatedAt = incoming.UpdatedAt,
        };
    }

    public async Task<List<(string Name, PlayerStats Stats)>> GetLeaderboardAsync(string game, int limit, string? difficulty = null)
    {
        var sanitizedGame = SanitizeName(game);
        if (string.IsNullOrWhiteSpace(sanitizedGame))
        {
            return [];
        }

        if (!IsStorageAvailable())
        {
            return [];
        }

        // Table Storage has no server-side ordering, so scan the game's partition and rank in
        // memory. Leaderboards are small, so this is cheap.
        var rows = new List<(string Name, PlayerStats Stats)>();
        try
        {
            await foreach (var entity in Table(PlayerStatsTable).QueryAsync<TableEntity>(
                filter: $"PartitionKey eq '{sanitizedGame.Replace("'", "''")}'",
                maxPerPage: 1000))
            {
                var json = entity.GetString("StatsJson");
                if (string.IsNullOrEmpty(json)) continue;
                var stats = JsonSerializer.Deserialize<PlayerStats>(json) ?? new PlayerStats();

                BackfillLegacyElo(stats);

                rows.Add((entity.RowKey, stats));
            }

            var diff = difficulty?.Trim().ToLowerInvariant();
            IEnumerable<(string Name, PlayerStats Stats)> ranked = diff switch
            {
                "easy" => rows.Where(r => r.Stats.Easy.TotalGames > 0)
                              .OrderByDescending(r => r.Stats.Easy.EloRating)
                              .ThenByDescending(r => r.Stats.Easy.TotalGames),
                "medium" => rows.Where(r => r.Stats.Medium.TotalGames > 0)
                              .OrderByDescending(r => r.Stats.Medium.EloRating)
                              .ThenByDescending(r => r.Stats.Medium.TotalGames),
                "hard" => rows.Where(r => r.Stats.Hard.TotalGames > 0)
                              .OrderByDescending(r => r.Stats.Hard.EloRating)
                              .ThenByDescending(r => r.Stats.Hard.TotalGames),
                _ => rows.OrderByDescending(r => r.Stats.WinRate)
                         .ThenByDescending(r => r.Stats.TotalGames),
            };

            return ranked.Take(limit).ToList();
        }
        catch (Exception ex)
        {
            MarkUnavailable(ex);
            return [];
        }
    }
    // ── Helpers ─────────────────────────────────────────────────────────

    private static string DefaultDate(string? date) =>
        string.IsNullOrWhiteSpace(date)
            ? DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
            : date;

    // Full display name, capped for table hygiene. Boards show the same name the
    // GameShell header shows — never initials or ids.
    private static string DisplayName24(string raw)
    {
        var s = SanitizeName(raw);
        return s.Length > 24 ? s[..24] : s;
    }


    /// <summary>
    /// The RowKey form of a player name, exposed for callers outside this assembly that must
    /// find a player's stored rows without re-deriving the rule. Added for the account
    /// export/erase path (Features/Account), which has to locate name-keyed rows exactly the
    /// way <see cref="SavePlayerStatsAsync"/> wrote them — a second, drifting copy of this
    /// normalisation would silently leave rows behind on an erase the player asked for.
    /// </summary>
    public static string NormalizePlayerKey(string input) => SanitizeName(input);

    internal static string SanitizeName(string input)
    {
        if (string.IsNullOrEmpty(input))
        {
            return string.Empty;
        }

        var sb = new System.Text.StringBuilder(input.Length);
        foreach (var c in input)
        {
            if (!_invalidChars.Contains(c) && c >= 0x20)
            {
                sb.Append(c);
            }
        }

        return sb.ToString().Trim();
    }
}
