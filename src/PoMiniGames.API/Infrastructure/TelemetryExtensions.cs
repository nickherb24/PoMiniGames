using Azure.Core;
using Azure.Identity;
using Azure.Monitor.OpenTelemetry.AspNetCore;
using OpenTelemetry.Instrumentation.AspNetCore;
using OpenTelemetry.Resources;

namespace PoMiniGames.Infrastructure;

/// <summary>
/// Registers OpenTelemetry + Azure Application Insights, and Azure Key Vault configuration.
/// Both services are cloud-only: no-ops in Development when the relevant config keys are absent.
/// </summary>
internal static class TelemetryExtensions
{
    /// <summary>Constant <c>cloud_RoleName</c> for App Insights. Bound at compile time so the
    /// resource service.name never collapses to <c>unknown_service:dotnet</c>. Only the API host
    /// sets this; the Blazor WASM client does not call <c>AddPoMiniGamesTelemetry()</c>, so the
    /// reflection guard ("don't execute this in Blazor WASM") becomes a structural one.</summary>
    public const string CloudRoleName = "PoMiniGames";

    /// <summary>Adds Azure Monitor / OpenTelemetry when an App Insights connection string is present.</summary>
    public static WebApplicationBuilder AddPoMiniGamesTelemetry(this WebApplicationBuilder builder)
    {
        var appInsightsConnString = builder.Configuration["PoMiniGames:ApplicationInsights:ConnectionString"]
            ?? PoPlatform.ResolveAppInsightsConnectionString(builder.Configuration)
            ?? builder.Configuration["APPINSIGHTS_CONNECTIONSTRING"];

        if (!string.IsNullOrEmpty(appInsightsConnString))
        {
            // cloud_RoleName is bound to a constant — never reflect against the executing
            // assembly at runtime (which can collide on trimming / single-file publish).
            var roleName = CloudRoleName;

            // Adaptive sampling profile: full fidelity in Dev/Test, ~10% ceiling in Production.
            // Exceptions are always emitted at Error level so failures remain fully visible.
            // SamplingRatio is the documented control surface on AzureMonitorOptions for
            // AdaptiveSampling; the path-level Filter below is what stops a 5× burst on
            // a single endpoint from blowing the ingestion budget. (A safety-net
            // `IngestionBudget` alert is AUTHORED in infra/alerts.bicep but that file is
            // not wired into main.bicep — no such alert is live in Azure today.)
            var samplingRatio = builder.Environment.IsProduction() ? 0.1f : 1.0f;

            builder.Services.AddOpenTelemetry()
                .ConfigureResource(resource => resource.AddService(roleName))
                .UseAzureMonitor(opts =>
                {
                    opts.ConnectionString = appInsightsConnString;
                    opts.SamplingRatio = samplingRatio;
                    // QuickPulse / Live Metrics: disabled in Production. Live Metrics
                    // streams a separate telemetry channel that bypasses adaptive
                    // sampling and silently burns 1–2 GB/month of ingestion per app.
                    opts.EnableLiveMetrics = !builder.Environment.IsProduction();
                });

            // Ingestion-budget guard: never record request traces for the
            // high-frequency, low-value probe endpoints (load-balancer health
            // pings, CI smoke tests, uptime monitors), the static Blazor framework
            // files, or the OpenAPI spec. These would otherwise dominate the
            // F1-tier ingestion budget with zero diagnostic value. Exceptions
            // and non-probe traffic remain governed by SamplingRatio.
            builder.Services.Configure<AspNetCoreTraceInstrumentationOptions>(o =>
            {
                o.Filter = context =>
                {
                    var path = context.Request.Path.Value ?? string.Empty;
                    if (path.StartsWith("/health", StringComparison.OrdinalIgnoreCase)
                     || path.StartsWith("/api/health", StringComparison.OrdinalIgnoreCase)
                     || path.StartsWith("/api/diag", StringComparison.OrdinalIgnoreCase)
                     || path.StartsWith("/_framework/", StringComparison.OrdinalIgnoreCase)
                     || path.StartsWith("/openapi/", StringComparison.OrdinalIgnoreCase)
                     || path.Equals("/diag", StringComparison.OrdinalIgnoreCase)
                     || path.Equals("/favicon.ico", StringComparison.OrdinalIgnoreCase))
                    {
                        return false;
                    }
                    return true;
                };
            });
        }

        return builder;
    }

    /// <summary>Adds Azure Key Vault configuration source when the vault URI is present.</summary>
    public static WebApplicationBuilder AddPoMiniGamesKeyVault(this WebApplicationBuilder builder)
    {
        var keyVaultUri = builder.Configuration["PoMiniGames:KeyVault:Uri"]
            ?? builder.Configuration["KeyVault:Uri"];

        if (!string.IsNullOrEmpty(keyVaultUri))
        {
            // In Development, authenticate to Key Vault with the Azure CLI identity ONLY.
            // The full DefaultAzureCredential chain probes VisualStudio/VS Code/shared-token-cache
            // credentials *before* the CLI, and on a dev box those can resolve to a different
            // AAD account than `az login` — one whose tenant sees this subscription as disabled,
            // producing a hard "subscription associated with this vault has been disabled" 403
            // that aborts startup even though `az keyvault secret list` succeeds. Pinning to the
            // CLI credential makes the app use exactly the identity the developer is signed in as.
            TokenCredential credential = builder.Environment.IsDevelopment()
                ? new AzureCliCredential(new AzureCliCredentialOptions
                {
                    ProcessTimeout = TimeSpan.FromSeconds(10),
                })
                // Pin a 3-attempt / 3-second-per-attempt budget
                // on the DefaultAzureCredential chain. Without this, a hung network during
                // cold start (a flaky VPN, the AAD STS being slow) means AddAzureKeyVault
                // blocks forever waiting for the first GetPropertiesOfSecrets enumeration —
                // a silent DoS on app startup.
                : new DefaultAzureCredential(new DefaultAzureCredentialOptions
                {
                    Retry = { MaxRetries = 2, NetworkTimeout = TimeSpan.FromSeconds(3) },
                });

            if (builder.Environment.IsDevelopment() || builder.Environment.IsEnvironment("Test"))
            {
                // In Development, a failed Key Vault load must NOT abort startup. If the
                // developer is offline, not `az login`'d, or the vault's subscription is in a
                // billing-blocked state (a "Warned"/disabled subscription returns a 403
                // "subscription associated with this vault has been disabled"), we fall back to
                // the local values in appsettings.Development.json and let the app boot — guest
                // login still works and Microsoft sign-in simply stays unwired until the vault
                // is reachable again. In cloud environments this failure stays fatal by design.
                try
                {
                    builder.Configuration.AddAzureKeyVault(
                        new Uri(keyVaultUri),
                        credential,
                        new PrefixKeyVaultSecretManager("PoMiniGames"));
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine(
                        $"[KeyVault] Development: skipping Key Vault '{keyVaultUri}' — {ex.GetType().Name}: {ex.Message}. " +
                        "Falling back to local appsettings. If this is a 403 'subscription disabled', the Azure " +
                        "subscription is in a Warned/billing-blocked state; resolve billing in the Azure portal.");
                }
            }
            else
            {
                builder.Configuration.AddAzureKeyVault(
                    new Uri(keyVaultUri),
                    credential,
                    new PrefixKeyVaultSecretManager("PoMiniGames"));
            }
        }

        return builder;
    }
}
