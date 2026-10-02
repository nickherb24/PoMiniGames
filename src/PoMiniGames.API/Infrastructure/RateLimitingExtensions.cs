using Microsoft.AspNetCore.RateLimiting;
using System.Threading.RateLimiting;

namespace PoMiniGames.Infrastructure;

/// <summary>Registers the rate-limiter policy used by high-score endpoints.</summary>
/// <remarks>
/// Pattern: Strategy + Specification. The limiter is parameterised by a partition key
/// (remote IP) and a fixed-window specification (10 requests / minute). Swapping the
/// window strategy (e.g. sliding-window or token-bucket) is a one-line change in the
/// <c>factory</c> delegate; the rest of the call sites are unaffected. This is the
/// textbook "rate-limiting as cross-cutting concern" decomposition from the
/// .NET rate-limiting middleware documentation.
/// </remarks>
internal static class RateLimitingExtensions
{
    public static IServiceCollection AddPoMiniGamesRateLimiting(this IServiceCollection services)
    {
        services.AddRateLimiter(opts =>
        {
            opts.RejectionStatusCode = StatusCodes.Status429TooManyRequests;

            // §9.2 chaos-engineering hardening: every policy now keys on a compound
            // (IP + identity) partition. The previous IP-only design let a single
            // attacker behind a corporate NAT — or a single AutoGuest browser on a
            // shared connection — saturate the bucket for every legitimate user
            // behind that NAT. The compound partition keeps anonymous bursts from
            // poisoning authenticated traffic and lets DevCookie / JWT identities
            // get their own bucket on top of an IP-level bucket for anon traffic.
            opts.AddPolicy("highscores", ctx =>
                RateLimitPartition.GetFixedWindowLimiter(
                    partitionKey: BuildPartitionKey(ctx),
                    factory: _ => new FixedWindowRateLimiterOptions
                    {
                        Window = TimeSpan.FromMinutes(1),
                        PermitLimit = 10,
                        AutoReplenishment = true,
                        QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                        QueueLimit = 0,
                    }));

            // Anonymous leaderboard READS. Separate from "highscores" on both axes:
            // a read is cheaper than a write (one bounded partition query, no
            // read-modify-write), and sharing a bucket would let a page that reads a
            // board before submitting to it starve its own write. 60/min still caps an
            // unauthenticated flood at ~1 rps per partition, which is what an endpoint
            // carrying AllowAnonymous needs — dropping the group's auth gate removes the
            // only other thing standing between a caller and Table Storage on an F1 plan.
            opts.AddPolicy("leaderboard-read", ctx =>
                RateLimitPartition.GetFixedWindowLimiter(
                    partitionKey: BuildPartitionKey(ctx),
                    factory: _ => new FixedWindowRateLimiterOptions
                    {
                        Window = TimeSpan.FromMinutes(1),
                        PermitLimit = 60,
                        AutoReplenishment = true,
                        QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                        QueueLimit = 0,
                    }));

            // Play-session minting. One mint per game the player opens, so a normal session
            // spends a handful; 30/min leaves a browsing player untouched while capping the
            // rate a script can farm signed sessions at. Cheaper than "highscores" work
            // (a Protect call, no storage) but deliberately not unlimited: a session is a
            // credential, and minting is the only way to get one.
            opts.AddPolicy("play-session", ctx =>
                RateLimitPartition.GetFixedWindowLimiter(
                    partitionKey: BuildPartitionKey(ctx),
                    factory: _ => new FixedWindowRateLimiterOptions
                    {
                        Window = TimeSpan.FromMinutes(1),
                        PermitLimit = 30,
                        AutoReplenishment = true,
                        QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                        QueueLimit = 0,
                    }));

            // Account export / erase. The tightest policy in the app because each call is a
            // full cross-table scan of every board's partition — by far the most expensive
            // thing an authenticated caller can ask for on an F1 plan. A human does this once
            // or twice, ever; 5/min is generous for that and useless as an amplifier.
            opts.AddPolicy("account-data", ctx =>
                RateLimitPartition.GetFixedWindowLimiter(
                    partitionKey: BuildPartitionKey(ctx),
                    factory: _ => new FixedWindowRateLimiterOptions
                    {
                        Window = TimeSpan.FromMinutes(1),
                        PermitLimit = 5,
                        AutoReplenishment = true,
                        QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                        QueueLimit = 0,
                    }));

            // AI-backed content generation (currently only PoFunQuiz question fetches).
            //
            // 2026-09-12: raised 5/min -> 8 per 15 s. The old figure priced this endpoint as if
            // every call reached a model. It does not: AiQuizGeneratorService wraps the
            // question POOL in a stampede-protected HybridCache (6 h, durable L2), so a
            // (category, batchCount) pair costs exactly one generation per six hours and every
            // other request is a cache read that deals a fresh hand out of it. What 5/min
            // actually bounded was *starting a quiz* — and a player who opens solo, retries
            // once, then opens 2-player has spent three of five permits inside one window, on
            // an endpoint where at most one of those calls could have cost anything. That is
            // the 429 the funquiz page was surfacing.
            //
            // Spend stays bounded by the three layers that can actually see cost: the pool
            // cache above (one call per category per 6 h, and QuestionCategory is a small
            // closed enum, so key rotation is bounded too), the durable per-identity token
            // budget, and AiConcurrencyGate. Eight quiz starts in fifteen seconds is already
            // faster than a human can read a question, and is still useless as an amplifier.
            // A SHORT window, unlike every policy above it, because what hurt here was not the
            // rate but the penalty: a one-minute window that trips on the fourth quiz start
            // locks the game for the rest of the minute and can only advertise a 60 s
            // Retry-After. 8 per 15 s is a higher sustained ceiling (32/min against the old
            // 5/min) AND a wait short enough for the page to sit through and retry itself.
            // A sliding window is not the fix — its permits come back one full window after
            // they were taken, so it smooths the ceiling without shortening the lockout, and
            // .NET's implementation publishes no Retry-After metadata to hand the client.
            opts.AddPolicy("ai-generation", ctx =>
                RateLimitPartition.GetFixedWindowLimiter(
                    partitionKey: BuildPartitionKey(ctx),
                    factory: _ => new FixedWindowRateLimiterOptions
                    {
                        Window = TimeSpan.FromSeconds(15),
                        PermitLimit = 8,
                        AutoReplenishment = true,
                        QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                        QueueLimit = 0,
                    }));

            // PoCabinet (2026-09-17): the score-submission policy for the cockpit-view racing game.
            // A racing session submits one best lap per finish, so 10/min mirrors "highscores"
            // — the cap that worked for the rest of the games. Uses the same (IP + identity)
            // partition so anonymous floods can't poison authed traffic.
            opts.AddPolicy("pocabinet", ctx =>
                RateLimitPartition.GetFixedWindowLimiter(
                    partitionKey: BuildPartitionKey(ctx),
                    factory: _ => new FixedWindowRateLimiterOptions
                    {
                        Window = TimeSpan.FromMinutes(1),
                        PermitLimit = 10,
                        AutoReplenishment = true,
                        QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                        QueueLimit = 0,
                    }));

            // PoJevArena (2026-09-25): library writes, match registration and status share a
            // modest cap; the decision proxy gets its own because a live match sends a batch
            // every 250 ms (240/min). Spend is bounded separately by the daily Jev allowance —
            // these only shape bursts.
            opts.AddPolicy("pojevarena", ctx =>
                RateLimitPartition.GetFixedWindowLimiter(
                    partitionKey: BuildPartitionKey(ctx),
                    factory: _ => new FixedWindowRateLimiterOptions
                    {
                        Window = TimeSpan.FromMinutes(1),
                        PermitLimit = 30,
                        AutoReplenishment = true,
                        QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                        QueueLimit = 0,
                    }));
            opts.AddPolicy("pojevarena-decide", ctx =>
                RateLimitPartition.GetFixedWindowLimiter(
                    partitionKey: BuildPartitionKey(ctx),
                    factory: _ => new FixedWindowRateLimiterOptions
                    {
                        Window = TimeSpan.FromMinutes(1),
                        PermitLimit = 300,
                        AutoReplenishment = true,
                        QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                        QueueLimit = 0,
                    }));

            // Browser error reports (2026-10-01). Anonymous and outside the antiforgery scope, so
            // this limit is what stops the sink being used to fill the log. The page itself sends
            // at most ten per load, deduplicated; 20/min covers a couple of bad page loads.
            opts.AddPolicy("client-errors", ctx =>
                RateLimitPartition.GetFixedWindowLimiter(
                    partitionKey: BuildPartitionKey(ctx),
                    factory: _ => new FixedWindowRateLimiterOptions
                    {
                        Window = TimeSpan.FromMinutes(1),
                        PermitLimit = 20,
                        AutoReplenishment = true,
                        QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                        QueueLimit = 0,
                    }));

            // Game invites (2026-10-01). Each one is a write and an outbound push to someone
            // else's device, so it gets the tightest window after account-data: nobody invites
            // more than a handful of people a minute, and the recipient is the one who pays.
            opts.AddPolicy("invites", ctx =>
                RateLimitPartition.GetFixedWindowLimiter(
                    partitionKey: BuildPartitionKey(ctx),
                    factory: _ => new FixedWindowRateLimiterOptions
                    {
                        Window = TimeSpan.FromMinutes(1),
                        PermitLimit = 6,
                        AutoReplenishment = true,
                        QueueProcessingOrder = QueueProcessingOrder.OldestFirst,
                        QueueLimit = 0,
                    }));

            // Every policy here is a fixed window with QueueLimit = 0, so a rejected caller has
            // to guess how long to wait — and the client's own retry handler deliberately does
            // not replay a 429. Hand back the window's remaining time as Retry-After so the UI
            // can say "in 12s" instead of failing blind. The metadata is only present on
            // limiters that know their replenishment schedule; absent it, say nothing rather
            // than invent a number.
            opts.OnRejected = (context, _) =>
            {
                if (context.Lease.TryGetMetadata(MetadataName.RetryAfter, out var retryAfter))
                {
                    context.HttpContext.Response.Headers.RetryAfter =
                        ((int)Math.Ceiling(retryAfter.TotalSeconds)).ToString(
                            System.Globalization.CultureInfo.InvariantCulture);
                }

                return ValueTask.CompletedTask;
            };
        });

        return services;
    }

    /// <summary>
    /// Compound partition key: <c>{ip}|{identity-or-anon}</c>. The authenticated
    /// user id (oid / NameIdentifier claim) — or <c>anon</c> when absent — is
    /// appended to the remote IP, so two distinct identities sharing an IP get
    /// separate buckets. The cookie session id (resolved by the auth middleware)
    /// is used as a fallback identity for unauthenticated DevCookie requests.
    /// </summary>
    private static string BuildPartitionKey(HttpContext ctx)
    {
        var ip = ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown";
        var identity = ctx.User?.Identity?.IsAuthenticated == true
            ? (ctx.User.FindFirst("oid")?.Value
               ?? ctx.User.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value
               ?? ctx.User.Identity.Name
               ?? "auth")
            : "anon";
        return $"{ip}|{identity}";
    }
}
