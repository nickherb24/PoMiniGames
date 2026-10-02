using Blazored.LocalStorage;
using Microsoft.AspNetCore.Components.Authorization;
using Microsoft.AspNetCore.Components.Web;
using Microsoft.AspNetCore.Components.WebAssembly.Hosting;
using Microsoft.JSInterop;
using PoMiniGamesClient;
using PoMiniGamesClient.Games.PoCoupleQuiz.Services;
using PoMiniGamesClient.Games.PoFunQuiz.Services;
using PoMiniGamesClient.Games.PoCabinet;
using PoMiniGamesClient.Games.PoRacer;
using PoMiniGamesClient.Services.Auth;
using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;

var builder = WebAssemblyHostBuilder.CreateDefault(args);
builder.RootComponents.Add<App>("#app");
builder.RootComponents.Add<HeadOutlet>("head::after");

// The host serves both the WASM client and the API on the SAME origin (no separate
// frontend server, no CORS), so the origin the app was served from is
// always where the API lives. Use it directly. This is correct in every scenario:
//   • dev run on :5080  -> served from :5080 -> API on :5080
//   • E2E-UI / any host on a dynamic port -> served from that port -> API on that port
//   • Production/Staging -> same origin
// A previous hardcode of http://localhost:5000 broke any host not on :5000 (including
// the dynamic-port E2E-UI Kestrel host: the SPA called :5000 and got ERR_CONNECTION_REFUSED).
// An explicit PoMiniGames:ApiBaseAddress override remains for split dev-server setups.
var apiBase = builder.Configuration["PoMiniGames:ApiBaseAddress"]
              ?? builder.Configuration["ApiBaseAddress"];
if (string.IsNullOrWhiteSpace(apiBase))
{
    apiBase = builder.HostEnvironment.BaseAddress;
}
// Cross-origin credentials: the Blazor WASM HttpClient uses the browser's
// `fetch` underneath, which defaults to `credentials: 'omit'`. On the
// standalone-client dev setup (Blazor served from :5261, API on :5000)
// every cross-origin request therefore drops the DevCookie set by
// /api/auth/dev-login and every protected endpoint returns 401.
//
// We patch `window.fetch` once at startup (see
// wwwroot/js/crossOriginFetchPatch.js) so requests to the API origin get
// `credentials: 'include'` while every other origin stays untouched.
// The patch is idempotent. Installed via JS interop during
// WebAssemblyHostBuilder.Build() below — see the `await host.RunAsync()`
// chain after `var host = builder.Build()`.
//
// The HttpClient is built over an explicit DelegatingHandler pipeline so
// credential inclusion has a code-level guarantee (IncludeCredentialsHandler),
// not only the JS monkey-patch, and so transient GET failures get a bounded
// retry (TransientRetryHandler), and so CSRF tokens are attached without every
// call site remembering to (AntiforgeryHandler). Order (outer → inner):
//   TransientRetryHandler → PlaySessionHandler → AntiforgeryHandler
//     → IncludeCredentialsHandler → HttpClientHandler
// Retry is outermost so each replayed clone passes back through
// IncludeCredentialsHandler and gets the credentials mode re-applied before it
// reaches the browser transport (HttpClientHandler backs the WASM fetch shim).
// PlaySessionHandler sits directly under the retry for the same reason the retry is
// outermost: a replayed score submission must be re-stamped with the play session, or
// the retry itself would look to the server like a submission with no session at all.
// It is above AntiforgeryHandler because it makes no request of its own and needs no
// cookie — it only copies a header onto the outbound message.
// AntiforgeryHandler sits ABOVE IncludeCredentialsHandler: the token fetch it makes must
// carry credentials, because the response sets the paired antiforgery cookie the server
// validates the header against.
builder.Services.AddScoped(sp => new HttpClient(
    new TransientRetryHandler
    {
        InnerHandler = new PlaySessionHandler(sp.GetRequiredService<PlaySessionStore>())
        {
            InnerHandler = new AntiforgeryHandler
            {
                InnerHandler = new IncludeCredentialsHandler
                {
                    InnerHandler = new HttpClientHandler()
                }
            }
        }
    })
{
    BaseAddress = new Uri(apiBase)
});
// Score integrity: the store holds the current play session (and depends on nothing, which
// is what lets the handler above resolve it while the HttpClient is still being built), the
// service mints one per game route the player opens. Registered before ApiService so the
// ordering reads the way the pipeline runs.
builder.Services.AddScoped<PlaySessionStore>();
builder.Services.AddScoped<PlaySessionService>();
builder.Services.AddScoped<ApiService>();
// Absolute API endpoints: resolved once from configuration + host env so
// SignalR and other string-URL transports can target the API host (:5000)
// even when the WASM is served standalone on :5261.
builder.Services.AddScoped<ApiEndpoints>();
builder.Services.AddScoped<AuthStateService>();
// BFF-aware AuthenticationStateProvider wired into <AuthorizeRouteView>.
builder.Services.AddScoped<AuthenticationStateProvider, BffAuthenticationStateProvider>();
builder.Services.AddAuthorizationCore();
builder.Services.AddScoped<PlayerNameService>();
builder.Services.AddScoped<ToastService>();
builder.Services.AddScoped<GameStatsService>();
// PoCabinet race session owns both lobby + race hub connections for
// the lifetime of one race. Scoped — each Blazor circuit creates its own.
builder.Services.AddScoped<PoCabinetSession>();
// PoCabinetCareerState holds the player's 3-stage progress
// in localStorage and exposes a Changed event the ChampionshipView subscribes
// to. Scoped so each Blazor circuit reads its own ILocalStorageService cache.
builder.Services.AddScoped<PoCabinetCareerState>();
// Offline score resilience: durable localStorage queue + flusher behind GameResultService,
// so a failed leaderboard submit is parked and synced on reconnect rather than lost.
builder.Services.AddScoped<PendingScoreStore>();
builder.Services.AddScoped<ScoreSyncService>();
builder.Services.AddScoped<GameResultService>();
builder.Services.AddScoped<MatchHistoryService>();
// Game invites: push opt-in for this device and invite-a-past-opponent.
builder.Services.AddScoped<InviteService>();
builder.Services.AddScoped<ActivityFeedService>();
// Native Web Audio micro-feedback — shared across every game so the platform
// has a consistent sound vocabulary. Lazily resolves the AudioContext on first call.
builder.Services.AddScoped<UiFeedbackService>();
// The silent, visual-only half of the feedback stack: particles and screen feel
// without a sound. Separate from UiFeedbackService because anything that should
// make a noise belongs in the cue vocabulary instead, where the sound and the
// visual stay welded together.
builder.Services.AddScoped<ScreenFxService>();
// Global settings (master mute, FPS badge) shared by the layout and every game.
builder.Services.AddScoped<SettingsService>();
// Blazored.LocalStorage. New code should take ILocalStorageService and use
// the *AsString* members; the generic overloads go through reflection-based JSON that the
// trim analyzer rejects. Existing raw `localStorage.getItem` interop is left as-is.
builder.Services.AddBlazoredLocalStorage();
// Viewport-width helper so leaderboards can render
// top-3 on mobile and top-10 on desktop without a JS-only media query.
builder.Services.AddScoped<BrowserViewport>();
// PWA: connectivity state for the offline banner, and service-worker registration
// plus the "new version available" prompt. Both are initialized once from
// MainLayout and are no-ops where the browser has no service worker support.
builder.Services.AddScoped<OnlineStatusService>();
builder.Services.AddScoped<AppUpdateService>();
// Singleton — manages the shared "Watch All Demos" auto-rotation timer
// across the lifetime of the Blazor session. Fixes the timer-leak /
// hijack-navigation bug (QA finding #1 + #4).
builder.Services.AddSingleton<KioskCoordinator>();
// PoCoupleQuiz Phase 1: SignalR client wrapper for the /couplequiz/hubs/game hub.
builder.Services.AddScoped<CoupleQuizHubService>();
// PoFunQuiz Phase 2 follow-up: SignalR client wrapper for /funquiz/gamehub.
builder.Services.AddScoped<FunQuizHubService>();
// PoSports: SignalR client wrapper for /posports/lobby-hub + /posports/race-hub.
builder.Services.AddScoped<PoMiniGamesClient.Games.PoSports.Services.PoSportsHubService>();
// PoVoxelStrike co-op: SignalR client wrapper for /povoxelstrike/lobby-hub +
// /povoxelstrike/lockstep-hub. Scoped like every other hub service so the connection
// is bound to the user's Blazor session lifetime.
builder.Services.AddScoped<PoMiniGamesClient.Games.PoVoxelStrike.Services.PoVoxelStrikeMultiplayerClient>();
builder.Services.AddScoped<PoEcosystemInteropService>();
// PoEcosystem's server surface: cloud world slots, the gallery, the chronicle and cloud thoughts.
builder.Services.AddScoped<PoMiniGamesClient.Games.PoEcosystem.Services.PoEcosystemApiClient>();
// PoJevArena's server surface: status/allowance, the creature library, match registration and
// the Jev decision round trip (every call on the shared HttpClient pipeline).
builder.Services.AddScoped<PoMiniGamesClient.Games.PoJevArena.PoJevArenaApiClient>();

