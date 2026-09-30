using PoMiniGames.Domain.Primitives;
using PoMiniGames.Features.Shared.Lobby;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoBrawl.Online;

/// <summary>
/// The PoBrawl 1v1 room: the shared ready/start lobby capped at two, where BOTH seats
/// (host included) must be ready, and every seat carries a fighter pick. A player joins
/// with the 1P avatar and changes fighter through <see cref="PickFighter"/>; the match
/// service needs both fighters pinned before it can start a fight.
/// </summary>
public sealed class PoBrawlLobbyService : LobbyRoom<PoBrawlLobbyPlayer>
{
    public const string GlobalCode = "BRAWL";

    /// <summary>Hard cap. PoBrawl is 1v1 only — a third arrival is rejected.</summary>
    public const int Cap = 2;

    public PoBrawlLobbyService() : base(GlobalCode, Cap, "Match already in progress")
    {
    }

    /// <summary>
    /// A fresh match code per start, carried to the fight page as <c>?code=</c> — internal
    /// plumbing, never shown. The match registry and match hub key on it, so a rematch keeps it.
    /// </summary>
    public string CreateMatchCode() => WithLock(_ => GameCode = "multi-" + Guid.NewGuid().ToString("N"));

    public (LobbyState<PoBrawlLobbyPlayer> state, string message) Open(
        string connectionId, string principalId, string displayName, bool isGuest, PoBrawlFighter fighter) =>
        OpenCore(connectionId, displayName, isGuest, (name, existing, _) =>
            // A re-join keeps the principal the seat was opened with, so two connections from
            // the same player never both count toward the cap.
            new PoBrawlLobbyPlayer(connectionId, existing?.PrincipalId ?? SanitizePrincipal(principalId), name, isGuest, existing?.IsReady ?? false, existing?.Fighter ?? fighter));

    /// <summary>Change fighter without re-joining. Any fighter is allowed for both seats; the match is unrated for Bob.</summary>
    public (bool ok, string message) PickFighter(string connectionId, PoBrawlFighter fighter) =>
        WithLock(players =>
        {
            if (!players.TryGetValue(connectionId, out var seat)) return (false, "Not in lobby");
            players[connectionId] = seat with { Fighter = fighter };
            return (true, $"{seat.DisplayName} picked {fighter.Name}");
        });

    protected override PoBrawlLobbyPlayer WithReady(PoBrawlLobbyPlayer player, bool ready) =>
        player with { IsReady = ready };

    /// <summary>A fight needs both seats filled and both ready — the host readies up too.</summary>
    protected override bool CanStart(IReadOnlyList<PoBrawlLobbyPlayer> players, string hostConnectionId) =>
        players.Count == Cap && players.All(p => p.IsReady);

    /// <summary>
    /// Lower-cased and trimmed because the value doubles as a Table Storage row key, and
    /// Azure table row keys are case-sensitive. The result ingest keys the Elo rows through
    /// this too, so a seat and its rating row always agree.
    /// </summary>
    internal static string SanitizePrincipal(string raw) =>
        string.IsNullOrWhiteSpace(raw) ? "anon" : raw.Trim().ToLowerInvariant();
}
