namespace PoMiniGamesClient.Models;

/// <summary>One playable mode of one game.</summary>
/// <param name="RequiresNetwork">
/// True when this specific mode cannot run without a live server — a SignalR hub for
/// multiplayer, or a server API the game calls mid-round. With the service worker
/// installed the app shell loads fine offline, so these would otherwise present as
/// playable and then fail at the point of no return (a lobby that never connects).
/// Modes marked here are shown as unavailable while offline instead.
/// <para>
/// This is per-<i>mode</i>, not per-game: a game's 1-player mode can run entirely on the
/// scripted provider and is fully offline-playable, while PoJoker needs the joke API
/// in every mode.
/// </para>
/// </param>
public sealed record CatalogMode(GameMode Mode, string Url, bool RequiresNetwork = false)
{
    /// <summary>
    /// Optional URL used by the home-page chip when it would otherwise duplicate the
    /// card head's URL. Null means "same as <see cref="Url"/>" — Couple Quiz's card
    /// head is <c>/couplequiz</c> and its chip is <c>/couplequiz/multi</c>, both of
    /// which resolve to the same lobby route, so the duplicate is now a deliberate
    /// alias rather than a broken-second-link bug.
    /// </summary>
    public string? ChipUrl { get; init; }
}

/// <summary>
/// A game and every mode it can actually be played in. One entry per game — the
/// home page renders one card per game with a chip per mode, so a game can no
/// longer go missing from a mode it supports.
/// </summary>
public sealed record CatalogGame(GameKey Key, string Title, string Icon, IReadOnlyList<CatalogMode> Modes)
{
    /// <summary>
    /// Render a chip for <see cref="Primary"/> even though the card title already links
    /// there. Off by default: the duplicate chip normally reads as a broken second link
    /// (see Index.razor). Opt in where suppressing it makes the card look like the game
    /// has no playable mode at all — Marble Race's only other mode is Demo, so the card
    /// advertised "Demo" and nothing else, and players read it as demo-only.
    /// </summary>
    public bool ChipPrimary { get; init; }

    /// <summary>The mode a card's title links to — the richest interactive mode available.
    /// Demo is last-resort only: a card whose primary action is "watch" is a card the
    /// player cannot play.</summary>
    public CatalogMode Primary =>
        Modes.FirstOrDefault(m => m.Mode == GameMode.OnePlayer)
        ?? Modes.FirstOrDefault(m => m.Mode == GameMode.Multiplayer)
        ?? Modes.FirstOrDefault(m => m.Mode == GameMode.TwoPlayer)
        ?? Modes[0];

    public CatalogMode? Find(GameMode mode) => Modes.FirstOrDefault(m => m.Mode == mode);
}

/// <summary>A single game+mode pair, flattened. Used by the per-mode views below.</summary>
public sealed record CatalogEntry(
    GameKey Key, string Title, string Icon, string Url, GameMode Mode, bool RequiresNetwork);

