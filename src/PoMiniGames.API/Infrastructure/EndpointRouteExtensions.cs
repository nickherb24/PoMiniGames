using PoMiniGames.Features.Account;
using PoMiniGames.Features.Auth;
using PoMiniGames.Features.ConnectFive;  // ConnectFiveHub (the slice's only server surface)
using PoMiniGames.Features.TicTacToe;    // TicTacToeHub (same)
using PoMiniGames.Features.Health;
using PoMiniGames.Features.Integrity;
using PoMiniGames.Features.Invites;       // push subscriptions + game invites (2026-10-01)
using PoMiniGames.Features.PoSports;
using PoMiniGames.Features.PoBrawl;        // moved out of Features.HighScores 2026-08-11,
                                           // same correction PoMarbleRace already had
using PoMiniGames.Features.PoBrawl.Online; // 2026-09-14: lobby hub + match hub + match ingest
using PoMiniGames.Features.PoMarbleRace;   // moved out of Features.HighScores so the
                                           // namespace matches its own slice folder
using PoMiniGames.Features.Leaderboard;
using PoMiniGames.Features.MatchHistory;
using PoMiniGames.Features.PoCoupleQuiz;  // CoupleQuizHub (the slice's only server surface)
using PoMiniGames.Features.PoEcosystem;   // cloud world slots, gallery, chronicle (2026-09-14)
using PoMiniGames.Features.PoFunQuiz;
using PoMiniGames.Features.PoJevArena;    // Jev-driven 10v10 arena (2026-09-25)
using PoMiniGames.Features.PoJoker;
using PoMiniGames.Features.PoRacer;
using PoMiniGames.Features.PoCabinet; // T4-T6: career, score, lobby + race hubs
using PoMiniGames.Features.PoVoxelStrike;

namespace PoMiniGames.Infrastructure;

