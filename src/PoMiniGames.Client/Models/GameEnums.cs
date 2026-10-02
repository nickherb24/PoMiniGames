namespace PoMiniGamesClient.Models;

public enum Difficulty
{
    Easy,
    Medium,
    Hard
}

/// <summary>
/// How a round stands, from the local player's point of view — the single enum for
/// "who won", used both as live game state and as the end-of-round cue fed to
/// <c>GameShell</c> / <c>GameOverModal</c>.
/// </summary>
/// <remarks>
/// <para>
/// This absorbed <c>GameOutcome</c> on 2026-09-13. The two were the same four-value
/// concept in two namespaces, and ConnectFive and TicTacToe each carried an identity
/// switch (<c>GameResult.Win => GameOutcome.Win</c>, …) to cross the seam. One enum,
/// no mapping.
/// </para>
/// <para>
/// <see cref="InProgress"/> doubles as the neutral cue and is not a failure state: a
/// round with no meaningful win condition for the local player (a demo, a local
/// 2-player game where "you" is ambiguous) leaves it unset and gets the neutral
/// round-over cue. Guessing would mean celebrating losses.
/// </para>
/// <para>
/// Not to be confused with <c>MatchOutcome</c> (Services/Play/MatchHistoryService.cs),
/// which is the wire form persisted to match history and deliberately has no
/// undecided member — an unfinished match is never recorded.
/// </para>
/// </remarks>
public enum GameResult
{
    InProgress,
    Win,
    Loss,
    Draw
}

/// <summary>TicTacToe board cell. Kept separate from <see cref="Piece"/>: same shape, different game.</summary>
/// <remarks>Byte-backed for the same reason as <see cref="Piece"/>: the board hands its cells to the shared grid rules as bytes.</remarks>
public enum CellValue : byte
{
    None = 0,
    X = 1,
    O = 2
}

/// <summary>ConnectFive disc colour. Kept separate from <see cref="CellValue"/>: same shape, different game.</summary>
/// <remarks>
/// Byte-backed, and the values match <c>ConnectFiveRules.Empty/Red/Yellow</c> in
/// PoMiniGames.Shared: the board hands its cells to the shared rules as a byte span
/// with no copy, and the online match state arrives as the same bytes.
/// </remarks>
public enum Piece : byte
{
    None = 0,
    Red = 1,
    Yellow = 2
}
