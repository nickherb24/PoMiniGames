namespace PoMiniGamesClient.Models;

// ---------------------------------------------------------------------------
// PoFunQuiz
// ---------------------------------------------------------------------------

/// <summary>A single trivia question returned by /api/funquiz/quiz/questions.</summary>
public class QuizQuestion
{
    public string Text { get; set; } = string.Empty;
    public List<string> Options { get; set; } = new();
    public int CorrectOptionIndex { get; set; }
    public string Category { get; set; } = "General";
    public int BasePoints { get; set; } = 2;
}

/// <summary>One ranked row on GET /api/funquiz/leaderboard. Mirrors the server's LeaderboardEntry.</summary>
public class FunQuizLeaderboardRow
{
    public string PlayerName { get; set; } = string.Empty;
    public int Score { get; set; }
    public int MaxStreak { get; set; }
    public string Category { get; set; } = "General";
    public DateTime DatePlayed { get; set; }
    public int Wins { get; set; }
    public int Losses { get; set; }
}

/// <summary>Body for POST /api/funquiz/leaderboard. The server overrides PlayerName
/// with the authenticated identity (email or anon-… marker); only Category + Score
/// are user-controllable. Score is clamped server-side to 0..10_000.</summary>
public class FunQuizLeaderboardSubmission
{
    public string Category { get; set; } = "General";
    public int Score { get; set; }
    public int MaxStreak { get; set; }
    public int Wins { get; set; }
    public int Losses { get; set; }
}

// Couple Quiz ranks on the shared PlayerStats board like the other win-rate games.
