using Microsoft.AspNetCore.Components;
using Microsoft.JSInterop;
using PoMiniGamesClient.Models;
using PoMiniGamesClient.Services.Auth;
using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGamesClient.Pages;

/// <summary>
/// Code-behind for <c>ProfilePage.razor</c>.
/// </summary>
/// <remarks>
/// Holds the page's C# so neither the markup nor the code has to be read through the
/// other. The Razor generator compiles the page into this same partial class, which is
/// why the split needs no wiring.
/// <c>RenderOpponentTable</c> stays in the .razor because inline Razor markup
/// inside a <see cref="RenderFragment"/> is compiled by the Razor generator rather than
/// by csc, and does not compile in a .cs file.
/// </remarks>
public partial class ProfilePage
{
    // ── Data model ──────────────────────────────────────────────
    private sealed class DiffEntry
    {
        public string Name { get; init; } = "";
        public int Wins { get; init; }
        public int Losses { get; init; }
        public int Draws { get; init; }
        public int EloRating { get; init; }
        public int TotalGames => Wins + Losses + Draws;
    }

    /// <summary>
    /// How a game's skill is measured. Replaces the former pair of booleans plus a
    /// hardcoded `key == "connectfive"` branch in LoadStats: with ten games that
    /// shape multiplied, and a second adaptive game (pobrawl) would have silently
    /// taken the difficulty-bucket path and reported zeros despite having data.
    /// </summary>
    private enum RatingKind
    {
        /// <summary>Single adaptive ELO vs a rating-matched CPU (TicTacToe, ConnectFive, Brawl).</summary>
        Adaptive,
        /// <summary>Easy/Medium/Hard buckets.</summary>
        Difficulty,
        /// <summary>No W/L semantics; the server board carries the number.</summary>
        HighScoreOnly,
        /// <summary>No outcome and no score — only how many times it was played.</summary>
        PlayCountOnly,
    }

    private sealed class GameEntry
    {
        public string Key { get; init; } = "";
        public string Label { get; init; } = "";
        public string Icon { get; init; } = "";
        public RatingKind Kind { get; init; }
        public int PlayCount { get; init; }
        /// <summary>Longest win streak across this game's rating buckets.</summary>
        public int BestStreak { get; init; }
        /// <summary>True when this game contributes a win rate — i.e. it can appear on the radar.</summary>
        public bool HasRecord => Kind is RatingKind.Adaptive or RatingKind.Difficulty;
        public int TotalWins { get; set; }
        public int TotalLosses { get; set; }
        public int TotalDraws { get; set; }
        public int TotalGames => TotalWins + TotalLosses + TotalDraws;
        public double WinRate => TotalGames > 0 ? (double)TotalWins / TotalGames : 0;
        public double WinPercent => TotalGames > 0 ? TotalWins * 100.0 / TotalGames : 0;
        public double DrawPercent => TotalGames > 0 ? TotalDraws * 100.0 / TotalGames : 0;
        public double LossPercent => TotalGames > 0 ? TotalLosses * 100.0 / TotalGames : 0;
        public List<DiffEntry> Difficulties { get; init; } = new();
    }

    // ── Game definitions (order determines radar axis order) ──
    // Every game in GameCatalog appears here. Brawl, Sports and Fun Quiz were already
    // persisting local stats through GameResultService/GameStatsService long before
    // they were listed — the data existed, the page just never read it, so a player
    // with prior history sees it appear on the first load after this ships.
    //
    // The list itself is GameCatalog's: a second, hand-kept table of key, name and icon
    // would drift out of step with the hub. All this page owns is the
    // kind of record each game keeps; a game with no entry below still gets its row, as a
    // session count, which is the only stat that is honest for a game with no win
    // condition and no score (Joker, PoEcosystem, SandPlayground).
    private static readonly Dictionary<string, RatingKind> Kinds = new(StringComparer.OrdinalIgnoreCase)
    {
        ["tictactoe"] = RatingKind.Adaptive,
        ["connectfive"] = RatingKind.Adaptive,
        ["pobrawl"] = RatingKind.Adaptive,
        ["posports"] = RatingKind.Difficulty,
        ["pofunquiz"] = RatingKind.Difficulty,
        ["poracer"] = RatingKind.Difficulty,
        ["pocouplequiz"] = RatingKind.Difficulty,
        ["pomarblerace"] = RatingKind.HighScoreOnly,
        ["povoxelstrike"] = RatingKind.HighScoreOnly,
    };

