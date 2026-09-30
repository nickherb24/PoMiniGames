using PoMiniGames.Shared.Games;
using PoMiniGamesClient.Models;
// Alias, not a namespace import: PoMiniGamesClient.Models mirrors several other Domain
// types by name, so importing the namespace wholesale would make them all ambiguous.
using PoSportsHighScore = PoMiniGames.Domain.Models.PoSportsHighScore;

using PoMiniGamesClient.Services.Auth;
using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGamesClient.Services.Play;

/// <summary>
/// The single intake every game reports an outcome to. It owns "what happens when a game ends":
/// local stats are always recorded, and a server high score is submitted in the same awaited step
/// when one is supplied — so the two writes can no longer desync the way a fire-and-forget submit can.
/// </summary>
/// <remarks>
/// Pattern: a deep module over two adapters. Local stats (<see cref="GameStatsService"/>) and the
/// server board (<see cref="ApiService"/>) sit behind one interface, concentrating outcome handling
/// in one place instead of each game wiring both — or routing around one of them.
/// </remarks>
public sealed class GameResultService
{
    private readonly GameStatsService _stats;
    private readonly ApiService _api;
    private readonly ScoreSyncService _sync;
    private readonly UiFeedbackService _feedback;
    private readonly AuthStateService _auth;
    private readonly ToastService _toast;
    // Nudge a guest to sign in at most once per app session — a soft invitation,
    // not a nag after every round.
    private bool _guestNudgeShown;

    public GameResultService(
        GameStatsService stats,
        ApiService api,
        ScoreSyncService sync,
        UiFeedbackService feedback,
        AuthStateService auth,
        ToastService toast)
    {
        _stats = stats;
        _api = api;
        _sync = sync;
        _feedback = feedback;
        _auth = auth;
        _toast = toast;
    }

    /// <summary>
    /// §10 A server submit didn't land, so the score was parked in the offline queue.
    /// Why it failed changes what the player should hear:
    /// <list type="bullet">
    /// <item>Guest (not signed in) — this isn't an error, it's the deferred-sign-in
    /// path. Nudge them to sign in so the parked score reaches the board; keep the
    /// audio soft.</item>
    /// <item>Signed-in — a genuine network hiccup. Buzz + reassure that it will sync.</item>
    /// </list>
    /// </summary>
    private async Task OnScoreParkedAsync()
    {
        if (!_auth.IsAuthenticated)
        {
            await _feedback.TapAsync();
            if (!_guestNudgeShown)
            {
                _guestNudgeShown = true;
                _toast.Show("Nice run! Sign in to save your score to the leaderboard.", ToastType.Info);
            }
        }
        else
        {
            await _feedback.ErrorAsync();
            _toast.Show("You're offline — your score will sync automatically.", ToastType.Warning);
        }
    }

    /// <summary>Records a local-only outcome (the common path for games without a server board).</summary>
    public Task<PlayerStats> RecordAsync(string gameKey, string playerName, Difficulty difficulty, GameResult result) =>
        _stats.RecordResult(gameKey, playerName, difficulty, result);

    /// <summary>
    /// Records the outcome locally AND pushes the updated stats to the server board, parking
    /// them in the offline queue if the write fails.
    /// </summary>
    /// <remarks>
    /// For win-rate games with no separate high-score payload. <see cref="RecordAsync"/> writes
    /// only to localStorage, so a game that used it and nothing else could never appear on its
    /// own leaderboard — which is exactly what happened to PoCoupleQuiz. This is
    /// <see cref="SubmitAdaptiveStatsAsync"/>'s flow without the adaptive-ELO mirroring, which
    /// only applies to games whose CPU is matched to the player's rating.
    /// </remarks>
    public async Task<PlayerStats> RecordAndSyncStatsAsync(
        string gameKey, string playerName, Difficulty difficulty, GameResult result)
    {
        var stats = await _stats.RecordResult(gameKey, playerName, difficulty, result);
        var (ok, _) = await _api.SavePlayerStatsAsync(gameKey, playerName, stats);
        if (!ok)
        {
            _sync.EnqueuePlayerStats(new PendingPlayerStats
            {
                GameKey = gameKey,
                PlayerName = playerName,
                Stats = stats,
            });
            await OnScoreParkedAsync();
        }
        return stats;
    }

