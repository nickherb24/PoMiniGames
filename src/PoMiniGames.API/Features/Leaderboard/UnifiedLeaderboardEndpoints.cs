using System.Globalization;
using PoMiniGames.Domain.Models;
using PoMiniGames.Domain.Abstractions;
using PoMiniGames.Features.PoFunQuiz;
using PoMiniGames.Features.PoFunQuiz.Storage;
using PoMiniGames.Features.PoJoker;
using PoMiniGames.Domain.Primitives;

namespace PoMiniGames.Features.Leaderboard;

/// <summary>
/// One read-model for every game's leaderboard. Collapses the win-rate stat boards and the
/// per-game high-score boards (snake, marble, drop-square) behind a single normalized shape
/// (<see cref="GameLeaderboardDto"/>) so the client renders all of them with one component and
/// always shows the correct unit. This is the BFF half of the "unified leaderboard" slice.
/// </summary>
public static class UnifiedLeaderboardEndpoints
{
    // Games ranked via the shared PlayerStats board: adaptive-ELO games rank by
    // rating. Every other board has a real score source and a dedicated builder
    // below.
    private static readonly (string Key, string Title)[] WinRateGames =
    [
        ("connectfive", "Connect Five"),
        // Couple Quiz joined this list on 2026-08-10. It used to rank named "teams" from
        // the PoCoupleQuizTeams table — a table nothing ever wrote to, so the board served
        // ten padded "XXX" rows forever. The game does report a per-match outcome, and with
        // the King seat now rotating every round both partners genuinely compete, so win
        // rate over those matches is a real measure with a real write path behind it.
        ("pocouplequiz", "Couple Quiz"),
        // Titles must match GameCatalog on the client — the product-name authority per the
        // 2026-07-19 audit, which removed the grid dimension from the name. The storage key
        // stays "tictactoe"; only the label changed.
        ("tictactoe", "Tic-Tac-Toe"),
    ];

    public static IEndpointRouteBuilder MapUnifiedLeaderboardEndpoints(this IEndpointRouteBuilder app)
    {
        // §1 MapGroup() per slice: /api/leaderboards/{game} reuses the parent prefix.
        var boards = app.MapGroup("/api/leaderboards").WithTags("Statistics");

        boards.MapGet("",
            async (IStorageService storage, ILeaderboardRepository funQuiz,
                   IJokeStorageClient joker, int limit = 5) =>
            {
                limit = Math.Clamp(limit, 1, 100);
                var all = await BuildAllAsync(storage, funQuiz, joker, limit);
                return Results.Ok(all);
            })
            .WithName("GetUnifiedLeaderboards")
            .WithSummary("Normalized leaderboards for every game in one call")
            .Produces<IEnumerable<GameLeaderboardDto>>(StatusCodes.Status200OK);

        boards.MapGet("/{game}",
            async (string game, IStorageService storage, ILeaderboardRepository funQuiz,
                   IJokeStorageClient joker, int limit = 10) =>
            {
                limit = Math.Clamp(limit, 1, 100);
                var board = await BuildOneAsync(storage, funQuiz, joker, game, limit);
                return board is null ? Results.NotFound(new { message = $"No leaderboard for game '{game}'" })
                                     : Results.Ok(board);
            })
            .WithName("GetUnifiedLeaderboard")
            .WithSummary("Normalized leaderboard for a single game")
            .Produces<GameLeaderboardDto>(StatusCodes.Status200OK)
            .Produces(StatusCodes.Status404NotFound);

        return app;
    }