    // Rated games first, in the order above (it is the radar's axis order), then the rest
    // in catalogue order.
    private static readonly (string Key, string Label, string Icon, RatingKind Kind)[] GameDefs =
    [
        .. Kinds.Keys
            .Select(key => GameCatalog.All.First(g => g.Key.Value.Equals(key, StringComparison.OrdinalIgnoreCase)))
            .Concat(GameCatalog.All.Where(g => !Kinds.ContainsKey(g.Key.Value)))
            .Select(g => (g.Key.Value, g.Title, g.Icon, Kinds.GetValueOrDefault(g.Key.Value, RatingKind.PlayCountOnly))),
    ];

    // ── State ────────────────────────────────────────────────────
    private bool _loading = true;
    private string _playerName = "Player";
    private int _totalGames, _totalWins, _totalLosses, _totalDraws;
    private int _bestStreak, _topElo;
    // The friendlier partial-session count shown under the "Saved Matches" chip. Built from GameStatsService's
    // per-game local counts in LoadStats so it picks up the visitor's
    // in-session play activity without conflating it with the saved W/L.
    private int _unsyncedSessions;
    private GameEntry? _bestEntry, _nemesisEntry;
    private List<GameEntry> _entries = new();

    // ── High scores (best available per 1P game) ──────────────────
    private sealed record HighScoreEntry(string Game, string Icon, string Value, string Sub, bool HasValue);
    private List<HighScoreEntry> _highScores = new();

    // The Game Breakdown card needs to know whether
    // a score-based game has a row on the leaderboard, so it can show a
    // link to /leaderboards instead of the static "see leaderboard" copy.
    // The HsDefs keys (e.g. "pomarblerace") line up with the GameDefs keys,
    // so this lookup is just the zip of those two arrays.
    private Dictionary<string, HighScoreEntry> _highScoresByKey
    {
        get
        {
            var map = new Dictionary<string, HighScoreEntry>(StringComparer.OrdinalIgnoreCase);
            for (var i = 0; i < HsDefs.Length && i < _highScores.Count; i++)
            {
                map[HsDefs[i].Key] = _highScores[i];
            }
            return map;
        }
    }

    private static readonly (string Key, string Title, string Icon, string Kind)[] HsDefs =
    {
        ("pomarblerace", "Marble Race",  "🔮", "marble"),
        ("povoxelstrike", "Voxel Strike", "🧱", "voxel"),
        ("posports",     "Sports",       "🏃", "sports"),
        ("pobrawl",      "Brawl",        "🥊", "brawl"),
        ("tictactoe",    "Tic-Tac-Toe",   "❌", "ai"),
        ("connectfive",  "Connect Five",  "🔴", "ai"),
    };

    // ── Head-to-head record vs named opponents ────────────────────
    private sealed class OpponentRecord
    {
        public string Name { get; init; } = "";
        public string Type { get; init; } = "guest";
        /// <summary>The game most recently played against them: where an invite takes both players.</summary>
        public string LastGame { get; init; } = "";
        public int Wins, Losses, Draws;
        public int Total => Wins + Losses + Draws;
    }
    private bool _matchesLoading = true;
    private List<OpponentRecord> _localOpponents = new();
    private List<OpponentRecord> _onlineOpponents = new();

    // ── Lifecycle ────────────────────────────────────────────────
    protected override void OnInitialized()
    {
        PlayerNameService.StateChanged += OnNameChanged;
        // _loading starts true (declared on the state field). The
        // skeleton renders on the first paint, and we let OnInitializedAsync
        // hydrate the stats + name. We deliberately do NOT call
        // PlayerNameService.GetPlayerName() or LoadStats() here — those would
        // resolve synchronously against cached localStorage and defeat the
        // skeleton. Instead, the async path runs after first render and
        // owns all data population so the placeholder is the first thing the
        // user sees, even on a 0-ms warm-cache render.
    }

