using Microsoft.Extensions.Logging;

namespace PoMiniGames.Features.Auth;

/// <summary>
/// Source-generated <see cref="ILogger"/> extensions for the auth pipeline. Replaces
/// the legacy interpolated-message paths that allocate a format string on every call
/// even when the level is disabled.
/// </summary>
internal static partial class AuthLog
{
    [LoggerMessage(EventId = 6101, Level = LogLevel.Warning,
        Message = "Microsoft OAuth is NOT configured (missing ClientId/ApiClientId). The app will boot, but /api/auth/handshake will report OAuth as unconfigured and real sign-in is unavailable.")]
    public static partial void MicrosoftOAuthNotConfigured(this ILogger logger);

    [LoggerMessage(EventId = 6102, Level = LogLevel.Critical,
        Message = "FATAL: authentication scheme '{Scheme}' is registered while running in Production. Fake authentication must never be enabled in Production.")]
    public static partial void FakeAuthSchemeInProduction(this ILogger logger, string scheme);

    [LoggerMessage(EventId = 6103, Level = LogLevel.Critical,
        Message = "FATAL: 'Auth:AutoGuestLogin' is enabled in a Production environment. This silently bypasses sign-in and is forbidden.")]
    public static partial void AutoGuestLoginInProduction(this ILogger logger);

    [LoggerMessage(EventId = 6104, Level = LogLevel.Information,
        Message = "Startup secret validation passed for {Environment}")]
    public static partial void StartupValidationPassed(this ILogger logger, string environment);

    [LoggerMessage(EventId = 6105, Level = LogLevel.Critical,
        Message = "Required secrets are missing for environment {Environment}: {Missing}. The application will NOT start.")]
    public static partial void RequiredSecretsMissing(this ILogger logger, string environment, string missing);

    [LoggerMessage(EventId = 6106, Level = LogLevel.Warning,
        Message = "Required secrets are missing for environment {Environment}: {Missing}. Continuing because non-Production environments are allowed to run with missing secrets.")]
    public static partial void RequiredSecretsMissingNonProduction(this ILogger logger, string environment, string missing);

    [LoggerMessage(EventId = 6107, Level = LogLevel.Information,
        Message = "Startup secret validation skipped in Test environment")]
    public static partial void StartupValidationSkippedForTest(this ILogger logger);

    [LoggerMessage(EventId = 6108, Level = LogLevel.Information,
        Message = "AIFoundryClientFactory initialised: endpoint={Endpoint}, defaultDeployment={DefaultDeployment}")]
    public static partial void AIFoundryInitialised(this ILogger logger, string endpoint, string defaultDeployment);

    [LoggerMessage(EventId = 6109, Level = LogLevel.Warning,
        Message = "AIFoundry not configured (Endpoint or DefaultDeployment missing); AI-consuming services will fall back to mock implementations in non-Production only.")]
    public static partial void AIFoundryNotConfigured(this ILogger logger);

    [LoggerMessage(EventId = 6110, Level = LogLevel.Warning,
        Message = "StorageInitializer reported an error; per-game tables/containers will be retried lazily on first use")]
    public static partial void StorageInitializerError(this ILogger logger, Exception ex);
}
