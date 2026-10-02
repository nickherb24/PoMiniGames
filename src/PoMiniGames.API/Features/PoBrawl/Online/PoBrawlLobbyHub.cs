using Microsoft.AspNetCore.SignalR;
using PoMiniGames.Domain.Primitives;
using PoMiniGames.Features.Auth;
using PoMiniGames.Features.Shared.Lobby;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoBrawl.Online;

/// <summary>
/// The PoBrawl 1v1 room over the shared lobby hub, plus a fighter pick: the first two people
/// to open the lobby are the fight. On start the match is created NOW, under a fresh match
/// code, with the roster captured.
/// </summary>
/// <remarks>
/// There is one shared room (like PoRacer), not rooms-by-code. The lobby resets the moment a
/// fight starts, so the next two
/// arrivals can pair up while the first pair is still fighting.
/// </remarks>
public sealed class PoBrawlLobbyHub : LobbyHub<PoBrawlLobbyPlayer, PoBrawlLobbyService>
{
    private readonly PoBrawlMatchRegistry _matches;

    public PoBrawlLobbyHub(PoBrawlLobbyService lobby, PoBrawlMatchRegistry matches, ILogger<PoBrawlLobbyHub> log)
        : base(lobby, "pobrawl-lobby", log)
    {
        _matches = matches;
    }

    protected override string StartingMessage => "Fight starting…";

    /// <summary>
    /// Server-canonical identity from the claims; the typed name is only a fallback for a nameless
    /// guest. A full or starting room refuses loudly, so the page shows why instead of a lobby
    /// the caller is not in.
    /// </summary>
    protected override (LobbyState<PoBrawlLobbyPlayer> state, string message) OpenSeat(string displayName, bool isGuest)
    {
        var identity = RequestIdentity.Resolve(Context.User);
        var name = !string.IsNullOrWhiteSpace(identity.DisplayName) ? identity.DisplayName : displayName;
        var (state, msg) = Lobby.Open(Context.ConnectionId, identity.UserId, name, identity.IsGuest || isGuest, PoBrawlRoster.Bob);
        if (!state.Players.Any(p => p.ConnectionId == Context.ConnectionId))
        {
            throw new HubException($"{msg} — a fight is being set up, try again in a moment.");
        }
        return (state, msg);
    }

    protected override Task OnStartingAsync()
    {
        _matches.Start(Lobby.CreateMatchCode(), Lobby.Players);
        // Clear the started flag and every ready flag at once: the players' lobby connections
        // close as they navigate to the fight, and the room must take the next pair.
        Lobby.End();
        return Task.CompletedTask;
    }

    /// <summary>Pick a fighter: any rateable president, or Bob (the 1P/2P avatar).</summary>
    public async Task PickFighter(string fighterId)
    {
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

        var (ok, msg) = Lobby.PickFighter(Context.ConnectionId, fighter);
        await BroadcastStateAsync();
        if (ok) await BroadcastEventAsync("pick", msg);
    }
}