    private static async Task<List<GameLeaderboardDto>> BuildAllAsync(
        IStorageService storage, ILeaderboardRepository funQuiz,
        IJokeStorageClient joker, int limit)
    {
        // §6: each board is an independent storage read, so fan them out concurrently instead
        // of awaiting one at a time. Wall-clock drops from the SUM of the per-board scans to
        // the slowest single one.
        //
        // Graceful degradation: every per-board build is wrapped in SafeAsync so a single
        // board's storage failure (e.g., TaskCanceledException from the 2s network timeout
        // against an unreachable Azurite) cannot 500 the whole /api/leaderboards endpoint.
        // A failed board returns its title with placeholder rows, matching the "no scores
        // yet" rendering the client already uses for empty boards.
        var winRateTasks = WinRateGames.Select(g => SafeBuildWinRateAsync(storage, g.Key, g.Title, limit));
        var boardTasks = new[]
        {
            SafeBuildMarbleAsync(storage, limit),
            SafeBuildPoRacerAsync(storage, limit),
            SafeBuildPoSportsAsync(storage, limit),
            SafeBuildPoBrawlAsync(storage, limit),
            // 2026-08-11: dedicated top-3 board for the PoBrawl demo-mode fighter ELO.
            // Ratings characters, not players — see BuildPoBrawlDemoAsync's docstring.
            // This is the board's only read; POST /api/pobrawl/elo is write only.
            SafeBuildPoBrawlDemoAsync(storage, limit),
            SafeBuildFunQuizAsync(funQuiz, limit),
            SafeBuildPoJokerAsync(joker, limit),
            SafeBuildPoVoxelStrikeAsync(storage, limit),
            SafeBuildOnlineMmrAsync(storage, limit),
        };

        var result = (await Task.WhenAll(winRateTasks.Concat(boardTasks))).ToList();

        // Boards with at least one REAL entry float to the top (every board is now
        // padded to `limit` with XXX placeholders, so raw count no longer ranks).
        return result.OrderByDescending(b => b.Entries.Count(e => e.Name != PlaceholderName)).ToList();
    }

    // Safe* wrappers around each board builder. A failed builder returns an empty-board
    // GameLeaderboardDto so the fan-out can keep producing the rest of the page; matches
    // the same "empty list, padded with XXX by the client" rendering the page already uses
    // for genuinely empty boards. The board's title still surfaces so the user can see
    // the section exists, just without rows.
    private static async Task<GameLeaderboardDto> SafeBuildWinRateAsync(IStorageService storage, string key, string title, int limit)
    {
        try { return await BuildWinRateAsync(storage, key, title, limit); }
        catch { return EmptyBoard(title); }
    }
    private static async Task<GameLeaderboardDto> SafeBuildMarbleAsync(IStorageService storage, int limit)
    {
        try { return await BuildMarbleAsync(storage, limit); }
        catch { return EmptyBoard("Marble Race"); }
    }
    private static async Task<GameLeaderboardDto> SafeBuildPoRacerAsync(IStorageService storage, int limit)
    {
        try { return await BuildPoRacerAsync(storage, limit); }
        catch { return EmptyBoard("Racer"); }
    }
    private static async Task<GameLeaderboardDto> SafeBuildPoSportsAsync(IStorageService storage, int limit)
    {
        try { return await BuildPoSportsAsync(storage, limit); }
        catch { return EmptyBoard("Sports"); }
    }
    private static async Task<GameLeaderboardDto> SafeBuildPoBrawlAsync(IStorageService storage, int limit)
    {
        try { return await BuildPoBrawlAsync(storage, limit); }
        catch { return EmptyBoard("Brawl"); }
    }
    private static async Task<GameLeaderboardDto> SafeBuildPoBrawlDemoAsync(IStorageService storage, int limit)
    {
        try { return await BuildPoBrawlDemoAsync(storage, limit); }
        catch { return EmptyBoard("Brawl Demo"); }
    }
    private static async Task<GameLeaderboardDto> SafeBuildFunQuizAsync(ILeaderboardRepository repo, int limit)
    {
        try { return await BuildFunQuizAsync(repo, limit); }
        catch { return EmptyBoard("Fun Quiz"); }
    }
    private static async Task<GameLeaderboardDto> SafeBuildPoJokerAsync(IJokeStorageClient client, int limit)
    {
        try { return await BuildPoJokerAsync(client, limit); }
        catch { return EmptyBoard("Joker"); }
    }
    private static async Task<GameLeaderboardDto> SafeBuildPoVoxelStrikeAsync(IStorageService storage, int limit)
    {
        try { return await BuildPoVoxelStrikeAsync(storage, limit); }
        catch { return EmptyBoard("Voxel Strike"); }
    }
    private static async Task<GameLeaderboardDto> SafeBuildOnlineMmrAsync(IStorageService storage, int limit)
    {
        try { return await BuildOnlineMmrAsync(storage, limit); }
        catch { return EmptyBoard("Online MMR"); }
    }