    protected override async Task OnInitializedAsync()
    {
        await LoadStatsAsync();
        // HighScore + MatchHistory are independent (disjoint fields), so run them
        // concurrently — the same way OnNameChanged already fires them.
        await Task.WhenAll(LoadHighScoresAsync(), LoadMatchesAsync());
        // Dismiss the skeleton once the slowest data source has resolved.
        // HighScore + MatchHistory fire in parallel; flipping _loading here means
        // the user sees a skeleton for the network round-trip (typically <300ms
        // on warm-cache) and never a stale identity flash if a previous user's
        // data was still resident in the component.
        _loading = false;
        StateHasChanged();
    }

    private async Task LoadStatsAsync()
    {
        _playerName = PlayerNameService.GetPlayerName();
        LoadStats();
        BuildLocalHighScores();
        await Task.CompletedTask;
    }

    // A guest session's display name is the minted "Guest-NNNNNN" handle (see
    // DevLoginIntake.BuildProfile); AuthenticatedUserProfile carries no kind of its own.
    private bool IsGuestUser()
        => AuthState.User?.DisplayName?.StartsWith("Guest", StringComparison.Ordinal) ?? true;

    public void Dispose() => PlayerNameService.StateChanged -= OnNameChanged;

    private void OnNameChanged()
    {
        _playerName = PlayerNameService.GetPlayerName();
        LoadStats();
        BuildLocalHighScores();
        // Re-show the skeleton so a "Switch user" mid-session (see top-bar dev
        // tool) never flashes the previous user's stats before the new ones
        // arrive.
        _loading = true;
        // Reset the failure flag so the old banner doesn't linger when the
        // new identity triggers a fresh fetch.
        _highScoreLoadFailed = false;
        _ = LoadHighScoresAsync();
        _ = LoadMatchesAsync();
        InvokeAsync(StateHasChanged);
    }

    // ── High scores ──────────────────────────────────────────────
    // Build the synchronous parts (AI-game personal bests from local stats) first
    // so the section renders immediately; the API-backed numeric scores fill in
    // once LoadHighScoresAsync completes.
    private void BuildLocalHighScores()
    {
        var list = new List<HighScoreEntry>();
        foreach (var (key, title, icon, kind) in HsDefs)
        {
            if (kind == "ai")
            {
                // Connect Five uses the adaptive single-rating ELO.
                if (key == "connectfive")
                {
                    var ar = GameStatsService.GetAdaptiveRating(key, _playerName);
                    list.Add(ar.TotalGames > 0
                        ? new HighScoreEntry(title, icon, $"ELO {ar.Elo}", $"{ar.WinRate:P0} · {ar.Wins}W {ar.Losses}L", true)
                        : new HighScoreEntry(title, icon, "—", "Not played yet", false));
                    continue;
                }

                var s = GameStatsService.GetStats(key, _playerName);
                if (s.TotalGames > 0)
                {
                    var bestElo = Math.Max(s.Easy.EloRating, Math.Max(s.Medium.EloRating, s.Hard.EloRating));
                    list.Add(new HighScoreEntry(title, icon, $"ELO {bestElo}",
                        $"{s.WinRate:P0} · {s.TotalWins}W {s.TotalLosses}L", true));
                }
                else
                {
                    list.Add(new HighScoreEntry(title, icon, "—", "Not played yet", false));
                }
            }
            else
            {
                // Numeric-score games: placeholder until the API responds.
                list.Add(new HighScoreEntry(title, icon, "…", "Loading…", false));
            }
        }
        _highScores = list;
    }

