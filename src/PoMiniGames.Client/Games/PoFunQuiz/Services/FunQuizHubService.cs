using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.SignalR.Client;
using PoMiniGamesClient.Services.Auth;
using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;
using Microsoft.Extensions.Configuration;

namespace PoMiniGamesClient.Games.PoFunQuiz.Services;

// ── Wire-format records (mirror server contracts) ──────────────────────────

public record FunQuizPlayerStateDto(string Name, int Score, int Streak);

public record FunQuizGameStateDto(
    string GameId,
    string HostName,
    string State,
    List<FunQuizPlayerStateDto> Players,
    List<FunQuizQuestionDto> Questions,
    int CurrentQuestionIndex,
    string Category,
    int SecondsPerQuestion);

public record FunQuizQuestionDto(
    string Text,
    List<string> Options,
    int CorrectOptionIndex,
    string Category,
    int BasePoints);

public record FunQuizScoreUpdateDto(string GameId, string PlayerName, int TotalScore, int Streak, int MaxStreak);

public record FunQuizPlayerFinishedQuestionDto(string GameId, string PlayerName, int FinishedCount, int TotalPlayers);

public record FunQuizGameFinishedDto(string GameId, IReadOnlyDictionary<string, int> FinalScores, FunQuizPlayerStateDto? Winner, bool IsTie);

public record FunQuizLobbyPlayerJoinedDto(string GameId, string PlayerName, List<string> Players);

public record FunQuizLobbyErrorDto(string GameCode, string Message);

/// <summary>
/// Client-side wrapper over <c>/funquiz/gamehub</c>. Two-player SignalR trivia:
/// JoinLobby → StartGame → UpdateScore loop → PlayerFinished → GameFinished.
/// </summary>
/// <remarks>
/// There are no game codes: <c>JoinLobby</c> seats you in the one open lobby
/// and the server tracks which game you are in by connection, so nothing downstream needs
/// a game id. <c>GameId</c> stays on the payload records purely as the server's correlation
/// value — the UI does not show it and never sends it back.
/// </remarks>
public sealed class FunQuizHubService : IAsyncDisposable
{
    private readonly NavigationManager _navigation;
    private readonly IConfiguration _configuration;
    private readonly ApiEndpoints _endpoints;
    private HubConnection? _connection;

    public event Action<FunQuizGameStateDto>? OnGameCreated;
    public event Action<FunQuizGameStateDto>? OnGameJoined;
    public event Action<FunQuizGameStateDto>? OnGameUpdated;
    public event Action<FunQuizGameStateDto>? OnGameStarted;
    public event Action<FunQuizScoreUpdateDto>? OnScoreUpdated;
    public event Action<FunQuizLobbyPlayerJoinedDto>? OnPlayerJoined;
    public event Action<FunQuizPlayerFinishedQuestionDto>? OnPlayerFinishedQuestion;
    public event Action<FunQuizGameFinishedDto>? OnGameFinished;
    public event Action<FunQuizLobbyErrorDto>? OnLobbyError;

    // Connection lifecycle events (consumed by the page to render a
    // "Reconnecting…" banner so players know the lobby is healing, not dead).
    public event Action<Exception?>? OnReconnecting;
    public event Action<string?>? OnReconnected;
    public event Action<Exception?>? OnClosed;

    public bool IsReconnecting { get; private set; }

    // Trim-safe config read. IConfiguration.GetValue<T> is annotated
    // RequiresUnreferencedCode; we only need a bool here so a direct index
    // lookup + TryParse avoids the warning under PublishTrimmed=true.
    private bool ReadForceSkipWebSockets()
    {
        var raw = _configuration["PoMiniGames:FunQuiz:ForceSkipWebSockets"];
        return bool.TryParse(raw, out var skip) && skip;
    }

    public FunQuizHubService(NavigationManager navigation, IConfiguration configuration, ApiEndpoints endpoints)
    {
        _navigation = navigation;
        _configuration = configuration;
        _endpoints = endpoints;
    }

