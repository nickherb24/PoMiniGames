using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Caching.Hybrid;
using Microsoft.Extensions.Options;
using PoMiniGames.AI;
using PoMiniGames.Features.Shared;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoCabinet;

/// <summary>
/// The officials' radio lines and the "race engineer" debrief.
/// </summary>
/// <remarks>
/// <para>
/// <b>This reverses PoCabinet's original "scripted dialogue only" call</b> (ADR-4, recorded on
/// <see cref="PoCabinetDialogue"/>) at the user's request. The scripted pools are now the fallback:
/// every failure here — mock mode, no foundry, a timeout, an error, a reply that doesn't parse or
/// is filtered to nothing — returns them (or the rule-based debrief) instead of an error, in
/// every environment, because both are flavour on screens that already work without them.
/// </para>
/// <para>
/// <b>Cost shape.</b> Banter is one structured call per <i>track</i> per day, platform-wide (the
/// pool is cached 24 h and shared by every player) — at most three calls a day, which is why it
/// needs no separate off-peak pre-bake job: the first race on a track each day is the pre-bake.
/// The debrief is one call per distinct set of rounded race numbers, cached 24 h. Both run on
/// cheap task deployments (<c>pocabinet.banter</c>, <c>pocabinet.debrief</c>), behind the
/// per-identity token budget and the <c>ai-generation</c> rate limit, like PoBrawl's presser.
/// </para>
/// <para>
/// <b>The server writes every word the model sees</b>: the client sends a track id or clamped
/// numbers, never text. Output is structured JSON (schema below), and every line is capped and
/// run through <see cref="BannedTerms"/> before it can reach a speech bubble or a voice.
/// </para>
/// </remarks>
public sealed class PoCabinetAiService
{
    /// <summary>The kinds a pool carries, in the order the client asks for them.</summary>
    public static readonly string[] Kinds = ["preRace", "passed", "lead", "finish"];

    /// <summary>Longest line a speech bubble renders.</summary>
    public const int MaxLineChars = 90;

    private const int MaxTipChars = 140;
    private static readonly TimeSpan CallTimeout = TimeSpan.FromSeconds(15);

    /// <summary>
    /// Lines containing any of these are dropped (substring, case-insensitive): real-world
    /// politics and anything that isn't PG. Satire of the officials' cartoon roles is the joke;
    /// real policy, elections and people are not.
    /// </summary>
    public static readonly string[] BannedTerms =
    [
        "election", "vote", "ballot", "democrat", "republican", "liberal", "conservative", "maga",
        "trump", "biden", "obama", "clinton", "impeach", "indict", "prison", "jail", "abortion",
        "immigra", "border", "kill", "dead", "die ", "murder", "gun", "shoot", "bomb", "hate",
        "sex", "drunk", "drug", "damn", "hell", "god",
    ];

    private const string BanterSystemPrompt =
        "You write short in-race radio lines for Cabinet, a slapstick arcade racing game where four cartoon cabinet " +
        "officials race go-fast sedans around satirical Washington tracks. Each official speaks in their cartoon role's " +
        "voice. Rules: every line at most 12 words and 80 characters; playful and PG; about the race itself (the track, " +
        "speed, being passed, leading, finishing). Never mention real-world politics, policies, parties, elections, " +
        "scandals, real people, health, age or appearance. No profanity. Kinds: preRace = on the grid before the start; " +
        "passed = the human driver just overtook this official; lead = this official just took the lead; finish = the " +
        "race just ended. Give four different lines for every kind.";

    private const string DebriefSystemPrompt =
        "You are the race engineer in Cabinet, a slapstick arcade racing game with satirical Washington tracks. From the " +
        "numbers given, write a short satirical newspaper headline about the driver's race (at most 10 words, PG, about " +
        "the race only) and up to three concrete driving tips (each one sentence, at most 22 words) that use the numbers " +
        "given — say where on the lap (a sector, or how far round the lap) and what to change. The numbers describe the " +
        "driver's best lap, not individual laps, so never give lap-by-lap advice. Never mention real-world politics, " +
        "policies, parties, elections, scandals or real people. No profanity. Do not invent numbers that were not given.";

