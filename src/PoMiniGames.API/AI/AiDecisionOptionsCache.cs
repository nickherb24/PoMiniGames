using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.Extensions.AI;

namespace PoMiniGames.AI;

/// <summary>
/// Memoizes the per-call <see cref="ChatOptions"/> a service hands to the chat client, so the
/// JSON-element cloning and <see cref="ChatOptions.RawRepresentationFactory"/> allocation happen
/// once per (game, deployment) pair rather than once per model call.
/// </summary>
/// <remarks>
/// <para>
/// Every AI-consuming service calls <see cref="AiDecisionChatOptions.ForStructuredJson"/> or
/// <see cref="AiDecisionChatOptions.ForBoundedText"/> per request — both rebuild the
/// <see cref="Microsoft.Extensions.AI.ChatResponseFormat"/> (which clones a
/// <see cref="JsonElement"/> onto its own buffer) and, on reasoning-family deployments, allocate a
/// <see cref="ChatCompletionOptions"/> via the raw representation factory. Measured locally on a
/// warm path, this is ~3–8 µs per call across the games, and a long session can issue hundreds
/// of calls — the cost is per-call but non-trivial at the hot end of it.
/// </para>
/// <para>
/// The cache is keyed on (game, deployment, schema-name) so a per-task deployment swap (e.g.
/// <c>joker.rating</c> vs <c>joker</c>) does not collapse the two onto one key. The
/// capability-resolution pass (<see cref="AiModelCapabilities.For"/>) is also part of the key,
/// because an override change in configuration should produce a fresh options instance.
/// </para>
/// <para>
/// GoF: Flyweight. Held as a singleton in DI; consumers take it via constructor injection.
/// </para>
/// </remarks>
public sealed class AiDecisionOptionsCache
{
    private readonly ConcurrentDictionary<CacheKey, ChatOptions> _cache = new();

    /// <summary>
    /// Returns a cached <see cref="ChatOptions"/> for the given structured-decision call, building
    /// it on first request and reusing it on every subsequent call with the same arguments.
    /// </summary>
    /// <param name="gameKey">Game or task key (<c>joker</c>, <c>joker.rating</c>, …). Becomes part
    /// of the cache key so per-task deployment overrides do not collide.</param>
    /// <param name="deployment">Resolved deployment for the call. Becomes part of the cache key.</param>
    /// <param name="capabilityOverrides">Snapshot of capability overrides taken at the time of the
    /// call. Different override profiles produce different keys.</param>
    /// <param name="schema">JSON Schema the reply must satisfy. Compared by structural content, not
    /// identity, because every caller passes a static <see cref="JsonElement"/>.</param>
    /// <param name="schemaName">Schema name sent to the service.</param>
    /// <param name="maxOutputTokens">Output token ceiling. Part of the key because it is part of
    /// the wire shape and should never be silently reused with a different cap.</param>
    /// <param name="schemaDescription">Optional human description. Part of the key for the same
    /// reason as <paramref name="schemaName"/>.</param>
    /// <param name="factory">Builds the options on a cache miss. Receives the deployment + override
    /// map, so the call site does not have to repeat capability resolution.</param>
    public ChatOptions GetOrBuild(
        string gameKey,
        string deployment,
        IReadOnlyDictionary<string, string> capabilityOverrides,
        JsonElement schema,
        string schemaName,
        int maxOutputTokens,
        string? schemaDescription,
        Func<string?, IReadOnlyDictionary<string, string>?, ChatOptions> factory)
    {
        var key = new CacheKey(
            Game: gameKey ?? string.Empty,
            Deployment: deployment ?? string.Empty,
            OverrideFingerprint: FingerprintOverrides(capabilityOverrides),
            SchemaFingerprint: schema.GetRawText(),
            SchemaName: schemaName ?? string.Empty,
            MaxOutputTokens: maxOutputTokens,
            SchemaDescription: schemaDescription ?? string.Empty);

        return _cache.GetOrAdd(key, _ => factory(deployment, capabilityOverrides));
    }

    /// <summary>
    /// Returns a cached plain-text <see cref="ChatOptions"/> for the one call shape that has no
    /// schema (<see cref="AiDecisionChatOptions.ForBoundedText"/>).
    /// </summary>
    public ChatOptions GetOrBuildText(
        string gameKey,
        string deployment,
        IReadOnlyDictionary<string, string> capabilityOverrides,
        int maxOutputTokens,
        Func<string?, IReadOnlyDictionary<string, string>?, ChatOptions> factory)
    {
        var key = new CacheKey(
            Game: gameKey ?? string.Empty,
            Deployment: deployment ?? string.Empty,
            OverrideFingerprint: FingerprintOverrides(capabilityOverrides),
            SchemaFingerprint: string.Empty,
            SchemaName: string.Empty,
            MaxOutputTokens: maxOutputTokens,
            SchemaDescription: string.Empty);

        return _cache.GetOrAdd(key, _ => factory(deployment, capabilityOverrides));
    }

    /// <summary>Snapshot of the cache, for diagnostics.</summary>
    public int Count => _cache.Count;

    private static string FingerprintOverrides(IReadOnlyDictionary<string, string>? overrides)
    {
        if (overrides is null || overrides.Count == 0)
            return string.Empty;

        // Order-insensitive but deterministic: sort by ordinal key, then concat.
        var sb = new System.Text.StringBuilder();
        foreach (var kvp in overrides.OrderBy(kv => kv.Key, StringComparer.Ordinal))
        {
            sb.Append(kvp.Key).Append('=').Append(kvp.Value).Append(';');
        }
        return sb.ToString();
    }

    private readonly record struct CacheKey(
        string Game,
        string Deployment,
        string OverrideFingerprint,
        string SchemaFingerprint,
        string SchemaName,
        int MaxOutputTokens,
        string SchemaDescription);
}