    private static async Task<GameLeaderboardDto?> BuildOneAsync(
        IStorageService storage, ILeaderboardRepository funQuiz,
        IJokeStorageClient joker, string game, int limit)
    {
        var key = game.ToLowerInvariant();
        if (string.Equals(key, "online-mmr", StringComparison.OrdinalIgnoreCase))
            return await BuildOnlineMmrAsync(storage, limit);

        var winRate = Array.Find(WinRateGames, g => g.Key == key);
        if (winRate.Key is not null)
            return await BuildWinRateAsync(storage, winRate.Key, winRate.Title, limit);

        // Canonicalise first, then dispatch on the one true key. Every arm here used to
        // list its own accepted spellings ("pofunquiz" or "funquiz", …) because the
        // client and this server disagree on whether the "Po" prefix belongs in an
        // identifier. That knowledge now lives in GameKey's alias table, so adding a
        // game means adding one arm rather than remembering both of its names.
        var canonical = Domain.Primitives.GameKey.TryParse(key);
        if (canonical is not { } id) return null;

        return id.Value switch
        {
            "pomarblerace" => await BuildMarbleAsync(storage, limit),
            "poracer" => await BuildPoRacerAsync(storage, limit),
            "posports" => await BuildPoSportsAsync(storage, limit),
            "pobrawl" => await BuildPoBrawlAsync(storage, limit),
            // By-id only, not in BuildAllAsync — see BuildPoBrawlKoAsync's remarks. This is
            // the board the 1P end-of-match modal renders.
            "pobrawlko" => await BuildPoBrawlKoAsync(storage, limit),
            // 2026-08-11: dedicated top-3 board for the PoBrawl demo-mode fighter ELO.
            // Ratings characters, not players — see BuildPoBrawlDemoAsync's docstring.
            // This is the board's only read; POST /api/pobrawl/elo is write only.
            "pobrawldemo" => await BuildPoBrawlDemoAsync(storage, limit),
            "funquiz" => await BuildFunQuizAsync(funQuiz, limit),
            // GameKey canonicalises "pocouplequiz" to "couplequiz", but the board is keyed by
            // the storage key the client writes stats under.
            "couplequiz" => await BuildWinRateAsync(storage, "pocouplequiz", "Couple Quiz", limit),
            "joker" => await BuildPoJokerAsync(joker, limit),
            "povoxelstrike" => await BuildPoVoxelStrikeAsync(storage, limit),
            _ => null,
        };
    }

    /// <summary>
    /// Placeholder name for the dummy rows that pad every board out to the requested
    /// limit. Real scores always rank above the padding (they are appended after the
    /// ranked entries); clients that don't want the padding filter on this name.
    /// Padding lives here in the BFF rather than as seeded storage records because
    /// the PlayerStats table keys rows by player name — ten identical "XXX" rows
    /// per game cannot exist in storage, and fake stats rows would leak into the
    /// /api/statistics aggregates and ELO maths.
    /// </summary>
    public const string PlaceholderName = "XXX";

    private static void PadWithPlaceholders(List<LeaderboardEntryDto> entries, int limit, string zeroDisplay)
    {
        for (var rank = entries.Count + 1; rank <= limit; rank++)
        {
            entries.Add(new LeaderboardEntryDto(rank, PlaceholderName, 0, zeroDisplay));
        }
    }

    /// <summary>
    /// Builds a board with the title but no real rows — every slot is a placeholder.
    /// Used by the Safe* wrappers when a per-board builder throws (storage unreachable,
    /// transient SDK error). The board still appears on the page so the user can see
    /// the game exists, just with no scores behind it.
    /// </summary>
    private static GameLeaderboardDto EmptyBoard(string title) => new(
        GameKey: "unavailable",
        Title: title,
        Unit: "Score",
        HigherIsBetter: true,
        Entries: [new LeaderboardEntryDto(1, PlaceholderName, 0, "—")]);

