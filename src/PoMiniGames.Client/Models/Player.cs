using PoMiniGamesClient.Models;

namespace PoMiniGamesClient.Models;

/// <summary>
/// Domain-driven wrapper for the "two-player" turn concept. The raw
/// <see cref="Piece"/> enum is a 3-state value (None/Red/Yellow); we use the
/// empty state as the board's "cell is empty" sentinel. Passing a raw
/// <see cref="Piece.None"/> into a player-shaped API (AI turn, win check,
/// match ownership) would compile silently and silently misbehave (zero
/// ownership = zero score = false positive). <see cref="Player"/> is a
/// strongly-typed record struct that REJECTS <see cref="Piece.None"/> at the
/// construction boundary so the wrong shape can't escape the call site.
/// </summary>
public readonly record struct Player(Piece Color)
{
    public static readonly Player Red = new(Piece.Red);
    public static readonly Player Yellow = new(Piece.Yellow);

    public bool IsEmpty => Color == Piece.None;

    /// <summary>The other player. Throws if invoked on the empty player.</summary>
    public Player Other => this == Red ? Yellow
                        : this == Yellow ? Red
                        : throw new InvalidOperationException("Empty player has no opponent.");

    public static Player Require(Piece color)
    {
        if (color == Piece.None)
        {
            throw new ArgumentException("Player cannot be Piece.None (that's the empty cell sentinel).", nameof(color));
        }
        return new Player(color);
    }

    public static bool TryCreate(Piece color, out Player player)
    {
        if (color == Piece.None)
        {
            player = default;
            return false;
        }
        player = new Player(color);
        return true;
    }

    public override string ToString() => Color.ToString();
}
