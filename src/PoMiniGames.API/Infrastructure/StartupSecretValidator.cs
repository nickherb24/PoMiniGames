using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Hosting;
using PoMiniGames.Features.Auth;

namespace PoMiniGames.Infrastructure;

/// <summary>
/// Hosted service that runs once at startup and validates that the secrets required for every
/// consolidated game (PoCoupleQuiz, PoFunQuiz) are present. This is the fail-fast
/// guard so a misconfigured production deployment never silently serves mock/fallback data
/// to real players.
///
/// <para><b>Behavior by environment</b>:</para>
/// <list type="bullet">
///   <item><b>Production</b> — throws <see cref="InvalidOperationException"/> if any required
///         secret is missing or empty. Prevents the app from accepting traffic with a
///         half-configured Azure OpenAI client that would degrade to mock data on every call.</item>
///   <item><b>Development</b> — logs a warning and continues so local dev iteration is not
///         blocked by missing secrets.</item>
///   <item><b>Test</b> — skips validation; tests intentionally use mock services.</item>
/// </list>
/// <para>Pattern: Fail-Fast. The service runs as <see cref="IHostedService"/> before the first
/// HTTP request is processed.</para>
/// </summary>
/// <remarks>Validates platform-level secrets (Key Vault, Table Storage, Microsoft Auth) plus
/// the centralized Azure AI Foundry endpoint/deployment. AI is a single shared hub — there are
/// no per-game secret sections.</remarks>
public sealed class StartupSecretValidator : IHostedService
{
    private readonly IHostEnvironment _environment;
    private readonly IConfiguration _configuration;
    private readonly ILogger<StartupSecretValidator> _logger;
    private readonly IAuthenticationSchemeProvider _schemeProvider;

    public StartupSecretValidator(
        IHostEnvironment environment,
        IConfiguration configuration,
        ILogger<StartupSecretValidator> logger,
        IAuthenticationSchemeProvider schemeProvider)
    {
        _environment = environment;
        _configuration = configuration;
        _logger = logger;
        _schemeProvider = schemeProvider;
    }

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        // ── Production compilation guard ─────────────────────────────
        // The FakeAuth scheme bypasses real identity and must never be live in Production.
        // Fail fast (unhandled) if it is registered while running as Production, regardless
        // of how it got there.
        if (_environment.IsProduction())
        {
            var fakeScheme = await _schemeProvider.GetSchemeAsync(FakeAuthHandler.SchemeName);
            if (fakeScheme is not null)
            {
                _logger.FakeAuthSchemeInProduction(FakeAuthHandler.SchemeName);
                throw new InvalidOperationException(
                    $"FATAL: authentication scheme '{FakeAuthHandler.SchemeName}' is registered while running in " +
                    "Production. Fake authentication must never be enabled in Production.");
            }

            // AutoGuestLogin is a silent sign-in bypass. It must NEVER be enabled in
            // Production regardless of how the config was sourced.
            if (_configuration.GetValue<bool>("Auth:AutoGuestLogin"))
            {
                _logger.AutoGuestLoginInProduction();
                throw new InvalidOperationException(
                    "FATAL: 'Auth:AutoGuestLogin' is enabled in a Production environment. " +
                    "This silently bypasses sign-in and is forbidden.");
            }
        }

        // Test environment uses mock services (registered by feature-specific wiring) — skip.
        if (_environment.IsEnvironment("Test"))
        {
            _logger.StartupValidationSkippedForTest();
            return;
        }

        var missing = new List<string>();

        // ── Platform-level secrets (Production-mandatory) ──────────────
        // These are required for the app to function correctly in Production regardless
        // of which game slices are enabled. Local dev may omit KeyVault:Uri because the
        // dev config sources secrets from user-secrets + appsettings.Development.json.
        if (_environment.IsProduction())
        {
            var kvUri = _configuration["PoMiniGames:KeyVault:Uri"] ?? _configuration["KeyVault:Uri"];
            if (string.IsNullOrWhiteSpace(kvUri))
            {
                missing.Add("PoMiniGames:KeyVault:Uri");
            }

            var storageEndpoint = _configuration["PoMiniGames:Storage:TableService:Endpoint"]
                ?? _configuration["PoMiniGames:Storage:TableService:ConnectionString"];
            if (string.IsNullOrWhiteSpace(storageEndpoint))
            {
                missing.Add("PoMiniGames:Storage:TableService:Endpoint");
            }

            // OAuth wiring: in Production the Entra app registration IDs must be present
            // (either inline or via Key Vault). The full fail-fast here complements the
            // /api/auth/handshake "microsoftConfigured" flag — the boot guard ensures we
            // never accept traffic in a half-configured state.
            var clientId = _configuration["PoMiniGames:MicrosoftAuth:ClientId"];
            var apiClientId = _configuration["PoMiniGames:MicrosoftAuth:ApiClientId"];
            if (string.IsNullOrWhiteSpace(clientId))
            {
                missing.Add("PoMiniGames:MicrosoftAuth:ClientId");
            }
            if (string.IsNullOrWhiteSpace(apiClientId))
            {
                missing.Add("PoMiniGames:MicrosoftAuth:ApiClientId");
            }
        }

        // ── Centralized Azure AI Foundry secrets (production-mandatory) ──
        // Replaces the legacy per-game AzureOpenAI sections. The KV contract:
        //   PoMiniGames--AI--FoundryEndpoint  (e.g. https://cog-pominigames-xxx.openai.azure.com)
        //   PoMiniGames--AI--DefaultDeployment (e.g. gpt-4o-mini)
        // The DefaultAzureCredential on the Web App's system-assigned MI provides
        // the AAD bearer; no API key is required (or stored) by design.
        if (_environment.IsProduction())
        {
            var foundryEndpoint = _configuration["PoMiniGames:AI:FoundryEndpoint"]
                ?? _configuration["PoMiniGames:AI:Endpoint"];
            var foundryDeployment = _configuration["PoMiniGames:AI:DefaultDeployment"];
            if (string.IsNullOrWhiteSpace(foundryEndpoint))
                missing.Add("PoMiniGames:AI:FoundryEndpoint");
            if (string.IsNullOrWhiteSpace(foundryDeployment))
                missing.Add("PoMiniGames:AI:DefaultDeployment");
        }

        if (missing.Count == 0)
        {
            _logger.StartupValidationPassed(_environment.EnvironmentName);
            return;
        }

        var joined = string.Join(", ", missing);
        var message = $"Required secrets are missing for environment '{_environment.EnvironmentName}': {joined}";

        if (_environment.IsProduction())
        {
            _logger.RequiredSecretsMissing(_environment.EnvironmentName, joined);
            throw new InvalidOperationException(message);
        }

        _logger.RequiredSecretsMissingNonProduction(_environment.EnvironmentName, joined);
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
