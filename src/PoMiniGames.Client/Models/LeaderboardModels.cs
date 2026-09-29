namespace PoMiniGamesClient.Models;

/// <summary>
/// Display shaping for leaderboard row names. Storage keeps whatever the submitter passed
/// (display name, email slug, id slug); a rotating guest identity lands there as its full
/// "Guest-1cd4098e-288240" and turns a board into a debugger trace. Trimmed to "Guest 1CD409"
/// for display only — ranking, IsMe-style highlighting and submissions keep the raw name.
/// </summary>
public static partial class LeaderboardNames
{
    // "Guest-1cd4098e-288240" / "Guest342812" — optional separator, a hex run, then any number
    // of further separated runs (DevAuth appends a second one).
    [System.Text.RegularExpressions.GeneratedRegex(
        "^Guest[-_\\s]?([0-9a-f]{6,16})(?:[-_\\s][0-9a-f]+)*$",
        System.Text.RegularExpressions.RegexOptions.Compiled | System.Text.RegularExpressions.RegexOptions.IgnoreCase)]
    private static partial System.Text.RegularExpressions.Regex GuestRotating();

    public static string Pretty(string? raw)
    {
        var safe = raw ?? string.Empty;
        var m = GuestRotating().Match(safe);
        if (!m.Success) return safe;
        var hex = m.Groups[1].Value[..Math.Min(6, m.Groups[1].Value.Length)].ToUpperInvariant();
        return $"Guest {hex}";
    }
}

/// <summary>One ranked row in a normalized leaderboard. Mirrors the server's LeaderboardEntryDto.</summary>
public sealed class LeaderboardEntryDto
{
    public int Rank { get; set; }
    public string Name { get; set; } = "";
    public double Value { get; set; }
    public string DisplayValue { get; set; } = "";

    /// <summary>
    /// Long-form text for a row whose <see cref="Name"/> was clipped to fit the column,
    /// rendered as the row's hover title. Only PoJoker sends it (a row there is a joke);
    /// null on every other board, and a null title attribute is omitted entirely.
    /// </summary>
    public string? Detail { get; set; }
}

/// <summary>A single game's normalized leaderboard. Mirrors the server's GameLeaderboardDto.</summary>
public sealed class GameLeaderboardDto
{
    public string GameKey { get; set; } = "";
    public string Title { get; set; } = "";
    public string Unit { get; set; } = "";
    public bool HigherIsBetter { get; set; }
    public List<LeaderboardEntryDto> Entries { get; set; } = [];
}
