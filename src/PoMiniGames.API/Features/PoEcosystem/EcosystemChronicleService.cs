using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Caching.Hybrid;
using Microsoft.Extensions.Options;
using PoMiniGames.AI;
using PoMiniGames.Features.Shared;
using PoMiniGames.Shared.Games.PoEcosystem;

namespace PoMiniGames.Features.PoEcosystem;

/// <summary>
/// Server-side narrator and diplomat for PoEcosystem.
/// Handles decade sagas, batched creature thoughts, tribal chieftain treaties and milestone lore.
/// There is no decree interpreter: the island is observed, never steered.
/// </summary>
public sealed class EcosystemChronicleService
{
    public const int MaxLogLines = 120;
    public const int MaxLogLineChars = 240;
    private const int SagaMaxChars = 1400;
    private const int TitleMaxChars = 80;
    private const int EpigraphMaxChars = 160;
    private const int ThoughtMaxChars = 200;

    private const string ThoughtSystemPrompt =
        "You voice the inner thoughts of one animal on a small island. Reply with ONLY this JSON, nothing else: " +
        "{\"thought\": \"<one short first-person sentence>\", \"trait\": \"<one of boldness|sociability|curiosity|greed|diligence>\", \"delta\": <number from -0.25 to 0.25>}. " +
        "The delta nudges that trait for a minute. " + AiPrompt.FencingInstruction;

    private const string BatchThoughtSystemPrompt =
        "You voice the inner thoughts of multiple creatures on a living island. Given a list of creatures with their status, " +
        "reply with ONLY a JSON array matching the schema where each creature has a short first-person thought sentence, " +
        "a trait (boldness|sociability|curiosity|greed|diligence), and a delta number from -0.25 to 0.25. " + AiPrompt.FencingInstruction;

    private const string ChronicleSystemPrompt =
        "You are the chronicler of a small island where rabbits, deer, wolves and a tribe of humans live, breed, hunt and die " +
        "without anyone steering them. Given a span of years and the island's log, write a short saga in plain, vivid prose: " +
        "name the creatures the log names, keep to what the log says happened, and make the decade feel like history rather than a list. " +
        "Emit only the JSON object described by the schema: {\"title\": \"<a title, at most ten words>\", " +
        "\"saga\": \"<two or three short paragraphs, under 1200 characters>\", \"epigraph\": \"<one closing line>\"}. " +
        AiPrompt.FencingInstruction;

    private const string TreatySystemPrompt =
        "You are the Chieftain Council of two island tribes in diplomatic contact. Given their status, resources and dispute, " +
        "formulate an inter-tribal pact or ultimatum. Reply with ONLY a JSON object matching the schema: " +
        "title (at most 8 words), narrative (at most 2 sentences), action (PeaceTreaty|DemandTribute|Armistice|WarDeclaration), " +
        "demandedResource (Wood|Stone|Food|None), resourceAmount (integer 0-100), peaceYears (integer 1-5). " + AiPrompt.FencingInstruction;

    private const string MilestoneLoreSystemPrompt =
        "You are the Island Herald commemorating a pivotal milestone in the island's civilization history. " +
        "Reply with ONLY a JSON object matching the schema: epithet (a majestic 2-5 word title for the event or chief), " +
        "oralLegend (a 1-2 sentence mythic chronicle entry to be engraved on tribal totems). " + AiPrompt.FencingInstruction;

    private readonly IConfiguration _configuration;
    private readonly IHostEnvironment _environment;
    private readonly ILogger<EcosystemChronicleService> _logger;
    private readonly GameChatClientFactory _clients;
    private readonly IOptionsMonitor<AIFoundryOptions> _foundry;
    private readonly AiDecisionOptionsCache _options;
    private readonly HybridCache _cache;