    /// <summary>How a server high-score submit resolved; drives the shared feedback path.</summary>
    private enum SubmitOutcome
    {
        /// <summary>The board accepted the score.</summary>
        Saved,
        /// <summary>Unreachable or a server fault — the payload is good, so park it and let the
        /// queue replay it on reconnect. The leaderboard is the platform's North Star.</summary>
        Park,
        /// <summary>The server rejected this score outright; queueing it would only replay the
        /// rejection forever. Say so instead of promising a sync that can't happen.</summary>
        Rejected,
    }

    /// <summary>
    /// The one record-then-submit flow both per-game wrappers share: record the local
    /// outcome, submit the high score (when one was earned), and translate the submit
    /// outcome into feedback — saved chime, offline park + nudge, or a rejection toast.
    /// </summary>
    private async Task<PlayerStats> RecordAndSubmitCoreAsync(
        string gameKey, string playerName, GameResult result, bool hasHighScore,
        Func<Task<SubmitOutcome>> submitAsync, Action enqueueOffline)
    {
        var stats = await _stats.RecordResult(gameKey, playerName, Difficulty.Medium, result);
        if (!hasHighScore)
        {
            await _feedback.TapAsync();
            return stats;
        }

        switch (await submitAsync())
        {
            case SubmitOutcome.Saved:
                await _feedback.CompleteAsync();
                break;
            case SubmitOutcome.Park:
                enqueueOffline();
                await OnScoreParkedAsync();
                break;
            default:
                await _feedback.ErrorAsync();
                _toast.Show("That score couldn't be saved to the leaderboard.", ToastType.Error);
                break;
        }
        return stats;
    }

    /// <summary>
    /// Records the local outcome and, when <paramref name="highScore"/> is supplied, submits it to the
    /// server board in the same awaited call. One report, both writes, consistent ordering.
    /// </summary>
    public Task<PlayerStats> RecordAndSubmitMarbleRaceAsync(
        string playerName, GameResult result, MarbleRaceHighScoreRequest? highScore) =>
        RecordAndSubmitCoreAsync("pomarblerace", playerName, result, highScore is not null,
            async () =>
            {
                var submitted = await _api.SubmitMarbleRaceHighScoreAsync(highScore!);
                return submitted.IsSaved ? SubmitOutcome.Saved
                    : submitted.ShouldRetry ? SubmitOutcome.Park
                    : SubmitOutcome.Rejected;
            },
            () => _sync.EnqueueMarbleRace(highScore!));

    /// <summary>
    /// §PoCabinet (T11, 2026-09-17): per-track best-lap ratchet. Ties the
    /// finished-race flow through the same offline-resilient path as the
    /// other games so a player who finishes a race while offline still gets
    /// the run recorded later.
    /// </summary>
    public Task<PlayerStats> RecordAndSubmitPoCabinetAsync(
        string playerName, GameResult result, PoCabinetHighScoreRequest? highScore) =>
        RecordAndSubmitCoreAsync("pocabinet", playerName, result, highScore is not null,
            async () =>
            {
                var submitted = await _api.SubmitPoCabinetHighScoreAsync(highScore!);
                return submitted.IsSaved ? SubmitOutcome.Saved
                    : submitted.ShouldRetry ? SubmitOutcome.Park
                    : SubmitOutcome.Rejected;
            },
            () => _sync.EnqueuePoCabinet(highScore!));

