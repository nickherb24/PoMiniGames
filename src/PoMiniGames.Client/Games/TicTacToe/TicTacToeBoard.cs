using System.Runtime.InteropServices;
using PoMiniGames.Shared.Games;
using PoMiniGamesClient.Models;

namespace PoMiniGamesClient.Games.TicTacToe;

public class TicTacToeBoard
{
    // Geometry and the win check come from the shared rules so the online match
    // service (which applies moves through the same class) can never disagree
    // with what this board draws. CellValue is byte-backed for exactly this handoff.
    public const int Size = TicTacToeRules.BoardSize;
    public const int WinLength = TicTacToeRules.BoardWinLength;

    // Flat row-major storage: a jagged CellValue[][] could not be viewed as the
    // byte span the shared rules read.
    private readonly CellValue[] _cells;

    public TicTacToeBoard()
    {
        _cells = new CellValue[Size * Size];
    }

    private TicTacToeBoard(CellValue[] cells)
    {
        _cells = cells;
    }

    /// <summary>
    /// Rebuild a board from an authoritative flat cell array (the online match
    /// state). Used when the local board is more than one move behind the server —
    /// a rejoin, or a missed broadcast — so there is no placement to animate anyway.
    /// </summary>
    public static TicTacToeBoard FromCells(ReadOnlySpan<byte> cells)
    {
        if (cells.Length != Size * Size)
        {
            throw new ArgumentException($"Expected {Size * Size} cells, got {cells.Length}.", nameof(cells));
        }
        var values = new CellValue[Size * Size];
        MemoryMarshal.Cast<byte, CellValue>(cells).CopyTo(values);
        return new TicTacToeBoard(values);
    }

    public CellValue Get(int row, int col) => _cells[row * Size + col];

    public TicTacToeBoard Place(int row, int col, CellValue value)
    {
        if (_cells[row * Size + col] != CellValue.None)
        {
            throw new Exception($"Cell ({row}, {col}) is already occupied");
        }

        var cells = new CellValue[_cells.Length];
        Array.Copy(_cells, cells, _cells.Length);
        cells[row * Size + col] = value;
        return new TicTacToeBoard(cells);
    }

    public WinResult CheckWin(CellValue player)
    {
        var line = TicTacToeRules.Instance.FindWin(MemoryMarshal.AsBytes<CellValue>(_cells), (byte)player);
        if (line is null) return new WinResult { Won = false, Cells = new List<(int, int)>() };
        var cells = new List<(int, int)>(WinLength);
        foreach (var index in line)
        {
            cells.Add((index / Size, index % Size));
        }
        return new WinResult { Won = true, Cells = cells };
    }

    public bool IsFull() => TicTacToeRules.Instance.IsFull(MemoryMarshal.AsBytes<CellValue>(_cells));

    public List<(int Row, int Col)> GetAvailableMoves()
    {
        var moves = new List<(int, int)>();
        for (int i = 0; i < _cells.Length; i++)
        {
            if (_cells[i] == CellValue.None)
            {
                moves.Add((i / Size, i % Size));
            }
        }
        return moves;
    }
}
