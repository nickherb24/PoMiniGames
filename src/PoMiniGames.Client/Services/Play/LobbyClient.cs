using Microsoft.AspNetCore.SignalR.Client;
using PoMiniGames.Shared.Games;
using PoMiniGamesClient.Services.Http;

namespace PoMiniGamesClient.Services.Play;

/// <summary>
/// Client half of the shared ready/start lobby (server: <c>LobbyHub</c>). One instance per
/// lobby connection; owns the hub, the current <see cref="State"/>, the re-join on
/// reconnect, and the three broadcasts every lobby emits. Game-specific hub calls
/// (a character or fighter pick) go through <see cref="InvokeAsync{T}"/>.
/// </summary>
/// <remarks>
/// Until 2026-09-14 Racer, Sports, Voxel Strike and Brawl each carried this exact
/// connect/subscribe/join/re-join sequence — twice in wrappers, twice inline in pages.
/// </remarks>
public sealed class LobbyClient<TPlayer> : IAsyncDisposable where TPlayer : ILobbyPlayer
{
    private readonly ApiEndpoints _endpoints;
    private readonly string _hubPath;
    private readonly List<IDisposable> _subs = [];
    private HubConnection? _hub;
    private string _displayName = "Player";
    private bool _isGuest = true;

    /// <param name="hubPath">Hub path relative to the API base, e.g. <c>poracer/lobby-hub</c>.</param>
    public LobbyClient(ApiEndpoints endpoints, string hubPath)
    {
        _endpoints = endpoints;
        _hubPath = hubPath;
    }

    public event Action<LobbyState<TPlayer>>? StateChanged;
    public event Action<LobbyEvent>? EventReceived;
    /// <summary>The host started; payload is the game code to carry to the game page.</summary>
    public event Action<string>? GameStarted;
    public event Action<HubConnectionState>? ConnectionChanged;

    public LobbyState<TPlayer>? State { get; private set; }
    public string ConnectionId => _hub?.ConnectionId ?? "";
    public HubConnectionState ConnectionState => _hub?.State ?? HubConnectionState.Disconnected;
    public bool IsConnected => _hub is not null && _hub.State == HubConnectionState.Connected;

    public TPlayer? Me => State is null ? default : State.Players.FirstOrDefault(p => p.ConnectionId == ConnectionId);
    public bool IsHost => State is not null && !string.IsNullOrEmpty(ConnectionId) && State.HostConnectionId == ConnectionId;
    public bool IsReady => Me?.IsReady ?? false;

    /// <summary>
    /// Open the connection (first call) and take a seat. A later call on a live connection
    /// just re-joins, which is also what runs after every automatic reconnect: SignalR hands
    /// out a new connection id and the server has already run Leave on the old one.
    /// </summary>
    public async Task<LobbyState<TPlayer>?> ConnectAndJoinAsync(string displayName, bool isGuest)
    {
        _displayName = string.IsNullOrWhiteSpace(displayName) ? "Player" : displayName;
        _isGuest = isGuest;
        if (_hub is null)
        {
            // Credentials handler, auto-reconnect and the camelCase enum protocol all come
            // from the shared factory — see HubConnectionFactory.
            _hub = HubConnectionFactory.Create(_endpoints.Hub(_hubPath));
            _subs.Add(_hub.On<LobbyState<TPlayer>>("lobbyState", s => { State = s; StateChanged?.Invoke(s); }));
            _subs.Add(_hub.On<LobbyEvent>("lobbyEvent", e => EventReceived?.Invoke(e)));
            _subs.Add(_hub.On<string>("gameStarted", code => GameStarted?.Invoke(code)));
            _hub.Reconnecting += _ => { ConnectionChanged?.Invoke(HubConnectionState.Reconnecting); return Task.CompletedTask; };
            _hub.Reconnected += async _ =>
            {
                ConnectionChanged?.Invoke(HubConnectionState.Connected);
                try { await JoinAsync(); } catch { /* surfaced on the next user action */ }
            };
            _hub.Closed += _ => { ConnectionChanged?.Invoke(HubConnectionState.Disconnected); return Task.CompletedTask; };
        }
        // Outside the create block: a first StartAsync that failed leaves _hub built but
        // Disconnected, and a page's "Try again" has to start it rather than join on a dead hub.
        if (_hub.State == HubConnectionState.Disconnected)
        {
            await _hub.StartAsync();
            ConnectionChanged?.Invoke(_hub.State);
        }
        return await JoinAsync();
    }

    public async Task<LobbyState<TPlayer>?> JoinAsync()
    {
        if (_hub is null) return null;
        var state = await _hub.InvokeAsync<LobbyState<TPlayer>>("Join", _displayName, _isGuest);
        State = state;
        StateChanged?.Invoke(state);
        return state;
    }

    public Task ToggleReadyAsync() => SendAsync("ToggleReady");

    public Task StartGameAsync() => SendAsync("StartGame");

    /// <summary>Give the seat up. Never throws — this runs on the way out.</summary>
    public async Task LeaveLobbyAsync()
    {
        if (_hub is null || _hub.State != HubConnectionState.Connected) return;
        try { await _hub.InvokeAsync("LeaveLobby"); } catch { /* socket may already be closed */ }
    }

    /// <summary>A game-specific hub call with a reply (e.g. <c>PickCharacter</c>).</summary>
    public Task<T> InvokeAsync<T>(string method, params object?[] args) =>
        _hub is null
            ? throw new InvalidOperationException("ConnectAndJoinAsync has not been called.")
            : _hub.InvokeCoreAsync<T>(method, args);

    /// <summary>A game-specific hub call with no reply (e.g. <c>PickFighter</c>).</summary>
    public Task SendAsync(string method, params object?[] args) =>
        _hub is null ? Task.CompletedTask : _hub.InvokeCoreAsync(method, args);

    public async ValueTask DisposeAsync()
    {
        var hub = _hub;
        _hub = null;
        foreach (var s in _subs) s.Dispose();
        _subs.Clear();
        if (hub is not null)
        {
            try { await hub.DisposeAsync(); } catch { /* socket may already be closed */ }
        }
    }
}