/// <summary>
/// The canonical list of every game and every mode it supports.
/// </summary>
/// <remarks>
/// <para>
/// Previously this was four hand-maintained per-mode lists, and they drifted: PoJoker
/// appeared <i>only</i> under Demo, so it was watch-only from the home page despite
/// having a working interactive route. Fun
/// Quiz and Couple Quiz had the same gap for single-player. Modelling the game once,
/// with its modes attached, is what makes that class of omission visible.
/// </para>
/// <para>
/// Every URL uses the uniform mode-suffix scheme — /{game}/1player, /{game}/2player,
/// /{game}/multi, /{game}/demo — so the mode is readable straight off the address bar.
/// Legacy forms (/{game}/1, ?mode=2p, ?demo=1, /lobby, /multiplayer) still route for old
/// bookmarks; <see cref="GameModes.Parse"/> is the single place that accepts them.
/// </para>
/// </remarks>
public static class GameCatalog
{
    public static readonly IReadOnlyList<CatalogGame> All =
    [
        new(GameKeys.ConnectFive, "Connect Five", "🔴",
        [
            new(GameMode.OnePlayer, "/connectfive/1player"),
            new(GameMode.TwoPlayer, "/connectfive/2player"),
            // Quick-match 1v1 over SignalR: no lobby, the first two arrivals are
            // paired. Server-authoritative board — see Features/ConnectFive.
            new(GameMode.Multiplayer, "/connectfive/multi", RequiresNetwork: true),
            new(GameMode.Demo, "/connectfive/demo"),
        ])
        {
            // ChipPrimary: 1P is the card head (the adaptive ELO ladder), so the
            // chip row would otherwise read "2P Demo" — players looking for a solo
            // game would scan the chips, see no 1P, and conclude the game is
            // unplayable alone. Same fix applied to Brawl / Sports / Marble Race.
            ChipPrimary = true,
        },

        // 2026-07-19 browser audit #8: the grid dimension (6×6 / 4-in-a-row) was
        // leaking into the product name as "TicTacToe6". Surface the classic product
        // name; the grid size stays in the in-game "How to play" copy and intro card.
        // Audit #10: the home card used to just say "Tic-Tac-Toe", which primed
        // visitors for the 3×3 / 3-in-a-row game they learned as a kid. This
        // variant is Connect-Four mechanics on a 6×6 grid — line up four in a
        // Audit #10: the home card used to just say "Tic-Tac-Toe", which primed
        // visitors for the 3×3 / 3-in-a-row game they learned as a kid. This
        // variant is Connect-Four mechanics on a 6×6 grid — line up four in a
        // row, horizontally, vertically or diagonally.
        new(GameKeys.TicTacToe, "Tic-Tac-Toe", "❌",
        [
            new(GameMode.OnePlayer, "/tictactoe/1player"),
            new(GameMode.TwoPlayer, "/tictactoe/2player"),
            // Quick-match 1v1 over SignalR, same turn-match service as Connect Five.
            new(GameMode.Multiplayer, "/tictactoe/multi", RequiresNetwork: true),
            new(GameMode.Demo, "/tictactoe/demo"),
        ])
        {
            // 1P is the card head, so the dedup-by-URL filter would hide the 1P
            // chip and leave the row reading "2P Demo" — a player looking for a
            // solo game sees no 1P and assumes the game is 2-player only. Same
            // reason Connect Five / Brawl / Sports / Marble Race set it.
            ChipPrimary = true,
        },

        // ChipPrimary: same reason as Sports and Marble Race. 1P is the card head,
        // so suppressing its chip left the row reading "2P Demo" — a player looking
        // for a solo game scanned the chips, saw no 1P, and concluded Brawl needed a
        // second person. It does not: /pobrawl/1player is the fifteen-president
        // ladder, the only Elo-rated and leaderboard-backed mode the game has.
        //
        // Auth consistency: every PoBrawl entry point opts into autoGuest so
        // 1P, 2P and demo all land the same way for anonymous visitors.
        new(GameKeys.PoBrawl, "Brawl", "🥊",
        [
            new(GameMode.OnePlayer, "/pobrawl/1player?autoGuest=1"),
            new(GameMode.TwoPlayer, "/pobrawl/2player?autoGuest=1"),
            // Server-authoritative 1v1 over SignalR. Two humans, one lobby, one
            // fight. POST /api/pobrawl/matches feeds the per-player Elo table —
            // see Features/PoBrawl/Online.
            new(GameMode.Multiplayer, "/pobrawl/multi", RequiresNetwork: true),
            new(GameMode.Demo, "/pobrawl/demo?autoGuest=1"),
        ]) { ChipPrimary = true },

        // ChipPrimary: 1P is the card head, so the chip row would otherwise read
        // "Online Demo" — Solo + Online + Demo, no 2P. 2P removed from the home card
        // on 2026-08-12 at the player's request; the /posports/2player route still
        // works for old bookmarks, but local same-keyboard split-keyboard play is no
        // longer advertised from the home grid (the same 2P is still offered for
        // Brawl / Connect Five / Tic-Tac-Toe / Fun Quiz).
        new(GameKeys.PoSports, "Sports", "🏃",
        [
            new(GameMode.OnePlayer, "/posports/1player"),
            new(GameMode.Multiplayer, "/posports/multi", RequiresNetwork: true),
            new(GameMode.Demo, "/posports/demo"),
        ]) { ChipPrimary = true },

        // ChipPrimary: 1P is the card head, so the dedup-by-URL filter would hide
        // the 1P chip and leave the row reading "Online Demo" — same fix as the
        // other solo-capable games (Connect Five, Brawl, Sports, Marble Race, etc.).
        new(GameKeys.PoRacer, "Racer", "🏎️",
        [
            new(GameMode.OnePlayer, "/poracer/1player"),
            new(GameMode.Multiplayer, "/poracer/multi", RequiresNetwork: true),
            new(GameMode.Demo, "/poracer/demo"),
        ]) { ChipPrimary = true },

        // PoCabinet (2026-09-17): third-person arcade racing, four named officials, four
        // tracks (Capitol Speedway / Mar-a-Lago GP / Press Briefing 500 / Playground Marble Run).
        // Three modes: 1P championship, multi SignalR lobby, demo AI showcase. The 2P
        // mode was dropped on 2026-09-29 (it only ever ran the solo race); old
        // /pocabinet/2player links land on 1P (PoCabinetPage.Mode). The lobby endpoint at /api/pocabinet is
        // authed; the leaderboard reads are anonymous.
        new(GameKeys.PoCabinet, "Cabinet", "🏛️",
        [
            new(GameMode.OnePlayer, "/pocabinet/1player"),
            new(GameMode.Multiplayer, "/pocabinet/multi", RequiresNetwork: true),
            new(GameMode.Demo, "/pocabinet/demo"),
        ]) { ChipPrimary = true },

        // ChipPrimary: 1P is the card head, so the chip row would otherwise show a lone
        // "Demo" and the game reads as unplayable. It is very much playable — you steer
        // the red marble with the arrow keys.
        new(GameKeys.PoMarbleRace, "Marble Race", "🔮",
        [
            new(GameMode.OnePlayer, "/pomarblerace/1player"),
            // Host-authoritative 2-player race over SignalR: the host browser runs the
            // physics and streams the pack, the guest steers the white marble.
            new(GameMode.Multiplayer, "/pomarblerace/multi", RequiresNetwork: true),
            new(GameMode.Demo, "/pomarblerace/demo"),
        ]) { ChipPrimary = true },

        // Voxel assets stream from /api/povoxelstrike/assets on first load (Cache API
        // holds them after that), so the first run needs a server — but the mode itself
        // is offline-capable once cached, matching the other single-player 3D games.
        new(GameKeys.PoVoxelStrike, "Voxel Strike", "🧱",
        [
            new(GameMode.OnePlayer, "/povoxelstrike/1player"),
            new(GameMode.Demo, "/povoxelstrike/demo"),
        ]) { ChipPrimary = true },

        // Joker's set is fetched from a joke API mid-performance in every mode — there
        // is no offline joke bank to fall back on.
        new(GameKeys.PoJoker, "Joker", "🃏",
        [
            new(GameMode.OnePlayer, "/pojoker", RequiresNetwork: true),
            new(GameMode.Demo, "/pojoker/demo", RequiresNetwork: true),
        ]),

        // Questions come from /api/funquiz/quiz/questions, so even solo needs a server.
        new(GameKeys.PoFunQuiz, "Fun Quiz", "🧠",
        [
            new(GameMode.OnePlayer, "/funquiz/1player", RequiresNetwork: true),
            new(GameMode.TwoPlayer, "/funquiz/2player", RequiresNetwork: true),
            new(GameMode.Multiplayer, "/funquiz/multi", RequiresNetwork: true),
        ]),

        // Multiplayer only (user decision, 2026-08-10). The 1-player entry here never
        // started a 1-player game: /couplequiz/1player landed on the multiplayer lobby
        // card, which merely offered a "Play solo (vs AI partner)" button for a mode whose
        // "AI partner" was a hardcoded answer index. Both are gone. There is no Demo entry
        // because this game was never in the kiosk reel below.
        //
        // Browser audit #2 (2026-08-10): the card head AND its lone "Online" chip both
        // pointed at /couplequiz, so a screen-reader / mouse user heard "Couple Quiz"
        // announced twice for the same destination. Use /couplequiz/multi as the chip
        // target — /couplequiz and /couplequiz/multi both render the same lobby
        // (PoCoupleQuizLobbyPage routes both), so the URL is functionally a no-op
        // alias for routing purposes, but it gives the two affordances distinct
        // destinations so each can be a separate, semantically correct link.
        new(GameKeys.PoCoupleQuiz, "Couple Quiz", "💕",
        [
            new(GameMode.Multiplayer, "/couplequiz", RequiresNetwork: true),
        ])
        {
            // Tell the renderer to use the primary as the chip target too — the
            // card has only one mode, so the dedup-by-URL logic would otherwise
            // leave it with no chips at all.
            ChipPrimary = true,
        },

        // PoJevArena (2026-09-25): design creatures, draft 10 v 10, and watch TypeSafe's Jev
        // decide every move. Needs sign-in (guests included) and a Jev key on the server;
        // not in the kiosk rotation, because an unattended loop spends Jev calls.
        new(GameKeys.PoJevArena, "Jev Arena", "⚔️",
        [
            new(GameMode.OnePlayer, "/pojevarena/1player", RequiresNetwork: true),
            new(GameMode.TwoPlayer, "/pojevarena/2player", RequiresNetwork: true),
            new(GameMode.Demo, "/pojevarena/demo", RequiresNetwork: true),
        ])
        {
            ChipPrimary = true,
        },

        // PoEcosystem is an autonomous simulation that is watched, never played. 1P is "your
        // island": kept in this browser and offered back on the next visit (2026-09-30 — the
        // card used to offer Demo only, so nothing could ever be resumed). Demo is the kiosk:
        // a fresh island every time, never saved.
        new(GameKeys.PoEcosystem, "PoEcosystem", "🌿",
        [
            new(GameMode.OnePlayer, "/poecosystem/1player"),
            new(GameMode.Demo, "/poecosystem/demo"),
        ])
        {
            ChipPrimary = true,
        },

        // 1P is the card head, so ChipPrimary keeps the chip row from presenting
        // this interactive sandbox as watch-only.
        new(GameKeys.SandPlayground, "SandPlayground", "🏜️",
        [
            new(GameMode.OnePlayer, "/sandplayground/1player"),
            new(GameMode.Demo, "/sandplayground/demo"),
        ])
        {
            ChipPrimary = true,
        },
    ];

