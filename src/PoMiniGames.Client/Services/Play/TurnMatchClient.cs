using Microsoft.AspNetCore.SignalR.Client;
using PoMiniGames.Shared.Games;
using PoMiniGamesClient.Services.Http;

namespace PoMiniGamesClient.Services.Play;

/// <summary>
/// Client-side wrapper around a turn-match hub (<c>/connectfive/hub</c>,
/// <c>/tictactoe/hub</c>). Owned by the game page for the life of the online
/// session (not DI-registered: one page, one connection, disposed together).
/// Exposes the two server events as C# events and keeps the seat token so a
/// SignalR automatic reconnect re-binds the seat on its own — the page never sees
/// the drop unless the server has already forfeited.
/// </summary>
public sealed class TurnMatchClient : IAsyncDisposable
{
    private readonly ApiEndpoints _endpoints;
    private readonly string _hubPath;
    private HubConnection? _hub;
    private string? _seatToken;

    /// <param name="hubPath">Hub path relative to the API base, e.g. <c>connectfive/hub</c>.</param>
    public TurnMatchClient(ApiEndpoints endpoints, string hubPath)
    {
        _endpoints = endpoints;
        _hubPath = hubPath;
    }

    /// <summary>A game began (first pairing or rematch). Carries the local seat's side and token.</summary>
    public event Action<TurnMatchStart>? MatchStarted;
    /// <summary>Authoritative board after every change.</summary>
    public event Action<TurnMatchState>? StateChanged;
    /// <summary>Transport-level changes the page may want to surface (reconnecting, closed).</summary>
    public event Action<HubConnectionState>? ConnectionChanged;
    /// <summary>The seat was lost across a reconnect (server forfeited it); the page should re-queue.</summary>
    public event Action? SeatLost;

    public HubConnectionState State => _hub?.State ?? HubConnectionState.Disconnected;

    public async Task ConnectAsync()
    {
        if (_hub is not null) return;
        // Credentials handler, auto-reconnect and the camelCase enum protocol all come
        // from the shared factory — see HubConnectionFactory.
        _hub = HubConnectionFactory.Create(_endpoints.Hub(_hubPath));
        _hub.On<TurnMatchStart>("matchStarted", start =>
        {
            _seatToken = start.SeatToken;
            MatchStarted?.Invoke(start);
        });
        _hub.On<TurnMatchState>("state", state => StateChanged?.Invoke(state));
        _hub.Reconnecting += _ =>
        {
            ConnectionChanged?.Invoke(HubConnectionState.Reconnecting);
            return Task.CompletedTask;
        };
        _hub.Reconnected += async _ =>
        {
            ConnectionChanged?.Invoke(HubConnectionState.Connected);
            await RejoinAsync();
        };
        _hub.Closed += _ =>
        {
            ConnectionChanged?.Invoke(HubConnectionState.Disconnected);
            return Task.CompletedTask;
        };
        await _hub.StartAsync();
        ConnectionChanged?.Invoke(_hub.State);
    }

    public Task<TurnMatchQueueStatus> FindMatchAsync(string displayName, bool isGuest) =>
        Require().InvokeAsync<TurnMatchQueueStatus>("FindMatch", displayName, isGuest);

    public Task CancelSearchAsync() => Require().InvokeAsync("CancelSearch");

    /// <summary>
    /// Place a mark. A rejected move throws <see cref="HubException"/> with the server's
    /// reason; an accepted one arrives through <see cref="StateChanged"/>. Gravity games
    /// may pass any row — the server resolves the landing row.
    /// </summary>
    public Task PlaceAsync(int row, int col) => Require().InvokeAsync("Place", row, col);


    public async Task LeaveAsync()
    {
        _seatToken = null;
        if (_hub is null || _hub.State != HubConnectionState.Connected) return;
        try { await _hub.InvokeAsync("Leave"); } catch { /* leaving anyway */ }
    }

    /// <summary>Forget the seat without telling the server (a finished game the player walked away from).</summary>
    public void ForgetSeat() => _seatToken = null;

    private async Task RejoinAsync()
    {
        if (_hub is null || string.IsNullOrEmpty(_seatToken)) return;
        try
        {
            var result = await _hub.InvokeAsync<TurnMatchRejoinResult?>("Rejoin", _seatToken);
            if (result is null)
            {
                _seatToken = null;
                SeatLost?.Invoke();
                return;
            }
            MatchStarted?.Invoke(result.Start);
            StateChanged?.Invoke(result.State);
        }
        catch
        {
            _seatToken = null;
            SeatLost?.Invoke();
        }
    }

    private HubConnection Require() =>
        _hub ?? throw new InvalidOperationException("ConnectAsync has not been called.");

    public async ValueTask DisposeAsync()
    {
        if (_hub is null) return;
        var hub = _hub;
        _hub = null;
        try { await hub.DisposeAsync(); } catch { /* page is going away */ }
    }
}
