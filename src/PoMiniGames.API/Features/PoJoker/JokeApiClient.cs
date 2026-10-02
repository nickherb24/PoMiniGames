using System.Text.Json;
using System.Text.Json.Serialization;
using PoMiniGames.Shared.Games.PoJoker;

namespace PoMiniGames.Features.PoJoker;

/// <summary>
/// HTTP client for fetching jokes from JokeAPI.dev. Supports safe mode filtering.
/// Adapter pattern (GoF): adapts JokeAPI's HTTP contract to <see cref="IJokeApiClient"/>.
/// Registered as a typed client via IHttpClientFactory with the standard resilience handler.
/// </summary>
public sealed class JokeApiClient(HttpClient httpClient, ILogger<JokeApiClient> logger) : IJokeApiClient
{
    /// <summary>Named HTTP client registered in <c>GameServicesExtensions</c>.</summary>
    public const string HttpClientName = "PoJokerJokeApi";

    private readonly HttpClient _httpClient = httpClient;
    private readonly ILogger<JokeApiClient> _logger = logger;
    private const string BaseUrl = "https://v2.jokeapi.dev/joke";

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    public async Task<JokeDto> FetchJokeAsync(
        bool safeMode = false,
        IEnumerable<int>? excludeIds = null,
        string category = "Any",
        CancellationToken cancellationToken = default)
    {
        var url = BuildUrl(safeMode, category);
        _logger.LogDebug("Fetching joke from {Url}", url);

        var response = await _httpClient.GetAsync(url, cancellationToken);
        response.EnsureSuccessStatusCode();

        var content = await response.Content.ReadAsStringAsync(cancellationToken);
        var jokeResponse = JsonSerializer.Deserialize<JokeApiResponse>(content, JsonOptions);

        if (jokeResponse is null || jokeResponse.Error)
        {
            throw new InvalidOperationException($"JokeAPI returned error: {jokeResponse?.Message ?? "Unknown error"}");
        }

        return new JokeDto
        {
            Id = jokeResponse.Id,
            Category = jokeResponse.Category ?? "Unknown",
            Type = jokeResponse.Type ?? "twopart",
            Setup = jokeResponse.Setup ?? string.Empty,
            Punchline = jokeResponse.Delivery ?? string.Empty,
            SafeMode = safeMode,
            Flags = new JokeFlags
            {
                Nsfw = jokeResponse.Flags?.Nsfw ?? false,
                Religious = jokeResponse.Flags?.Religious ?? false,
                Political = jokeResponse.Flags?.Political ?? false,
                Racist = jokeResponse.Flags?.Racist ?? false,
                Sexist = jokeResponse.Flags?.Sexist ?? false,
                Explicit = jokeResponse.Flags?.Explicit ?? false
            }
        };
    }

    private static string BuildUrl(bool safeMode, string category = "Any")
    {
        var safeCategory = string.IsNullOrWhiteSpace(category) ? "Any" : category;
        var url = $"{BaseUrl}/{safeCategory}?type=twopart";

        if (safeMode)
        {
            url += "&safe-mode";
        }
        else
        {
            // Dark and crude are the act; jokes that target a group are not. These are also
            // the ones the AI jester's content filter refuses, which left the show with a
            // joke on screen and nothing to say about it.
            url += "&blacklistFlags=racist,sexist,religious";
        }

        // Note: JokeAPI does not support excluding specific joke IDs via API.
        // Exclusion is handled at the application level (the endpoint re-fetches if needed).
        return url;
    }

    private sealed record JokeApiResponse
    {
        public bool Error { get; init; }
        public string? Message { get; init; }
        public int Id { get; init; }
        public string? Category { get; init; }
        public string? Type { get; init; }
        public string? Setup { get; init; }
        public string? Delivery { get; init; }
        public JokeApiFlags? Flags { get; init; }
    }

    private sealed record JokeApiFlags
    {
        public bool Nsfw { get; init; }
        public bool Religious { get; init; }
        public bool Political { get; init; }
        public bool Racist { get; init; }
        public bool Sexist { get; init; }
        public bool Explicit { get; init; }
    }
}