    private static readonly JsonElement BanterSchema = JsonDocument.Parse(
        """
        {
          "type": "object",
          "properties": {
            "officials": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "id": { "type": "string" },
                  "preRace": { "type": "array", "items": { "type": "string" } },
                  "passed": { "type": "array", "items": { "type": "string" } },
                  "lead": { "type": "array", "items": { "type": "string" } },
                  "finish": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["id", "preRace", "passed", "lead", "finish"],
                "additionalProperties": false
              }
            }
          },
          "required": ["officials"],
          "additionalProperties": false
        }
        """).RootElement.Clone();

    private static readonly JsonElement DebriefSchema = JsonDocument.Parse(
        """
        {
          "type": "object",
          "properties": {
            "headline": { "type": "string" },
            "tips": { "type": "array", "items": { "type": "string" } }
          },
          "required": ["headline", "tips"],
          "additionalProperties": false
        }
        """).RootElement.Clone();

    /// <summary>The cartoon role each official plays (matches the car colours' notes in cars.js).</summary>
    private static readonly Dictionary<string, string> Roles = new(StringComparer.Ordinal)
    {
        ["sean-s"] = "the press secretary: defensive, denies everything, answers no questions",
        ["steve-b"] = "the chief strategist: always plotting, sees a master plan in every corner",
        ["bill-b"] = "the attorney general: aggressive, legalistic, treats the race like a courtroom",
        ["mike-p"] = "the vice president: steady, polite, relentlessly on-message",
    };

    private readonly IConfiguration _configuration;
    private readonly IHostEnvironment _environment;
    private readonly ILogger<PoCabinetAiService> _logger;
    private readonly GameChatClientFactory _clients;
    private readonly IOptionsMonitor<AIFoundryOptions> _foundry;
    private readonly AiDecisionOptionsCache _options;
    private readonly HybridCache _cache;