    private async Task LoadHighScoresAsync()
    {
        // The leaderboards endpoint returns the GLOBAL top-N, not the current player's own
        // best, so treating the top row as "yours" would surface a previous session's high
        // score as if it belonged to the current guest.
        //
        // Match on the row's UserId, which the server stamps from the auth cookie. Matching
        // on the display name alone cannot find rows it should: legacy rows store 3-letter
        // initials, guest rows store the literal "Guest", and the server truncates names to
        // 24 chars — none of which equal the local player name. A wider page also keeps a
        // personal best visible when it sits outside the global top ten.
        // The boards are independent reads — fetch them concurrently rather than
        // serially stacking round-trips behind the profile skeleton.
        //
        // A swallowed HTTP error must not silently show "Not played yet" for players who
        // DO have a saved row on the public leaderboard. The failure path is detected
        // explicitly so the user sees a banner that names the failed endpoint and offers
        // a retry — otherwise the page is indistinguishable from a profile of someone who
        // has never played.
        var marbleTask = ApiService.GetMarbleRaceHighScoresAsync(100);
        var voxelTask = ApiService.GetPoVoxelStrikeHighScoresAsync(100);
        var sportsTask = ApiService.GetPoSportsHighScoresAsync(100);
        var brawlTask = ApiService.GetPoBrawlHighScoresAsync(100);
        await Task.WhenAll(marbleTask, voxelTask, sportsTask, brawlTask);

        var marbleResult = marbleTask.Result;
        var voxelResult = voxelTask.Result;
        var sportsResult = sportsTask.Result;
        var brawlResult = brawlTask.Result;

        // Count actually-loaded boards so we can name the failures precisely.
        // The task results have different element types (different DTOs),
        // so the array can't infer a single element type — use object and cast.
        var loaded = new object?[] { marbleResult, voxelResult, sportsResult, brawlResult }.Count(r => r is not null);
        if (loaded < 4)
        {
            _highScoreLoadFailed = true;
        }

        var mine = new Dictionary<string, HighScoreEntry>(StringComparer.Ordinal)
        {
            ["Marble Race"] = FindMine(marbleResult, "Marble Race", "🔮",
                s => s.UserId, s => s.PlayerInitials, s => s.BestScore.ToString("N0")),
            ["Voxel Strike"] = FindMine(voxelResult, "Voxel Strike", "🧱",
                s => s.UserId, s => s.PlayerName, s => s.Score.ToString("N0")),
            ["Sports"] = FindMine(sportsResult, "Sports", "🏃",
                s => s.UserId, s => s.PlayerName, s => $"{s.TotalTimeSeconds:0.00}s"),
            // PoBrawlHighScore carries no UserId — unlike the Marble and Sports rows,
            // the server never stamps one on this board. Name matching is all there is.
            ["Brawl"] = FindMine(brawlResult, "Brawl", "🥊",
                userIdOf: null, s => s.PlayerInitials, s => $"{s.KoTimeSeconds:0.00}s"),
        };

        for (var i = 0; i < _highScores.Count; i++)
        {
            if (mine.TryGetValue(_highScores[i].Game, out var entry)) _highScores[i] = entry;
        }
        StateHasChanged();
    }

    // Drives a banner explaining a failed leaderboard fetch.
    // The fetch can fail (network offline, API down, antiforgery 403) and we
    // cannot tell from a null result alone. The user sees this banner above
    // the high-scores grid instead of an unexplained "Not played yet" list.
    private bool _highScoreLoadFailed;

    /// <summary>
    /// Resolve the current player's own best row out of a board response.
    /// </summary>
    /// <remarks>
    /// The leaderboards endpoints return the GLOBAL top-N, not the caller's own best, so
    /// treating the top row as "yours" would surface a previous session's high score as if
    /// it belonged to the current guest.
    ///
    /// Match on the row's UserId, which the server stamps from the auth cookie. Matching
    /// on the display name alone cannot find rows it should: legacy rows store
    /// 3-letter initials, guest rows store the literal "Guest", and the server truncates
    /// names to 24 chars — none of which equal the local player name. A wide page also
    /// keeps a personal best visible when it sits outside the global top ten.
    ///
    /// <paramref name="userIdOf"/> is null for boards whose rows carry no user id at all
    /// (PoBrawl), which degrades this to name-only matching for those rows.
    /// </remarks>
    private HighScoreEntry FindMine<T>(
        T[]? rows, string title, string icon,
        Func<T, string>? userIdOf, Func<T, string> nameOf, Func<T, string> formatOf)
        where T : class
    {
        var me = _playerName?.Trim() ?? string.Empty;
        var myUserId = AuthState.User?.UserId ?? string.Empty;

        T? found = default;
        if (userIdOf is not null && !string.IsNullOrEmpty(myUserId))
        {
            found = rows?.FirstOrDefault(r => string.Equals(userIdOf(r), myUserId, StringComparison.Ordinal));
        }
        // Anonymous/legacy rows carry no usable id — fall back to the name they do carry.
        if (found is null && !string.IsNullOrEmpty(me))
        {
            found = rows?.FirstOrDefault(r =>
                !string.IsNullOrEmpty(nameOf(r)) && nameOf(r).Equals(me, StringComparison.OrdinalIgnoreCase));
        }

        // No own score — the global #1 is irrelevant to a profile page, so suppress it
        // entirely rather than pretending it belongs to this user.
        return found is not null
            ? new HighScoreEntry(title, icon, formatOf(found), "your best", true)
            : new HighScoreEntry(title, icon, "—", "Not played yet", false);
    }