    // ── The closed vocabulary for GameLeaderboardDto.Unit ─────────────────────
    // Unit is the label printed on each leaderboard card beside the game title.
    // One label per distinct MEASURE, and no synonyms.
    //
    // A 2026-08-08 UI audit found nine cards carrying seven labels for five real
    // measures: Sports said "Best meet" for the same seconds-lower-is-better
    // value Racer called "Best time", while Marble Race said "Points", Fun Quiz
    // and Joker said "Score", and Couple Quiz said "High score" — all for a plain
    // point total. Read as a page, that noise implies the games are scored
    // differently when they are not. (Couple Quiz has since moved to "Win rate",
    // which is a genuinely different measure.)
    //
    //   ELO        adaptive rating (see AdaptiveEloGames below)
    //   Win rate   a percentage
    //   Score      a point total, higher is better
    //   Best time  seconds, LOWER is better
    //   Best rung  PoBrawl's "N/10" ladder progress
    //
    // Adding a board? Reuse one of these. Only mint a new label when the measure
    // itself is genuinely new — and add it here when you do. Kept as a comment
    // rather than an enum because Unit crosses the wire as a display string and
    // the client renders it verbatim.

    /// <summary>
    /// Games whose 1-player CPU is matched to the player's adaptive ELO. Their
    /// boards rank by that rating — the adaptive matchmaking pins win rate near
    /// 50% by design, so win rate can't distinguish players. The client mirrors
    /// the adaptive rating into the Medium bucket's EloRating on every game.
    /// </summary>
    private static readonly HashSet<string> AdaptiveEloGames = ["connectfive", "tictactoe"];

    private static async Task<GameLeaderboardDto> BuildWinRateAsync(
        IStorageService storage, string key, string title, int limit)
    {
        if (AdaptiveEloGames.Contains(key))
        {
            var eloBoard = await storage.GetLeaderboardAsync(key, limit, "medium");
            var eloEntries = eloBoard
                .Select((p, i) => new LeaderboardEntryDto(
                    i + 1, p.Name, p.Stats.Medium.EloRating,
                    p.Stats.Medium.EloRating.ToString("N0", CultureInfo.InvariantCulture)))
                .ToList();
            PadWithPlaceholders(eloEntries, limit, "0");
            return new GameLeaderboardDto(key, title, "ELO", HigherIsBetter: true, eloEntries);
        }

        var board = await storage.GetLeaderboardAsync(key, limit);
        var entries = board
            .Select((p, i) => new LeaderboardEntryDto(
                i + 1, p.Name, p.Stats.WinRate,
                p.Stats.WinRate.ToString("P0", CultureInfo.InvariantCulture)))
            .ToList();
        PadWithPlaceholders(entries, limit, 0d.ToString("P0", CultureInfo.InvariantCulture));
        return new GameLeaderboardDto(key, title, "Win rate", HigherIsBetter: true, entries);
    }

    private static async Task<GameLeaderboardDto> BuildMarbleAsync(IStorageService storage, int limit)
    {
        var scores = await storage.GetMarbleRaceHighScoresAsync(limit);
        var entries = scores
            .Select((s, i) => new LeaderboardEntryDto(
                i + 1, s.PlayerInitials, s.BestScore, s.BestScore.ToString("N0", CultureInfo.InvariantCulture)))
            .ToList();
        PadWithPlaceholders(entries, limit, "0");
        return new GameLeaderboardDto("pomarblerace", "Marble Race", "Score", HigherIsBetter: true, entries);
    }

    /// <summary>Best lap per player (lower is better) from the PoRacer score table.</summary>
    private static async Task<GameLeaderboardDto> BuildPoRacerAsync(IStorageService storage, int limit)
    {
        var scores = await storage.GetPoRacerHighScoresAsync(50);
        var entries = scores
            .Where(s => s.TotalTimeSeconds > 0)
            .GroupBy(s => s.PlayerName)
            .Select(g => (Name: g.Key, Best: g.Min(s => s.TotalTimeSeconds)))
            .OrderBy(x => x.Best)
            .Take(limit)
            .Select((x, i) => new LeaderboardEntryDto(
                i + 1, x.Name, x.Best,
                x.Best.ToString("0.0", CultureInfo.InvariantCulture) + "s"))
            .ToList();
        PadWithPlaceholders(entries, limit, "—");
        return new GameLeaderboardDto("poracer", "Racer", "Best lap", HigherIsBetter: false, entries);
    }

