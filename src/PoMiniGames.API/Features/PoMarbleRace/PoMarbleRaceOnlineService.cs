using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoMarbleRace;

/// <summary>
/// Quick-match queue and pairing registry for online Marble Race. Deliberately holds no
/// race state: the host browser is the simulation (see <c>PoMarbleRaceShared.cs</c>), so
/// the server's whole job is to pair two connections, tell each which role it has, and
/// relay frames one way and steering the other. Process-local like every other live
/// registry in the host.
/// </summary>
public sealed class PoMarbleRaceOnlineService
{
    /// <summary>Pack slot the guest steers. Slot 0 is the host's red marble; slot 1 is recoloured white for the guest.</summary>
    public const int GuestMarbleIndex = 1;

    private readonly object _lock = new();
    private readonly List<Waiting> _queue = new();
    private readonly Dictionary<string, Race> _byConnection = new(StringComparer.Ordinal);

    public int WaitingCount { get { lock (_lock) return _queue.Count; } }

    /// <summary>
    /// Queue for a race. The first arrival becomes host (it runs the physics and its map
    /// choice is the course); the second completes the pair. Returns the pairing, or null
    /// while waiting or when the connection is already seated.
    /// </summary>
    public Pairing? Enqueue(string connectionId, string principalId, string displayName, bool isGuest, int mapId)
    {
        lock (_lock)
        {
            if (_byConnection.ContainsKey(connectionId)) return null;
            if (_queue.Any(w => w.ConnectionId == connectionId)) return null;

            var arrival = new Waiting(connectionId, principalId, Features.Shared.PlayerNames.Sanitize(displayName), isGuest, mapId);
            if (_queue.Count == 0)
            {
                _queue.Add(arrival);
                return null;
            }

            var host = _queue[0];
            _queue.RemoveAt(0);
            var race = new Race(Guid.NewGuid().ToString("N"), host, arrival, Random.Shared.Next(1, int.MaxValue));
            _byConnection[host.ConnectionId] = race;
            _byConnection[arrival.ConnectionId] = race;
            return race.Pairing();
        }
    }

    public void Dequeue(string connectionId)
    {
        lock (_lock) _queue.RemoveAll(w => w.ConnectionId == connectionId);
    }

    /// <summary>The other seat's connection id, or null when the caller is not in a race.</summary>
    public string? PeerOf(string connectionId)
    {
        lock (_lock)
        {
            if (!_byConnection.TryGetValue(connectionId, out var race)) return null;
            return race.Host.ConnectionId == connectionId ? race.Guest.ConnectionId : race.Host.ConnectionId;
        }
    }

    public MarbleRaceRole? RoleOf(string connectionId)
    {
        lock (_lock)
        {
            if (!_byConnection.TryGetValue(connectionId, out var race)) return null;
            return race.Host.ConnectionId == connectionId ? MarbleRaceRole.Host : MarbleRaceRole.Guest;
        }
    }

    /// <summary>
    /// Drop a connection from the queue and from its race. Returns the peer left behind, if
    /// any, so the hub can tell it. A race with one seat gone is over — there is no rejoin,
    /// because the host IS the simulation and a guest that comes back has no state to resume.
    /// </summary>
    public string? Remove(string connectionId)
    {
        lock (_lock)
        {
            _queue.RemoveAll(w => w.ConnectionId == connectionId);
            if (!_byConnection.Remove(connectionId, out var race)) return null;
            var peer = race.Host.ConnectionId == connectionId ? race.Guest.ConnectionId : race.Host.ConnectionId;
            _byConnection.Remove(peer);
            return peer;
        }
    }

    public sealed record Pairing(string RaceId, string HostConnectionId, MarbleRaceStart HostStart, string GuestConnectionId, MarbleRaceStart GuestStart);

    private sealed record Waiting(string ConnectionId, string PrincipalId, string DisplayName, bool IsGuest, int MapId);

    private sealed class Race
    {
        public Race(string raceId, Waiting host, Waiting guest, int seed)
        {
            RaceId = raceId;
            Host = host;
            Guest = guest;
            Seed = seed;
        }

        public string RaceId { get; }
        public Waiting Host { get; }
        public Waiting Guest { get; }
        public int Seed { get; }

        public Pairing Pairing()
        {
            var host = new MarbleRaceSeat(Host.DisplayName, Host.IsGuest, MarbleRaceRole.Host, true);
            var guest = new MarbleRaceSeat(Guest.DisplayName, Guest.IsGuest, MarbleRaceRole.Guest, true);
            return new Pairing(
                RaceId,
                Host.ConnectionId,
                new MarbleRaceStart(RaceId, MarbleRaceRole.Host, Seed, Host.MapId, GuestMarbleIndex, host, guest),
                Guest.ConnectionId,
                new MarbleRaceStart(RaceId, MarbleRaceRole.Guest, Seed, Host.MapId, GuestMarbleIndex, host, guest));
        }
    }
}
