namespace PoMiniGames.Features.PoFunQuiz;

// ── Enums ───────────────────────────────────────────────────────────────────

public enum QuestionCategory
{
    General,
    Science,
    History,
    Geography,
    Sports,
    Entertainment,
    Technology,
    ArtCulture,
}

public enum GameMode
{
    Solo,
    LocalTwoPlayer,
    PrivateRoom,
    SharedLobby,
}

public enum GameState
{
    Waiting,
    InProgress,
    Finished
}

// ── Question + Player + Session ──────────────────────────────────────────────

public class QuizQuestion
{
    public string Text { get; set; } = string.Empty;
    public List<string> Options { get; set; } = new();
    public int CorrectOptionIndex { get; set; }
    public QuestionCategory Category { get; set; } = QuestionCategory.General;
    public DifficultyLevel Difficulty { get; set; } = DifficultyLevel.Medium;

    public int BasePoints => Difficulty switch
    {
        DifficultyLevel.Easy => 1,
        DifficultyLevel.Medium => 2,
        DifficultyLevel.Hard => 3,
        _ => 2,
    };
}

public enum DifficultyLevel
{
    Easy,
    Medium,
    Hard
}

public class Player
{
    public string Name { get; set; } = string.Empty;
    public int Score { get; set; }
    public int MaxStreak { get; set; }
}

public class PlayerScoreState
{
    public int BaseScore { get; private set; }
    public int SpeedBonus { get; private set; }
    public int StreakBonus { get; private set; }
    public int TimeBonus { get; private set; }
    public int TotalScore => BaseScore + SpeedBonus + StreakBonus + TimeBonus;

    public int CurrentStreak { get; private set; }
    public int MaxStreak { get; private set; }

    public void ApplyCorrectAnswer(int basePoints, double speedMultiplier)
    {
        BaseScore += basePoints;
        CurrentStreak++;
        if (CurrentStreak > MaxStreak) MaxStreak = CurrentStreak;
        // Speed bonus: per-answer additional points scaled by (multiplier - 1).
        if (speedMultiplier > 1.0) SpeedBonus += (int)Math.Round(basePoints * (speedMultiplier - 1.0));
        // Streak bonus: 2+ → +1, 3+ → +2, 5+ → +3.
        StreakBonus = CurrentStreak switch
        {
            >= 5 => 3,
            >= 3 => 2,
            >= 2 => 1,
            _ => 0
        };
    }

    public void ResetStreak() => CurrentStreak = 0;
    public void SetBaseScore(int score) => BaseScore = score;
    public void SetTimeBonus(int bonus) => TimeBonus = bonus;
    public void SetRemoteScoreState(int correctCount, int maxStreak, int speedBonus, int streakBonus, int timeBonus)
    {
        BaseScore = correctCount;
        MaxStreak = maxStreak;
        SpeedBonus = speedBonus;
        StreakBonus = streakBonus;
        TimeBonus = timeBonus;
    }
}

public class GameSession
{
    public string GameId { get; set; } = Guid.NewGuid().ToString();
    public Player Player1 { get; set; } = new();
    public Player Player2 { get; set; } = new();
    public List<QuizQuestion> Player1Questions { get; set; } = new();
    public List<QuizQuestion> Player2Questions { get; set; } = new();
    public DateTime? StartTime { get; set; }
    public DateTime? EndTime { get; set; }
    public TimeSpan Duration => EndTime.HasValue && StartTime.HasValue ? EndTime.Value - StartTime.Value : TimeSpan.Zero;
    public PlayerScoreState Player1State { get; } = new();
    public PlayerScoreState Player2State { get; } = new();
    public int Player1Score => Player1State.TotalScore;
    public int Player2Score => Player2State.TotalScore;
    public List<string> SelectedCategories { get; set; } = new();
    public bool IsComplete => EndTime.HasValue;
    public Player? Winner => Player1Score == Player2Score ? null : Player1Score > Player2Score ? Player1 : Player2;
    public bool IsTie => Player1Score == Player2Score;
    public GameState State { get; set; } = GameState.Waiting;
}

// ── Leaderboard entry ───────────────────────────────────────────────────────

public class LeaderboardEntry
{
    public string PlayerName { get; set; } = string.Empty;
    public int Score { get; set; }
    public int MaxStreak { get; set; }
    public QuestionCategory Category { get; set; } = QuestionCategory.General;
    public DateTime DatePlayed { get; set; } = DateTime.UtcNow;
    public int Wins { get; set; }
    public int Losses { get; set; }
}
