using PoMiniGames.Features.Shared.Lobby;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoRacer;

/// <summary>
/// The PoRacer room over the shared lobby hub. The only game-specific step is spinning
/// the race up the instant the host starts (roster captured now, not at the clients'
/// eventual JoinRace) and dropping a leaver's input from the sim.
/// </summary>
public sealed class PoRacerLobbyHub : LobbyHub<PoRacerLobbyPlayer, PoRacerLobbyService>
{
    private readonly PoRacerRaceRegistry _races;

    public PoRacerLobbyHub(PoRacerLobbyService lobby, PoRacerRaceRegistry races, ILogger<PoRacerLobbyHub> log)
        : base(lobby, "poracer-lobby", log)
    {
        _races = races;
    }

    protected override string StartingMessage => "Race starting…";

    protected override (LobbyState<PoRacerLobbyPlayer> state, string message) OpenSeat(string displayName, bool isGuest)
    {
        var identity = PoMiniGames.Features.Auth.RequestIdentity.Resolve(Context.User);
        return Lobby.Open(Context.ConnectionId, identity.DisplayName, identity.IsGuest, identity.UserId);
    }

    /// <summary>The host's track pick. Anyone else's is ignored: the race runs the host's seat.</summary>
    public async Task PickTrack(string trackId)
    {
        if (Lobby.HostConnectionId == Context.ConnectionId && Lobby.PickTrack(Context.ConnectionId, trackId))
            await BroadcastStateAsync();
    }

    protected override Task OnStartingAsync()
    {
        _races.StartMultiplayer();
        return Task.CompletedTask;
    }
}
