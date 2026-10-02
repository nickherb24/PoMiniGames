using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Caching.Hybrid;
using Microsoft.Extensions.Options;
using PoMiniGames.AI;
using PoMiniGames.Domain.Primitives;
using PoMiniGames.Features.Shared;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoBrawl;

/// <summary>
/// Writes the single press-conference line shown (and spoken) on PoBrawl's result modal.
/// </summary>
/// <remarks>
/// <para>
/// <b>Cost shape.</b> One bounded-text call on the cheap <c>pobrawl.presser</c> task deployment,
/// behind the per-identity token budget (automatic, through
/// <see cref="BudgetedChatClient"/>) and the <c>ai-generation</c> rate limit. The client asks
/// only when the modal is shown — a 1P ladder win rolls straight into the next rung with no
/// modal, and demo mode never asks — so a kiosk left running spends nothing.
/// </para>
/// <para>
/// <b>Every failure is a canned line, never an error, in every environment.</b> The other AI
/// slices rethrow in Production so a broken model is loud; this one is pure flavour on a
/// screen that already carries the real result, so a 500 there would cost the player the
/// modal's calm for nothing. Failures are still logged (EventId 4702).
/// </para>
/// <para>
/// <b>Only real replies are cached.</b> The factory throws on a failed or empty call, and
/// HybridCache does not store a faulted factory, so a canned line is never pinned in the cache
/// for 24 h in place of the real one.
/// </para>
/// </remarks>
public sealed class PoBrawlPresserService
{
    /// <summary>Longest line the modal will render.</summary>
    public const int MaxChars = 220;

    private const int MaxTokens = 120;

    /// <summary>
    /// Ceiling on the whole call. The modal is already on screen; a line that takes longer than
    /// this is worth less than the canned one, and the request must not hold its slot open.
    /// </summary>
    private static readonly TimeSpan CallTimeout = TimeSpan.FromSeconds(12);

    private const string SystemPrompt =
        "You write the one line a fighter says at the press conference after a bout in PoBrawl, a slapstick cartoon " +
        "boxing game where caricatures of U.S. presidents and an everyman named BOB trade punches. " +
        "Rules: one or two sentences, at most 35 words; first person, spoken by the named speaker in their famous public " +
        "speaking style; playful, good-natured and PG; make fun of the fight itself using the numbers given. Never mention " +
        "real-world politics, policies, parties, elections, scandals, health, age or appearance, and never invent real events. " +
        "No profanity. Output only the line itself, with no quotation marks and no speaker label.";

    /// <summary>Who reads the introduction — the reply's speaker.</summary>
    public const string Announcer = "Ring announcer";

    private const string IntroSystemPrompt =
        "You are the ring announcer at PoBrawl, a slapstick cartoon boxing game where caricatures of U.S. presidents and " +
        "an everyman named BOB trade punches. Write the one-breath introduction read over the arena PA before the bell. " +
        "Rules: one or two sentences, at most 30 words; big, booming, old-school boxing-announcer energy; name both " +
        "fighters, left corner first; playful and PG. Never mention real-world politics, policies, parties, elections, " +
        "scandals, health, age or appearance. No profanity. Output only the announcement as it would be shouted over the PA, " +
        "in flowing sentences with no labels, colons or lists, and no quotation marks.";

    private readonly IConfiguration _configuration;
    private readonly IHostEnvironment _environment;
    private readonly ILogger<PoBrawlPresserService> _logger;
    private readonly GameChatClientFactory _clients;
    private readonly IOptionsMonitor<AIFoundryOptions> _foundry;
    private readonly AiDecisionOptionsCache _options;
    private readonly HybridCache _cache;

    public PoBrawlPresserService(
        IConfiguration configuration,
        IHostEnvironment environment,
        ILogger<PoBrawlPresserService> logger,
        GameChatClientFactory clients,
        IOptionsMonitor<AIFoundryOptions> foundry,
        AiDecisionOptionsCache options,
        HybridCache cache)
    {
        _configuration = configuration;
        _environment = environment;
        _logger = logger;
        _clients = clients;
        _foundry = foundry;
        _options = options;
        _cache = cache;
    }

    private bool UseMock => AiMockFallback.ShouldUseMock(_environment, _configuration.GetValue<bool>("PoBrawl:Features:UseMockAI"));

    /// <summary>A request with both names resolved server-side and every number clamped.</summary>
    private sealed record Bout(
        string SpeakerName, string OpponentName, PoBrawlOutcome Outcome, bool Knockout,
        int Hits, int OpponentHits, int Blocks, int BestCombo, int BiggestHit, int Seconds);

