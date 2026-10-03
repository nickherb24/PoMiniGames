using System.Text.Json;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;
using PoMiniGames.Shared.Games.PoJoker;

namespace PoMiniGames.Features.PoJoker;

/// <summary>
/// Rewrites a flagged joke into a clean one that keeps its comic shape, so the Jester
/// can perform it instead of skipping it.
/// </summary>
/// <remarks>
/// <para><b>Why this exists.</b> <see cref="JokeSanitizer"/> substitutes words, which
/// turned out to do nothing to the jokes that actually get flagged: JokeAPI's racist
/// and sexist flags mark jokes whose <i>premise</i> is the offensive part, not jokes
/// containing profanity. Measured against the live Dark feed, every flagged joke came
/// back with no substitutable word in it. Changing the premise needs a rewrite, not a
/// find-and-replace.</para>
///
/// <para><b>Fallback chain</b> (never blocks the show): AI rewrite → word
/// substitution → play as fetched. Each step is best-effort; a rewrite that fails for
/// any reason — model not configured, timeout, refusal, upstream content filter —
/// falls through to the next rather than stalling the performance.</para>
///
/// <para>A refusal is a legitimate outcome here, not an error: the model declining to
/// restate a joke is precisely the signal that it should not be restated. That case
/// is logged and handed to the caller as <c>null</c>.</para>
/// </remarks>
public sealed class JokeRewriteService
{
    /// <summary>Output ceiling for a rewrite. Two short lines by contract.</summary>
    private const int RewriteMaxTokens = 250;

    private readonly ILogger<JokeRewriteService> _logger;
    private readonly IHostEnvironment _environment;
    private readonly GameChatClientFactory _clients;
    private readonly IOptionsMonitor<AIFoundryOptions> _foundryOptions;
    private readonly AiDecisionOptionsCache _optionsCache;
    private readonly int _timeoutSeconds;

    // JokeAPI serves a small pool, so the same flagged joke comes round again and again.
    // Successful rewrites are remembered by joke id; a failure is not, so it is retried.
    // ponytail: in-process and cleared when full. Move to HybridCache if rewrites should
    // survive a restart.
    private const int MaxRemembered = 500;
    private readonly System.Collections.Concurrent.ConcurrentDictionary<int, JokeDto> _rewrites = new();

    // Asks for a replacement joke rather than a cleaned copy of the original: the
    // point is to lose the premise, keeping only the comedic form.
    //
    // The fencing instruction matters more here than anywhere else in the solution: this is the one
    // prompt that asks a model to RESTATE text an attacker may have influenced, which is the shape
    // where a stray instruction inside that text is most likely to be acted on.
    private const string SystemPrompt = """
        You rewrite jokes so they are inoffensive.

        You will be given a joke that has been flagged as offensive. Write a NEW
        two-part joke that keeps only the comedic STRUCTURE of the original - the
        style of wordplay, the rhythm, the kind of misdirection. Everything that made
        the original offensive must be gone: no slurs, no demeaning premise, no group
        as the butt of the joke.

        The result must be genuinely funny and stand on its own to someone who has
        never seen the original.

        Emit only the JSON object described by the schema. Set "canRewrite" to false,
        leaving setup and punchline empty, if you cannot do this.
        """ + "\n" + AiPrompt.FencingInstruction;

    public JokeRewriteService(
        IConfiguration configuration,
        IHostEnvironment environment,
        ILogger<JokeRewriteService> logger,
        GameChatClientFactory clients,
        IOptionsMonitor<AIFoundryOptions> foundryOptions,
        AiDecisionOptionsCache optionsCache)
    {
        _logger = logger;
        _environment = environment;
        _clients = clients;
        _foundryOptions = foundryOptions;
        _optionsCache = optionsCache;
        // Deliberately NOT the shared PoJoker:AzureOpenAI:TimeoutSeconds (30s) that
        // analysis uses. Analysis runs while the joke is already on screen, so it can
        // afford to wait; this call blocks the fetch, so every second is dead air
        // before the joke appears. Measured against an unresponsive deployment, the
        // inherited 30s turned a ~150 ms fetch into a 25 s stall.
        //
        // A slow model must degrade to the fallback chain quickly rather than hold up
        // the show — losing the rewrite costs less than stalling the performance.
        _timeoutSeconds = configuration.GetValue("PoJoker:Rewrite:TimeoutSeconds", 8);
    }

    /// <summary>
    /// Returns a rewritten joke, or <c>null</c> when no rewrite could be produced —
    /// model unavailable, timed out, content-filtered, refused, or unparseable. The
    /// caller is expected to fall back rather than treat null as an error.
    /// </summary>
    public async Task<JokeDto?> TryRewriteAsync(JokeDto joke, CancellationToken cancellationToken = default)
    {
        if (_rewrites.TryGetValue(joke.Id, out var remembered))
        {
            return remembered;
        }

        var rewritten = await RewriteAsync(joke, cancellationToken);
        if (rewritten is not null)
        {
            if (_rewrites.Count >= MaxRemembered) _rewrites.Clear();
            _rewrites[joke.Id] = rewritten;
        }

        return rewritten;
    }