/// <summary>
/// Single, ordered registration point for every HTTP endpoint and SignalR hub.
/// Program.cs maps the whole surface with one <c>app.MapPoMiniGamesEndpoints()</c>
/// call, so the route table is described in exactly one place.
///
/// The authenticated game API is one <c>MapGroup("/api")</c>: the prefix is declared
/// once here and every slice below mounts a relative group under it, so the shared
/// <c>/api</c> segment and the auth gate that guards it are stated in the same place.
/// (Declaring it once keeps the boundary the antiforgery filter keys on visible at the
/// registration site.) Anonymous surfaces below are mapped
/// straight on <c>app</c> and therefore still spell their full path. SignalR hubs are mapped directly on
/// <c>app</c> because <c>MapHub&lt;T&gt;</c> returns <c>IHubEndpointConventionBuilder</c>,
/// which is not an <c>IEndpointConventionBuilder</c> and cannot be composed inside a group.
/// </summary>
internal static class EndpointRouteExtensions
{
    public static WebApplication MapPoMiniGamesEndpoints(this WebApplication app)
    {
        // ── Platform: unprotected (auth flow, health probes, diagnostics) ──
        app.MapAuthEndpoints();
        // CSRF token issuer. Anonymous + GET, so it stays reachable before sign-in
        // and is itself exempt from the validation gate it feeds.
        app.MapAntiforgeryEndpoints();
        app.MapHealthEndpoints();
        // Uniform cross-app liveness probe (see PoPlatform). Same shape in every Po app, which
        // is what lets the portfolio dashboard poll them all and render one uptime grid.
        app.MapPoLiveness();
        // AI usage read-model. Grouped with the health probes rather than behind the game-API auth
        // gate because it is a diagnostics surface, and it reports no other identity's spend — only
        // aggregate per-game counters plus the caller's own allowance.
        app.MapAiUsageEndpoints();
        app.MapDiagEndpoints();
        // Browser-side error sink (js/errorReporter.js). Deliberately NOT under /api: it is fed
        // by sendBeacon, which cannot carry the antiforgery header that scope requires.
        app.MapClientErrorEndpoints();

        // ── Public read-only leaderboards (guest-first) ────────────────────
        // A brand-new visitor can browse the boards before signing in, so
        // the leaderboard READ endpoints are anonymous. These are pure GETs
        // (no writes), and default authorization is anonymous — they just have to
        // stay outside the authenticated group below. Score
        // SUBMIT paths stay authenticated (guests park scores locally and flush
        // them on sign-in), so anonymous read never becomes anonymous write.
        app.MapUnifiedLeaderboardEndpoints();
        // PoVoxelStrike voxel assets are read-only game content (content-addressed,
        // immutable), so they sit with the anonymous reads; the run-submission POST
        // is in the authenticated group below.
        app.MapPoVoxelStrikeAssetEndpoints();
        // PoEcosystem gallery: shared islands are public by their owners' choice, and a visit
        // is a read of bytes only the browser engine can interpret.
        app.MapPoEcosystemGalleryEndpoints();
        // Dynamic SVG Player License cards & Online MMR profile inspection
        app.MapPlayerCardEndpoints();

        // ── Authenticated game API ─────────────────────────────────────────
        // All game-data endpoints require a valid session. Per-endpoint rate
        // limits (highscores, ai-generation, infer) are declared
        // inside each slice; the group adds the auth gate only.
        //
        // The "/api" prefix lives here, not in the slices: it is exactly the scope
        // AntiforgeryExtensions validates, so the CSRF boundary, the auth boundary and
        // the URL boundary are now one line instead of three separate conventions.
        var gameApi = app.MapGroup("/api").RequireAuthorization();

        // Play sessions: minted per game opened, redeemed by the score guard on submission.
        // Authenticated because a session is bound to an identity — there is nothing to bind
        // for an anonymous caller, and an unbound session is a token anyone could spend.
        gameApi.MapPlaySessionEndpoints();
        // Self-service data export + erase. In the authenticated group for the obvious reason:
        // the subject is always the caller's own claim identity.
        gameApi.MapAccountEndpoints();
        gameApi.MapGetPlayerStats();
        gameApi.MapSavePlayerStats();
        gameApi.MapMarbleRaceHighScoresEndpoints();
        gameApi.MapPoBrawlLeaderboardEndpoints();
        gameApi.MapPoBrawlPresserEndpoints();
        // The 1P ladder run per claim identity, so it follows a player across devices.
        gameApi.MapPoBrawlProgressEndpoints();
        gameApi.MapMatchHistoryEndpoints();
        // PoCoupleQuiz is SignalR-first — CoupleQuizHub below is its entire server surface.
        gameApi.MapFunQuizEndpoints();
        gameApi.MapPoJokerEndpoints();
        gameApi.MapPoRacerScoreEndpoints();
        // PoCabinet (T4): career cross-device resume endpoint. T5 adds the score
        // endpoint; T6 adds the lobby + race SignalR hubs.
        gameApi.MapPoCabinetCareerEndpoints();
        gameApi.MapPoCabinetScoreEndpoints();
        gameApi.MapPoCabinetAiEndpoints();
        gameApi.MapPoSportsHighScoresEndpoints();
        gameApi.MapPoVoxelStrikeScoreEndpoints();
        // PoBrawl online (lobby + match hub) — match result ingest endpoint. Same
        // shape as PoRacer's score endpoints: authenticated, rate-limited highscores.
        gameApi.MapPoBrawlOnlineMatchEndpoints();
        // PoEcosystem: the caller's three cloud slots, sharing, the chronicle and cloud thoughts.
        gameApi.MapPoEcosystemEndpoints();
        // PoJevArena: Jev status/allowance, match registration and the decision proxy. Inside the
        // authenticated group because every route spends or reveals the caller's Jev allowance.
        gameApi.MapPoJevArenaEndpoints();
        // Game invites: push subscriptions, invite-a-past-opponent and the lobby QR code.
        gameApi.MapInviteEndpoints();

        // ── SignalR hubs (auth required; not part of MapGroup) ────────────
        app.MapHub<CoupleQuizHub>("/couplequiz/hubs/game").RequireAuthorization();
        app.MapHub<FunQuizHub>("/funquiz/gamehub").RequireAuthorization();
        app.MapHub<PoRacerLobbyHub>("/poracer/lobby-hub").RequireAuthorization();
        app.MapHub<PoRacerRaceHub>("/poracer/race-hub").RequireAuthorization();
        app.MapHub<PoMiniGames.Features.PoSports.PoSportsLobbyHub>("/posports/lobby-hub").RequireAuthorization();
        // PoCabinet (T6): lobby + race hubs at their own roots (anonymous /negotiate).
        app.MapHub<PoCabinetLobbyHub>("/pocabinet/lobby-hub").RequireAuthorization();
        app.MapHub<PoCabinetRaceHub>("/pocabinet/race-hub").RequireAuthorization();
        app.MapHub<PoMiniGames.Features.PoSports.PoSportsRaceHub>("/posports/race-hub").RequireAuthorization();
        // PoVoxelStrike co-op: lobby hub for the ready/start room, lockstep hub for the
        // active run. Both follow the platform pattern (auth required, separate from
        // MapGroup because MapHub returns IHubEndpointConventionBuilder).
        app.MapHub<PoMiniGames.Features.PoVoxelStrike.PoVoxelStrikeLobbyHub>("/povoxelstrike/lobby-hub").RequireAuthorization();
        app.MapHub<PoMiniGames.Features.PoVoxelStrike.PoVoxelStrikeLockstepHub>("/povoxelstrike/lockstep-hub").RequireAuthorization();
        // PoBrawl online: lobby hub carries the ready/start room, match hub carries the
        // per-tick combat state. Same platform conventions as every other live hub.
        app.MapHub<PoMiniGames.Features.PoBrawl.Online.PoBrawlLobbyHub>("/pobrawl/lobby-hub").RequireAuthorization();
        app.MapHub<PoMiniGames.Features.PoBrawl.Online.PoBrawlMatchHub>("/pobrawl/match-hub").RequireAuthorization();
        // ConnectFive + TicTacToe online: one turn-match hub each carries queue, moves,
        // rematch and reconnect. SignalR-first like PoCoupleQuiz — neither slice maps
        // an HTTP route at all.
        app.MapHub<ConnectFiveHub>("/connectfive/hub").RequireAuthorization();
        app.MapHub<TicTacToeHub>("/tictactoe/hub").RequireAuthorization();
        // PoMarbleRace online: pairing + host→guest frame relay + guest→host steering.
        app.MapHub<PoMarbleRaceOnlineHub>("/pomarblerace/hub").RequireAuthorization();

        return app;
    }
}
