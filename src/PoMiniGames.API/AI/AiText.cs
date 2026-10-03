using System.Text.Json;

namespace PoMiniGames.AI;

/// <summary>
/// Small text helpers every AI-backed slice needs when reading a model's reply.
/// </summary>
internal static class AiText
{
    /// <summary>
    /// Parses the first JSON object in the reply, or null. Tolerant of prose around it:
    /// unnecessary for a schema-constrained provider, but the JSON-object-mode fallback
    /// (models with no json_schema support) can still wrap the object in a sentence.
    /// </summary>
    public static JsonDocument? TryExtractJson(string? raw)
    {
        var start = raw?.IndexOf('{') ?? -1;
        var end = raw?.LastIndexOf('}') ?? -1;
        if (raw is null || start < 0 || end <= start)
            return null;

        try
        {
            return JsonDocument.Parse(raw[start..(end + 1)]);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>A reply shortened for a log line; "(empty)" when there was none.</summary>
    public static string Truncate(string? text, int max)
        => string.IsNullOrEmpty(text) ? "(empty)"
         : text.Length <= max ? text
         : text[..max] + "…";
}
