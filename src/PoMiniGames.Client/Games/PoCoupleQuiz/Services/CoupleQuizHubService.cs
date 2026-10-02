using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.SignalR.Client;
using PoMiniGamesClient.Services.Auth;
using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGamesClient.Games.PoCoupleQuiz.Services;

/// <summary>
/// Strongly-typed mirror of the PoCoupleQuiz server contracts. Lives in the client
/// project so the WASM doesn't depend on the host's types. Field shapes match the
/// server payloads exactly (camelCase via JSON).
/// </summary>
/// <remarks>
/// The payloads carry no game code, AI mode or difficulty: there is one lobby per server,
/// so a code names nothing, and the round count is sent as <c>MaxRounds</c>.
/// </remarks>
public record CoupleQuizGamePlayerState(string Name, bool IsKingPlayer, int Score);

public record CoupleQuizLobbyEventPayload(
    bool IsHost,
    string PlayerName,
    List<string> Players,
    List<string> ReadyPlayers,
    string HostName,
    int MaxRounds);

public record CoupleQuizLobbyUpdatedPayload(
    List<string> Players,
    List<string> ReadyPlayers,
    string HostName,
    int MaxRounds);

public record CoupleQuizGameStartedPayload(
    string KingPlayerName,
    List<CoupleQuizGamePlayerState> Players,
    string QuestionText,
    string QuestionCategory,
    int RoundIndex,
    int MaxRounds,
    int RoundSeconds);

public record CoupleQuizRoundStartedPayload(
    int RoundIndex,
    int MaxRounds,
    string KingPlayerName,
    List<CoupleQuizGamePlayerState> Players,
    string QuestionText,
    string QuestionCategory,
    int RoundSeconds);

public record CoupleQuizAnswerRecordedPayload(string PlayerName, int RoundIndex);

public record CoupleQuizRoundResultPayload(
    int RoundIndex,
    string KingAnswer,
    List<string> MatchedPlayers,
    Dictionary<string, int> Scores,
    Dictionary<string, string> PlayerAnswers,
    List<CoupleQuizGamePlayerState> Players);

public record CoupleQuizGameOverPayload(
    IReadOnlyDictionary<string, int> FinalScores,
    List<CoupleQuizGamePlayerState> Players);

/// <summary>
/// Client-side wrapper around the <c>/couplequiz/hubs/game</c> SignalR connection.
/// Exposes the server events as C# events for the page to subscribe to. The page
/// should call <see cref="ConnectAsync"/> on init, then <see cref="JoinAsync"/>
/// once a name is known.
/// </summary>
public sealed class CoupleQuizHubService : IAsyncDisposable
{
    private readonly NavigationManager _navigation;
    private readonly ApiEndpoints _endpoints;
    private HubConnection? _connection;

    /// <summary>
    /// The most recent <c>GameStarted</c> payload, buffered so the game page can
    /// initialise from it. The lobby page consumes the live event to navigate to
    /// <c>/couplequiz/game</c>; by the time that page mounts and subscribes, the
    /// live event has already fired — so it reads this buffer instead. Cleared on
    /// game-over so a stale game can't leak into the next lobby session.
    /// </summary>
    public CoupleQuizGameStartedPayload? LastGameStarted { get; private set; }

    public event Action<CoupleQuizLobbyEventPayload>? OnLobbyJoined;
    public event Action<CoupleQuizLobbyUpdatedPayload>? OnLobbyUpdated;
    public event Action<string>? OnLobbyError;
    public event Action<CoupleQuizGameStartedPayload>? OnGameStarted;
    public event Action<CoupleQuizRoundStartedPayload>? OnRoundStarted;
    public event Action<CoupleQuizAnswerRecordedPayload>? OnAnswerRecorded;
    public event Action<CoupleQuizRoundResultPayload>? OnRoundResult;
    public event Action<CoupleQuizGameOverPayload>? OnGameOver;
    public event Action<string>? OnGameError;
    public event Action<CoupleQuizLobbyUpdatedPayload>? OnPlayerDisconnected;

    public CoupleQuizHubService(NavigationManager navigation, ApiEndpoints endpoints) =>
        (_navigation, _endpoints) = (navigation, endpoints);

    public async Task ConnectAsync()
    {
        if (_connection is not null) return;
        // Absolute URL: SignalR ignores the DI HttpClient BaseAddress, so we
        // compose against ApiEndpoints.ApiBase — the API host (:5000), not the
        // WASM host (:5261). Without this, the standalone client hits
        // /couplequiz/hubs/game/negotiate on :5261 and gets a 405.
        // Credentials handler + auto-reconnect come baked into the shared
        // factory (see HubConnectionFactory for the cookie contract).
        _connection = HubConnectionFactory.Create(_endpoints.Hub("couplequiz/hubs/game"));

        _connection.On<CoupleQuizLobbyEventPayload>("LobbyJoined", p => OnLobbyJoined?.Invoke(p));
        _connection.On<CoupleQuizLobbyUpdatedPayload>("LobbyUpdated", p => OnLobbyUpdated?.Invoke(p));
        _connection.On<string>("LobbyError", m => OnLobbyError?.Invoke(m));
        _connection.On<CoupleQuizGameStartedPayload>("GameStarted", p =>
        {
            // Buffer first, THEN raise — the game page reads the buffer on mount.
            LastGameStarted = p;
            OnGameStarted?.Invoke(p);
        });
        _connection.On<CoupleQuizRoundStartedPayload>("RoundStarted", p => OnRoundStarted?.Invoke(p));
        _connection.On<CoupleQuizAnswerRecordedPayload>("AnswerRecorded", p => OnAnswerRecorded?.Invoke(p));
        _connection.On<CoupleQuizRoundResultPayload>("RoundResult", p => OnRoundResult?.Invoke(p));
        _connection.On<CoupleQuizGameOverPayload>("GameOver", p =>
        {
            LastGameStarted = null; // don't let a finished game re-hydrate a new page
            OnGameOver?.Invoke(p);
        });
        _connection.On<string>("GameError", m => OnGameError?.Invoke(m));
        _connection.On<CoupleQuizLobbyUpdatedPayload>("PlayerDisconnected", p => OnPlayerDisconnected?.Invoke(p));

        await _connection.StartAsync();
    }

    public Task JoinAsync(string playerName)
    {
        EnsureConnected();
        return _connection!.InvokeAsync("Join", playerName);
    }

    public Task SetReadyAsync()
    {
        EnsureConnected();
        return _connection!.InvokeAsync("SetReady");
    }

    /// <summary>Host-only; the server ignores it from anyone else.</summary>
    public Task SetRoundsAsync(int rounds)
    {
        EnsureConnected();
        return _connection!.InvokeAsync("SetRounds", rounds);
    }

    public Task SubmitAnswerAsync(string answer)
    {
        EnsureConnected();
        return _connection!.InvokeAsync("SubmitAnswer", answer);
    }

    private void EnsureConnected()
    {
        if (_connection is null || _connection.State != HubConnectionState.Connected)
        {
            throw new InvalidOperationException("Hub connection is not active. Call ConnectAsync first.");
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_connection is not null)
        {
            await _connection.DisposeAsync();
        }
    }
}