    // ── Head-to-head ─────────────────────────────────────────────
    private async Task LoadMatchesAsync()
    {
        _matchesLoading = true;
        var matches = await MatchHistory.GetMyMatchesAsync();
        _localOpponents = Aggregate(matches.Where(m => m.Mode == "local-2p"));
        _onlineOpponents = Aggregate(matches.Where(m => m.Mode != "local-2p"));
        _matchesLoading = false;
        StateHasChanged();
    }

    private static List<OpponentRecord> Aggregate(IEnumerable<MatchRecordDto> matches)
    {
        return matches
            .GroupBy(m => m.OpponentName, StringComparer.OrdinalIgnoreCase)
            .Select(g => new OpponentRecord
            {
                Name = g.Key,
                Type = g.Any(x => x.OpponentType == "microsoft") ? "microsoft" : "guest",
                // The API returns history newest-first, so the group's first row is the latest.
                LastGame = g.First().Game,
                Wins = g.Count(x => x.Outcome == "win"),
                Losses = g.Count(x => x.Outcome == "loss"),
                Draws = g.Count(x => x.Outcome == "draw"),
            })
            .OrderByDescending(o => o.Total)
            .ToList();
    }


    // ── Invite a past opponent ───────────────────────────────────
    private string? _inviting;

    /// <summary>
    /// Push an invite to someone from the online head-to-head list, for the game last played
    /// against them. The server only delivers to people who turned invites on, so "sent 0" is
    /// an ordinary outcome and gets its own wording rather than an error.
    /// </summary>
    private async Task InviteAsync(OpponentRecord opponent)
    {
        if (_inviting is not null) return;
        _inviting = opponent.Name;
        try
        {
            var slug = InviteService.SlugFor(opponent.LastGame);
            var sent = await Invites.InviteAsync(opponent.Name, slug);
            if (sent is null)
            {
                Toasts.Show($"Couldn't invite {opponent.Name}. Try again in a minute.", ToastType.Error);
            }
            else if (sent == 0)
            {
                Toasts.Show($"{opponent.Name} hasn't turned on invites. Share the lobby link with them instead.", ToastType.Info);
            }
            else
            {
                Toasts.ShowAction($"Invite sent to {opponent.Name}.", "Open lobby", () =>
                {
                    NavigationManager.NavigateTo($"/{slug}/multi");
                    return Task.CompletedTask;
                }, ToastType.Success);
            }
        }
        finally
        {
            _inviting = null;
        }
    }

