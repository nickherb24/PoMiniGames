using PoMiniGames.Shared.Games.PoJoker;

namespace PoMiniGames.Features.PoJoker;

/// <summary>
/// Abstraction over the JokeAPI external HTTP service.
/// Repository pattern (GoF): isolates the data-access concern of fetching jokes.
/// </summary>
public interface IJokeApiClient
{
    Task<JokeDto> FetchJokeAsync(
        bool safeMode = false,
        IEnumerable<int>? excludeIds = null,
        string category = "Any",
        CancellationToken cancellationToken = default);
}

/// <summary>Service contract for AI joke analysis and punchline prediction.</summary>
public interface IAnalysisService
{
    Task<(JokeAnalysisDto Analysis, JokeRatingDto Rating)> AnalyzeJokeAsync(
        JokeDto joke,
        CancellationToken cancellationToken = default);
}