    private async Task<JokeDto?> RewriteAsync(JokeDto joke, CancellationToken cancellationToken)
    {
        // Own task key so the rewrite can be pointed at a different deployment from the Jester's
        // punchline prediction — this call blocks the fetch, so it is the one that most wants a
        // fast model.
        var deployment = _clients.DeploymentFor(AIFoundryOptions.Tasks.JokerRewrite);
        var chatClient = _foundryOptions.CurrentValue.IsConfigured
            ? _clients.ForDeployment(AIFoundryOptions.Tasks.JokerRewrite, deployment)
            : null;

        if (chatClient is null)
        {
            // Unlike AiJesterService there is no mock stand-in: a fabricated "rewrite"
            // would claim the joke was cleaned when it was not. Fall through instead.
            _logger.LogWarning(
                "PoJoker: AIFoundry not configured in {Environment}; flagged joke {JokeId} cannot be rewritten.",
                _environment.EnvironmentName, joke.Id);
            return null;
        }

        try
        {
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            cts.CancelAfter(TimeSpan.FromSeconds(_timeoutSeconds));

            var messages = new List<ChatMessage>
            {
                new(ChatRole.System, SystemPrompt),
                new(ChatRole.User, AiPrompt.FenceAll(("Setup", joke.Setup), ("Punchline", joke.Punchline))),
            };

            var response = await chatClient.GetResponseAsync(
                messages,
                _optionsCache.GetOrBuild(
                    gameKey: AIFoundryOptions.Tasks.JokerRewrite,
                    deployment: deployment,
                    capabilityOverrides: _clients.CapabilityOverrides,
                    schema: RewriteSchema,
                    schemaName: "joke_rewrite",
                    maxOutputTokens: RewriteMaxTokens,
                    schemaDescription: "A clean replacement joke, or a refusal.",
                    factory: (d, ov) => AiDecisionChatOptions.ForStructuredJson(
                        RewriteSchema,
                        schemaName: "joke_rewrite",
                        maxOutputTokens: RewriteMaxTokens,
                        deployment: d ?? string.Empty,
                        schemaDescription: "A clean replacement joke, or a refusal.",
                        capabilityOverrides: ov)),
                cts.Token);

            if (response.FinishReason == ChatFinishReason.ContentFilter)
            {
                _logger.LogInformation(
                    "PoJoker: rewrite of joke {JokeId} was content-filtered; falling back.", joke.Id);
                return null;
            }

            return Parse(response.Text, joke);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            _logger.LogWarning("PoJoker: rewrite of joke {JokeId} timed out after {Timeout}s.",
                joke.Id, _timeoutSeconds);
            return null;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "PoJoker: rewrite of joke {JokeId} failed.", joke.Id);
            return null;
        }
    }

    /// <summary>
    /// The rewrite contract, as a schema rather than a two-line text protocol.
    /// </summary>
    /// <remarks>
    /// The previous contract was <c>SETUP: …</c> / <c>PUNCHLINE: …</c> lines, or the literal string
    /// <c>CANNOT</c>. Both halves of that are fragile in the same direction: a model that adds a
    /// preamble, wraps the lines, or writes "I cannot do this" instead of the exact token produces
    /// a reply the parser reads as a malformed rewrite rather than as the refusal it is. Making the
    /// refusal a boolean field means it cannot be misspelled.
    /// </remarks>
    public static JsonElement RewriteSchema { get; } = JsonDocument.Parse(
        """
        {
          "type": "object",
          "properties": {
            "canRewrite": { "type": "boolean" },
            "setup": { "type": "string" },
            "punchline": { "type": "string" }
          },
          "required": ["canRewrite", "setup", "punchline"],
          "additionalProperties": false
        }
        """).RootElement.Clone();

    /// <summary>
    /// Reads the rewrite out of the reply. Anything that does not yield two non-empty halves is
    /// treated as a refusal — better to fall through to the next step of the chain than to perform
    /// a malformed joke.
    /// </summary>
    private JokeDto? Parse(string? text, JokeDto original)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;

        var start = text.IndexOf('{');
        var end = text.LastIndexOf('}');
        if (start < 0 || end <= start)
        {
            _logger.LogInformation(
                "PoJoker: rewrite of joke {JokeId} returned no JSON object; treating as a refusal.", original.Id);
            return null;
        }

        string? setup, punchline;
        try
        {
            using var doc = JsonDocument.Parse(text[start..(end + 1)]);
            var root = doc.RootElement;

            if (root.TryGetProperty("canRewrite", out var can)
                && can.ValueKind == JsonValueKind.False)
            {
                _logger.LogInformation("PoJoker: model declined to rewrite joke {JokeId}.", original.Id);
                return null;
            }

            setup = root.TryGetProperty("setup", out var s) && s.ValueKind == JsonValueKind.String
                ? s.GetString()?.Trim()
                : null;
            punchline = root.TryGetProperty("punchline", out var p) && p.ValueKind == JsonValueKind.String
                ? p.GetString()?.Trim()
                : null;
        }
        catch (JsonException)
        {
            _logger.LogInformation(
                "PoJoker: rewrite of joke {JokeId} was not valid JSON; treating as a refusal.", original.Id);
            return null;
        }

        if (string.IsNullOrWhiteSpace(setup) || string.IsNullOrWhiteSpace(punchline))
        {
            _logger.LogInformation(
                "PoJoker: rewrite of joke {JokeId} did not parse into a setup and punchline.", original.Id);
            return null;
        }

        // Flags describe the ORIGINAL joke and are cleared deliberately: what gets
        // performed is a different joke, and leaving them set would misreport it.
        return original with
        {
            Type = "twopart",
            Setup = setup,
            Punchline = punchline,
            Joke = string.Empty,
            Flags = new JokeFlags(),
            Sanitized = true,
        };
    }
}
