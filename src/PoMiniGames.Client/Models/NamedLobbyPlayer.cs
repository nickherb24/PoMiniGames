using PoMiniGames.Shared.Games;

namespace PoMiniGamesClient.Models;

/// <summary>
/// A lobby seat for the two hubs that know their players by name rather than by
/// connection (Couple Quiz, Fun Quiz), so their lobbies can be drawn by the shared
/// <c>LobbyPanel</c> instead of a hand-rolled list each.
/// </summary>
/// <remarks>
/// The name stands in for the connection id: it is what those hubs use as identity, and
/// it is unique within a lobby. Neither hub says whether a seat is a guest.
/// </remarks>
public sealed record NamedLobbyPlayer(string DisplayName, bool IsReady) : ILobbyPlayer
{
    public string ConnectionId => DisplayName;
    public bool IsGuest => false;
}