    private static async Task<GameLeaderboardDto> BuildPoSportsAsync(IStorageService storage, int limit)
    {
        // The descriptor keeps one ratcheted row per player, so no re-grouping is
        // needed here — the read is already one-best-per-player, ranked ascending.
        var scores = await storage.GetPoSportsHighScoresAsync(limit);
        var entries = scores
            .Where(s => s.TotalTimeSeconds > 0)
            .Select((s, i) => new LeaderboardEntryDto(
                i + 1, s.PlayerName, s.TotalTimeSeconds,
                s.TotalTimeSeconds.ToString("0.0", CultureInfo.InvariantCulture) + "s"))
            .ToList();
        PadWithPlaceholders(entries, limit, "—");
        return new GameLeaderboardDto("posports", "Sports", "Best time", HigherIsBetter: false, entries);
    }

    /// <summary>
    /// PoBrawl ranks by the level of opponent conquered: highest presidential
    /// ladder rung beaten (1-10, each rung a harder CPU), ties broken by the
    /// player's fastest KO time, then ELO. Displays as "N/10".
    /// </summary>
    private static async Task<GameLeaderboardDto> BuildPoBrawlAsync(IStorageService storage, int limit)
    {
        // Two independent partition scans — fan out concurrently (§6), this builder is
        // on the critical path of BuildAllAsync's WhenAll.
        var ladderTask = storage.GetPoBrawlLadderAsync(50);
        var kosTask = storage.GetPoBrawlHighScoresAsync(50);
        await Task.WhenAll(ladderTask, kosTask);
        var ladder = ladderTask.Result;
        var kos = kosTask.Result;

        // KO rows now carry the full player name; legacy rows hold 3-letter
        // initials. Join by exact name first, initials as the legacy fallback.
        var bestKoByName = kos
            .Where(k => k.KoTimeSeconds > 0)
            .GroupBy(k => k.PlayerInitials)
            .ToDictionary(g => g.Key, g => g.Min(k => k.KoTimeSeconds));

        double BestKo(string playerName) =>
            bestKoByName.TryGetValue(playerName, out var exact) ? exact
            : bestKoByName.TryGetValue(InitialsOf(playerName), out var legacy) ? legacy
            : double.MaxValue;

        var entries = ladder
            .OrderByDescending(l => l.PresidentsBeaten)
            .ThenBy(l => BestKo(l.PlayerName))
            .ThenByDescending(l => l.Elo)
            .Take(limit)
            // Denominator comes from the roster so the rung display tracks it; a literal 10
            // rendered "15/10" the moment the roster grew.
            .Select((l, i) => new LeaderboardEntryDto(
                i + 1, l.PlayerName, l.PresidentsBeaten, $"{l.PresidentsBeaten}/{PoBrawlRoster.Count}"))
            .ToList();
        PadWithPlaceholders(entries, limit, $"0/{PoBrawlRoster.Count}");
        return new GameLeaderboardDto("pobrawl", "Brawl", "Best rung", HigherIsBetter: true, entries);
    }

    /// <summary>
    /// PoBrawl fastest-KO board: lowest time to put a president down, in seconds.
    /// </summary>
    /// <remarks>
    /// <para>
    /// Same <c>PoBrawlHighScore</c> partition that <see cref="BuildPoBrawlAsync"/> reads for
    /// its tiebreak, ranked on that value instead of using it to break ladder ties. This is
    /// what the 1-player end-of-match modal shows: between rungs the interesting number is
    /// how fast you put the last one down, not a standings table of how far other players
    /// have climbed.
    /// </para>
    /// <para>
    /// <b>Deliberately not in <c>BuildAllAsync</c>.</b> It is reachable by id only, so the
    /// /leaderboards page still carries exactly one Brawl player board (the ladder) plus the
    /// demo Elo board. Adding it there would put two boards fed by the same players' runs
    /// side by side on that page, which is the duplication the unified endpoint exists to
    /// avoid. Add it to the array if the page should list it — that is a product call, not
    /// an oversight.
    /// </para>
    /// <para>
    /// <c>HigherIsBetter: false</c> — this is the only PoBrawl board where lower wins, and
    /// GameOverModal reads that flag to decide which end of the list is rank 1.
    /// </para>
    /// </remarks>
    private static async Task<GameLeaderboardDto> BuildPoBrawlKoAsync(IStorageService storage, int limit)
    {
        var kos = await storage.GetPoBrawlHighScoresAsync(100);

        // One row per player: the table keeps every submitted time, and a player who has
        // beaten twenty presidents would otherwise fill the whole top three themselves.
        var entries = kos
            .Where(k => k.KoTimeSeconds > 0 && !string.IsNullOrWhiteSpace(k.PlayerInitials))
            .GroupBy(k => k.PlayerInitials)
            .Select(g => new { Name = g.Key, Best = g.Min(k => k.KoTimeSeconds) })
            .OrderBy(x => x.Best)
            .Take(limit)
            .Select((x, i) => new LeaderboardEntryDto(
                i + 1, x.Name, (int)Math.Round(x.Best * 100),
                x.Best.ToString("0.00", CultureInfo.InvariantCulture) + "s"))
            .ToList();

        // "—" rather than a 0.00s that would sort as the best possible time if any caller
        // ever ranked the padded rows instead of filtering them.
        PadWithPlaceholders(entries, limit, "—");
        return new GameLeaderboardDto("pobrawlko", "Brawl — Fastest KO", "Time", HigherIsBetter: false, entries);
    }

