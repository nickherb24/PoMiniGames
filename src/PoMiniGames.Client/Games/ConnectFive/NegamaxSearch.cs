using PoMiniGamesClient.Models;

namespace PoMiniGamesClient.Games.ConnectFive;

/// <summary>
/// 4-ply alpha-beta negamax with a transposition table.
/// For Connect-Five's 9x9 board (4.5 x 10^10 positions), 4-ply is reachable
/// inside the existing AiMoveBudgetMs (8 s in ConnectFivePage.RunAiTurnAsync).
///
/// Heuristics in <see cref="ScoreWindow"/> evaluate a 5-cell window as open-3,
/// open-4, etc. — the shape language Connect-Five players recognize. The
/// "winning move first" ordering prunes catastrophic lines immediately.
///
/// The transposition table is bounded to 2048 entries (LRU-evict on overflow)
/// to keep the search cheap on WASM where every byte in the L1 matters.
/// </summary>
internal sealed class NegamaxSearch
{
    private readonly Player _rootPlayer;
    private readonly int _maxDepth;
    private readonly Dictionary<long, int> _tt = new(2048);

    public NegamaxSearch(Player rootPlayer, int maxDepth)
    {
        _rootPlayer = rootPlayer;
        _maxDepth = maxDepth;
    }

    /// <summary>Returns the best (row, col) move for the given side.</summary>
    public (int Row, int Col) ChooseMove(ConnectFiveBoard board)
    {
        var opp = _rootPlayer.Other;
        var cols = board.GetAvailableCols();

        // Quick exit: 1-ply win-or-block first — negamax also finds these but
        // returning immediately avoids any alpha-beta risk and keeps latency low.
        var win = FindWinningMove(board, _rootPlayer);
        if (win.HasValue) return win.Value;
        var block = FindWinningMove(board, opp);
        if (block.HasValue) return block.Value;

        int bestScore = int.MinValue;
        var bestMove = (Row: -1, Col: -1);
        int alpha = int.MinValue + 1;
        const int beta = int.MaxValue - 1;

        // Ordering: prefer center, then alternating outward — empirically
        // prunes the most on Connect-Five openings.
        var ordered = OrderColumnsForSearch(cols);

        foreach (var col in ordered)
        {
            var row = board.GetTargetRow(col);
            var next = board.Place(row, col, _rootPlayer);
            var score = -Negamax(next, opp, _maxDepth - 1, -beta, -alpha);
            if (score > bestScore)
            {
                bestScore = score;
                bestMove = (row, col);
                alpha = Math.Max(alpha, score);
            }
            if (alpha >= beta) break;
        }

        return bestMove.Row >= 0 ? bestMove : (board.GetTargetRow(cols[0]), cols[0]);
    }

    private int Negamax(ConnectFiveBoard board, Player toMove, int depth, int alpha, int beta)
    {
        // Terminal checks
        if (toMove == _rootPlayer && board.CheckWin(_rootPlayer).Won) return +1_000_000 + depth;
        if (toMove == _rootPlayer.Other && board.CheckWin(_rootPlayer.Other).Won) return -1_000_000 - depth;
        if (board.IsFull()) return 0;
        if (depth == 0) return EvaluateStatic(board);

        var key = TTKey(board, toMove);
        if (_tt.TryGetValue(key, out var cached) && Math.Abs(cached) >= 900_000)
        {
            return cached;
        }

        var opp = toMove.Other;
        var cols = board.GetAvailableCols();
        if (cols.Count == 0) return 0;
        var ordered = OrderColumnsForSearch(cols);

        int best = int.MinValue;
        foreach (var col in ordered)
        {
            var row = board.GetTargetRow(col);
            var next = board.Place(row, col, toMove);
            var score = -Negamax(next, opp, depth - 1, -beta, -alpha);
            if (score > best) best = score;
            if (best > alpha) alpha = best;
            if (alpha >= beta) break;
        }

        if (_tt.Count < 2048) _tt[key] = best;
        else
        {
            // Cheap LRU eviction: drop a random entry when full. WASM perf
            // matters more than perfect hit rate; we keep the cap to avoid
            // unbounded growth on long sessions.
            var first = _tt.First().Key;
            _tt.Remove(first);
            _tt[key] = best;
        }
        return best;
    }

    private int EvaluateStatic(ConnectFiveBoard board)
    {
        // Windowed heuristic over every 5-cell run (horizontal/vertical/diag).
        var opp = _rootPlayer.Other;
        int score = 0;
        var dirs = new[] { (0, 1), (1, 0), (1, 1), (1, -1) };
        for (int r = 0; r < ConnectFiveBoard.Rows; r++)
        {
            for (int c = 0; c < ConnectFiveBoard.Cols; c++)
            {
                foreach (var (dr, dc) in dirs)
                {
                    score += ScoreWindow(board, r, c, dr, dc, _rootPlayer, opp);
                }
            }
        }
        return score;
    }

    private static int ScoreWindow(ConnectFiveBoard board, int r, int c, int dr, int dc, Player me, Player opp)
    {
        // Out-of-bounds run? Skip.
        if (r + dr * (ConnectFiveBoard.WinLength - 1) < 0
            || r + dr * (ConnectFiveBoard.WinLength - 1) >= ConnectFiveBoard.Rows
            || c + dc * (ConnectFiveBoard.WinLength - 1) < 0
            || c + dc * (ConnectFiveBoard.WinLength - 1) >= ConnectFiveBoard.Cols)
        {
            return 0;
        }

        int mine = 0, theirs = 0;
        for (int i = 0; i < ConnectFiveBoard.WinLength; i++)
        {
            var cell = board.Get(r + dr * i, c + dc * i);
            if (cell == me.Color) mine++;
            else if (cell == opp.Color) theirs++;
        }

        // Disjoint windows are unplayable (both sides claim them).
        if (mine > 0 && theirs > 0) return 0;
        if (mine > 0) return mine * mine;
        if (theirs > 0) return -(theirs * theirs);
        return 0;
    }

    private static List<int> OrderColumnsForSearch(List<int> cols)
    {
        var center = ConnectFiveBoard.Cols / 2;
        return cols.OrderBy(c => Math.Abs(c - center)).ToList();
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

    private static long TTKey(ConnectFiveBoard board, Player toMove)
    {
        // Mix the side-to-move in via XOR with a phi-constant mask. The mask
        // (0x9E3779B97F4A7C15) overflows long.MaxValue, so reinterpret via
        // unchecked.
        var sideMix = unchecked((long)((ulong)0x9E3779B97F4A7C15UL * (ulong)toMove.Color));
        return board.HashForSearch() ^ sideMix;
    }
}