    // ── Stats loading ────────────────────────────────────────────
    private void LoadStats()
    {
        _entries = new();
        _totalGames = _totalWins = _totalLosses = _totalDraws = 0;
        _bestStreak = 0;
        _unsyncedSessions = 0;
        // Seed _topElo at the AdaptiveRating starting value (1200 — see
        // GameModels.cs) so a fresh guest sees "— not played —" via the chip's
        // `> 1200` gate. Anything above this requires the user to have actually
        // played at least one game.
        _topElo = 1200;

        foreach (var (key, label, icon, kind) in GameDefs)
        {
            var entry = kind switch
            {
                RatingKind.Adaptive => BuildAdaptiveEntry(key, label, icon),
                RatingKind.Difficulty => BuildDifficultyEntry(key, label, icon),
                RatingKind.PlayCountOnly => new GameEntry
                {
                    Key = key,
                    Label = label,
                    Icon = icon,
                    Kind = kind,
                    PlayCount = GameStatsService.GetPlayCount(key),
                },
                // HighScoreOnly: the server board carries the number (see HsDefs).
                // There is no local W/L record to read.
                _ => new GameEntry { Key = key, Label = label, Icon = icon, Kind = kind },
            };

            _entries.Add(entry);

            // The "session" count shown under the "Saved Matches" chip. Only
            // PlayCountOnly games (Joker today) contribute, with their full local
            // play count; rated games are already counted in the saved W/L, so
            // adding them would double-count.
            if (entry.Kind == RatingKind.PlayCountOnly)
            {
                _unsyncedSessions += entry.PlayCount;
            }

            // Only games carrying a real W/L record feed the headline aggregates. A
            // Joker session is not a match and must never dilute the overall win rate
            // or the donut; a Marble Race run is a score, not an outcome.
            if (!entry.HasRecord) continue;

            _totalGames += entry.TotalGames;
            _totalWins += entry.TotalWins;
            _totalLosses += entry.TotalLosses;
            _totalDraws += entry.TotalDraws;

            // Only factor a rating into Top ELO / Best Streak once the
            // player has actually played this game. Otherwise the StartingElo floor
            // dominates the headline chips for games they have never touched.
            if (entry.TotalGames > 0)
            {
                _bestStreak = Math.Max(_bestStreak, entry.BestStreak);
                _topElo = Math.Max(_topElo, entry.Difficulties.Max(d => d.EloRating));
            }
        }

        var played = _entries.Where(e => e.TotalGames > 0).ToList();
        _bestEntry = played.OrderByDescending(e => e.WinRate).ThenByDescending(e => e.TotalGames).FirstOrDefault();
        _nemesisEntry = played.Count > 1
            ? played.OrderBy(e => e.WinRate).ThenByDescending(e => e.TotalGames).First()
            : null;
        if (_bestEntry == _nemesisEntry) _nemesisEntry = null;
    }

    /// <summary>
    /// Whether the player has anything to show for this game, measured against whatever
    /// the game tracks: a W/L record, a session count, or a row of their own on the
    /// server board. A game with none of them is a chip on the "not played yet" line.
    /// </summary>
    private static bool HasActivity(GameEntry g, Dictionary<string, HighScoreEntry> best) =>
        g.TotalGames > 0 || g.PlayCount > 0 || (best.TryGetValue(g.Key, out var hs) && hs.HasValue);

    /// <summary>
    /// The player's best on the server board, for the games whose board carries a score
    /// or a time. Null for the AI games: their "best" is the ELO their rating rows show.
    /// </summary>
    private static string? ScoreOf(GameEntry g, Dictionary<string, HighScoreEntry> best) =>
        HsDefs.Any(d => d.Key == g.Key && d.Kind != "ai") && best.TryGetValue(g.Key, out var hs) && hs.HasValue
            ? hs.Value
            : null;

    // Every PlayCountOnly game (Joker today) is a demo-only experience — the only
    // entry point on the catalog is its /demo route, so a "Watch again" link from
    // the profile card takes the user straight to it without bouncing through the
    // home page first.
    private static string DemoUrl(string gameKey) => $"/{gameKey}/demo";

    /// <summary>
    /// Where an unplayed game's chip leads: the catalogue's primary mode for it. The stat
    /// keys here predate the catalogue's (pofunquiz / funquiz), hence the suffix match;
    /// anything unmatched falls back to the hub.
    /// </summary>
    private static string PlayUrl(string gameKey) =>
        GameCatalog.All.FirstOrDefault(g => gameKey.EndsWith(g.Key.Value, StringComparison.OrdinalIgnoreCase))?.Primary.Url ?? "/";

    /// <summary>
    /// A game rated by a single adaptive ELO against a rating-matched CPU. The whole
    /// record lives in one bucket, surfaced as the "Adaptive" difficulty row so the
    /// breakdown grid renders it the same way as a bucketed game.
    /// </summary>
    private GameEntry BuildAdaptiveEntry(string key, string label, string icon)
    {
        var ar = GameStatsService.GetAdaptiveRating(key, _playerName);
        return new GameEntry
        {
            Key = key,
            Label = label,
            Icon = icon,
            Kind = RatingKind.Adaptive,
            TotalWins = ar.Wins,
            TotalLosses = ar.Losses,
            TotalDraws = ar.Draws,
            BestStreak = ar.WinStreak,
            Difficulties =
            [
                new DiffEntry { Name = "Adaptive", Wins = ar.Wins, Losses = ar.Losses, Draws = ar.Draws, EloRating = ar.Elo }
            ]
        };
    }

