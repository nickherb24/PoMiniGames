using PoMiniGames.Domain.Services;
using PoMiniGames.Features.PoCoupleQuiz;
using PoMiniGames.Features.PoFunQuiz;
using PoMiniGames.Features.PoFunQuiz.Storage;
using PoMiniGames.Features.PoEcosystem;
using PoMiniGames.Features.PoJoker;
using PoMiniGames.Features.PoJoker.Storage;
using PoMiniGames.Features.PoJevArena;
using PoMiniGames.Features.PoJevArena.Jev;
using PoMiniGames.Features.PoRacer;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Options;
using PoMiniGames.Infrastructure.Services;

namespace PoMiniGames.Infrastructure;

/// <summary>
/// Registers all game-specific services used by the local-only app.
/// </summary>
internal static class GameServicesExtensions
{
    public static IServiceCollection AddPoMiniGamesGameServices(this IServiceCollection services)
    {
        // ─── Score integrity + account data ─────────────────────────────────
        // The guard is what stands between a public leaderboard and a client that can post any
        // number it likes. Registered here rather than in its slice so the options binding,
        // the session minter and the guard itself cannot be wired up half-way — a guard with
        // no IPlaySessionService behind it silently degrades to range checks only.
        services.AddOptions<PoMiniGames.Features.Integrity.IntegrityOptions>()
            .BindConfiguration(PoMiniGames.Features.Integrity.IntegrityOptions.SectionName);
        // TryAdd: TimeProvider.System is the default the framework registers in most hosts, but
        // not all of them, and PlaySessionService's elapsed measurement is the whole mechanism.
        services.TryAddSingleton(TimeProvider.System);
        services.AddSingleton<PoMiniGames.Features.Integrity.IPlaySessionService,
                              PoMiniGames.Features.Integrity.PlaySessionService>();
        services.AddSingleton<PoMiniGames.Features.Integrity.IScoreIntegrityGuard,
                              PoMiniGames.Features.Integrity.ScoreIntegrityGuard>();
        // Scoped: one cross-table scan per request, and it holds no state between them.
        services.AddScoped<PoMiniGames.Features.Account.PlayerDataService>();

        // ─── Centralized Azure AI Foundry hub (PoShared RG) ─────────────────
        // One shared AzureOpenAIClient + per-deployment ChatClient cache. Every
        // game that needs an AI model resolves through AIFoundryChatClientCache
        // with its game key (couplequiz, funquiz, face, joker, survive).
        // Replaces the legacy per-game PoFunQuiz:AzureOpenAI, PoCoupleQuiz:AzureOpenAI,
        // PoFace:AzureOpenAI, PoJoker:AzureOpenAI, Inference:* sections.
        services.AddOptions<AIFoundryOptions>()
            // Bind the configuration section the Key Vault secrets land in. This was missing:
            // the options object was built ONLY from the environment-variable overrides below,
            // so a correctly-populated kv-poshared (PoMiniGames--AI--*) left Endpoint empty,
            // IsConfigured false, and every AI-backed game silently served mock data.
            .BindConfiguration(AIFoundryOptions.SectionName)
            .PostConfigure<IConfiguration>((opts, configuration) =>
            {
                // The vault names the endpoint secret PoMiniGames--AI--FoundryEndpoint, which
                // binds to "<section>:FoundryEndpoint" — not to the Endpoint property. Map it
                // across rather than renaming the secret, which other apps also read.
                // Host environment variables stay the local override, and each only applies when
                // actually set: unconditionally assigning DefaultDeployment used to stamp
                // "gpt-4o-mini" over whatever the vault said.
                var endpoint = Environment.GetEnvironmentVariable("PoMiniGames__AI__FoundryEndpoint")
                    ?? configuration[$"{AIFoundryOptions.SectionName}:FoundryEndpoint"];
                if (!string.IsNullOrWhiteSpace(endpoint))
                {
                    opts.Endpoint = endpoint!;
                }

                var defaultDeployment = Environment.GetEnvironmentVariable("PoMiniGames__AI__DefaultDeployment");
                if (!string.IsNullOrWhiteSpace(defaultDeployment))
                {
                    opts.DefaultDeployment = defaultDeployment!;
                }

                // The vault stores the per-game map as ONE secret — PoMiniGames--AI--Deployments,
                // "game=deployment,game=deployment" — which arrives as a scalar value at
                // "<section>:Deployments" and cannot bind to a dictionary at all. Parsed here so
                // the flat and nested forms produce the same options object; nested keys already
                // bound above are kept, with the flat form filling gaps rather than overwriting.
                var flat = Environment.GetEnvironmentVariable("PoMiniGames__AI__Deployments")
                    ?? configuration[$"{AIFoundryOptions.SectionName}:Deployments"];
                foreach (var (game, deployment) in ParseDeploymentPairs(flat))
                {
                    if (!opts.Deployments.Any(kv => string.Equals(kv.Key, game, StringComparison.OrdinalIgnoreCase)))
                        opts.Deployments[game] = deployment;
                }
            });
        services.AddSingleton<AIFoundryClientFactory>();
        services.AddSingleton<AIFoundryChatClientCache>();
        // §3: register the resilience pipeline (retry + circuit breaker + outer timeout)
        // used by every AI Foundry consumer. Idempotent — safe to call multiple times.
        // Consumed by ResilientChatClient, which every keyed game chat client is wrapped in;
        // for a long while it was registered here and resolved nowhere, so a single call could
        // (and did) run 51.6 s against its own documented 20 s ceiling.
        services.AddAzureOpenAIResilience();
        // Cross-cutting AI concerns: usage/latency read-model, per-identity spend ceiling, and a
        // startup check that every configured deployment name exists on the account.
        services.AddSingleton<AiUsageAccumulator>();
        services.AddOptions<AiTokenBudgetOptions>().BindConfiguration(AiTokenBudgetOptions.SectionName);
        // Durable backing for the daily ceiling. Without it the ledger is a ConcurrentDictionary
        // that an App Service F1 recycle (no AlwaysOn, so idle = recycle) resets to zero, which
        // made "250k tokens per identity per day" mean "per identity per uptime".
        services.AddSingleton<IAiTokenLedgerStore>(sp =>
        {
            // TableServiceClient is always registered (AddPoMiniGamesStorage), but a host built
            // without storage — or with it unreachable — must still serve AI traffic, so the null
            // store is the documented degradation rather than a startup failure.
            var tables = sp.GetService<Azure.Data.Tables.TableServiceClient>();
            return tables is null
                ? NullAiTokenLedgerStore.Instance
                : new TableAiTokenLedgerStore(tables, sp.GetRequiredService<ILogger<TableAiTokenLedgerStore>>());
        });
        services.AddSingleton<AiTokenBudget>();
        // Write-behind flusher: pushes accumulated spend to the ledger on an interval and once
        // more on graceful shutdown. Idles immediately when the store is the null one.
        services.AddHostedService<AiTokenBudgetFlushService>();
        // Memoizes per-(game, deployment) ChatOptions so the JSON-element cloning and the
        // raw-representation factory allocation happen once per pair rather than once per call.
        // Pure-local hot-path win; no network effect. Registered as the interface too so the
        // game services that inject IAiDecisionOptionsCache resolve the same singleton.
        services.AddSingleton<AiDecisionOptionsCache>();
        services.AddSingleton<IAiDecisionOptionsCache>(sp => sp.GetRequiredService<AiDecisionOptionsCache>());
        // Embeddings for the similarity-scoring path. Dormant unless
        // PoMiniGames:AI:EmbeddingDeployment names a deployment — the shared account currently has
        // none, so PoCoupleQuiz still scores via chat; see AiEmbeddingService.
        services.AddSingleton<AiEmbeddingService>();
        services.AddHttpClient(nameof(FoundryDeploymentValidator), client =>
        {
            client.Timeout = TimeSpan.FromSeconds(10);
        });
        services.AddHostedService<FoundryDeploymentValidator>();
        // Keeps the default deployment warm with one minimal call every 30 minutes, so the
        // first player-facing AI interaction of a cold period pays steady-state latency rather
        // than the cold-start penalty. Idles silently when the foundry is unconfigured.
        services.AddHostedService<AiWarmupService>();
        // Every AI-consuming slice now resolves its chat client through GameChatClientFactory, so
        // each gets the resilience pipeline, the spend ceiling and the telemetry by construction.
        // Registering the keys here (rather than in each slice) keeps the set in one place and
        // makes the health-tracker keys predictable. Idempotent.
        services.AddGameChatClient(AIFoundryOptions.Games.CoupleQuiz);
        services.AddGameChatClient(AIFoundryOptions.Games.FunQuiz);
        services.AddGameChatClient(AIFoundryOptions.Games.Joker);
        services.AddGameChatClient(AIFoundryOptions.Games.Ecosystem);
        services.AddGameChatClient(AIFoundryOptions.Games.PoBrawl);
        // /health gains an AI check, and /api/health/ai exposes the usage read-model that
        // AiUsageAccumulator has been filling with no reader.
        services.AddHealthChecks()
            .AddCheck<AiFoundryHealthCheck>(
                "AiFoundry",
                tags: ["ai", "ready"]);
        // PoRaceRagdoll feature removed.

        // Elo calculation with configurable options
        services.Configure<EloOptions>(options =>
        {
            // Default values from EloOptions class will be used unless overridden in config
        });
        services.AddSingleton(sp =>
        {
            var config = sp.GetRequiredService<IOptions<EloOptions>>();
            return new EloCalculator(config.Value);
        });
        // Head-to-head ratings for the PoBrawl demo board. A distinct calculator with its own
        // options section, not a mode of EloCalculator — see PairwiseEloCalculator's remarks
        // for why the two cannot merge.
        // BindConfiguration rather than Configure(section): this extension takes no
        // IConfiguration, and resolving it from DI keeps the signature unchanged.
        services.AddOptions<PairwiseEloOptions>().BindConfiguration(PairwiseEloOptions.SectionName);
        services.AddSingleton(sp =>
        {
            var config = sp.GetRequiredService<IOptions<PairwiseEloOptions>>();
            return new PairwiseEloCalculator(config.Value);
        });

        // Storage initializer for the consolidated games (PoCoupleQuiz, PoFunQuiz).
        // Ensures all per-game tables and blob containers exist at host startup.
        services.AddSingleton<StorageInitializer>();

        // MatchHistory — cross-game head-to-head record (local 2P + online multiplayer).
        // Writes to the MatchHistory table (PartitionKey = owner identity, RowKey = reverse-time).
        services.AddSingleton<PoMiniGames.Features.MatchHistory.MatchHistoryRepository>();

        // Fail-fast startup validator: throws in Production if any consolidated game's
        // required Azure OpenAI secrets are missing. See PoFunQuiz StartupSecretValidator
        // (2026-06-13 mock-data fix) for the original pattern.
        services.AddHostedService<StartupSecretValidator>();

        // PoCoupleQuiz — Phase 1 of the consolidation. See Features/PoCoupleQuiz/.
        // The question service resolves to the mock in Dev/Test when UseMockAI=true
        // or Azure OpenAI is not configured; in Production it always uses the real
        // service (StartupSecretValidator fails-fast if the secrets are missing).
        // CoupleQuizOptions is bound in Program.cs before AddPoMiniGamesGameServices.
        services.AddSingleton<IGameSessionManager, GameSessionManager>();
        // Note: GameSessionManager is a pure in-memory state holder, not a hosted service.
        // The round timer lives in CoupleQuizRoundDirector below.
        // Every consumer injects IGameSessionManager; nothing resolves the concrete type, so
        // the previous concrete-forwarding registration was dead and has been removed.
        services.AddSingleton<IQuestionService, AiQuestionService>();
        services.AddSingleton<MockQuestionService>();
        // Owns the round clock. A Hub instance lives for one invocation and cannot hold a
        // timer, so rounds are driven from this singleton over a long-lived IHubContext.
        services.AddSingleton<CoupleQuizRoundDirector>();

        // PoFunQuiz — Phase 2 of the consolidation. See Features/PoFunQuiz/.
        // AiQuizGeneratorService is the production path; mock fallback is gated to Dev/Test
        // inside the service. The leaderboard repository writes to the
        // PoFunQuizPlayers table (PartitionKey = Category, RowKey = Guid).
        // MultiplayerLobbyService is the in-memory registry for the SignalR hub
        // (CreateGame/JoinGame/StartGame/UpdateScore/PlayerFinished).
        // §3.4 HybridCache: stampede-protected memoization for deterministic, expensive
        // Azure OpenAI calls (answer-similarity scoring + question generation).
        // Shared by PoCoupleQuiz (answer similarity) and PoFunQuiz (question list).
        // L2 for HybridCache. Registered BEFORE AddHybridCache so the hybrid layer picks it up:
        // without an IDistributedCache the "L1/L2" above is L1 only, and every cached model
        // generation is lost on the next F1 recycle and re-bought at generation rates.
        // TryAdd so a test host that wires its own distributed cache keeps it.
        Microsoft.Extensions.DependencyInjection.Extensions.ServiceCollectionDescriptorExtensions
            .TryAddSingleton<Microsoft.Extensions.Caching.Distributed.IDistributedCache>(services, sp =>
                new PoMiniGames.Infrastructure.TableDistributedCache(
                    sp.GetRequiredService<Azure.Data.Tables.TableServiceClient>(),
                    sp.GetRequiredService<ILogger<PoMiniGames.Infrastructure.TableDistributedCache>>()));
        services.AddHybridCache();
        services.AddSingleton<IOpenAIService, AiQuizGeneratorService>();
        // Off-peak warm of the question cache. Disabled unless PoMiniGames:AI:QuizPrebake:Enabled
        // is set — it is the one background job here that deliberately spends tokens, so it does
        // not get to switch itself on. Only worth running because the HybridCache L2 above is now
        // durable; against an in-process cache it would warm entries an F1 recycle then discards.
        services.AddOptions<QuizPrebakeOptions>().BindConfiguration(QuizPrebakeOptions.SectionName);
        services.AddHostedService<QuizPrebakeService>();
        services.AddSingleton<PoMiniGames.Features.PoFunQuiz.Storage.ILeaderboardRepository,
            PoMiniGames.Features.PoFunQuiz.Storage.LeaderboardRepository>();
        services.AddSingleton<MultiplayerLobbyService>();

        // PoJoker — demo-only autonomous comedy show. See Features/PoJoker/.
        // AiJesterService is the production path (shared Azure OpenAI resilience); it
        // falls back to MockAnalysisService in Dev/Test when PoJoker:AzureOpenAI is
        // unconfigured, and throws in Production (StartupSecretValidator fails fast).
        // The joke fetch is a typed HttpClient to JokeAPI.dev with the standard
        // resilience handler; the storage client writes to the PoJokerPerformances
        // table (PartitionKey = SessionId) ensured by StorageInitializer.
        services.AddHttpClient(JokeApiClient.HttpClientName, client =>
            {
                client.Timeout = TimeSpan.FromSeconds(15);
            })
            .AddStandardResilienceHandler();
        services.AddSingleton<IJokeApiClient>(sp => new JokeApiClient(
            sp.GetRequiredService<IHttpClientFactory>().CreateClient(JokeApiClient.HttpClientName),
            sp.GetRequiredService<ILogger<JokeApiClient>>()));
        services.AddSingleton<MockAnalysisService>();
        services.AddSingleton<IAnalysisService, AiJesterService>();
        // Rewrites flagged jokes so the Jester performs a clean version instead of
        // skipping them. Deliberately has no mock stand-in: a fabricated rewrite
        // would report a joke as cleaned when it was not.
        services.AddSingleton<IJokeRewriteService, JokeRewriteService>();
        services.AddSingleton<IJokeStorageClient, JokeStorageClient>();

        // PoEcosystem — cloud world slots + gallery (blob + table), and the chronicle /
        // cloud-thought narrator. The store degrades to empty when storage is unreachable;
        // the narrator follows the shared mock gate (PoEcosystem:Features:UseMockAI).
        services.AddSingleton<EcosystemWorldStore>();
        services.AddSingleton<IEcosystemChronicleService, EcosystemChronicleService>();

        // PoJevArena — Jev (TypeSafe, via OpenRouter) is the arena's only decision source.
        // The client is a typed HttpClient with its own per-call timeout and no retry pipeline
        // (a late decision is worthless at 1 Hz); the concurrency gate is a singleton so every
        // typed-client instance shares one in-flight cap. The stub is selected only under the
        // Test environment — anywhere else a missing key means "Jev unavailable", never a mock.
        services.AddOptions<JevOptions>()
            .BindConfiguration(JevOptions.SectionName);
        services.AddSingleton<JevConcurrencyGate>();
        services.AddHttpClient<JevClient>(
            JevClient.HttpClientName,
            (sp, client) => client.BaseAddress = new Uri(sp
                .GetRequiredService<IOptions<JevOptions>>()
                .Value.Endpoint));
        services.AddSingleton<StubJevClient>();
        services.AddTransient<IJevClient>(sp =>
        {
            var options = sp.GetRequiredService<IOptions<JevOptions>>().Value;
            return options.UseStub && sp.GetRequiredService<IHostEnvironment>().IsEnvironment("Test")
                ? sp.GetRequiredService<StubJevClient>()
                : sp.GetRequiredService<JevClient>();
        });
        // Daily Jev call cap: its own AiTokenBudget (counting calls, not tokens) over its own
        // ledger table, flushed by a second instance of the stock flusher. Registered through
        // AddSingleton<IHostedService> on purpose — AddHostedService<T> is a TryAddEnumerable
        // and would silently drop a second AiTokenBudgetFlushService.
        services.AddSingleton(sp =>
        {
            var tables = sp.GetService<Azure.Data.Tables.TableServiceClient>();
            IAiTokenLedgerStore store = tables is null
                ? NullAiTokenLedgerStore.Instance
                : new TableAiTokenLedgerStore(
                    tables, sp.GetRequiredService<ILogger<TableAiTokenLedgerStore>>(), JevCallAllowance.TableName);
            var clock = sp.GetRequiredService<TimeProvider>();
            return new JevCallAllowance(new AiTokenBudget(
                sp.GetRequiredService<IOptions<JevOptions>>().Value.DailyCallsPerIdentity, clock.GetUtcNow, store));
        });
        services.AddSingleton<ArenaMatchRegistry>();
        services.AddSingleton<CreatureLibraryStore>();
        services.AddSingleton<IHostedService>(sp => new AiTokenBudgetFlushService(
            sp.GetRequiredService<JevCallAllowance>().Budget,
            sp.GetRequiredService<IOptions<AiTokenBudgetOptions>>(),
            sp.GetRequiredService<ILogger<AiTokenBudgetFlushService>>()));

        // PoRacer — multiplayer racing. The lobby service is the in-memory
        // registry; the race registry + service own the per-game simulation
        // timer. Both are process-local (single-instance, like every other
        // multiplayer lobby in the host) and are DI-managed so the host's
        // graceful-shutdown path can dispose the race registry.
        services.AddSingleton<PoMiniGames.Features.PoRacer.PoRacerLobbyService>();
        services.AddSingleton<PoMiniGames.Features.PoRacer.PoRacerRaceRegistry>();

        // PoCabinet (T6): lobby + race registry, same shape as PoRacer. The registry
        // owns the 30 Hz simulation timer and the per-game SimSession pool, and is
        // disposed via its IAsyncDisposable on host shutdown so the timer doesn't leak.
        services.AddSingleton<PoMiniGames.Features.PoCabinet.PoCabinetLobbyService>();
        services.AddSingleton<PoMiniGames.Features.PoCabinet.PoCabinetRaceRegistry>();

        // PoBrawl online — 1v1 SignalR-driven combat. One shared in-memory lobby (the first two
        // arrivals fight), an in-memory match per started fight, and a hosted pump driving the
        // per-tick frame broadcast for all of them.
        services.AddSingleton<PoMiniGames.Features.PoBrawl.Online.PoBrawlLobbyService>();
        services.AddSingleton<PoMiniGames.Features.PoBrawl.Online.PoBrawlMatchRegistry>();
        services.AddHostedService<PoMiniGames.Features.PoBrawl.Online.PoBrawlMatchPump>();
        // The post-fight press-conference line (one cheap model call per shown result modal).
        services.AddSingleton<PoMiniGames.Features.PoBrawl.IPoBrawlPresserService, PoMiniGames.Features.PoBrawl.PoBrawlPresserService>();
        services.AddSingleton<PoMiniGames.Features.PoBrawl.PoBrawlProgressStore>();

        // ConnectFive + TicTacToe online — turn-based 1v1 over SignalR. One shared
        // TurnMatchService<THub> per hub holds that game's quick-match queue and every
        // authoritative board; there is no lobby service because a two-seat turn game
        // has nothing to configure before play. The rules instance is the only thing
        // that differs. See Features/Shared/TurnMatch for the reconnect contract.
        services.AddSingleton(sp => new PoMiniGames.Features.Shared.TurnMatch.TurnMatchService<PoMiniGames.Features.ConnectFive.ConnectFiveHub>(
            PoMiniGames.Shared.Games.ConnectFiveRules.Instance,
            sp.GetRequiredService<Microsoft.AspNetCore.SignalR.IHubContext<PoMiniGames.Features.ConnectFive.ConnectFiveHub>>(),
            sp.GetRequiredService<ILogger<PoMiniGames.Features.Shared.TurnMatch.TurnMatchService<PoMiniGames.Features.ConnectFive.ConnectFiveHub>>>()));
        services.AddSingleton(sp => new PoMiniGames.Features.Shared.TurnMatch.TurnMatchService<PoMiniGames.Features.TicTacToe.TicTacToeHub>(
            PoMiniGames.Shared.Games.TicTacToeRules.Instance,
            sp.GetRequiredService<Microsoft.AspNetCore.SignalR.IHubContext<PoMiniGames.Features.TicTacToe.TicTacToeHub>>(),
            sp.GetRequiredService<ILogger<PoMiniGames.Features.Shared.TurnMatch.TurnMatchService<PoMiniGames.Features.TicTacToe.TicTacToeHub>>>()));

        // PoMarbleRace online — host-authoritative 2-player race. The service is only a
        // pairing registry and relay table: the host BROWSER is the simulation (see
        // Shared/Games/PoMarbleRaceShared.cs for why lockstep was not an option).
        services.AddSingleton<PoMiniGames.Features.PoMarbleRace.PoMarbleRaceOnlineService>();

        // PoSports — family track meet. Same single-lobby process-local shape as
        // PoRacer; the registry owns the meet sim timers and is DI-managed for
        // graceful-shutdown disposal.
        services.AddSingleton<PoMiniGames.Features.PoSports.PoSportsLobbyService>();
        services.AddSingleton<PoMiniGames.Features.PoSports.PoSportsRaceRegistry>();

        // PoVoxelStrike — startup GLB → voxel ingestion plus the in-memory asset catalog
        // the manifest/payload endpoints read. See Features/PoVoxelStrike/.
        services.AddOptions<PoMiniGames.Features.PoVoxelStrike.PoVoxelStrikeOptions>()
            .BindConfiguration(PoMiniGames.Features.PoVoxelStrike.PoVoxelStrikeOptions.SectionName);
        services.AddSingleton<PoMiniGames.Features.PoVoxelStrike.VoxelAssetCatalog>();
        services.AddHostedService<PoMiniGames.Features.PoVoxelStrike.AssetIngestionHostedService>();
        // PoVoxelStrike co-op: same single-lobby process-local shape as PoRacer/PoFunQuiz.
        // The lobby service is the in-memory registry; the lockstep service owns the
        // per-game input batching; the pump broadcasts frames on a drift-corrected
        // 50 ms timer (host-independent — survives host websocket reconnects).
        services.AddSingleton<PoMiniGames.Features.PoVoxelStrike.PoVoxelStrikeLobbyService>();
        services.AddSingleton<PoMiniGames.Features.PoVoxelStrike.PoVoxelStrikeLockstepService>();
        services.AddHostedService<PoMiniGames.Features.PoVoxelStrike.PoVoxelStrikeLockstepPump>();

        services.ConfigureHttpJsonOptions(options =>
        {
            options.SerializerOptions.Converters.Add(
                new System.Text.Json.Serialization.JsonStringEnumConverter());
        });

        return services;
    }

    /// <summary>
    /// Parses the flat <c>game=deployment,game=deployment</c> form of the per-game deployment map.
    /// Accepts <c>:</c> as the separator too, which is how the secret is documented.
    /// </summary>
    private static IEnumerable<(string Game, string Deployment)> ParseDeploymentPairs(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
            yield break;

        foreach (var pair in raw.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var split = pair.IndexOfAny(['=', ':']);
            if (split <= 0 || split == pair.Length - 1)
                continue;

            var game = pair[..split].Trim();
            var deployment = pair[(split + 1)..].Trim();
            if (game.Length > 0 && deployment.Length > 0)
                yield return (game, deployment);
        }
    }
}
