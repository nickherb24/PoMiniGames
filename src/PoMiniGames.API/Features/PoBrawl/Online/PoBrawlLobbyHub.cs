using Microsoft.AspNetCore.SignalR;
using PoMiniGames.Domain.Primitives;
using PoMiniGames.Features.Auth;
using PoMiniGames.Shared.Games;
using PoBrawlFighter = PoMiniGames.Domain.Primitives.PoBrawlFighter;

namespace PoMiniGames.Features.PoBrawl.Online;

/// <summary>
/// The PoBrawl room lobby: quick match, private rooms by code, the open-room browser, and the
/// fighter pick. Speaks the shared lobby wire shape (<c>lobbyState</c> / <c>lobbyEvent</c> /
/// <c>gameStarted</c>, and a <c>Join(displayName, isGuest)</c> that <c>LobbyClient</c> calls on
/// every reconnect), so <c>LobbyClient</c> and <c>LobbyPanel</c> work unchanged.
/// </summary>
/// <remarks>
/// It no longer derives <c>LobbyHub</c>: that base binds one hub to one room through its
/// constructor, and a hub instance cannot know which room its caller is in until it has a
/// <c>Context</c>. The room per connection lives in <see cref="PoBrawlRooms"/> instead; the
/// state machine itself is still the shared <c>LobbyRoom</c>.
/// </remarks>
public sealed class PoBrawlLobbyHub : Hub
{
    private readonly PoBrawlRooms _rooms;
    private readonly PoBrawlMatchRegistry _matches;
    private readonly ILogger<PoBrawlLobbyHub> _log;

    public PoBrawlLobbyHub(PoBrawlRooms rooms, PoBrawlMatchRegistry matches, ILogger<PoBrawlLobbyHub> log)
    {
        _rooms = rooms;
        _matches = matches;
        _log = log;
    }

    private static string Group(string code) => $"pobrawl-lobby-{code.ToUpperInvariant()}";

    public override async Task OnDisconnectedAsync(Exception? ex)
    {
        await LeaveCurrentAsync();
        await base.OnDisconnectedAsync(ex);
    }

    /// <summary>
    /// Take a seat: back in the room this connection already sits in (a reconnect), otherwise
    /// quick match — the first public room with a free seat, or a new public room.
    /// </summary>
    public Task<LobbyState<PoBrawlLobbyPlayer>> Join(string displayName, bool isGuest) =>
        SeatAsync(_rooms.RoomOf(Context.ConnectionId) ?? _rooms.QuickMatch(), displayName, isGuest);

    /// <summary>Join a room by its code. Fails loudly for an unknown code, a full room, or a fight in progress.</summary>
    public Task<LobbyState<PoBrawlLobbyPlayer>> JoinRoom(string code, string displayName, bool isGuest) =>
        SeatAsync(_rooms.Get(code) ?? throw new HubException($"No room with code {code?.Trim().ToUpperInvariant()}."), displayName, isGuest);

    /// <summary>Open a new room and host it. A private room is reachable by its code only.</summary>
    public Task<LobbyState<PoBrawlLobbyPlayer>> CreateRoom(bool isPublic, string displayName, bool isGuest) =>
        SeatAsync(_rooms.Create(isPublic), displayName, isGuest);

    /// <summary>Public rooms waiting for a second player, and public fights you can watch.</summary>
    public IReadOnlyList<PoBrawlRoomSummary> ListOpen() => _rooms.ListOpen(_matches);

    public async Task ToggleReady()
    {
        if (_rooms.RoomOf(Context.ConnectionId) is not { } room) return;
        var (ok, _, msg) = room.ToggleReady(Context.ConnectionId);
        if (!ok) return;
        await BroadcastStateAsync(room);
        await BroadcastEventAsync(room, "ready", msg);
    }

    public Task LeaveLobby() => LeaveCurrentAsync();

