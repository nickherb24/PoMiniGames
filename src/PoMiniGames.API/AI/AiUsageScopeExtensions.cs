using Microsoft.AspNetCore.SignalR;
using PoMiniGames.Features.Auth;

namespace PoMiniGames.AI;

/// <summary>
/// Opens an <see cref="AiUsageScope"/> naming the caller for every request and every hub
/// invocation, so <see cref="BudgetedChatClient"/> knows whose allowance to charge.
/// </summary>
/// <remarks>
/// <para>
/// Two entry points because this host has two. <c>POST /api/infer</c> opened a scope by hand, which
/// is why it was the only surface the token budget ever covered — every other AI call, whether it
/// arrived over HTTP or over a SignalR connection, ran with no identity in scope and therefore no
/// ceiling. Doing it once in the pipeline is what makes the coverage total rather than a list of
/// call sites someone has to remember to extend.
/// </para>
/// <para>
/// The scope is cheap: an <see cref="AsyncLocal{T}"/> assignment and a restore on dispose. It is
/// opened unconditionally rather than only for AI routes because "which routes reach a model" is
/// not a stable property — PoCoupleQuiz's hub reaches one from a method named <c>SubmitAnswer</c>.
/// </para>
/// </remarks>
public static class AiUsageScopeExtensions
{
    /// <summary>
    /// Opens a usage scope for the duration of each request.
    /// </summary>
    /// <remarks>
    /// Must be registered AFTER <c>UseAuthentication</c>: the identity is read from
    /// <c>HttpContext.User</c>, and before the authentication middleware has run that is an
    /// unauthenticated principal, so every signed-in caller would be charged to their IP instead of
    /// their account — and would share a ledger with everyone behind the same NAT.
    /// </remarks>
    public static IApplicationBuilder UseAiUsageScope(this IApplicationBuilder app)
        => app.Use(async (context, next) =>
        {
            using var scope = AiUsageScope.Begin(ResolveIdentity(context));
            await next();
        });

    /// <summary>
    /// Budget identity for a caller: the signed-in user, falling back to the remote address so an
    /// anonymous or guest caller still cannot spend without limit.
    /// </summary>
    /// <remarks>
    /// Same shape as <c>InferEndpoints.ResolveBudgetIdentity</c>, which this replaces — one
    /// definition, so the relay and every other AI surface charge the same ledger for the same
    /// person rather than maintaining two.
    /// </remarks>
    public static string ResolveIdentity(HttpContext context)
    {
        var identity = RequestIdentity.Resolve(context.User);
        return !string.IsNullOrEmpty(identity.UserId)
            ? $"id:{identity.UserId}"
            : $"ip:{context.Connection.RemoteIpAddress?.ToString() ?? "unknown"}";
    }
}

/// <summary>
/// Opens an <see cref="AiUsageScope"/> around every SignalR hub invocation.
/// </summary>
/// <remarks>
/// PoCoupleQuiz generates a question and scores every submitted answer from inside
/// <c>CoupleQuizHub</c>, so a per-request middleware alone would leave the game with the highest
/// per-round call count entirely unmetered. <c>IHttpContextAccessor</c> is not a reliable
/// substitute inside a hub — for WebSocket transports there is no ambient HTTP request — so the
/// identity is taken from the hub's own <c>Context</c>.
/// </remarks>
public sealed class AiUsageScopeHubFilter : IHubFilter
{
    public async ValueTask<object?> InvokeMethodAsync(
        HubInvocationContext invocationContext,
        Func<HubInvocationContext, ValueTask<object?>> next)
    {
        using var scope = AiUsageScope.Begin(ResolveIdentity(invocationContext.Context));
        return await next(invocationContext);
    }

    private static string ResolveIdentity(HubCallerContext context)
    {
        var identity = RequestIdentity.Resolve(context.User);
        if (!string.IsNullOrEmpty(identity.UserId))
            return $"id:{identity.UserId}";

        // No signed-in user id. Key on the remote address, the same as the HTTP path: a
        // per-connection key hands every reconnect a fresh allowance, which is no ceiling at all.
        var ip = context.GetHttpContext()?.Connection.RemoteIpAddress?.ToString();
        return ip is null ? $"conn:{context.ConnectionId}" : $"ip:{ip}";
    }
}