    /// <summary>A game rated by Easy/Medium/Hard buckets.</summary>
    private GameEntry BuildDifficultyEntry(string key, string label, string icon)
    {
        var stats = GameStatsService.GetStats(key, _playerName);
        return new GameEntry
        {
            Key = key,
            Label = label,
            Icon = icon,
            Kind = RatingKind.Difficulty,
            TotalWins = stats.TotalWins,
            TotalLosses = stats.TotalLosses,
            TotalDraws = stats.TotalDraws,
            BestStreak = Math.Max(stats.Easy.WinStreak,
                            Math.Max(stats.Medium.WinStreak, stats.Hard.WinStreak)),
            Difficulties =
            [
                new DiffEntry { Name = "Easy",   Wins = stats.Easy.Wins,   Losses = stats.Easy.Losses,   Draws = stats.Easy.Draws,   EloRating = stats.Easy.EloRating   },
                new DiffEntry { Name = "Medium", Wins = stats.Medium.Wins, Losses = stats.Medium.Losses, Draws = stats.Medium.Draws, EloRating = stats.Medium.EloRating },
                new DiffEntry { Name = "Hard",   Wins = stats.Hard.Wins,   Losses = stats.Hard.Losses,   Draws = stats.Hard.Draws,   EloRating = stats.Hard.EloRating   },
            ]
        };
    }

    // ── Radar SVG ────────────────────────────────────────────────
    private string BuildRadarSvg()
    {
        const double cx = 150, cy = 150, maxR = 90;
        // One axis per plotted game. This was hardcoded to 10 while GameDefs
        // defined only 4 games, so the label loop below indexed _entries[4..9]
        // and threw IndexOutOfRangeException, crashing the whole profile page.
        //
        // Only games with a win rate the player has actually earned are plotted.
        // Score-based (Marble Race) and play-count-only (Joker) games have
        // no win rate: plotting them would pin those axes to zero and read as
        // catastrophic losses. Unplayed W/L games are excluded for the same reason.
        // Both live in the breakdown grid instead, which has a proper unplayed state.
        var plotted = _entries.Where(e => e.HasRecord && e.TotalGames > 0).ToList();
        int n = plotted.Count;
        // A player who has only played score-based games lands here — same empty SVG
        // as a brand-new player, rather than a degenerate 1- or 2-axis polygon.
        if (n < 3) return "<svg viewBox=\"0 0 300 300\" class=\"prf-radar\" aria-hidden=\"true\"></svg>";
        double step = 2 * Math.PI / n;
        const double startAngle = -Math.PI / 2;

        string Pt(double r, int i)
        {
            var a = startAngle + step * i;
            return $"{cx + r * Math.Cos(a):F1},{cy + r * Math.Sin(a):F1}";
        }

        string RingPoly(double frac) =>
            string.Join(" ", Enumerable.Range(0, n).Select(i => Pt(maxR * frac, i)));

        var dataPoly = string.Join(" ", plotted.Select((e, i) => Pt(maxR * e.WinRate, i)));

        var sb = new System.Text.StringBuilder();
        sb.Append("<svg viewBox=\"0 0 300 300\" class=\"prf-radar\" aria-hidden=\"true\">");

        // Background rings
        foreach (var frac in new[] { 0.25, 0.5, 0.75, 1.0 })
            sb.Append($"<polygon points=\"{RingPoly(frac)}\" fill=\"none\" stroke=\"rgba(255,255,255,0.06)\" stroke-width=\"1\"/>");

        // Axis lines
        for (int i = 0; i < n; i++)
        {
            var a = startAngle + step * i;
            sb.Append($"<line x1=\"{cx:F1}\" y1=\"{cy:F1}\" x2=\"{cx + maxR * Math.Cos(a):F1}\" y2=\"{cy + maxR * Math.Sin(a):F1}\" stroke=\"rgba(255,255,255,0.07)\" stroke-width=\"1\"/>");
        }

        // Data polygon
        sb.Append($"<polygon points=\"{dataPoly}\" fill=\"rgba(99,102,241,0.22)\" stroke=\"rgba(99,102,241,0.85)\" stroke-width=\"2\" stroke-linejoin=\"round\"/>");

        // Dots on played games (every plotted entry has games by construction)
        foreach (var (e, i) in plotted.Select((e, i) => (e, i)))
        {
            var a = startAngle + step * i;
            var r = maxR * e.WinRate;
            sb.Append($"<circle cx=\"{cx + r * Math.Cos(a):F1}\" cy=\"{cy + r * Math.Sin(a):F1}\" r=\"3.5\" fill=\"#6366f1\"/>");
        }

        // Labels
        for (int i = 0; i < n; i++)
        {
            var a = startAngle + step * i;
            var lx = cx + (maxR + 22) * Math.Cos(a);
            var ly = cy + (maxR + 22) * Math.Sin(a);
            var anchor = lx < cx - 5 ? "end" : lx > cx + 5 ? "start" : "middle";
            var label = plotted[i].Label.Split(' ')[0]; // first word only
            sb.Append($"<text x=\"{lx:F1}\" y=\"{ly:F1}\" text-anchor=\"{anchor}\" dominant-baseline=\"middle\" fill=\"rgba(148,163,184,0.75)\" font-size=\"8.5\" font-family=\"system-ui,sans-serif\">{System.Web.HttpUtility.HtmlEncode(label)}</text>");
        }

        sb.Append("</svg>");
        return sb.ToString();
    }