    public PoCabinetAiService(
        IConfiguration configuration,
        IHostEnvironment environment,
        ILogger<PoCabinetAiService> logger,
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

    private bool UseMock => AiMockFallback.ShouldUseMock(_environment, _configuration.GetValue<bool>("PoCabinet:Features:UseMockAI"));

    // ── Banter ───────────────────────────────────────────────────────────────

    public async Task<PoCabinetBanterPool> BanterAsync(string? trackId, CancellationToken ct = default)
    {
        var track = PoCabinetCatalog.IsKnownTrack(trackId) ? trackId!.Trim().ToLowerInvariant() : PoCabinetCatalog.DefaultTrackId;
        var canned = CannedBanter();
        var officials = string.Join("; ", PoCabinetPersonality.Roster.Select(o => $"{o.Id} is {o.Name}, {Roles.GetValueOrDefault(o.Id, "an official")}"));
        var user = $"Track: {PoCabinetCatalog.GetTrack(track).Name}. Officials (use these ids): {officials}.";
        var json = await GenerateAsync(AIFoundryOptions.Tasks.PoCabinetBanter, $"pocabinet:banter:v1:{track}",
            BanterSystemPrompt, user, BanterSchema, "cabinet_banter", 1200, ct);
        return json is null ? canned : MergeBanter(json, canned);
    }

    /// <summary>Parse the model's pool, filter every line, and fill any empty slot from the script.</summary>
    internal static PoCabinetBanterPool MergeBanter(string json, PoCabinetBanterPool canned)
    {
        var pool = new PoCabinetBanterPool();
        var fromModel = 0;
        try
        {
            using var doc = JsonDocument.Parse(json);
            foreach (var o in doc.RootElement.GetProperty("officials").EnumerateArray())
            {
                var id = o.TryGetProperty("id", out var idEl) ? idEl.GetString() : null;
                if (id is null || !Roles.ContainsKey(id)) continue;
                var kinds = new Dictionary<string, List<string>>(StringComparer.Ordinal);
                foreach (var kind in Kinds)
                {
                    var lines = new List<string>();
                    if (o.TryGetProperty(kind, out var arr) && arr.ValueKind == JsonValueKind.Array)
                    {
                        foreach (var el in arr.EnumerateArray())
                        {
                            if (Clean(el.GetString(), MaxLineChars) is { } line && !lines.Contains(line)) lines.Add(line);
                            if (lines.Count == 6) break;
                        }
                    }
                    fromModel += lines.Count;
                    kinds[kind] = lines;
                }
                pool.Lines[id] = kinds;
            }
        }
        catch (Exception ex) when (ex is JsonException or KeyNotFoundException or InvalidOperationException)
        {
            return canned;
        }
        foreach (var (id, kinds) in canned.Lines)
        {
            if (!pool.Lines.TryGetValue(id, out var mine)) { pool.Lines[id] = kinds; continue; }
            foreach (var (kind, lines) in kinds)
            {
                if (!mine.TryGetValue(kind, out var got) || got.Count == 0) mine[kind] = lines;
            }
        }
        pool.Mock = fromModel == 0;
        return pool;
    }

    /// <summary>The hand-written pools, mapped onto the client's kinds.</summary>
    internal static PoCabinetBanterPool CannedBanter()
    {
        var pool = new PoCabinetBanterPool { Mock = true };
        foreach (var (id, byKind) in PoCabinetDialogue.Pools)
        {
            pool.Lines[id] = new Dictionary<string, List<string>>(StringComparer.Ordinal)
            {
                ["preRace"] = byKind.GetValueOrDefault(DialogueKind.PreRace)?.ToList() ?? [],
                ["passed"] = byKind.GetValueOrDefault(DialogueKind.PositionChange)?.ToList() ?? [],
                ["lead"] = byKind.GetValueOrDefault(DialogueKind.LapFinish)?.ToList() ?? [],
                ["finish"] = byKind.GetValueOrDefault(DialogueKind.RaceFinish)?.ToList() ?? [],
            };
        }
        return pool;
    }

    // ── Debrief ──────────────────────────────────────────────────────────────

    /// <summary>A request with every number clamped and the track resolved server-side.</summary>
    internal sealed record Facts(
        string TrackName, int Position, int TotalCars, double BestLap, double Pb, double[] Sectors,
        int FullThrottle, int Brake, int TopKmh, int SlowestKmh, int WorstPoint, int WallHits, int Laps);

    public async Task<PoCabinetDebriefReply> DebriefAsync(PoCabinetDebriefRequest request, CancellationToken ct = default)
    {
        var facts = Clamp(request);
        var canned = CannedDebrief(facts);
        var json = await GenerateAsync(AIFoundryOptions.Tasks.PoCabinetDebrief, "pocabinet:debrief:v1:" + Fingerprint(facts),
            DebriefSystemPrompt, Describe(facts), DebriefSchema, "race_debrief", 400, ct);
        if (json is null) return canned;
        try
        {
            using var doc = JsonDocument.Parse(json);
            var headline = Clean(doc.RootElement.GetProperty("headline").GetString(), MaxLineChars);
            var tips = doc.RootElement.GetProperty("tips").EnumerateArray()
                .Select(t => Clean(t.GetString(), MaxTipChars)).OfType<string>().Take(3).ToList();
            if (headline is null || tips.Count == 0) return canned;
            return new PoCabinetDebriefReply(headline, tips, Mock: false);
        }
        catch (Exception ex) when (ex is JsonException or KeyNotFoundException or InvalidOperationException)
        {
            return canned;
        }
    }

    internal static Facts Clamp(PoCabinetDebriefRequest r)
    {
        static double Sec(double v, double max) => double.IsFinite(v) ? Math.Clamp(Math.Round(v, 2), 0, max) : 0;
        static int Pct(int v) => Math.Clamp(v, 0, 100);
        var track = PoCabinetCatalog.GetTrack(PoCabinetCatalog.IsKnownTrack(r.TrackId) ? r.TrackId : PoCabinetCatalog.DefaultTrackId);
        var sectors = r.SectorDeltas is { Length: 3 } s && s.All(double.IsFinite)
            ? s.Select(d => Math.Clamp(Math.Round(d, 2), -30, 30)).ToArray()
            : [];
        var total = Math.Clamp(r.TotalCars, 1, PoCabinetCatalog.SoloCarCount);
        return new Facts(
            track.Name, Math.Clamp(r.Position, 1, total), total, Sec(r.BestLapSeconds, 600), Sec(r.PbSeconds, 600), sectors,
            Pct(r.FullThrottlePct), Pct(r.BrakePct), Math.Clamp(r.TopKmh, 0, 400), Math.Clamp(r.SlowestKmh, 0, 400),
            Math.Clamp(r.WorstPointPct, -1, 100), Math.Clamp(r.WallHits, 0, 99), Math.Clamp(r.Laps, 0, 9));
    }

    private static string Describe(Facts f)
    {
        var inv = CultureInfo.InvariantCulture;
        var sb = new StringBuilder()
            .Append(inv, $"Track: {f.TrackName}. Finished P{f.Position} of {f.TotalCars} after {f.Laps} laps. ")
            .Append(inv, $"Best lap {f.BestLap:0.00} s")
            .Append(f.Pb > 0 ? string.Format(inv, " (personal best {0:0.00} s). ", f.Pb) : " (first recorded lap here). ");
        if (f.Sectors.Length == 3)
        {
            sb.Append(inv, $"Versus the personal best, sector 1 {f.Sectors[0]:+0.00;-0.00} s, sector 2 {f.Sectors[1]:+0.00;-0.00} s, sector 3 {f.Sectors[2]:+0.00;-0.00} s (+ = slower). ");
        }
        sb.Append(inv, $"Full throttle {f.FullThrottle}% of the lap, braking {f.Brake}%. Top speed {f.TopKmh} km/h, slowest corner {f.SlowestKmh} km/h. ");
        if (f.WorstPoint >= 0) sb.Append(inv, $"Most time was lost {f.WorstPoint}% of the way round the lap. ");
        sb.Append(inv, $"Barrier hits: {f.WallHits}.");
        return sb.ToString();
    }

    /// <summary>Rule-based stand-in: the same numbers, turned into tips by thresholds.</summary>
    internal static PoCabinetDebriefReply CannedDebrief(Facts f)
    {
        var inv = CultureInfo.InvariantCulture;
        var tips = new List<string>();
        if (f.Sectors.Length == 3)
        {
            var worst = Array.IndexOf(f.Sectors, f.Sectors.Max());
            var best = Array.IndexOf(f.Sectors, f.Sectors.Min());
            if (f.Sectors[worst] > 0.05)
                tips.Add(string.Format(inv, "Sector {0} cost you {1:0.00} s against your best — that's where this lap is.", worst + 1, f.Sectors[worst]));
            if (f.Sectors[best] < -0.05)
                tips.Add(string.Format(inv, "Sector {0} was {1:0.00} s quicker than your best. Keep that line.", best + 1, -f.Sectors[best]));
        }
        else if (f.WorstPoint >= 0)
        {
            tips.Add(string.Format(inv, "Most time went about {0}% of the way round — look at your braking into that corner.", f.WorstPoint));
        }
        if (f.WallHits > 0)
            tips.Add(string.Format(inv, "{0} barrier hit{1} cost you speed: a tidier line beats a braver one.", f.WallHits, f.WallHits == 1 ? "" : "s"));
        if (f.FullThrottle < 55)
            tips.Add(string.Format(inv, "Flat out only {0}% of the lap — get back on the gas earlier out of the corners.", f.FullThrottle));
        if (f.Brake > 18)
            tips.Add(string.Format(inv, "On the brakes {0}% of the lap: brake later and harder, then let go.", f.Brake));
        if (f.SlowestKmh is > 0 and < 90)
            tips.Add(string.Format(inv, "Your slowest corner dropped to {0} km/h — carry more speed through it.", f.SlowestKmh));
        if (tips.Count == 0) tips.Add("A clean race. Next step: move each braking point a car length later.");

        var headline = f.Position == 1
            ? $"OFFICIALS STUNNED AS CHALLENGER TAKES {f.TrackName.ToUpperInvariant()}"
            : $"P{f.Position} AT {f.TrackName.ToUpperInvariant()}: CABINET DEMANDS A RECOUNT";
        return new PoCabinetDebriefReply(headline, tips.Take(3).ToList(), Mock: true);
    }

    private static string Fingerprint(Facts f)
    {
        var text = string.Join('|', f.TrackName, f.Position, f.TotalCars, f.BestLap.ToString("0.0", CultureInfo.InvariantCulture),
            f.Pb.ToString("0.0", CultureInfo.InvariantCulture), string.Join(',', f.Sectors.Select(s => s.ToString("0.0", CultureInfo.InvariantCulture))),
            f.FullThrottle / 5, f.Brake / 5, f.TopKmh / 10, f.SlowestKmh / 10, f.WorstPoint / 10, f.WallHits, f.Laps);
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text)))[..32];
    }

    // ── Shared plumbing ──────────────────────────────────────────────────────

    /// <summary>
    /// One structured call on <paramref name="taskKey"/>'s deployment, cached 24 h under
    /// <paramref name="cacheKey"/>. Null on every failure (the caller uses its fallback).
    /// </summary>
    private async Task<string?> GenerateAsync(
        string taskKey, string cacheKey, string systemPrompt, string userPrompt,
        JsonElement schema, string schemaName, int maxTokens, CancellationToken ct)
    {
        if (UseMock) return null;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(CallTimeout);
        try
        {
            // Inside the try: building the decorated client resolves DI state too, and a failure
            // there is still just "use the script" — never a 500 on a flavour route.
            var deployment = _clients.DeploymentFor(taskKey);
            var client = _foundry.CurrentValue.IsConfigured ? _clients.ForDeployment(taskKey, deployment) : null;
            if (client is null) return null;
            // Carried into the factory explicitly: HybridCache may run it on a pooled thread
            // where the request's AsyncLocal budget identity is not flowing.
            var identity = AiUsageScope.CurrentIdentity;
            return await _cache.GetOrCreateAsync(
                cacheKey,
                (Service: this, Client: client, Deployment: deployment, Identity: identity, Task: taskKey,
                    System: systemPrompt, User: userPrompt, Schema: schema, Name: schemaName, Max: maxTokens),
                static async (state, token) =>
                {
                    using var scope = AiUsageScope.Restore(state.Identity);
                    return await state.Service.CallModelAsync(state.Client, state.Task, state.Deployment,
                        state.System, state.User, state.Schema, state.Name, state.Max, token);
                },
                new HybridCacheEntryOptions { Expiration = TimeSpan.FromHours(24), LocalCacheExpiration = TimeSpan.FromHours(1) },
                cancellationToken: timeout.Token);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "PoCabinet {Task} call failed; using the scripted fallback", taskKey);
            return null;
        }
    }

    private async Task<string> CallModelAsync(
        IChatClient client, string taskKey, string deployment, string systemPrompt, string userPrompt,
        JsonElement schema, string schemaName, int maxTokens, CancellationToken ct)
    {
        var messages = new List<ChatMessage> { new(ChatRole.System, systemPrompt), new(ChatRole.User, userPrompt) };
        var options = _options.GetOrBuild(
            taskKey, deployment, _clients.CapabilityOverrides, schema, schemaName, maxTokens, null,
            (d, ov) => AiDecisionChatOptions.ForStructuredJson(schema, schemaName, maxTokens, d ?? string.Empty, null, ov));
        var response = await client.GetResponseAsync(messages, options, ct);
        var text = (response.Text ?? string.Empty).Trim();
        // An empty reply is a failure, not a result: throwing keeps it out of the cache.
        return text.Length == 0 ? throw new InvalidOperationException("Empty PoCabinet reply.") : text;
    }

    /// <summary>Trim, strip quotes, collapse whitespace, cap at a word boundary; null when empty or banned.</summary>
    internal static string? Clean(string? raw, int max)
    {
        var text = string.Join(' ', (raw ?? string.Empty).Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries))
            .Trim().Trim('"', '“', '”', '\'').Trim();
        if (text.Length == 0) return null;
        var lower = text.ToLowerInvariant() + " ";
        if (BannedTerms.Any(t => lower.Contains(t, StringComparison.Ordinal))) return null;
        if (text.Length > max)
        {
            var cut = text.LastIndexOf(' ', max - 1);
            text = (cut > max / 2 ? text[..cut] : text[..(max - 1)]).TrimEnd(',', ';', ':', ' ') + "…";
        }
        return text;
    }
}