    /// <summary>The line, or <c>null</c> when either fighter id is not on the roster.</summary>
    public Task<PoBrawlPresserReply?> AskAsync(PoBrawlPresserRequest request, CancellationToken ct = default)
    {
        var bout = Resolve(request);
        return bout is null
            ? Task.FromResult<PoBrawlPresserReply?>(null)
            : GenerateAsync("pobrawl:presser:" + Fingerprint(bout), bout.SpeakerName, SystemPrompt, Describe(bout), () => Canned(bout), ct);
    }

    /// <summary>The PA's ring introduction for a pairing, or <c>null</c> when either id is not a fighter.</summary>
    public Task<PoBrawlPresserReply?> IntroAsync(PoBrawlIntroRequest request, CancellationToken ct = default)
    {
        var left = NameFor(request.P1Id);
        var right = NameFor(request.P2Id);
        if (left is null || right is null) return Task.FromResult<PoBrawlPresserReply?>(null);
        // One cached line per pairing: at most 16 x 16 of them, ever, for the whole platform.
        var prompt = $"Introduce this bout. In the left corner is {Billing(left)}; in the right corner is {Billing(right)}. It is one round of sixty seconds.";
        return GenerateAsync($"pobrawl:intro:v2:{left}|{right}", Announcer, IntroSystemPrompt, prompt, () => CannedIntro(left, right), ct);
    }

