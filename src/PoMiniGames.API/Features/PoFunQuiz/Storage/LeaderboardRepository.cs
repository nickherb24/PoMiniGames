using Azure;
using Azure.Data.Tables;

namespace PoMiniGames.Features.PoFunQuiz.Storage;

public class LeaderboardEntryEntity : ITableEntity
{
    public string PartitionKey { get; set; } = string.Empty;
    public string RowKey { get; set; } = Guid.NewGuid().ToString();
    public DateTimeOffset? Timestamp { get; set; }
    public ETag ETag { get; set; }
    public string PlayerName { get; set; } = string.Empty;
    public int Score { get; set; }
    public int MaxStreak { get; set; }
    public string Category { get; set; } = "General";
    public DateTime DatePlayed { get; set; }
    public int Wins { get; set; }
    public int Losses { get; set; }
}

public sealed class LeaderboardRepository(TableServiceClient tableServiceClient)
{
    private const string TableName = "PoFunQuizPlayers";
    private readonly TableClient _table = tableServiceClient.GetTableClient(TableName);

    public async Task SubmitAsync(LeaderboardEntry entry, CancellationToken cancellationToken = default)
    {
        // Server-side sanitization: override any client-supplied PlayerName with the
        // authenticated user. The caller is responsible for setting PlayerName to
        // the email claim (or "anon-<guid>" for guest mode) before invoking.
        var playerName = Truncate(Sanitize(entry.PlayerName), 32);
        var score = Math.Clamp(entry.Score, 0, 10_000); // hard cap
        var maxStreak = Math.Max(0, entry.MaxStreak);
        var datePlayed = entry.DatePlayed == default ? DateTime.UtcNow : entry.DatePlayed;
        var entity = new LeaderboardEntryEntity
        {
            PartitionKey = entry.Category.ToString(),
            // Deterministic content-hash RowKey (player + score + streak + minute bucket) so a
            // retried/duplicate POST collapses onto the same row instead of flooding the board
            // with identical entries. Bucketing DatePlayed to the minute keeps genuine retries
            // (same submission within the minute) idempotent without merging distinct runs.
            RowKey = DeterministicRowKey(playerName, score, maxStreak, entry.Category.ToString(), datePlayed),
            PlayerName = playerName,
            Score = score,
            MaxStreak = maxStreak,
            Category = entry.Category.ToString(),
            DatePlayed = datePlayed,
            Wins = Math.Max(0, entry.Wins),
            Losses = Math.Max(0, entry.Losses)
        };
        try
        {
            await _table.AddEntityAsync(entity, cancellationToken);
        }
        catch (RequestFailedException ex) when (ex.Status == 409)
        {
            // Duplicate/retried submission with identical content — already recorded.
        }
        // Graceful degradation: an unreachable Table Storage backend (Azurite down, missing
        // connection string, dev machine without Docker) must NOT 500 the score-submit
        // endpoint. Drop the write silently — the score still appears locally on the
        // player's end-of-match UI; it just doesn't make it to the persistent board. The
        // caller's high-score endpoint stays usable.
        catch (Exception)
        {
            // Intentionally ignored: see StorageService.MarkUnavailable for the same pattern.
        }
    }

    private static string DeterministicRowKey(string player, int score, int maxStreak, string category, DateTime datePlayed)
    {
        var minuteBucket = new DateTime(datePlayed.Year, datePlayed.Month, datePlayed.Day,
            datePlayed.Hour, datePlayed.Minute, 0, DateTimeKind.Utc).Ticks;
        var canonical = $"{player}|{score}|{maxStreak}|{category}|{minuteBucket}";
        var hash = System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(canonical));
        return Convert.ToHexStringLower(hash);
    }

    public async Task<IReadOnlyList<LeaderboardEntry>> GetTopAsync(QuestionCategory category, int top, CancellationToken cancellationToken = default)
    {
        top = Math.Clamp(top, 1, 100);
        var rows = new List<LeaderboardEntryEntity>();
        try
        {
            // Table Storage has no server-side ORDER BY. Scan the partition and rank in memory.
            await foreach (var entity in _table.QueryAsync<LeaderboardEntryEntity>(
                filter: $"PartitionKey eq '{category.ToString().Replace("'", "''")}'",
                maxPerPage: 1000,
                cancellationToken: cancellationToken))
            {
                rows.Add(entity);
            }
        }
        // Graceful degradation: an unreachable Table Storage backend (Azurite down, missing
        // connection string) must NOT 500 the leaderboard endpoint. Return an empty list —
        // the client pads every board to `limit` with "XXX" placeholders anyway, so the
        // empty-list path renders identically to "no scores yet". Matches StorageService's
        // behavior on the high-score boards (see StorageService.GetHighScoresAsync).
        catch (Exception)
        {
            rows.Clear();
        }
        return rows
            .OrderByDescending(r => r.Score)
            .ThenByDescending(r => r.MaxStreak)
            .ThenByDescending(r => r.DatePlayed)
            .Take(top)
            .Select(r => new LeaderboardEntry
            {
                PlayerName = r.PlayerName,
                Score = r.Score,
                MaxStreak = r.MaxStreak,
                Category = Enum.TryParse<QuestionCategory>(r.Category, out var c) ? c : QuestionCategory.General,
                DatePlayed = r.DatePlayed,
                Wins = r.Wins,
                Losses = r.Losses
            })
            .ToList();
    }

    private static string Sanitize(string s) => System.Text.RegularExpressions.Regex.Replace(s ?? string.Empty, "<.*?>", string.Empty);
    private static string Truncate(string s, int max) => s.Length <= max ? s : s[..max];
}