    public async Task ConnectAsync()
    {
        if (_connection is not null && _connection.State != HubConnectionState.Disconnected) return;
        // Absolute URL: SignalR ignores the DI HttpClient BaseAddress, so we
        // compose against ApiEndpoints.ApiBase — the API host (:5000), not the
        // WASM host (:5261). Without this, the standalone client hits
        // /funquiz/gamehub/negotiate on :5261 and gets a 405.
        var url = _endpoints.Hub("funquiz/gamehub");
        // Credentials handler + auto-reconnect come baked into the shared
        // factory (see HubConnectionFactory for the cookie contract).
        //
        // Dev-box quirk: on this dev machine the WebSocket upgrade
        // through `UseResponseCompression` takes 30-60s to complete (one full
        // reload cycle per handshake), which makes 2-player testing brittle —
        // the host's connection can drop before the second player finishes
        // negotiating and the lobby state goes stale. Setting
        // `PoMiniGames:FunQuiz:ForceSkipWebSockets=true` in appsettings restricts
        // the client to ServerSentEvents / LongPolling, which establish in <1s
        // and are functionally identical for our bidirectional invoke + push
        // pattern. Production should keep the default (WS preferred).
        var transports = ReadForceSkipWebSockets()
            ? HttpTransportType.ServerSentEvents | HttpTransportType.LongPolling
            : (HttpTransportType?)null;
        _connection = HubConnectionFactory.Create(url, transports,
            [TimeSpan.FromSeconds(0), TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(3), TimeSpan.FromSeconds(5)]);
        _connection.On<FunQuizGameStateDto>("GameCreated", p => OnGameCreated?.Invoke(p));
        _connection.On<FunQuizGameStateDto>("GameJoined", p => OnGameJoined?.Invoke(p));
        _connection.On<FunQuizGameStateDto>("GameUpdated", p => OnGameUpdated?.Invoke(p));
        _connection.On<FunQuizGameStateDto>("GameStarted", p => OnGameStarted?.Invoke(p));
        _connection.On<FunQuizScoreUpdateDto>("ScoreUpdated", p => OnScoreUpdated?.Invoke(p));
        _connection.On<FunQuizLobbyPlayerJoinedDto>("PlayerJoined", p => OnPlayerJoined?.Invoke(p));
        _connection.On<FunQuizPlayerFinishedQuestionDto>("PlayerFinishedQuestion", p => OnPlayerFinishedQuestion?.Invoke(p));
        _connection.On<FunQuizGameFinishedDto>("GameFinished", p => OnGameFinished?.Invoke(p));
        _connection.On<FunQuizLobbyErrorDto>("LobbyError", p => OnLobbyError?.Invoke(p));

        // Surface reconnect lifecycle so the UI can show a "Reconnecting…"
        // banner instead of leaving the player staring at a dead lobby.
        _connection.Reconnecting += ex =>
        {
            OnReconnecting?.Invoke(ex);
            return Task.CompletedTask;
        };
        _connection.Reconnected += id =>
        {
            OnReconnected?.Invoke(id);
            return Task.CompletedTask;
        };
        _connection.Closed += ex =>
        {
            OnClosed?.Invoke(ex);
            return Task.CompletedTask;
        };
        await _connection.StartAsync();
    }

    /// <summary>Join the one open lobby (opening it if empty). Category applies only if you open it.</summary>
    public Task JoinLobby(string playerName, string category, int questionCount = 10)
    {
        EnsureConnected();
        return _connection!.InvokeAsync("JoinLobby", playerName, category, questionCount);
    }

    public Task StartGame()
    {
        EnsureConnected();
        return _connection!.InvokeAsync("StartGame");
    }

    public Task UpdateScore(bool isCorrect, double speedMultiplier, int secondsRemaining)
    {
        EnsureConnected();
        return _connection!.InvokeAsync("UpdateScore", isCorrect, speedMultiplier, secondsRemaining);
    }

    public Task PlayerFinished()
    {
        EnsureConnected();
        return _connection!.InvokeAsync("PlayerFinished");
    }

    public Task AdvanceQuestion()
    {
        EnsureConnected();
        return _connection!.InvokeAsync("AdvanceQuestion");
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
        if (_connection is not null) await _connection.DisposeAsync();
    }
}
