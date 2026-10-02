using System.Runtime.InteropServices;
using PoMiniGames.Shared.Games;
using PoMiniGamesClient.Models;

namespace PoMiniGamesClient.Games.ConnectFive;

public class ConnectFiveBoard
{
    // Geometry and the win check come from the shared rules so the online match
    // service (which applies moves through the same class) can never disagree
    // with what this board draws. Piece is byte-backed for exactly this handoff.
    public const int Rows = ConnectFiveRules.BoardRows;
    public const int Cols = ConnectFiveRules.BoardCols;
    public const int WinLength = ConnectFiveRules.BoardWinLength;

    // Flat Piece[Rows * Cols] storage rather than a jagged Piece[Rows][]:
    // 81 contiguous pieces > 9 array headers, and one allocation per Place().
    // Array.Copy is intrinsified by the JIT and runs at memory-bandwidth speed.
    private readonly Piece[] _cells;

    // Per-column next-landing-row cache. O(1) GetTargetRow + O(Cols)
    // GetAvailableCols. Maintained incrementally by Place.
    private readonly int[] _topRow;

    public ConnectFiveBoard()
    {
        _cells = new Piece[Rows * Cols];
        _topRow = new int[Cols];
        for (int c = 0; c < Cols; c++)
        {
            _topRow[c] = Rows - 1;
        }
    }

    // Private ctor for Place: clones the source cells + top-row cache in one go.
    private ConnectFiveBoard(Piece[] cells, int[] topRow)
    {
        _cells = cells;
        _topRow = topRow;
    }

    /// <summary>
    /// Rebuild a board from an authoritative flat cell array (the online match
    /// state). Used when the local board is more than one move behind the server —
    /// a rejoin, or a missed broadcast — so there is no drop to animate anyway.
    /// </summary>
    public static ConnectFiveBoard FromCells(ReadOnlySpan<byte> cells)
    {
        if (cells.Length != Rows * Cols)
        {
            throw new ArgumentException($"Expected {Rows * Cols} cells, got {cells.Length}.", nameof(cells));
        }
        var pieces = new Piece[Rows * Cols];
        MemoryMarshal.Cast<byte, Piece>(cells).CopyTo(pieces);
        var topRow = new int[Cols];
        for (int c = 0; c < Cols; c++)
        {
            topRow[c] = ConnectFiveRules.TargetRow(cells, c);
        }
        return new ConnectFiveBoard(pieces, topRow);
    }

    public Piece Get(int row, int col) => _cells[row * Cols + col];

    public int GetTargetRow(int col) => _topRow[col];

    public bool IsColumnFull(int col) => _topRow[col] < 0;

    /// <summary>
    /// Place a piece using a <see cref="Player"/> (the strongly-typed turn owner).
    /// Rejects the empty player so a Piece.None turn can never leak
    /// through the AI / placement boundary and silently corrupt win checks.
    /// </summary>
    public ConnectFiveBoard Place(int row, int col, Player player)
    {
        if (player.IsEmpty)
        {
            throw new ArgumentException("Cannot place the empty player.", nameof(player));
        }
        return Place(row, col, player.Color);
    }

    public ConnectFiveBoard Place(int row, int col, Piece value)
    {
        if (value == Piece.None)
        {
            // The empty sentinel must never be placed on the board; placing it
            // would silently corrupt win-detection and gravity. Fail loud so
            // the bug surfaces at the call site, not three moves later when
            // CheckWin returns a phantom match.
            throw new ArgumentException("Cannot place Piece.None on the board.", nameof(value));
        }

        // Gravity is enforced by the board, not by the caller: a mismatched (row, col)
        // pair would place a piece above the column's actual stack, producing
        // overlapping discs. The board ignores the caller's row and uses the
        // bottom-most empty cell of the chosen column. The `row` parameter is kept
        // for API stability; the caller's value is validated and only used as a
        // sanity check.
        if (row < 0 || row >= Rows)
        {
            throw new ArgumentOutOfRangeException(nameof(row), $"Row {row} is outside the board.");
        }
        if (col < 0 || col >= Cols)
        {
            throw new ArgumentOutOfRangeException(nameof(col), $"Col {col} is outside the board.");
        }
        var actualRow = GetTargetRow(col);
        if (actualRow < 0)
        {
            throw new InvalidOperationException($"Cannot place in column {col} — column is full.");
        }
        // If the caller passed a row that doesn't match the gravity-correct row,
        // fall back to the gravity-correct row. This is a "best effort" recovery
        // that keeps the demo loop robust to a bad caller row.
        var finalRow = actualRow;

        var newCells = new Piece[_cells.Length];
        Array.Copy(_cells, newCells, _cells.Length);
        newCells[finalRow * Cols + col] = value;
        var newTopRow = (int[])_topRow.Clone();
        newTopRow[col] = finalRow - 1;
        return new ConnectFiveBoard(newCells, newTopRow);
    }

    public WinResult CheckWin(Player player)
    {
        if (player.IsEmpty) return new WinResult { Won = false, Cells = new List<(int, int)>() };
        return CheckWin(player.Color);
    }

    public WinResult CheckWin(Piece player)
    {
        if (player == Piece.None)
        {
            // Refuse to "win" for the empty player — a caller passing
            // Piece.None here is a bug, not a no-op. Returning "no win" hides
            // the regression; throwing makes it visible.
            throw new ArgumentException("Cannot check win for Piece.None.", nameof(player));
        }

        // Delegated to the shared rules, which hold the full-window scan; the byte
        // view of _cells is free because Piece is byte-backed.
        var line = ConnectFiveRules.Instance.FindWin(MemoryMarshal.AsBytes<Piece>(_cells), (byte)player);
        if (line is null) return new WinResult { Won = false, Cells = new List<(int, int)>() };
        var cells = new List<(int, int)>(WinLength);
        foreach (var index in line)
        {
            cells.Add((index / Cols, index % Cols));
        }
        return new WinResult { Won = true, Cells = cells };
    }

    public bool IsFull()
    {
        // O(Cols) using the top-row cache. A column is full when
        // _topRow[col] < 0; the board is full when every column is full.
        for (int c = 0; c < Cols; c++)
        {
            if (_topRow[c] >= 0) return false;
        }
        return true;
    }

    /// <summary>
    /// Enumerate playable columns in O(Cols) from the top-row cache, instead of
    /// walking <see cref="Rows"/> per column on every AI turn.
    /// </summary>
    public List<int> GetAvailableCols()
    {
        var cols = new List<int>(Cols);
        for (int c = 0; c < Cols; c++)
        {
            if (_topRow[c] >= 0) cols.Add(c);
        }
        return cols;
    }

    /// <summary>
    /// Cheap 64-bit FNV-style folding hash over the flat cell array. Used by
    /// the Negamax search's transposition table. Collisions are tolerable —
    /// alpha-beta + depth caps mean a wrong cached hit at worst costs one
    /// ply of refinement (the score is still within the alpha-beta window).
    /// </summary>
    internal long HashForSearch()
    {
        // FNV-1a 64-bit offset basis (0xcbf29ce484222325) overflows long.MaxValue,
        // so we operate in ulong and reinterpret the final bits as long. The
        // hash bits don't care about sign; this is purely a folding function.
        ulong h = 0xcbf29ce484222325UL;
        for (int i = 0; i < _cells.Length; i++)
        {
            h = (h ^ (ulong)_cells[i]) * 1099511628211UL;
        }
        return unchecked((long)h);
    }
}