    public EcosystemChronicleService(
        IConfiguration configuration,
        IHostEnvironment environment,
        ILogger<EcosystemChronicleService> logger,
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

    private bool UseMock => AiMockFallback.ShouldUseMock(_environment, _configuration.GetValue<bool>("PoEcosystem:Features:UseMockAI"));

    private IChatClient? Client(string key, out string deployment)
    {
        deployment = _clients.DeploymentFor(key);
        if (UseMock) { _logger.EcoMockEnabled(_environment.EnvironmentName); return null; }
        var client = _foundry.CurrentValue.IsConfigured ? _clients.ForDeployment(key, deployment) : null;
        if (client is not null) return client;
        if (AiMockFallback.IsNonProduction(_environment)) { _logger.EcoNotConfigured(_environment.EnvironmentName); return null; }
        throw new InvalidOperationException($"PoEcosystem: AIFoundry not configured. Set {AIFoundryOptions.SectionName} in Key Vault (kv-poshared).");
    }

    // ── Decade Chronicle ──────────────────────────────────────────────────
    public async Task<EcoChronicle> WriteAsync(EcoChronicleRequest request, CancellationToken ct = default)
    {
        var clean = Sanitize(request);
        var client = Client(AIFoundryOptions.Games.Ecosystem, out var deployment);
        if (client is null) return MockChronicle(clean);

        var key = "ecosystem:chronicle:" + Fingerprint(clean);
        var identity = AiUsageScope.CurrentIdentity;
        return await _cache.GetOrCreateAsync(
            key,
            (Service: this, Request: clean, Deployment: deployment, Identity: identity),
            static async (state, token) =>
            {
                using var scope = AiUsageScope.Restore(state.Identity);
                return await state.Service.WriteUncachedAsync(state.Request, state.Deployment, token);
            },
            new HybridCacheEntryOptions { Expiration = TimeSpan.FromHours(24), LocalCacheExpiration = TimeSpan.FromHours(1) },
            cancellationToken: ct);
    }

    private async Task<EcoChronicle> WriteUncachedAsync(EcoChronicleRequest request, string deployment, CancellationToken ct)
    {
        var client = Client(AIFoundryOptions.Games.Ecosystem, out _);
        if (client is null) return MockChronicle(request);
        try
        {
            var compressedLog = CompressLog(request.Log);
            var user = new StringBuilder()
                .Append("Years ").Append(request.FromYear).Append(" to ").Append(request.ToYear)
                .Append(" of the island. The human tribe is the ").Append(request.Tribe).Append(" tribe. ")
                .Append("Alive now: ").Append(CountsText(request.Counts)).Append(". ")
                .Append(ExtinctText(request.Extinct))
                .Append(string.IsNullOrWhiteSpace(request.Almanac) ? "" : "Almanac: " + request.Almanac + ". ")
                .Append('\n')
                .Append(AiPrompt.Fence(compressedLog, "LogSummary", 4_000))
                .ToString();

            var messages = new List<ChatMessage> { new(ChatRole.System, ChronicleSystemPrompt), new(ChatRole.User, user) };
            var options = _options.GetOrBuild(
                AIFoundryOptions.Games.Ecosystem, deployment, _clients.CapabilityOverrides,
                ChronicleSchema, "island_chronicle", 700, "A short saga of a span of years on the island.",
                (d, ov) => AiDecisionChatOptions.ForStructuredJson(ChronicleSchema, "island_chronicle", 700, d ?? string.Empty, "A short saga of a span of years on the island.", ov));

            var response = await client.GetResponseAsync(messages, options, ct);
            return ParseChronicle(response.Text) ?? MockChronicle(request);
        }
        catch (Exception ex)
        {
            _logger.EcoChronicleFailed(ex, request.Seed, request.FromYear, request.ToYear);
            if (AiMockFallback.IsNonProduction(_environment)) return MockChronicle(request);
            throw;
        }
    }

    // ── Single Thought ───────────────────────────────────────────────────
    public async Task<EcoThoughtReply> ThinkAsync(EcoThoughtRequest request, CancellationToken ct = default)
    {
        var prompt = (request.Prompt ?? string.Empty).Trim();

        var client = Client(AIFoundryOptions.Tasks.EcosystemThought, out var deployment);
        if (client is null) return new EcoThoughtReply(MockThought(prompt), Mock: true);
        try
        {
            var messages = new List<ChatMessage>
            {
                new(ChatRole.System, ThoughtSystemPrompt),
                new(ChatRole.User, AiPrompt.Fence(prompt, "Creature", 800)),
            };
            var options = _options.GetOrBuildText(
                AIFoundryOptions.Tasks.EcosystemThought, deployment, _clients.CapabilityOverrides, 90,
                (d, ov) => AiDecisionChatOptions.ForBoundedText(90, d ?? string.Empty, ov));
            var response = await client.GetResponseAsync(messages, options, ct);
            var text = (response.Text ?? string.Empty).Trim();
            if (text.Length > ThoughtMaxChars) text = text[..ThoughtMaxChars];
            return new EcoThoughtReply(text, Mock: false);
        }
        catch (Exception ex)
        {
            _logger.EcoThoughtFailed(ex);
            if (AiMockFallback.IsNonProduction(_environment)) return new EcoThoughtReply(MockThought(prompt), Mock: true);
            throw;
        }
    }

    // ── Batch Thoughts ───────────────────────────────────────────────────
    public async Task<EcoThoughtBatchReply> ThinkBatchAsync(EcoThoughtBatchRequest request, CancellationToken ct = default)
    {
        var items = (request.Items ?? []).Take(8).ToArray();
        if (items.Length == 0) return new EcoThoughtBatchReply([], Mock: true);

        var client = Client(AIFoundryOptions.Tasks.EcosystemThoughtBatch, out var deployment);
        if (client is null) return MockBatchThought(request);
        try
        {
            var promptBuilder = new StringBuilder();
            foreach (var item in items)
            {
                promptBuilder.Append($"ID {item.Id}: {item.Species} '{item.Name}', hunger {item.Hunger:P0}, thirst {item.Thirst:P0}, health {item.Health:P0}, goal: {item.Goal}. Nearby: {item.Nearby}\n");
            }

            var messages = new List<ChatMessage>
            {
                new(ChatRole.System, BatchThoughtSystemPrompt),
                new(ChatRole.User, AiPrompt.Fence(promptBuilder.ToString(), "CreatureBatch", 2_000)),
            };
            var options = _options.GetOrBuild(
                AIFoundryOptions.Tasks.EcosystemThoughtBatch, deployment, _clients.CapabilityOverrides,
                BatchThoughtSchema, "creature_thoughts", 400, "Batched animal thoughts.",
                (d, ov) => AiDecisionChatOptions.ForStructuredJson(BatchThoughtSchema, "creature_thoughts", 400, d ?? string.Empty, "Batched animal thoughts.", ov));

            var response = await client.GetResponseAsync(messages, options, ct);
            return ParseBatchThoughts(response.Text) ?? MockBatchThought(request);
        }
        catch (Exception ex)
        {
            _logger.EcoBatchThoughtFailed(ex);
            if (AiMockFallback.IsNonProduction(_environment)) return MockBatchThought(request);
            throw;
        }
    }

    // ── Chieftain Council Treaty ─────────────────────────────────────────
    public async Task<EcoTreatyReply> NegotiateTreatyAsync(EcoTreatyRequest request, CancellationToken ct = default)
    {
        var client = Client(AIFoundryOptions.Tasks.EcosystemTreaty, out var deployment);
        if (client is null) return MockTreaty(request);
        try
        {
            var prompt = new StringBuilder()
                .Append($"Tribe 1: {request.TribeA.Name} (Tech {request.TribeA.Tech}, Pop {request.TribeA.Population}, Wood {request.TribeA.Wood}, Stone {request.TribeA.Stone}, Food {request.TribeA.Food})\n")
                .Append($"Tribe 2: {request.TribeB.Name} (Tech {request.TribeB.Tech}, Pop {request.TribeB.Population}, Wood {request.TribeB.Wood}, Stone {request.TribeB.Stone}, Food {request.TribeB.Food})\n")
                .Append($"Dispute context: {request.Reason}\n")
                .Append(request.RecentEvents is { Count: > 0 } ? $"Recent events: {string.Join("; ", request.RecentEvents)}\n" : "")
                .ToString();

            var messages = new List<ChatMessage>
            {
                new(ChatRole.System, TreatySystemPrompt),
                new(ChatRole.User, AiPrompt.Fence(prompt, "DiplomacyContext", 1_500)),
            };
            var options = _options.GetOrBuild(
                AIFoundryOptions.Tasks.EcosystemTreaty, deployment, _clients.CapabilityOverrides,
                TreatySchema, "tribal_treaty", 350, "Chieftain diplomatic treaty resolution.",
                (d, ov) => AiDecisionChatOptions.ForStructuredJson(TreatySchema, "tribal_treaty", 350, d ?? string.Empty, "Chieftain diplomatic treaty resolution.", ov));

            var response = await client.GetResponseAsync(messages, options, ct);
            return ParseTreaty(response.Text) ?? MockTreaty(request);
        }
        catch (Exception ex)
        {
            _logger.EcoTreatyFailed(ex);
            if (AiMockFallback.IsNonProduction(_environment)) return MockTreaty(request);
            throw;
        }
    }

    // ── Milestone Lore ───────────────────────────────────────────────────
    public async Task<EcoMilestoneLoreReply> GenerateMilestoneLoreAsync(EcoMilestoneLoreRequest request, CancellationToken ct = default)
    {
        var key = $"ecosystem:lore:{request.Seed}:{request.Year}:{request.MilestoneType}:{request.TribeName}";
        return await _cache.GetOrCreateAsync(
            key,
            (Service: this, Request: request),
            static async (state, token) =>
            {
                var client = state.Service.Client(AIFoundryOptions.Tasks.EcosystemMilestoneLore, out var deployment);
                if (client is null) return MockLore(state.Request);
                try
                {
                    var prompt = $"Year {state.Request.Year}: {state.Request.TribeName} reached milestone: {state.Request.MilestoneType}. Details: {state.Request.Details}";
                    var messages = new List<ChatMessage>
                    {
                        new(ChatRole.System, MilestoneLoreSystemPrompt),
                        new(ChatRole.User, AiPrompt.Fence(prompt, "Milestone", 800)),
                    };
                    var options = state.Service._options.GetOrBuild(
                        AIFoundryOptions.Tasks.EcosystemMilestoneLore, deployment, state.Service._clients.CapabilityOverrides,
                        MilestoneLoreSchema, "milestone_lore", 250, "Engraved oral legend.",
                        (d, ov) => AiDecisionChatOptions.ForStructuredJson(MilestoneLoreSchema, "milestone_lore", 250, d ?? string.Empty, "Engraved oral legend.", ov));

                    var response = await client.GetResponseAsync(messages, options, token);
                    return ParseLore(response.Text) ?? MockLore(state.Request);
                }
                catch (Exception ex)
                {
                    state.Service._logger.EcoLoreFailed(ex);
                    return MockLore(state.Request);
                }
            },
            new HybridCacheEntryOptions { Expiration = TimeSpan.FromHours(24) },
            cancellationToken: ct);
    }

    // ── Culture Pantheon ─────────────────────────────────────────────────
    public IReadOnlyList<EcoCultureProfile> GenerateTribeCultures(int seed)
    {
        var rng = new Random(seed);
        string[] deitiesA = ["Sol-Rhea the Dawn Mother", "Ignis of the Sun Peaks", "Aurelius the Light Giver"];
        string[] deitiesB = ["Thalor the Deep Warden", "Maris the Tide Weaver", "Nereus of the Abyssal Current"];
        string[] deitiesC = ["Sylva the Root Binder", "Cernun the Horned Warden", "Vera of the Canopy"];

        return
        [
            new EcoCultureProfile(1, "Amber Clan", deitiesA[rng.Next(deitiesA.Length)], "Golden Sun Eagle", "Never fell a cedar tree at dusk", "By the First Light!"),
            new EcoCultureProfile(2, "Cobalt Clan", deitiesB[rng.Next(deitiesB.Length)], "Great Tide Serpent", "Never taint a fresh water spring", "Rise with the Surge!"),
            new EcoCultureProfile(3, "Verdant Clan", deitiesC[rng.Next(deitiesC.Length)], "Grand Horned Stag", "Never hunt a nursing doe", "The Roots Hold Firm!"),
        ];
    }

    // ── Log Rollup & Compression ─────────────────────────────────────────
    internal static string CompressLog(string[]? rawLines)
    {
        if (rawLines is null || rawLines.Length == 0) return "The seasons turned quietly.";

        var births = 0;
        var predation = 0;
        var ageDeaths = 0;
        var skirmishes = 0;
        var buildings = 0;
        var techUnlocks = 0;
        var notableEvents = new List<string>(rawLines.Length);

        foreach (var raw in rawLines)
        {
            if (string.IsNullOrWhiteSpace(raw)) continue;
            var line = raw.Trim();
            var lower = line.ToLowerInvariant();

            if (lower.Contains("ate") || lower.Contains("drank") || lower.Contains("forag") || lower.Contains("graz"))
            {
                continue;
            }

            if (lower.Contains("born") || lower.Contains("birthed") || lower.Contains("spawned")) { births++; continue; }
            if (lower.Contains("hunted") || lower.Contains("preyed") || lower.Contains("killed by wolf")) { predation++; continue; }
            if (lower.Contains("died of age") || lower.Contains("old age")) { ageDeaths++; continue; }
            if (lower.Contains("war") || lower.Contains("skirmish") || lower.Contains("raid") || lower.Contains("combat")) { skirmishes++; }
            if (lower.Contains("built") || lower.Contains("constructed") || lower.Contains("granary") || lower.Contains("totem") || lower.Contains("hut")) { buildings++; }
            if (lower.Contains("tech") || lower.Contains("researched") || lower.Contains("tier")) { techUnlocks++; }

            notableEvents.Add(line);
        }

        var sb = new StringBuilder();
        sb.Append("Decade Rollup: ")
          .Append(births).Append(" births, ")
          .Append(predation).Append(" predation casualties, ")
          .Append(ageDeaths).Append(" natural deaths, ")
          .Append(buildings).Append(" structures built, ")
          .Append(techUnlocks).Append(" tech discoveries, ")
          .Append(skirmishes).Append(" skirmishes/conflicts. ");

        var notable = notableEvents.TakeLast(15).ToArray();
        if (notable.Length > 0)
        {
            sb.Append("Pivotal milestones: ").Append(string.Join("; ", notable));
        }

        var result = sb.ToString();
        return result.Length > 2000 ? result[..2000] : result;
    }

    // ── Request Hygiene ──────────────────────────────────────────────────
    internal static EcoChronicleRequest Sanitize(EcoChronicleRequest r)
    {
        var log = (r.Log ?? [])
            .Where(l => !string.IsNullOrWhiteSpace(l))
            .Select(l => l.Length > MaxLogLineChars ? l[..MaxLogLineChars] : l)
            .TakeLast(MaxLogLines)
            .ToArray();
        var tribe = new string((r.Tribe ?? "island").Where(char.IsLetterOrDigit).Take(24).ToArray());
        if (tribe.Length == 0) tribe = "island";
        var counts = (r.Counts ?? []).Take(4).Select(c => Math.Max(0, c)).ToArray();
        if (counts.Length < 4) counts = [.. counts, .. new int[4 - counts.Length]];
        var extinct = (r.Extinct ?? []).Take(4).ToArray();
        if (extinct.Length < 4) extinct = [.. extinct, .. new bool[4 - extinct.Length]];
        var from = Math.Max(0, r.FromYear);
        var to = Math.Max(from, r.ToYear);
        var almanac = r.Almanac is null ? null : (r.Almanac.Length > 400 ? r.Almanac[..400] : r.Almanac);
        return new EcoChronicleRequest(r.Seed, from, to, tribe, counts, extinct, log, almanac);
    }

    private static string Fingerprint(EcoChronicleRequest r)
    {
        var text = $"{r.Seed}|{r.FromYear}|{r.ToYear}|{r.Tribe}|{string.Join(',', r.Counts)}|{string.Join('\n', r.Log)}";
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text)))[..32];
    }

    private static readonly string[] SpeciesPlural = ["rabbits", "deer", "wolves", "humans"];

    private static string CountsText(int[] counts)
        => string.Join(", ", counts.Select((c, i) => $"{c} {SpeciesPlural[i]}"));

    private static string ExtinctText(bool[] extinct)
    {
        var gone = extinct.Select((e, i) => e ? SpeciesPlural[i] : null).Where(s => s is not null).ToArray();
        return gone.Length == 0 ? "" : $"Extinct: {string.Join(", ", gone)}. ";
    }

    // ── Schemas ──────────────────────────────────────────────────────────
    public static JsonElement ChronicleSchema { get; } = JsonDocument.Parse(
        """
        {
          "type": "object",
          "properties": {
            "title": { "type": "string" },
            "saga": { "type": "string" },
            "epigraph": { "type": "string" }
          },
          "required": ["title", "saga", "epigraph"],
          "additionalProperties": false
        }
        """).RootElement.Clone();

    public static JsonElement BatchThoughtSchema { get; } = JsonDocument.Parse(
        """
        {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": { "type": "integer" },
              "thought": { "type": "string" },
              "trait": { "type": "string" },
              "delta": { "type": "number" }
            },
            "required": ["id", "thought", "trait", "delta"],
            "additionalProperties": false
          }
        }
        """).RootElement.Clone();

    public static JsonElement TreatySchema { get; } = JsonDocument.Parse(
        """
        {
          "type": "object",
          "properties": {
            "title": { "type": "string" },
            "narrative": { "type": "string" },
            "action": { "type": "string" },
            "demandedResource": { "type": "string" },
            "resourceAmount": { "type": "integer" },
            "peaceYears": { "type": "integer" }
          },
          "required": ["title", "narrative", "action", "demandedResource", "resourceAmount", "peaceYears"],
          "additionalProperties": false
        }
        """).RootElement.Clone();

    public static JsonElement MilestoneLoreSchema { get; } = JsonDocument.Parse(
        """
        {
          "type": "object",
          "properties": {
            "epithet": { "type": "string" },
            "oralLegend": { "type": "string" }
          },
          "required": ["epithet", "oralLegend"],
          "additionalProperties": false
        }
        """).RootElement.Clone();

    // ── Parsers ──────────────────────────────────────────────────────────
    internal static EcoChronicle? ParseChronicle(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        var start = text.IndexOf('{');
        var end = text.LastIndexOf('}');
        if (start < 0 || end <= start) return null;
        try
        {
            using var doc = JsonDocument.Parse(text[start..(end + 1)]);
            var root = doc.RootElement;
            var title = Clip(root.TryGetProperty("title", out var t) ? t.GetString() : null, TitleMaxChars);
            var saga = Clip(root.TryGetProperty("saga", out var s) ? s.GetString() : null, SagaMaxChars);
            var epigraph = Clip(root.TryGetProperty("epigraph", out var e) ? e.GetString() : null, EpigraphMaxChars);
            if (string.IsNullOrWhiteSpace(saga)) return null;
            return new EcoChronicle(string.IsNullOrWhiteSpace(title) ? "The island" : title, saga, epigraph, Mock: false, DateTimeOffset.UtcNow);
        }
        catch (JsonException) { return null; }
    }

    internal static EcoThoughtBatchReply? ParseBatchThoughts(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        var start = text.IndexOf('[');
        var end = text.LastIndexOf(']');
        if (start < 0 || end <= start) return null;
        try
        {
            using var doc = JsonDocument.Parse(text[start..(end + 1)]);
            if (doc.RootElement.ValueKind != JsonValueKind.Array) return null;
            var list = new List<EcoThoughtItemResult>();
            foreach (var elem in doc.RootElement.EnumerateArray())
            {
                var id = elem.TryGetProperty("id", out var pId) ? pId.GetInt32() : 0;
                var thought = elem.TryGetProperty("thought", out var pT) ? pT.GetString() ?? "" : "";
                var trait = elem.TryGetProperty("trait", out var pTr) ? pTr.GetString() ?? "diligence" : "diligence";
                var delta = elem.TryGetProperty("delta", out var pD) ? (float)pD.GetDouble() : 0.05f;
                list.Add(new EcoThoughtItemResult(id, thought, trait, Math.Clamp(delta, -0.25f, 0.25f)));
            }
            return new EcoThoughtBatchReply(list, Mock: false);
        }
        catch (JsonException) { return null; }
    }

    internal static EcoTreatyReply? ParseTreaty(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        var start = text.IndexOf('{');
        var end = text.LastIndexOf('}');
        if (start < 0 || end <= start) return null;
        try
        {
            using var doc = JsonDocument.Parse(text[start..(end + 1)]);
            var root = doc.RootElement;
            var title = Clip(root.TryGetProperty("title", out var t) ? t.GetString() : null, TitleMaxChars);
            var narrative = Clip(root.TryGetProperty("narrative", out var n) ? n.GetString() : null, 400);
            var action = Clip(root.TryGetProperty("action", out var a) ? a.GetString() : null, 40);
            var res = Clip(root.TryGetProperty("demandedResource", out var dr) ? dr.GetString() : null, 40);
            var amount = root.TryGetProperty("resourceAmount", out var ra) ? ra.GetInt32() : 0;
            var years = root.TryGetProperty("peaceYears", out var py) ? py.GetInt32() : 3;

            return new EcoTreatyReply(
                string.IsNullOrWhiteSpace(title) ? "Tribal Concordat" : title,
                string.IsNullOrWhiteSpace(narrative) ? "An agreement was forged between the clans." : narrative,
                string.IsNullOrWhiteSpace(action) ? "PeaceTreaty" : action,
                string.IsNullOrWhiteSpace(res) ? "None" : res,
                Math.Clamp(amount, 0, 200),
                Math.Clamp(years, 1, 10),
                Mock: false);
        }
        catch (JsonException) { return null; }
    }

    internal static EcoMilestoneLoreReply? ParseLore(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        var start = text.IndexOf('{');
        var end = text.LastIndexOf('}');
        if (start < 0 || end <= start) return null;
        try
        {
            using var doc = JsonDocument.Parse(text[start..(end + 1)]);
            var root = doc.RootElement;
            var epithet = Clip(root.TryGetProperty("epithet", out var ep) ? ep.GetString() : null, 80);
            var legend = Clip(root.TryGetProperty("oralLegend", out var ol) ? ol.GetString() : null, 400);

            return new EcoMilestoneLoreReply(
                string.IsNullOrWhiteSpace(epithet) ? "The Great Event" : epithet,
                string.IsNullOrWhiteSpace(legend) ? "And so the island changed forever." : legend,
                Mock: false);
        }
        catch (JsonException) { return null; }
    }

    private static string Clip(string? s, int max)
    {
        var v = (s ?? string.Empty).Trim();
        return v.Length > max ? v[..max] : v;
    }

    // ── Mocks ────────────────────────────────────────────────────────────
    internal static EcoChronicle MockChronicle(EcoChronicleRequest r)
    {
        var compressed = CompressLog(r.Log);
        var saga = $"In the years {r.FromYear} to {r.ToYear} the {r.Tribe} tribe kept to its village while the island went about its business. " +
                   $"{compressed} " +
                   $"When the decade closed there were {CountsText(r.Counts)} on the island.{(ExtinctText(r.Extinct).Length > 0 ? " " + ExtinctText(r.Extinct).Trim() : "")}";
        if (saga.Length > SagaMaxChars) saga = saga[..SagaMaxChars];
        return new EcoChronicle($"The {r.Tribe} years, {r.FromYear}–{r.ToYear}", saga, "Written by no one in particular.", Mock: true, DateTimeOffset.UtcNow);
    }

    private static readonly string[] MockTraits = ["boldness", "sociability", "curiosity", "greed", "diligence"];
    private static readonly string[] MockLines =
    [
        "The wind carries something I cannot name.", "I will keep to the others today.", "What lies past the far shore?",
        "Mine, before anyone else gets there.", "There is work in this before dark.",
    ];

    internal static string MockThought(string prompt)
    {
        var h = 0;
        foreach (var c in prompt) h = unchecked(h * 31 + c);
        var k = Math.Abs(h) % MockTraits.Length;
        return $"{{\"thought\": \"{MockLines[k]}\", \"trait\": \"{MockTraits[k]}\", \"delta\": 0.05}}";
    }

    internal static EcoThoughtBatchReply MockBatchThought(EcoThoughtBatchRequest request)
    {
        var results = new List<EcoThoughtItemResult>();
        foreach (var item in request.Items ?? [])
        {
            var h = Math.Abs((item.Id * 31) ^ (item.Name ?? string.Empty).GetHashCode());
            var trait = MockTraits[h % MockTraits.Length];
            var line = MockLines[h % MockLines.Length];
            var thought = $"{item.Name}: {line}";
            results.Add(new EcoThoughtItemResult(item.Id, thought, trait, 0.05f));
        }
        return new EcoThoughtBatchReply(results, Mock: true);
    }

    internal static EcoTreatyReply MockTreaty(EcoTreatyRequest request)
    {
        var a = request.TribeA?.Name ?? "Amber Clan";
        var b = request.TribeB?.Name ?? "Cobalt Clan";
        var title = $"Pact of {a} and {b}";
        var narrative = $"The elders of {a} and {b} convene under the ancient totem to resolve: {request.Reason}. An armistice is sealed with gifts.";
        return new EcoTreatyReply(title, narrative, "PeaceTreaty", "Food", 30, 3, Mock: true);
    }

    internal static EcoMilestoneLoreReply MockLore(EcoMilestoneLoreRequest request)
    {
        var epithet = $"The Epoch of {request.MilestoneType}";
        var legend = $"In Year {request.Year}, the {request.TribeName} accomplished {request.Details}. The sacred totems commemorate their triumph.";
        return new EcoMilestoneLoreReply(epithet, legend, Mock: true);
    }
}
