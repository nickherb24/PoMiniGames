using System.Security.Cryptography;
using System.Text;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoCabinet;

/// <summary>
/// The one in-memory PoCabinet lobby: whoever arrives first hosts, the next arrivals take the
/// free seats up to eight, the host starts, and optional AI officials fill the rest. The lobby
/// outlives its race — when the race ends it reopens with the same roster, which is what
/// "rematch" means. There are no join codes: everyone who opens the
/// multiplayer page lands in this lobby.
///
/// <para>
/// Seats are keyed by the caller's claim id, not the SignalR connection id. A reconnect gets a
/// new connection id; keying seats on it would turn every network blip into a lost seat. Connection ids are still tracked per player so a player is
/// only dropped once their LAST connection goes.
/// </para>
/// <para>
/// All state sits behind one lock: hub calls arrive on arbitrary threads and the race
/// registry's timer calls <see cref="MarkRaceFinished"/> from its own.
/// </para>
/// </summary>
public sealed class PoCabinetLobbyService
{
    public const int MaxPlayers = PoCabinetCatalog.CarCount;
    public const int MaxBots = 4;
    public const int DefaultBots = 3;

    /// <summary>
    /// Internal id of the lobby's race and its SignalR groups. Never shown to players: one
    /// lobby means at most one race at a time, so a fixed id is enough.
    /// </summary>
    public const string RaceId = "cabinet";

    private readonly object _gate = new();
    private Lobby? _lobby;

    /// <summary>
    /// Take a seat, creating the lobby (caller as host, on <paramref name="trackId"/>) when
    /// nobody is in it. Idempotent for a player already seated (a reconnect or a rematch
    /// return). Null when a race is running or all eight seats are taken.
    /// </summary>
    public Lobby? Join(string playerId, string displayName, bool isGuest, string? trackId = null,
        string? color = null, string? connectionId = null)
    {
        lock (_gate)
        {
            var lobby = _lobby ??= new Lobby(playerId,
                PoCabinetCatalog.IsKnownTrack(trackId) ? PoCabinetCatalog.GetTrack(trackId).Id : PoCabinetCatalog.DefaultTrackId);
            var existing = lobby.Players.FirstOrDefault(p => p.PlayerId == playerId);
            if (existing is not null)
            {
                if (connectionId is not null) existing.Connections.Add(connectionId);
                existing.Disconnected = false;
                if (color is not null) existing.Color = SanitizeColor(color);
                return lobby;
            }
            if (lobby.IsStarted) return null;
            if (lobby.Players.Count >= MaxPlayers) return null;

            // The host is ready by definition; everyone else readies up.
            var player = new LobbyPlayer(playerId, displayName, isGuest, isReady: lobby.HostId == playerId) { Color = SanitizeColor(color) };
            if (connectionId is not null) player.Connections.Add(connectionId);
            lobby.Players.Add(player);
            return lobby;
        }
    }

    /// <summary>Toggle the player's ready flag.</summary>
    public bool ToggleReady(string playerId)
    {
        lock (_gate)
        {
            var player = _lobby is { IsStarted: false } lobby ? lobby.Players.FirstOrDefault(p => p.PlayerId == playerId) : null;
            if (player is null) return false;
            player.IsReady = !player.IsReady;
            return true;
        }
    }

    /// <summary>Host-only: switch the track for the next race.</summary>
    public bool SetTrack(string hostId, string? trackId)
    {
        lock (_gate)
        {
            if (HostedIdle(hostId) is not { } lobby || !PoCabinetCatalog.IsKnownTrack(trackId)) return false;
            lobby.TrackId = PoCabinetCatalog.GetTrack(trackId).Id;
            return true;
        }
    }

    /// <summary>Host-only: how many AI officials fill free seats (0–4).</summary>
    public bool SetBots(string hostId, int count)
    {
        lock (_gate)
        {
            if (HostedIdle(hostId) is not { } lobby) return false;
            lobby.BotCount = Math.Clamp(count, 0, MaxBots);
            return true;
        }
    }

