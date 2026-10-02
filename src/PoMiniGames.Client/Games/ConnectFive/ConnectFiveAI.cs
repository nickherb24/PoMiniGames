using PoMiniGamesClient.Models;

namespace PoMiniGamesClient.Games.ConnectFive;

public class ConnectFiveAI
{
    public (int Row, int Col) GetMove(ConnectFiveBoard board, Player player, Difficulty difficulty)
    {
        return difficulty switch
        {
            Difficulty.Easy => EasyMove(board, player),
            Difficulty.Medium => MediumMove(board, player),
            Difficulty.Hard => HardMove(board, player),
            _ => MediumMove(board, player)
        };
    }

    /// <summary>
    /// Pick a move whose strength scales with <paramref name="cpuElo"/>. The ELO
    /// maps to a (search depth, blunder-rate) rung: at a low rating the CPU mostly
    /// plays random moves (missing blocks and wins); as the rating climbs it plays
    /// deeper negamax with fewer blunders. This lets the 1-player game match the
    /// CPU to the player's adaptive rating for a ~50/50 challenge.
    /// </summary>
    public (int Row, int Col) GetAdaptiveMove(ConnectFiveBoard board, Player player, int cpuElo)
    {
        var (depth, blunder) = StrengthForElo(cpuElo);

        // A "blunder" is a fully random legal move — it may miss its own win or
        // fail to block the player, which is exactly what makes low rungs weak.
        if (blunder > 0 && Random.Shared.NextDouble() < blunder)
        {
            var cols = board.GetAvailableCols();
            if (cols.Count == 0) return (0, 0);
            var randCol = cols[Random.Shared.Next(cols.Count)];
            return (board.GetTargetRow(randCol), randCol);
        }

        // Otherwise play a "smart" move: depth 1 = the win/block/center heuristic,
        // depth >= 2 = alpha-beta negamax to that depth.
        if (depth <= 1) return MediumMove(board, player);

        var search = new NegamaxSearch(player, maxDepth: depth);
        return search.ChooseMove(board);
    }

    /// <summary>
    /// Maps a CPU ELO to a strength rung. Seven rungs span roughly 800–2000; the
    /// top rung is the existing 4-ply "Hard" search with no blunders. Depth is
    /// capped at 4 to keep every move well inside the game's responsiveness budget.
    /// </summary>
    public static (int Depth, double Blunder) StrengthForElo(int elo) => elo switch
    {
        < 900 => (1, 0.60),
        < 1050 => (1, 0.38),
        < 1200 => (2, 0.24),
        < 1350 => (2, 0.12),
        < 1500 => (3, 0.06),
        < 1700 => (4, 0.03),
        _ => (4, 0.00),
    };

    private (int, int) EasyMove(ConnectFiveBoard board, Player player)
    {
        var opponent = player.Other;

        if (Random.Shared.NextDouble() < 0.3)
        {
            var block = FindWinningMove(board, opponent);
            if (block.HasValue) return block.Value;
        }

        var cols = board.GetAvailableCols();
        if (cols.Count == 0) return (0, 0);
        var col = cols[Random.Shared.Next(cols.Count)];
        return (board.GetTargetRow(col), col);
    }

    private (int, int) MediumMove(ConnectFiveBoard board, Player player)
    {
        var opponent = player.Other;

        var win = FindWinningMove(board, player);
        if (win.HasValue) return win.Value;

        var block = FindWinningMove(board, opponent);
        if (block.HasValue) return block.Value;

        var cols = board.GetAvailableCols();
        if (cols.Count == 0) return (0, 0);

        var centerCol = ConnectFiveBoard.Cols / 2;
        if (cols.Contains(centerCol))
        {
            return (board.GetTargetRow(centerCol), centerCol);
        }

        // Pick one column and use its target row for both halves of the tuple: a row
        // from one column paired with another column would land a piece above that
        // column's existing stack.
        var pick = cols[Random.Shared.Next(cols.Count)];
        return (board.GetTargetRow(pick), pick);
    }

    private (int, int) HardMove(ConnectFiveBoard board, Player player)
    {
        // 4-ply negamax with alpha-beta + a small transposition table.
        // Bounded by the existing AiMoveBudgetMs in RunAiTurnAsync (8 s ceiling).
        // Medium difficulty calls the same search at depth=2 to stay sub-100ms.
        var search = new NegamaxSearch(player, maxDepth: 4);
        return search.ChooseMove(board);
    }

    private (int, int)? FindWinningMove(ConnectFiveBoard board, Player player)
    {
        foreach (var col in board.GetAvailableCols())
        {
            var row = board.GetTargetRow(col);
            var next = board.Place(row, col, player);
            if (next.CheckWin(player).Won) return (row, col);
        }
        return null;
    }
}