    /// <summary>
    /// Host-only. The match is created NOW with the roster captured — not on the clients'
    /// eventual join to the match hub, which a WebSocket reconnect could otherwise race.
    /// </summary>
    public async Task StartGame()
    {
        if (_rooms.RoomOf(Context.ConnectionId) is not { } room) return;
        if (!room.TryStart(Context.ConnectionId)) return;
        _matches.Start(room.GameCode, room.Players);
        // Clear the started flag and every ready flag: the next round (after the fight) needs a
        // fresh Ready from both, and the room must accept the players back.
        room.End();
        _log.LogInformation("PoBrawl room {Code} starting a fight", room.GameCode);
        await BroadcastEventAsync(room, "starting", "Fight starting…");
        await Clients.Group(Group(room.GameCode)).SendAsync("gameStarted", room.GameCode);
    }

    /// <summary>Pick a fighter: any rateable president, or Bob (the 1P/2P avatar).</summary>
    public async Task PickFighter(string fighterId)
    {
        if (_rooms.RoomOf(Context.ConnectionId) is not { } room) return;
        PoBrawlFighter fighter;
        var canonicalId = PoBrawlRoster.Canonicalize(fighterId);
        if (canonicalId is not null)
        {
            fighter = new PoBrawlFighter(canonicalId, PoBrawlRoster.DisplayName(canonicalId));
        }
        else if (string.Equals(fighterId, PoBrawlRoster.Bob.Id, StringComparison.OrdinalIgnoreCase))
        {
            fighter = PoBrawlRoster.Bob;
        }
        else
        {
            throw new HubException($"'{fighterId}' is not a PoBrawl fighter.");
        }

        var (ok, msg) = room.PickFighter(Context.ConnectionId, fighter);
        await BroadcastStateAsync(room);
        if (ok) await BroadcastEventAsync(room, "pick", msg);
    }

    /// <summary>
    /// Seat the caller in <paramref name="room"/>, leaving any other room first. Server-canonical
    /// identity from the claims; the typed name is only a fallback for a nameless guest.
    /// </summary>
    private async Task<LobbyState<PoBrawlLobbyPlayer>> SeatAsync(PoBrawlLobbyService room, string displayName, bool isGuest)
    {
        if (_rooms.RoomOf(Context.ConnectionId) is { } current && current != room) await LeaveCurrentAsync();

        var identity = RequestIdentity.Resolve(Context.User);
        var name = !string.IsNullOrWhiteSpace(identity.DisplayName) ? identity.DisplayName : displayName;
        var (state, msg) = room.Open(Context.ConnectionId, identity.UserId, name, identity.IsGuest || isGuest, PoBrawlRoster.Bob);
        if (!state.Players.Any(p => p.ConnectionId == Context.ConnectionId))
        {
            // Full, or a fight is starting there: say which, rather than show the caller a room
            // they are not in.
            throw new HubException(msg);
        }
        _rooms.Seat(Context.ConnectionId, room.GameCode);
        await Groups.AddToGroupAsync(Context.ConnectionId, Group(room.GameCode));
        await BroadcastStateAsync(room);
        await BroadcastEventAsync(room, "joined", msg);
        return room.State;
    }

    private async Task LeaveCurrentAsync()
    {
        if (_rooms.Unseat(Context.ConnectionId) is not { } room) return;
        var (ok, msg) = room.Leave(Context.ConnectionId);
        await Groups.RemoveFromGroupAsync(Context.ConnectionId, Group(room.GameCode));
        await BroadcastStateAsync(room);
        if (ok && !string.IsNullOrEmpty(msg)) await BroadcastEventAsync(room, "left", msg);
    }

    private Task BroadcastStateAsync(PoBrawlLobbyService room) =>
        Clients.Group(Group(room.GameCode)).SendAsync("lobbyState", room.State);

    private Task BroadcastEventAsync(PoBrawlLobbyService room, string kind, string message) =>
        Clients.Group(Group(room.GameCode)).SendAsync("lobbyEvent", new LobbyEvent(kind, message, DateTimeOffset.UtcNow));
}
