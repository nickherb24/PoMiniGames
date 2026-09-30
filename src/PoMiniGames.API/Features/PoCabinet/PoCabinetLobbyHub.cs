using Microsoft.AspNetCore.SignalR;
using PoMiniGames.Features.Auth;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoCabinet;

/// <summary>
/// SignalR hub for the PoCabinet multiplayer lobby, at <c>/pocabinet/lobby-hub</c>. There is
/// one lobby and no codes: <see cref="Join"/> seats the caller (the first arrival hosts), the
/// host picks the track and how many AI officials fill free seats, and <see cref="TryStart"/>
/// builds the grid and hands off to <see cref="PoCabinetRaceHub"/>. Every change is broadcast
/// to the lobby group as <c>LobbyState</c>.
///
/// <para>
/// Identity comes from the claims (<see cref="RequestIdentity"/>), never from the client: seats
/// are keyed by it and a signed-in player's claim name wins over whatever name they typed.
/// Hub endpoints require auth (<c>/negotiate</c> included), mapped in
/// <c>EndpointRouteExtensions</c>.
/// </para>
/// </summary>
public sealed class PoCabinetLobbyHub(PoCabinetLobbyService lobbies, PoCabinetRaceRegistry races) : Hub
{
    /// <summary>
    /// Take a seat (the first arrival hosts, on <paramref name="trackId"/>). A caller who gets
    /// no seat — the race is running or all eight are taken — still joins the group and gets
    /// the view with a null <c>YourSeatId</c>, so their page can wait and retry on the next
    /// <c>LobbyState</c>.
    /// </summary>
    public async Task<PoCabinetLobbyView?> Join(string displayName, string? trackId, string? color)
    {
        var me = Caller(displayName);
        var seated = lobbies.Join(me.Id, me.Name, me.IsGuest, trackId, color, Context.ConnectionId) is not null;
        await Groups.AddToGroupAsync(Context.ConnectionId, PoCabinetRaceRegistry.LobbyGroup);
        if (seated) await BroadcastAsync();
        return lobbies.View(seated ? me.Id : null);
    }

    public Task<bool> ToggleReady() => MutateAsync(lobbies.ToggleReady);

    public Task<bool> SetTrack(string trackId) => MutateAsync(id => lobbies.SetTrack(id, trackId));

    public Task<bool> SetBots(int count) => MutateAsync(id => lobbies.SetBots(id, count));

    public async Task<bool> TryStart()
    {
        var me = Caller(null);
        var lobby = lobbies.Start(me.Id);
        if (lobby is null) return false;
        races.Create(PoCabinetLobbyService.RaceId, lobby.TrackId, lobbies.BuildGrid());
        await BroadcastAsync();
        await Clients.Group(PoCabinetRaceRegistry.LobbyGroup).SendAsync("RaceStarting", PoCabinetLobbyService.RaceId, lobby.TrackId);
        return true;
    }

    public async Task Leave()
    {
        var me = Caller(null);
        lobbies.Leave(me.Id);
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, PoCabinetRaceRegistry.LobbyGroup);
        await BroadcastAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        if (lobbies.DropConnection(Context.ConnectionId)) await BroadcastAsync();
        await base.OnDisconnectedAsync(exception);
    }

    private async Task<bool> MutateAsync(Func<string, bool> change)
    {
        var me = Caller(null);
        if (!change(me.Id)) return false;
        await BroadcastAsync();
        return true;
    }

    private Task BroadcastAsync()
    {
        var view = lobbies.View();
        return view is null
            ? Task.CompletedTask
            : Clients.Group(PoCabinetRaceRegistry.LobbyGroup).SendAsync("LobbyState", view);
    }

    private (string Id, string Name, bool IsGuest) Caller(string? requestedName)
    {
        var identity = RequestIdentity.Resolve(Context.User);
        if (string.IsNullOrEmpty(identity.UserId))
            throw new HubException("Sign in or continue as a guest to race.");
        var typed = SanitizeName(requestedName);
        var name = identity.IsAuthenticated && !string.IsNullOrWhiteSpace(identity.DisplayName)
            ? identity.DisplayName
            : typed ?? (string.IsNullOrWhiteSpace(identity.DisplayName) ? "Player" : identity.DisplayName);
        return (identity.UserId, name.Length > 24 ? name[..24] : name, identity.IsGuest);
    }

    private static string? SanitizeName(string? name)
    {
        if (string.IsNullOrWhiteSpace(name)) return null;
        var clean = new string(name.Where(ch => !char.IsControl(ch)).ToArray()).Trim();
        return clean.Length == 0 ? null : clean;
    }
}