    /// <summary>
    /// One bounded line from the cheap presser deployment, cached 24 h under <paramref name="cacheKey"/>.
    /// Every failure — mock mode, no foundry, a timeout, an error — is the canned line instead.
    /// </summary>
    private async Task<PoBrawlPresserReply?> GenerateAsync(
        string cacheKey, string speaker, string systemPrompt, string userPrompt, Func<PoBrawlPresserReply> canned, CancellationToken ct)
    {
        var deployment = _clients.DeploymentFor(AIFoundryOptions.Tasks.PoBrawlPresser);
        if (UseMock)
        {
            _logger.PresserMockEnabled(_environment.EnvironmentName);
            return canned();
        }
        var client = _foundry.CurrentValue.IsConfigured
            ? _clients.ForDeployment(AIFoundryOptions.Tasks.PoBrawlPresser, deployment)
            : null;
        if (client is null) return canned();

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(CallTimeout);
        try
        {
            // Carried into the factory explicitly: HybridCache may run it on a pooled
            // thread where the request's AsyncLocal budget identity is not flowing.
            var identity = AiUsageScope.CurrentIdentity;
            var text = await _cache.GetOrCreateAsync(
                cacheKey,
                (Service: this, Client: client, Deployment: deployment, Identity: identity, System: systemPrompt, User: userPrompt),
                static async (state, token) =>
                {
                    using var scope = AiUsageScope.Restore(state.Identity);
                    return await state.Service.CallModelAsync(state.Client, state.Deployment, state.System, state.User, token);
                },
                new HybridCacheEntryOptions
                {
                    Expiration = TimeSpan.FromHours(24),
                    LocalCacheExpiration = TimeSpan.FromHours(1),
                },
                cancellationToken: timeout.Token);
            return new PoBrawlPresserReply(speaker, text, Mock: false);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (OperationCanceledException)
        {
            _logger.PresserFailed(new TimeoutException($"Presser call exceeded {CallTimeout.TotalSeconds:0} s."));
            return canned();
        }
        catch (Exception ex)
        {
            _logger.PresserFailed(ex);
            return canned();
        }
    }

    private async Task<string> CallModelAsync(IChatClient client, string deployment, string systemPrompt, string userPrompt, CancellationToken ct)
    {
        var messages = new List<ChatMessage>
        {
            new(ChatRole.System, systemPrompt),
            new(ChatRole.User, userPrompt),
        };
        var options = _options.GetOrBuildText(
            AIFoundryOptions.Tasks.PoBrawlPresser, deployment, _clients.CapabilityOverrides, MaxTokens,
            (d, ov) => AiDecisionChatOptions.ForBoundedText(MaxTokens, d ?? string.Empty, ov));
        var response = await client.GetResponseAsync(messages, options, ct);
        var text = Clean(response.Text);
        // An empty reply is a failure, not a line: throwing keeps it out of the cache.
        return text.Length == 0 ? throw new InvalidOperationException("Empty presser reply.") : text;
    }

    /// <summary>Resolve both fighters from the roster and clamp every number, or null.</summary>
    private static Bout? Resolve(PoBrawlPresserRequest r)
    {
        var speaker = NameFor(r.SpeakerId);
        var opponent = NameFor(r.OpponentId);
        if (speaker is null || opponent is null) return null;
        var outcome = Enum.IsDefined(r.Outcome) ? r.Outcome : PoBrawlOutcome.Draw;
        static int Clamp(int v, int max) => Math.Clamp(v, 0, max);
        return new Bout(
            speaker, opponent, outcome, r.Knockout && outcome != PoBrawlOutcome.Draw,
            Clamp(r.Hits, 999), Clamp(r.OpponentHits, 999), Clamp(r.Blocks, 999),
            Clamp(r.BestCombo, 99), Clamp(r.BiggestHit, 999), Clamp(r.Seconds, 600));
    }

    private static string? NameFor(string? id)
    {
        if (string.Equals(id, PoBrawlRoster.Bob.Id, StringComparison.OrdinalIgnoreCase)) return PoBrawlRoster.Bob.Name;
        var canonical = PoBrawlRoster.Canonicalize(id);
        return canonical is null ? null : PoBrawlRoster.DisplayName(canonical);
    }

    private static string Describe(Bout b)
    {
        var result = (b.Outcome, b.Knockout) switch
        {
            (PoBrawlOutcome.Win, true) => "won by knockout",
            (PoBrawlOutcome.Win, false) => "won on points at the bell",
            (PoBrawlOutcome.Loss, true) => "lost by knockout",
            (PoBrawlOutcome.Loss, false) => "lost on points at the bell",
            _ => "fought to a draw",
        };
        return $"Speaker: {Billing(b.SpeakerName)}. Opponent: {b.OpponentName}. The speaker {result} after {b.Seconds} seconds. " +
               $"Speaker landed {b.Hits} hits, blocked {b.Blocks}, best combo {b.BestCombo}, biggest hit {b.BiggestHit} damage. " +
               $"Opponent landed {b.OpponentHits} hits.";
    }

    private static string Clean(string? raw)
    {
        var text = (raw ?? string.Empty).Trim().Trim('"', '“', '”').Trim();
        return text.Length > MaxChars ? text[..MaxChars].TrimEnd() + "…" : text;
    }

    private static string Fingerprint(Bout b)
    {
        var text = $"{b.SpeakerName}|{b.OpponentName}|{b.Outcome}|{b.Knockout}|{b.Hits}|{b.OpponentHits}|{b.Blocks}|{b.BestCombo}|{b.BiggestHit}|{b.Seconds}";
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text)))[..32];
    }

    private static string Billing(string name) =>
        name == PoBrawlRoster.Bob.Name ? "BOB, a mild-mannered office worker who wandered into the ring" : $"{name}, the cartoon president";

    /// <summary>The introduction's stand-in, picked by the pairing so it is stable for a pair.</summary>
    private static PoBrawlPresserReply CannedIntro(string left, string right)
    {
        string[] lines =
        [
            $"In the left corner, {left}! In the right corner, {right}! Sixty seconds, one round — let's get ready to brawl!",
            $"Ladies and gentlemen, from the left, {left}! And from the right, the one and only {right}! Touch gloves and come out swinging!",
            $"Tonight's main event: {left} versus {right}! One round, no recounts. Fighters, to your marks!",
        ];
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(left + "|" + right));
        return new PoBrawlPresserReply(Announcer, lines[hash[0] % lines.Length], Mock: true);
    }

    /// <summary>Deterministic stand-in: mock mode, an unconfigured foundry, a timeout, or any failure.</summary>
    private static PoBrawlPresserReply Canned(Bout b)
    {
        var opp = b.OpponentName;
        string[] lines = (b.Outcome, b.Knockout) switch
        {
            (PoBrawlOutcome.Win, true) =>
            [
                $"{b.Hits} clean shots and {opp} is taking a nap. I'd call that a mandate.",
                $"I said it would end early. {opp} didn't get the memo.",
                $"A {b.BestCombo}-hit combo. Frankly, the canvas owes me a thank-you note.",
            ],
            (PoBrawlOutcome.Win, false) =>
            [
                $"The judges saw it, the crowd saw it. {b.Hits} hits don't lie.",
                $"{opp} is tough, I'll give them that. Just not sixty-seconds-of-me tough.",
            ],
            (PoBrawlOutcome.Loss, true) =>
            [
                "I'd like to see the replay. Then I'd like to never see it again.",
                $"{opp} got lucky. {b.OpponentHits} times, apparently.",
            ],
            (PoBrawlOutcome.Loss, false) =>
            [
                $"We lost the decision, not the argument. I want a recount of those {b.OpponentHits} hits.",
                "Sixty seconds wasn't enough. Give me sixty-one next time.",
            ],
            _ =>
            [
                $"A draw. {opp} and I finally agree on something: nobody won.",
                "Even on the cards. I'll take the rematch any day of the week.",
            ],
        };
        var index = (int)(uint.Parse(Fingerprint(b)[..8], System.Globalization.NumberStyles.HexNumber) % (uint)lines.Length);
        return new PoBrawlPresserReply(b.SpeakerName, lines[index], Mock: true);
    }
}
