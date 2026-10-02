// The GameKey value object itself lives in PoMiniGames.Domain.Primitives and is
// re-exported here under the client's Models namespace.
//
// There used to be two of them: this file declared its own `readonly record struct
// GameKey` with the same purpose, the same implicit string conversions and the same
// case-insensitive equality as the Domain one. Two implementations of one concept is
// how the catalogues drifted apart in the first place — the client's list said
// "pofunquiz" while the Domain catalogue said "funquiz", and the leaderboard endpoint
// grew a `"pofunquiz" or "funquiz"` switch to paper over it.
//
// A using-alias rather than a wrapper: the client needs the type under
// PoMiniGamesClient.Models (every razor page resolves it from there via _Imports),
// but it must be the SAME type as the server validates against, not a lookalike.
global using GameKey = PoMiniGames.Domain.Primitives.GameKey;

namespace PoMiniGamesClient.Models;

/// <summary>
/// The game keys the client sends on the wire. Reference these instead of magic
/// string literals.
/// </summary>
/// <remarks>
/// <para>
/// Four of these are <em>aliases</em> rather than canonical keys: the Domain catalogue
/// stores Couple Quiz, Fun Quiz and Joker without the "Po" prefix. The values
/// here are kept as they are on purpose — they are already live leaderboard partition
/// keys in Table Storage and cached stat keys in browser localStorage, so renaming them
/// would orphan real data rather than tidy it.
/// </para>
/// <para>
/// <see cref="PoMiniGames.Domain.Primitives.GameKey.TryParse"/> canonicalises both
/// spellings, so the server resolves whichever form arrives. That alias table is the
/// one place the discrepancy is expressed.
/// </para>
/// </remarks>
public static class GameKeys
{
    public static readonly GameKey ConnectFive = new("connectfive");
    public static readonly GameKey TicTacToe = new("tictactoe");
    public static readonly GameKey PoRacer = new("poracer");
    public static readonly GameKey PoMarbleRace = new("pomarblerace");
    public static readonly GameKey PoCoupleQuiz = new("pocouplequiz");
    public static readonly GameKey PoFunQuiz = new("pofunquiz");
    public static readonly GameKey PoJoker = new("pojoker");
    public static readonly GameKey PoBrawl = new("pobrawl");
    public static readonly GameKey PoSports = new("posports");

    // "pobrawldemo" is the leaderboard-only key for the Brawl demo-mode
    // fighter ELO board. It mirrors GameKey.PoBrawlDemo on the server so a client that
    // happens to build its own lookup (e.g. a "view Brawl Demo board" link) can default
    // to the same wire form the unified /api/leaderboards/{game} route returns. The
    // /leaderboards page currently reaches the board via the all-boards response, so
    // this constant is for forward use rather than for the current render path.
    public static readonly GameKey PoBrawlDemo = new("pobrawldemo");

    public static readonly GameKey PoVoxelStrike = new("povoxelstrike");
    public static readonly GameKey PoEcosystem = new("poecosystem");
    public static readonly GameKey SandPlayground = new("sandplayground");
    public static readonly GameKey PoCabinet = new("pocabinet");

    // Also in the Domain allowlist, because play sessions are minted for every catalogue game;
    // PoJevArena itself records no PlayerStats and has no leaderboard.
    public static readonly GameKey PoJevArena = new("pojevarena");
}
