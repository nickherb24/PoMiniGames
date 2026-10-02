using Microsoft.Extensions.Options;
using PoMiniGames.Domain.Primitives;
using PoMiniGames.Domain.Services;
using PoMiniGames.Features.Auth;

namespace PoMiniGames.Features.Integrity;

/// <param name="Allowed">False only when the endpoint must refuse the submission.</param>
/// <param name="Code">Machine-readable cause for the response body, e.g. <c>score_out_of_range</c>.</param>
/// <param name="Message">Player-facing explanation.</param>
public readonly record struct IntegrityVerdict(bool Allowed, string? Code, string? Message)
{
    public static IntegrityVerdict Allow { get; } = new(true, null, null);

    /// <summary>The 400 body every score endpoint returns on a refusal, so the shape is uniform.</summary>
    public IResult ToProblem() => Results.BadRequest(new { error = Code, detail = Message });
}

/// <summary>
/// Applies both plausibility tiers to one submission and reports what it found.
/// </summary>
/// <remarks>
/// <para>
/// Ordering is deliberate. The absolute-range tier runs first and unconditionally, because it
/// is the one that cannot be wrong: it needs no client cooperation and no clock. Only if the
/// number itself is sane does the guard look at the play session, where a refusal has a real
/// false-positive cost (an offline replay, an expired sitting) and is therefore gated behind
/// <see cref="IntegrityOptions.Mode"/>.
/// </para>
/// <para>
/// Every non-allow finding is logged at Warning even when the mode lets it through. That is the
/// whole point of Observe: the logs are the evidence used to decide whether Enforce is safe to
/// turn on for this deployment.
/// </para>
/// </remarks>
public sealed class ScoreIntegrityGuard
{
    /// <summary>
    /// Header the client returns its play session on. A header rather than a body field so the
    /// guard is uniform across six endpoints whose request DTOs have nothing else in common.
    /// </summary>
    public const string SessionHeader = "X-Play-Session";

    private readonly PlaySessionService _sessions;
    private readonly IOptionsMonitor<IntegrityOptions> _options;
    private readonly ILogger<ScoreIntegrityGuard> _log;

    public ScoreIntegrityGuard(
        PlaySessionService sessions,
        IOptionsMonitor<IntegrityOptions> options,
        ILogger<ScoreIntegrityGuard> log)
    {
        _sessions = sessions;
        _options = options;
        _log = log;
    }

    /// <param name="score">The ranked value: points on a point board, seconds on a time board.</param>
    public IntegrityVerdict Inspect(HttpContext http, GameKey game, double score)
    {
        var options = _options.CurrentValue;
        var identity = RequestIdentity.Resolve(http.User);
        var identityKey = ResolveIdentityKey(identity);

        // ── Tier one: absolute range. Always evaluated, never mode-gated. ──
        var valueVerdict = ScoreRules.CheckValue(game, score);
        if (valueVerdict != ScoreVerdict.Plausible)
        {
            IntegrityLog.ValueRejected(_log, game.Value, score, valueVerdict.ToString(), options.EnforceValueBounds);
            if (options.EnforceValueBounds)
            {
                return new IntegrityVerdict(false, "score_out_of_range", ScoreRules.Describe(valueVerdict));
            }
        }

        if (options.Mode == IntegrityMode.Off)
        {
            return IntegrityVerdict.Allow;
        }

        // ── Tier two: the play session, and the rate check it makes possible. ──
        var token = http.Request.Headers[SessionHeader].ToString();
        var redemption = _sessions.Redeem(token, game, identityKey);
        var enforcing = options.Mode == IntegrityMode.Enforce;

        if (!redemption.IsValid)
        {
            IntegrityLog.SessionRejected(_log, game.Value, redemption.Status.ToString(), enforcing);
            return enforcing
                ? new IntegrityVerdict(false, "play_session_required",
                    "This score could not be verified against an active play session. Play the round again to submit it.")
                : IntegrityVerdict.Allow;
        }

        var rateVerdict = ScoreRules.CheckAgainstSession(game, score, redemption.Elapsed);
        if (rateVerdict == ScoreVerdict.Plausible)
        {
            return IntegrityVerdict.Allow;
        }

        IntegrityLog.RateRejected(_log, game.Value, score, redemption.Elapsed.TotalSeconds, rateVerdict.ToString(), enforcing);
        return enforcing
            ? new IntegrityVerdict(false, "score_implausible", ScoreRules.Describe(rateVerdict))
            : IntegrityVerdict.Allow;
    }

    /// <summary>
    /// Cleans a client-supplied display name for a public board. Returns the name to store —
    /// never null, never empty — falling back to <paramref name="fallback"/> when the submitted
    /// one is unpublishable.
    /// </summary>
    public string ResolveDisplayName(string? submitted, string fallback)
    {
        if (!_options.CurrentValue.ModerateDisplayNames)
        {
            return string.IsNullOrWhiteSpace(submitted) ? fallback : submitted!;
        }

        var result = DisplayNameSanitizer.Sanitize(submitted, fallback);
        if (result.Verdict == DisplayNameVerdict.Rejected)
        {
            // The submitted name is never logged: reproducing a slur in the log to record that
            // it was blocked defeats the purpose of blocking it. The reason code is enough to
            // tell a real filter hit from a normalisation.
            IntegrityLog.NameRejected(_log, result.Reason ?? "blocked");
        }

        return result.Value;
    }

    /// <summary>
    /// The value a play session is bound to. The stable claim id when there is one; otherwise
    /// the display name, which is all a guest has. Guests are inherently low-trust here — the
    /// binding stops one guest spending another's session, not a guest renaming themselves.
    /// </summary>
    private static string ResolveIdentityKey(RequestIdentity.Identity identity) =>
        !string.IsNullOrEmpty(identity.UserId) ? identity.UserId
        : !string.IsNullOrWhiteSpace(identity.DisplayName) ? identity.DisplayName
        : "anon";
}

/// <summary>
/// Source-generated logging for the guard. Warning level throughout, including in Observe mode:
/// these lines are the dataset the Enforce decision gets made from, and Information would bury
/// them under request logging.
/// </summary>
internal static partial class IntegrityLog
{
    [LoggerMessage(Level = LogLevel.Warning,
        Message = "Score integrity: value out of range game={Game} score={Score} verdict={Verdict} enforced={Enforced}")]
    public static partial void ValueRejected(ILogger logger, string game, double score, string verdict, bool enforced);

    [LoggerMessage(Level = LogLevel.Warning,
        Message = "Score integrity: play session not valid game={Game} status={Status} enforced={Enforced}")]
    public static partial void SessionRejected(ILogger logger, string game, string status, bool enforced);

    [LoggerMessage(Level = LogLevel.Warning,
        Message = "Score integrity: implausible for elapsed game={Game} score={Score} elapsedSeconds={Elapsed} verdict={Verdict} enforced={Enforced}")]
    public static partial void RateRejected(ILogger logger, string game, double score, double elapsed, string verdict, bool enforced);

    [LoggerMessage(Level = LogLevel.Warning,
        Message = "Display name rejected reason={Reason}")]
    public static partial void NameRejected(ILogger logger, string reason);

    [LoggerMessage(Level = LogLevel.Information,
        Message = "Account data {Operation} for identity partition={Partition} rows={Rows}")]
    public static partial void AccountData(ILogger logger, string operation, string partition, int rows);
}
