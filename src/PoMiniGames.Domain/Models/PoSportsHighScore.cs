namespace PoMiniGames.Domain.Models;

/// <summary>
/// A single PoSports track-meet result. Stored in Azure Table Storage via
/// <c>StorageService</c> using the same <c>HighScoreDescriptor</c> strategy as
/// MarbleRace, PoBrawl, and PoRacer. Ranked by <see cref="TotalTimeSeconds"/>,
/// ascending — a track meet is won by the lowest combined time.
/// </summary>
public sealed class PoSportsHighScore
{
    public string PlayerName { get; set; } = string.Empty;
    /// <summary>Server-populated from the auth cookie (sub/oid). Empty for anonymous cookies.</summary>
    public string UserId { get; set; } = string.Empty;
    public bool IsGuest { get; set; }
    /// <summary>Ranking key: sprint + hurdles leg times, including stumble penalties.</summary>
    public double TotalTimeSeconds { get; set; }
    public double SprintSeconds { get; set; }
    /// <summary>Hurdles leg time including stumble penalties.</summary>
    public double HurdlesSeconds { get; set; }
    // No HurdlesClean here: nothing ever produced one. It was validated, clamped, stored,
    // and asserted in tests while every real row held 0, so the stat could never be shown
    // truthfully. Reintroduce it WITH a producer (the sims already count stumbles).
    /// <summary>Character key the run was made with: kim|matt|nick|tong.</summary>
    public string Character { get; set; } = string.Empty;
    /// <summary>ISO-8601 string, not a native DateTimeOffset — matches the other boards' legacy-safe storage.</summary>
    public string Date { get; set; } = string.Empty;
    /// <summary>Lobby code the score came from. Diagnostic-only; empty for single-player runs.</summary>
    public string GameCode { get; set; } = string.Empty;

    // ── Request-only fields. Neither is stored: the descriptor's Sanitize builds the row
    // from the fields above, so they never reach the table or the board read-model. ──

    /// <summary>
    /// The run's key log (format: <c>js/posports/runlog.js</c>). A solo submit must carry it:
    /// the server replays it through its own sim and stores the time IT gets, so the three
    /// time fields above are only a claim to compare against.
    /// </summary>
    public string? Inputs { get; set; }
    /// <summary>True when the run was the day's seeded meet — it is also filed on that day's board.</summary>
    public bool Daily { get; set; }
}