    /// <summary>
    /// True if the host can begin: every seated human is ready and the grid would hold at least
    /// two cars once the AI officials are counted — a lone host with bots on can race.
    /// </summary>
    public bool CanStart(string hostId)
    {
        lock (_gate)
        {
            return _lobby is { } lobby && CanStartLocked(lobby, hostId);
        }
    }

    /// <summary>Mark the lobby started and return it (the caller builds the grid from it).</summary>
    public Lobby? Start(string hostId)
    {
        lock (_gate)
        {
            // CanStartLocked refuses a started lobby, so a second Start is a no-op.
            if (_lobby is not { } lobby || !CanStartLocked(lobby, hostId)) return null;
            lobby.IsStarted = true;
            return lobby;
        }
    }

    /// <summary>
    /// The race ended: reopen the lobby for a rematch. Players who dropped during the race are
    /// removed now; everyone but the host has to ready up again.
    /// </summary>
    public Lobby? MarkRaceFinished()
    {
        lock (_gate)
        {
            if (_lobby is not { } lobby) return null;
            lobby.IsStarted = false;
            foreach (var gone in lobby.Players.Where(p => p.Disconnected).ToList())
            {
                RemoveLocked(lobby, gone.PlayerId);
            }
            if (lobby.Players.Count == 0)
            {
                _lobby = null;
                return null;
            }
            foreach (var p in lobby.Players) p.IsReady = p.PlayerId == lobby.HostId;
            return lobby;
        }
    }

    /// <summary>Remove a player; close the lobby when the last one leaves.</summary>
    public void Leave(string playerId)
    {
        lock (_gate)
        {
            if (_lobby is { } lobby) RemoveLocked(lobby, playerId);
        }
    }

    /// <summary>
    /// A SignalR connection closed. The owning player leaves if that was their last
    /// connection — immediately if the lobby is idle, at race end if a race is running (their
    /// car keeps its grid slot until then). True when the roster changed.
    /// </summary>
    public bool DropConnection(string connectionId)
    {
        lock (_gate)
        {
            var player = _lobby?.Players.FirstOrDefault(p => p.Connections.Contains(connectionId));
            if (_lobby is not { } lobby || player is null) return false;
            player.Connections.Remove(connectionId);
            if (player.Connections.Count > 0) return false;
            if (lobby.IsStarted) player.Disconnected = true;
            else RemoveLocked(lobby, player.PlayerId);
            return true;
        }
    }

    /// <summary>The lobby, or null while nobody is in it.</summary>
    public Lobby? Current
    {
        get
        {
            lock (_gate)
            {
                return _lobby;
            }
        }
    }

    /// <summary>Wire view of the lobby; <paramref name="forPlayerId"/> fills <c>YourSeatId</c>.</summary>
    public PoCabinetLobbyView? View(string? forPlayerId = null)
    {
        lock (_gate)
        {
            if (_lobby is not { } lobby) return null;
            return new PoCabinetLobbyView
            {
                Code = RaceId,
                TrackId = lobby.TrackId,
                BotCount = lobby.BotCount,
                InRace = lobby.IsStarted,
                Players = lobby.Players.Select(p => new PoCabinetLobbySeat
                {
                    SeatId = SeatIdFor(p.PlayerId),
                    DisplayName = p.DisplayName,
                    IsGuest = p.IsGuest,
                    IsReady = p.IsReady,
                    IsHost = p.PlayerId == lobby.HostId,
                    Color = p.Color,
                }).ToList(),
                YourSeatId = forPlayerId is null ? null : SeatIdFor(forPlayerId),
            };
        }
    }

