using System.Text.Json.Serialization;
using PoMiniGames.Shared.Games;

namespace PoMiniGamesClient.Games.PoCabinet;

/// <summary>
/// Source-generated <see cref="JsonSerializerContext"/> for PoCabinet's localStorage
/// payloads. Avoids the reflection-based serializer (which the trim analyzer rejects
/// with IL2026) and is the only serializer path PoCabinetCareerState uses.
/// </summary>
[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    PropertyNameCaseInsensitive = true,
    UseStringEnumConverter = true)]
[JsonSerializable(typeof(PoCabinetCareerDto))]
[JsonSerializable(typeof(PoCabinetUiSettings))]
internal sealed partial class PoCabinetJsonContext : JsonSerializerContext;
