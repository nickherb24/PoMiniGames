namespace PoMiniGames.Shared.Games;

// ────────────────────────────  Lobby (shared)  ─────────────────────────────
//
// One wire shape for every ready/start lobby (Racer, Sports, Voxel Strike, Brawl).
// Sharing one LobbyState/LobbyEvent pair keeps the lobby pages and lobby services from
// drifting into per-game copies. A game's player record still carries whatever that game needs
// (a character, a fighter, a seat number) — it just has to expose the four fields the
// shared lobby machinery reads.

/// <summary>The fields every lobby seat exposes; the shared room, hub and panel read nothing else.</summary>
public interface ILobbyPlayer
{
    string ConnectionId { get; }
    string DisplayName { get; }
    bool IsGuest { get; }
    bool IsReady { get; }
}

/// <summary>Snapshot of one lobby, broadcast to every member after every change.</summary>
public sealed record LobbyState<TPlayer>(
    IReadOnlyList<TPlayer> Players,
    string? HostConnectionId,
    string GameCode,
    int MaxPlayers,
    DateTimeOffset LastUpdatedUtc) where TPlayer : ILobbyPlayer;

/// <summary>Transient toast-style event (joined / left / ready / pick / starting).</summary>
public sealed record LobbyEvent(string Kind, string Message, DateTimeOffset AtUtc);
