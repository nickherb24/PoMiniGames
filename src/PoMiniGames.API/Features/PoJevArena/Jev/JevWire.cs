using System.Text.Json.Serialization;

namespace PoMiniGames.Features.PoJevArena.Jev;

// Wire shapes for POST {Endpoint}{Path} (OpenRouter System One), per the
// OpenRouter API reference. Property names are Jev's contract (snake_case where it uses it) and
// must not be renamed by a naming policy.

internal sealed record JevWireRequest(
    [property: JsonPropertyName("model")] string Model,
    [property: JsonPropertyName("state")] string State,
    [property: JsonPropertyName("questions")] IReadOnlyDictionary<string, JevWireQuestion> Questions,
    [property: JsonPropertyName("session_id")] string SessionId,
    [property: JsonPropertyName("user")] string User);

internal sealed record JevWireQuestion(
    [property: JsonPropertyName("type")] string Type,
    [property: JsonPropertyName("instructions")] string Instructions,
    [property: JsonPropertyName("criteria")] IReadOnlyDictionary<string, string> Criteria);

internal sealed class JevWireResponse
{
    [JsonPropertyName("answers")]
    public Dictionary<string, JevWireAnswer>? Answers { get; set; }

    [JsonPropertyName("usage")]
    public JevWireUsage? Usage { get; set; }
}

internal sealed class JevWireAnswer
{
    [JsonPropertyName("type")]
    public string? Type { get; set; }

    [JsonPropertyName("choice")]
    public string? Choice { get; set; }

    [JsonPropertyName("noul")]
    public double? Noul { get; set; }

    [JsonPropertyName("confidence")]
    public double? Confidence { get; set; }

    [JsonPropertyName("probabilities")]
    public Dictionary<string, double>? Probabilities { get; set; }
}

internal sealed class JevWireUsage
{
    [JsonPropertyName("input_tokens")]
    public long InputTokens { get; set; }

    [JsonPropertyName("output_tokens")]
    public long OutputTokens { get; set; }

    [JsonPropertyName("cost")]
    public double? Cost { get; set; }
}

[JsonSourceGenerationOptions(NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals)]
[JsonSerializable(typeof(JevWireRequest))]
[JsonSerializable(typeof(JevWireResponse))]
internal sealed partial class JevWireJsonContext : JsonSerializerContext
{
}