// ─── PoJoker (demo-only autonomous comedy show) ──────────────────────
// TTS + Web-Audio effects run via JS interop
// (pojoker-speech-interop.js / pojoker-audio-interop.js). PerformanceSettings is a plain
// singleton consumed by JesterStage when it constructs the PerformanceOrchestrator.
builder.Services.AddScoped<PoMiniGamesClient.Games.PoJoker.JokerSpeechService>();
builder.Services.AddScoped<PoMiniGamesClient.Games.PoJoker.JokerAudioService>();
builder.Services.AddSingleton<PoMiniGames.Shared.Games.PoJoker.PerformanceSettings>();

var host = builder.Build();

// Initialize LocalStorageService with the JS runtime so all localStorage operations work
LocalStorageService.SetJSRuntime(host.Services.GetRequiredService<IJSRuntime>());

// Cross-origin credentials patch: must run before any HttpClient is used
// (i.e. before any component renders), so we install it right after Build
// but before RunAsync. Requests to `apiBase` get credentials: 'include' so
// the DevCookie set by /api/auth/dev-login round-trips on the
// standalone-client (:5261 → :5000) dev setup. Everything else — including
// MSAL's Entra calls — keeps the browser default; passing apiBase is what
// scopes it (see the module header for the sign-in outage a blanket patch
// caused). Installs nothing when the API is same-origin.
var fetchPatchModule = await host.Services.GetRequiredService<IJSRuntime>()
    .InvokeAsync<IJSObjectReference>("import", "./js/crossOriginFetchPatch.js");
await fetchPatchModule.InvokeVoidAsync("installCrossOriginCredentialsPatch", apiBase);

await host.RunAsync();
