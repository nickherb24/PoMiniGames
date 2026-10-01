using PoMiniGames.Features.Shared.Lobby;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoRacer;

/// <summary>
/// The PoRacer room: the plain ready/start lobby plus one pick, the track. Eight seats — one
/// per car on the grid. The race sim calls <see cref="LobbyRoom{TPlayer}.End"/> when the
/// last car finishes so a new host can claim the room.
/// </summary>
public sealed class PoRacerLobbyService : LobbyRoom<PoRacerLobbyPlayer>
{
    public const string GlobalCode = "LOBBY";
    public const int Cap = 8;

    public PoRacerLobbyService() : base(GlobalCode, Cap, "Race already in progress")
    {
    }

    // The last track anyone picked. A new seat starts on it, so the drivers coming back from a
    // race (new connections, so new seats) find the room on the track they just ran.
    private string _trackId = PoRacerCatalog.DefaultTrackId;

    public (LobbyState<PoRacerLobbyPlayer> state, string message) Open(string connectionId, string displayName, bool isGuest, string userId) =>
        OpenCore(connectionId, displayName, isGuest,
            (name, previous, _) => new PoRacerLobbyPlayer(connectionId, name, isGuest, false, userId,
                previous?.TrackId ?? _trackId));

    /// <summary>
    /// Record the caller's track pick on their seat. Every seat may hold one; the race runs the
    /// host's, so a host change simply hands the choice to the next host's seat.
    /// </summary>
    public bool PickTrack(string connectionId, string trackId) => WithLock(seats =>
    {
        if (!seats.TryGetValue(connectionId, out var seat)) return false;
        seats[connectionId] = seat with { TrackId = _trackId = PoRacerCatalog.GetTrack(trackId).Id };
        return true;
    });

    public string CreateRaceCode() => WithLock(_ => GameCode = "multi-" + Guid.NewGuid().ToString("N"));

    protected override PoRacerLobbyPlayer WithReady(PoRacerLobbyPlayer player, bool ready) =>
        player with { IsReady = ready };
}