    /// <summary>
    /// The single sync path for adaptive-ELO games (ConnectFive/TicTacToe): mirror the
    /// adaptive record into the legacy stats shape (Medium bucket carries the adaptive
    /// W/L/D and ELO), persist locally, and PUT to the server so the leaderboard shows
    /// this player. A failed PUT is parked in the offline queue and replayed on reconnect.
    /// </summary>
    public async Task SubmitAdaptiveStatsAsync(string gameKey, string playerName, AdaptiveRating rating)
    {
        var stats = _stats.GetStats(gameKey, playerName);
        stats.Medium.Wins = rating.Wins;
        stats.Medium.Losses = rating.Losses;
        stats.Medium.Draws = rating.Draws;
        stats.Medium.EloRating = rating.Elo;
        await _stats.SaveStats(gameKey, stats);
        var (ok, _) = await _api.SavePlayerStatsAsync(gameKey, playerName, stats);
        if (!ok)
        {
            _sync.EnqueuePlayerStats(new PendingPlayerStats
            {
                GameKey = gameKey,
                PlayerName = playerName,
                Stats = stats,
            });
        }
    }

    /// <summary>Records the PoSports meet locally and submits the combined time together.</summary>
    /// <remarks>
    /// Routed through the shared flow so a failed submit parks for replay instead of being
    /// discarded: the board ratchets to the fastest time, so a personal best dropped on a
    /// flaky connection is gone for good unless the player beats it again.
    /// </remarks>
    public Task<PlayerStats> RecordAndSubmitPoSportsAsync(
        string playerName, GameResult result, PoSportsHighScore? highScore) =>
        RecordAndSubmitCoreAsync("posports", playerName, result, highScore is not null,
            async () =>
            {
                var submitted = await _api.SubmitPoSportsHighScoreAsync(highScore!);
                return submitted.IsSaved ? SubmitOutcome.Saved
                    : submitted.ShouldRetry ? SubmitOutcome.Park
                    : SubmitOutcome.Rejected;
            },
            () => _sync.EnqueuePoSports(highScore!));

    /// <summary>Records the PoVoxelStrike run locally and submits it to the board together.</summary>
    /// <remarks>Every finished run submits — the server descriptor ratchets to the player's
    /// best, so a lower score is an accepted no-op rather than a rejection.
    /// <paramref name="onNewBest"/> fires only on a confirmed server save whose stored row
    /// carries this run's score — i.e. the ratchet advanced. A parked (offline) submit never
    /// fires it: no confirmation, no badge.</remarks>
    public Task<PlayerStats> RecordAndSubmitPoVoxelStrikeAsync(
        string playerName, GameResult result, PoVoxelStrikeRunRequest? run,
        Action<bool>? onNewBest = null) =>
        RecordAndSubmitCoreAsync("povoxelstrike", playerName, result, run is not null,
            async () =>
            {
                var submitted = await _api.SubmitPoVoxelStrikeRunAsync(run!);
                if (submitted.IsSaved)
                {
                    onNewBest?.Invoke(submitted.Value is { } saved && saved.Score == run!.Score);
                    return SubmitOutcome.Saved;
                }
                return submitted.ShouldRetry ? SubmitOutcome.Park : SubmitOutcome.Rejected;
            },
            () => _sync.EnqueuePoVoxelStrike(run!));

    /// <summary>Records the PoBrawl outcome locally and submits the fastest-KO score together.</summary>
    /// <remarks>The PoBrawl submit API only signals reachability (null response), so a
    /// failure always parks for replay — there is no explicit-rejection path here.</remarks>
    public Task<PlayerStats> RecordAndSubmitPoBrawlAsync(
        string playerName, GameResult result, PoBrawlHighScore? highScore) =>
        RecordAndSubmitCoreAsync("pobrawl", playerName, result, highScore is not null,
            async () => await _api.SubmitPoBrawlHighScoreAsync(highScore!) is null
                ? SubmitOutcome.Park
                : SubmitOutcome.Saved,
            () => _sync.EnqueuePoBrawl(highScore!));
}