    /// <summary>
    /// PoBrawl demo-mode fighter ELO. The row subject is the character, not the player —
    /// demo matches are CPU-vs-CPU, so "Trump" or "Obama" is what climbs the board, not
    /// the human who walked past the kiosk. This is the only read of the partition that
    /// <c>POST /api/pobrawl/elo</c> writes.
    /// </summary>
    /// <remarks>
    /// Roster is bounded at <see cref="PoBrawlRoster.Count"/> (15), so a top-3 view is
    /// always the headline of the board; <c>limit</c> controls the size of the canned
    /// "XXX" padding rows the rest of the BFF emits, not the real content. Unit is "ELO"
    /// because the climbing value is the same head-to-head adaptive rating the
    /// <c>connectfive</c>/<c>tictactoe</c> boards use — the closed-vocabulary comment
    /// above forbids a separate "Rating" label for the same measure.
    /// </remarks>
    private static async Task<GameLeaderboardDto> BuildPoBrawlDemoAsync(IStorageService storage, int limit)
    {
        var ratings = await storage.GetPoBrawlFighterRatingsAsync(limit);
        var entries = ratings
            .Select((r, i) => new LeaderboardEntryDto(
                i + 1,
                // DisplayName is resolved server-side from PoBrawlRoster (the row never
                // carries a caller-supplied name — see PoBrawlLeaderboardEndpoints' POST).
                r.DisplayName,
                r.Elo,
                r.Elo.ToString("N0", CultureInfo.InvariantCulture)))
            .ToList();
        PadWithPlaceholders(entries, limit, "0");
        return new GameLeaderboardDto("pobrawldemo", "Brawl Demo", "ELO", HigherIsBetter: true, entries);
    }

    /// <summary>
    /// PoVoxelStrike ranks by best run score. The descriptor keeps one ratcheted row per
    /// player, so the read is already one-best-per-player, ranked descending.
    /// </summary>
    private static async Task<GameLeaderboardDto> BuildPoVoxelStrikeAsync(IStorageService storage, int limit)
    {
        var scores = await storage.GetPoVoxelStrikeHighScoresAsync(limit);
        var entries = scores
            .Select((s, i) => new LeaderboardEntryDto(
                i + 1, s.PlayerName, s.Score, s.Score.ToString("N0", CultureInfo.InvariantCulture)))
            .ToList();
        PadWithPlaceholders(entries, limit, "0");
        // Unit "Score" from the closed vocabulary above — a plain point total, higher wins.
        return new GameLeaderboardDto("povoxelstrike", "Voxel Strike", "Score", HigherIsBetter: true, entries);
    }

    /// <summary>
    /// PoFunQuiz ranks by best single-run score. The repository partitions by category, so an
    /// overall board means scanning every category and keeping each player's personal best —
    /// otherwise a player who played three categories would occupy three rows.
    /// </summary>
    private static async Task<GameLeaderboardDto> BuildFunQuizAsync(ILeaderboardRepository repo, int limit)
    {
        var perCategory = await Task.WhenAll(
            Enum.GetValues<PoFunQuiz.QuestionCategory>()
                .Select(c => repo.GetTopAsync(c, limit)));

        var entries = perCategory
            .SelectMany(rows => rows)
            .GroupBy(r => r.PlayerName, StringComparer.OrdinalIgnoreCase)
            .Select(g => (Name: g.Key, Best: g.Max(r => r.Score)))
            .OrderByDescending(x => x.Best)
            .Take(limit)
            .Select((x, i) => new LeaderboardEntryDto(
                i + 1, x.Name, x.Best, x.Best.ToString("N0", CultureInfo.InvariantCulture)))
            .ToList();
        PadWithPlaceholders(entries, limit, "0");
        return new GameLeaderboardDto("pofunquiz", "Fun Quiz", "Score", HigherIsBetter: true, entries);
    }