    // ── Donut SVG ────────────────────────────────────────────────
    private string BuildDonutSvg()
    {
        const double r = 60, cx = 100, cy = 100;
        double circ = 2 * Math.PI * r;

        if (_totalGames == 0)
        {
            return $"<svg viewBox=\"0 0 200 200\" class=\"prf-donut\" aria-hidden=\"true\">" +
                   $"<circle cx=\"{cx}\" cy=\"{cy}\" r=\"{r}\" fill=\"none\" stroke=\"rgba(255,255,255,0.08)\" stroke-width=\"20\"/>" +
                   $"<text x=\"{cx}\" y=\"{cy - 8}\" text-anchor=\"middle\" dominant-baseline=\"middle\" fill=\"rgba(148,163,184,0.5)\" font-size=\"13\" font-family=\"system-ui,sans-serif\">No</text>" +
                   $"<text x=\"{cx}\" y=\"{cy + 10}\" text-anchor=\"middle\" dominant-baseline=\"middle\" fill=\"rgba(148,163,184,0.5)\" font-size=\"13\" font-family=\"system-ui,sans-serif\">games</text>" +
                   "</svg>";
        }

        double winLen = _totalWins / (double)_totalGames * circ;
        double drawLen = _totalDraws / (double)_totalGames * circ;
        double lossLen = _totalLosses / (double)_totalGames * circ;

        string Seg(double len, double cumOffset, string color) =>
            $"<circle cx=\"{cx}\" cy=\"{cy}\" r=\"{r}\" fill=\"none\" stroke=\"{color}\" stroke-width=\"20\" " +
            $"stroke-dasharray=\"{len:F2} {circ - len:F2}\" stroke-dashoffset=\"{circ - cumOffset:F2}\" " +
            $"transform=\"rotate(-90 {cx} {cy})\"/>";

        var sb = new System.Text.StringBuilder();
        sb.Append("<svg viewBox=\"0 0 200 200\" class=\"prf-donut\" aria-hidden=\"true\">");

        // Background ring
        sb.Append($"<circle cx=\"{cx}\" cy=\"{cy}\" r=\"{r}\" fill=\"none\" stroke=\"rgba(255,255,255,0.04)\" stroke-width=\"20\"/>");

        double cum = 0;
        if (winLen > 0) { sb.Append(Seg(winLen, cum, "#22c55e")); cum += winLen; }
        if (drawLen > 0) { sb.Append(Seg(drawLen, cum, "#f59e0b")); cum += drawLen; }
        if (lossLen > 0) { sb.Append(Seg(lossLen, cum, "#ef4444")); }

        // Centre label
        sb.Append($"<text x=\"{cx}\" y=\"{cy - 7}\" text-anchor=\"middle\" fill=\"#f1f5f9\" font-size=\"18\" font-weight=\"700\" font-family=\"system-ui,sans-serif\">{_totalGames}</text>");
        sb.Append($"<text x=\"{cx}\" y=\"{cy + 12}\" text-anchor=\"middle\" fill=\"rgba(148,163,184,0.7)\" font-size=\"10\" font-family=\"system-ui,sans-serif\">GAMES</text>");

        sb.Append("</svg>");
        return sb.ToString();
    }
}