    /// <summary>Games sorted for display — alphabetical, matching the old per-section order.</summary>
    public static readonly IReadOnlyList<CatalogGame> AllSorted =
        All.OrderBy(g => g.Title, StringComparer.OrdinalIgnoreCase).ToList();

    private static IReadOnlyList<CatalogEntry> For(GameMode mode) =>
        All.Select(g => (game: g, mode: g.Find(mode)))
           .Where(x => x.mode is not null)
           .Select(x => new CatalogEntry(
               x.game.Key, x.game.Title, x.game.Icon, x.mode!.Url, mode, x.mode.RequiresNetwork))
           .OrderBy(e => e.Title, StringComparer.OrdinalIgnoreCase)
           .ToList();

    public static readonly IReadOnlyList<CatalogEntry> SinglePlayer = For(GameMode.OnePlayer);
    public static readonly IReadOnlyList<CatalogEntry> LocalTwoPlayer = For(GameMode.TwoPlayer);
    public static readonly IReadOnlyList<CatalogEntry> Multiplayer = For(GameMode.Multiplayer);

    /// <summary>
    /// The kiosk reel, in rotation order. Deliberately NOT alphabetical and NOT derived
    /// from <see cref="For"/>: the reel opens on the two quickest-to-read board games so a
    /// passer-by sees a full round early, and the longer 3D matches sit late.
    /// </summary>
    public static readonly IReadOnlyList<CatalogEntry> Demo =
    [
        .. new[]
        {
            GameKeys.TicTacToe, GameKeys.ConnectFive, GameKeys.PoRacer, GameKeys.PoMarbleRace,
            GameKeys.PoVoxelStrike, GameKeys.PoJoker, GameKeys.PoBrawl, GameKeys.PoSports,
            GameKeys.PoCabinet,
        }
        .Select(key => All.First(g => g.Key == key))
        .Select(g =>
        {
            var demo = g.Find(GameMode.Demo)!;
            return new CatalogEntry(g.Key, g.Title, g.Icon, demo.Url, GameMode.Demo, demo.RequiresNetwork);
        }),
    ];
}
