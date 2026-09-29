using System.Collections.Concurrent;
using System.Security.Cryptography;
using PoMiniGames.Domain.Primitives;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoBrawl.Online;

/// <summary>
/// Every PoBrawl room, by code, plus which room each lobby connection sits in. Process-local
/// like the rooms themselves.
/// </summary>
/// <remarks>
/// <para>
/// An empty room is kept for <see cref="IdleLifetime"/>, not dropped when it drains: both players'
/// lobby connections close the moment they navigate to the fight, and "back to the lobby" after
/// the bell has to find the same code again (the host migrates to whoever returns first).
/// </para>
/// <para>
/// Quick match — the default on the lobby page, and what a player who just opens it gets — sits
/// the caller in the first public room with a free seat that is not mid-start, or opens a new
/// public one. That keeps "two people open the page and end up together" working, which is what
/// the single global room used to guarantee.
/// </para>
/// </remarks>
public sealed class PoBrawlRooms
{
    public static readonly TimeSpan IdleLifetime = TimeSpan.FromMinutes(20);

    // No 0/O/1/I: codes get read aloud and typed on phones.
    private const string CodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    private const int CodeLength = 5;

    private sealed class Entry(PoBrawlLobbyService room, DateTimeOffset touched)
    {
        public PoBrawlLobbyService Room { get; } = room;
        public DateTimeOffset Touched { get; set; } = touched;
    }

    private readonly ConcurrentDictionary<string, Entry> _rooms = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string, string> _connectionToCode = new(StringComparer.Ordinal);
    private readonly object _createLock = new();

    public PoBrawlLobbyService Create(bool isPublic)
    {
        lock (_createLock)
        {
            Prune();
            string code;
            do code = NewCode(); while (_rooms.ContainsKey(code));
            var room = new PoBrawlLobbyService(code, isPublic);
            _rooms[code] = new Entry(room, DateTimeOffset.UtcNow);
            return room;
        }
    }

    public PoBrawlLobbyService? Get(string? code)
    {
        if (string.IsNullOrWhiteSpace(code) || !_rooms.TryGetValue(code.Trim(), out var entry)) return null;
        entry.Touched = DateTimeOffset.UtcNow;
        return entry.Room;
    }

    /// <summary>The first public room with a free seat that is not starting, or a new public room.</summary>
    public PoBrawlLobbyService QuickMatch()
    {
        lock (_createLock)
        {
            var open = _rooms.Values
                .Where(e => e.Room.IsPublic && !e.Room.IsStarted && e.Room.Players.Count is > 0 and < PoBrawlLobbyService.Cap)
                .OrderBy(e => e.Touched)
                .FirstOrDefault();
            if (open is not null)
            {
                open.Touched = DateTimeOffset.UtcNow;
                return open.Room;
            }
        }
        return Create(isPublic: true);
    }

    public void Seat(string connectionId, string code) => _connectionToCode[connectionId] = code;

    public PoBrawlLobbyService? RoomOf(string connectionId) =>
        _connectionToCode.TryGetValue(connectionId, out var code) ? Get(code) : null;

    public PoBrawlLobbyService? Unseat(string connectionId) =>
        _connectionToCode.TryRemove(connectionId, out var code) ? Get(code) : null;

    /// <summary>
    /// The room browser: public rooms waiting for a second player, and public fights running now
    /// (joinable as a spectator). Newest activity first.
    /// </summary>
    public IReadOnlyList<PoBrawlRoomSummary> ListOpen(PoBrawlMatchRegistry matches)
    {
        var rows = new List<(DateTimeOffset Touched, PoBrawlRoomSummary Row)>();
        foreach (var entry in _rooms.Values.Where(e => e.Room.IsPublic))
        {
            var room = entry.Room;
            var players = room.Players;
            var fight = matches.Get(room.GameCode);
            if (fight is { FinishedAtUtc: null })
            {
                rows.Add((entry.Touched, new PoBrawlRoomSummary(room.GameCode, fight.Player1.DisplayName, 2, PoBrawlLobbyService.Cap,
                    InProgress: true, [FighterName(fight.Player1.Fighter.Id), FighterName(fight.Player2.Fighter.Id)])));
            }
            else if (players.Count is > 0 and < PoBrawlLobbyService.Cap && !room.IsStarted)
            {
                var host = players.FirstOrDefault(p => p.ConnectionId == room.HostConnectionId) ?? players[0];
                rows.Add((entry.Touched, new PoBrawlRoomSummary(room.GameCode, host.DisplayName, players.Count, PoBrawlLobbyService.Cap,
                    InProgress: false, [.. players.Select(p => FighterName(p.Fighter.Id))])));
            }
        }
        return [.. rows.OrderByDescending(r => r.Touched).Take(20).Select(r => r.Row)];
    }

    /// <summary>Drop rooms nobody has touched for <see cref="IdleLifetime"/> and nobody is sitting in.</summary>
    private void Prune()
    {
        var cutoff = DateTimeOffset.UtcNow - IdleLifetime;
        foreach (var (code, entry) in _rooms)
        {
            if (entry.Touched < cutoff && entry.Room.IsEmpty) _rooms.TryRemove(code, out _);
        }
    }

    private static string FighterName(string id) =>
        string.Equals(id, PoBrawlRoster.Bob.Id, StringComparison.OrdinalIgnoreCase) ? PoBrawlRoster.Bob.Name : PoBrawlRoster.DisplayName(id);

    private static string NewCode()
    {
        Span<char> chars = stackalloc char[CodeLength];
        for (var i = 0; i < chars.Length; i++) chars[i] = CodeAlphabet[RandomNumberGenerator.GetInt32(CodeAlphabet.Length)];
        return new string(chars);
    }
}