    /// <summary>
    /// PoJoker scores a whole 10-joke show, and its rows are keyed by session rather than by
    /// player (the show has no sign-in), so the display name is the shortened session id —
    /// mirroring what /pojoker/leaderboard already shows.
    /// </summary>
    /// <summary>
    /// Ranks the best JOKES, not the best sessions.
    /// </summary>
    /// <remarks>
    /// This board used to list sessions by score, rendered as a truncated session id
    /// ("a3f9…"). That is an opaque identifier: it told a reader nothing, could not be
    /// matched to a person, and made the one board in the app whose subject is content
    /// look like a debug dump. Every other board shows the achievement; here the
    /// achievement IS the joke, so the joke is what it shows — ranked by the AI Jester's
    /// own humour/cleverness/originality scores. See <see cref="TopJokeDto"/>.
    /// </remarks>
    private static async Task<GameLeaderboardDto> BuildPoJokerAsync(IJokeStorageClient client, int limit)
    {
        var jokes = await client.GetTopJokesAsync(limit);
        var entries = jokes
            .Select((j, i) => new LeaderboardEntryDto(
                i + 1, Ellipsize(j.Setup, JokeRowChars), j.Score,
                j.Score.ToString("F1", CultureInfo.InvariantCulture),
                // Full text on hover: the row is clipped to fit a narrow column, and the
                // punchline is deliberately not in the visible part — a board should not
                // spoil every joke on it at a glance.
                Detail: j.FullText))
            .ToList();
        PadWithPlaceholders(entries, limit, "0.0");
        return new GameLeaderboardDto("pojoker", "Joker", "Rating", HigherIsBetter: true, entries);
    }

    /// <summary>Visible characters of a joke setup before it is clipped.</summary>
    private const int JokeRowChars = 48;

    /// <summary>Clip to <paramref name="max"/> characters on a word boundary, with an ellipsis.</summary>
    private static string Ellipsize(string text, int max)
    {
        var clean = text.Replace('\n', ' ').Replace('\r', ' ').Trim();
        if (clean.Length <= max) return clean;
        // Break at the last space inside the budget so the row never ends mid-word; fall back
        // to a hard cut for text with no spaces in range (long URLs, agglutinative languages).
        var cut = clean.LastIndexOf(' ', Math.Min(max, clean.Length - 1));
        if (cut < max / 2) cut = max;
        return string.Concat(clean.AsSpan(0, cut).TrimEnd(), "…");
    }

    // ShortSession() removed 2026-08-11 with the PoJoker session board it existed for —
    // it truncated a session GUID for display, and no board shows a session id any more.

    /// <summary>Mirror of the client's Initials(): first 3 alphanumeric chars, uppercased.</summary>
    private static string InitialsOf(string name)
    {
        if (string.IsNullOrWhiteSpace(name)) return "PO";
        var letters = new string(name.Where(char.IsLetterOrDigit).ToArray());
        if (letters.Length == 0) return "PO";
        return letters[..Math.Min(3, letters.Length)].ToUpperInvariant();
    }

    private static async Task<GameLeaderboardDto> BuildOnlineMmrAsync(IStorageService storage, int limit)
    {
        var ratings = await storage.GetOnlineMmrLeaderboardAsync(limit);
        var entries = ratings
            .Select((r, i) => new LeaderboardEntryDto(
                i + 1,
                r.DisplayName,
                r.Mmr,
                $"{r.Mmr:N0} MMR ({r.TierName})"))
            .ToList();
        PadWithPlaceholders(entries, limit, "1,200 MMR");
        return new GameLeaderboardDto("online-mmr", "Online MMR", "MMR", HigherIsBetter: true, entries);
    }
}
