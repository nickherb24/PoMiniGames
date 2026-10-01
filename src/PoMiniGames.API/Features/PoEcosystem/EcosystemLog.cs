using Microsoft.Extensions.Logging;

namespace PoMiniGames.Features.PoEcosystem;

/// <summary>Source-generated log messages for the PoEcosystem slice (same shape as FunQuizLog).</summary>
internal static partial class EcosystemLog
{
    [LoggerMessage(EventId = 4601, Level = LogLevel.Warning,
        Message = "PoEcosystem: UseMockAI=true in {Environment}; the chronicler serves canned sagas.")]
    public static partial void EcoMockEnabled(this ILogger logger, string environment);

    [LoggerMessage(EventId = 4602, Level = LogLevel.Warning,
        Message = "PoEcosystem: AI Foundry not configured; the chronicler serves canned sagas in {Environment}.")]
    public static partial void EcoNotConfigured(this ILogger logger, string environment);

    [LoggerMessage(EventId = 4603, Level = LogLevel.Error,
        Message = "PoEcosystem: chronicle generation failed for seed {Seed}, years {FromYear}-{ToYear}.")]
    public static partial void EcoChronicleFailed(this ILogger logger, Exception ex, int seed, int fromYear, int toYear);

    [LoggerMessage(EventId = 4604, Level = LogLevel.Warning,
        Message = "PoEcosystem: world store operation {Operation} failed; degrading to empty.")]
    public static partial void EcoStoreFailed(this ILogger logger, Exception ex, string operation);

    [LoggerMessage(EventId = 4605, Level = LogLevel.Warning,
        Message = "PoEcosystem: cloud thought failed; the creature falls back to instinct.")]
    public static partial void EcoThoughtFailed(this ILogger logger, Exception ex);

    [LoggerMessage(EventId = 4606, Level = LogLevel.Warning,
        Message = "PoEcosystem: batch thought failed; creatures fall back to instinct.")]
    public static partial void EcoBatchThoughtFailed(this ILogger logger, Exception ex);

    [LoggerMessage(EventId = 4607, Level = LogLevel.Warning,
        Message = "PoEcosystem: treaty negotiation failed; tribes maintain current status.")]
    public static partial void EcoTreatyFailed(this ILogger logger, Exception ex);

    [LoggerMessage(EventId = 4609, Level = LogLevel.Warning,
        Message = "PoEcosystem: milestone lore generation failed.")]
    public static partial void EcoLoreFailed(this ILogger logger, Exception ex);
}