    /// <summary>
    /// The race grid for the started lobby: humans in seat order, then as many AI officials as
    /// asked for and fit. Snapshot taken under the lock so a late leave cannot tear it.
    /// </summary>
    public IReadOnlyList<PoCabinetDriver> BuildGrid()
    {
        lock (_gate)
        {
            if (_lobby is not { } lobby) return [];
            var grid = lobby.Players
                .Select(p => new PoCabinetDriver(p.PlayerId, p.DisplayName, IsPlayer: true,
                    Color: string.IsNullOrEmpty(p.Color) ? "#3a7d44" : p.Color, Personality: null))
                .ToList();
            var roster = PoCabinetPersonality.Roster;
            for (int i = 0; i < EffectiveBots(lobby); i++)
            {
                var o = roster[i];
                grid.Add(new PoCabinetDriver($"bot-{i}", o.Name, IsPlayer: false, o.Color, o.Personality,
                    o.MaxSpeed, o.CorneringSkill, o.Id));
            }
            return grid;
        }
    }

    /// <summary>Opaque seat id: stable for a player, never the claim id itself.</summary>
    public static string SeatIdFor(string playerId)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(RaceId + "|" + playerId));
        return Convert.ToHexString(bytes, 0, 5).ToLowerInvariant();
    }

    private static int EffectiveBots(Lobby lobby) =>
        Math.Min(lobby.BotCount, Math.Max(0, MaxPlayers - lobby.Players.Count));

    private static bool CanStartLocked(Lobby lobby, string hostId)
    {
        if (lobby.IsStarted || lobby.HostId != hostId) return false;
        if (lobby.Players.Count == 0 || lobby.Players.Count + EffectiveBots(lobby) < 2) return false;
        return lobby.Players.All(p => p.IsReady);
    }

    private Lobby? HostedIdle(string hostId) =>
        _lobby is { IsStarted: false } lobby && lobby.HostId == hostId ? lobby : null;

    private void RemoveLocked(Lobby lobby, string playerId)
    {
        lobby.Players.RemoveAll(p => p.PlayerId == playerId);
        if (lobby.Players.Count == 0)
        {
            // A running race keeps its (empty) lobby until MarkRaceFinished, so a newcomer
            // cannot start a second race under the same RaceId while the first still ticks.
            if (!lobby.IsStarted) _lobby = null;
            return;
        }
        // If the host left, promote the first remaining player; they are ready by definition.
        if (lobby.HostId == playerId)
        {
            var newHost = lobby.Players[0];
            lobby.HostId = newHost.PlayerId;
            newHost.IsReady = true;
        }
    }

    /// <summary>Paint names from the paint shop or #rrggbb; anything else becomes empty (client default).</summary>
    private static string SanitizeColor(string? color)
    {
        if (string.IsNullOrWhiteSpace(color) || color.Length > 20) return "";
        return color.All(ch => char.IsAsciiLetterOrDigit(ch) || ch == '#') ? color : "";
    }

    public sealed class Lobby(string hostId, string trackId)
    {
        public string HostId { get; set; } = hostId;
        public string TrackId { get; set; } = trackId;
        public int BotCount { get; set; } = DefaultBots;
        public bool IsStarted { get; set; }
        public List<LobbyPlayer> Players { get; } = new();
    }

    public sealed class LobbyPlayer
    {
        public LobbyPlayer(string playerId, string displayName, bool isGuest, bool isReady)
        {
            PlayerId = playerId;
            DisplayName = displayName;
            IsGuest = isGuest;
            IsReady = isReady;
        }

        /// <summary>Claim-derived identity (never sent to other clients — see <see cref="SeatIdFor"/>).</summary>
        public string PlayerId { get; }
        public string DisplayName { get; }
        public bool IsGuest { get; }
        public bool IsReady { get; set; }
        public string Color { get; set; } = "";
        /// <summary>Live SignalR connections for this player (tabs, reconnects).</summary>
        public HashSet<string> Connections { get; } = new(StringComparer.Ordinal);
        /// <summary>Lost every connection mid-race; removed when the race ends.</summary>
        public bool Disconnected { get; set; }
    }
}
