using Microsoft.AspNetCore.SignalR;
using PoMiniGames.Features.Auth;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoBrawl.Online;

/// <summary>
/// Match hub for live PoBrawl 1v1. Each connection joins its room's group and
/// streams <see cref="PoBrawlMatchInput"/>s to the server; the server broadcasts
/// <see cref="PoBrawlMatchState"/>s from the pump and a single
/// <see cref="PoBrawlMatchResult"/> per corner on finish.
/// </summary>
/// <remarks>
/// The group is keyed by the room CODE, not the match id, so a rematch (a new match on the same
/// code) reaches everyone already watching — spectators included — without a re-subscribe.
/// </remarks>
public sealed class PoBrawlMatchHub : Hub
{
    private readonly PoBrawlMatchRegistry _registry;
    private readonly ILogger<PoBrawlMatchHub> _log;

    public PoBrawlMatchHub(PoBrawlMatchRegistry registry, ILogger<PoBrawlMatchHub> log)
    {
        _registry = registry;
        _log = log;
    }

    public static string MatchGroup(string code) => $"pobrawl-match-{code.ToUpperInvariant()}";

    /// <summary>
    /// A drop starts the corner's reconnect grace (see <see cref="PoBrawlMatchService.ReconnectGraceSeconds"/>);
    /// coming back — a SignalR auto-reconnect or a page refresh — is just another JoinMatch.
    /// </summary>
    public override async Task OnDisconnectedAsync(Exception? ex)
    {
        _registry.MatchFor(Context.ConnectionId)?.UnregisterConnection(Context.ConnectionId);
        _registry.UnbindConnection(Context.ConnectionId);
        await base.OnDisconnectedAsync(ex);
    }

    /// <summary>
    /// Join the fight on <paramref name="code"/>. A caller on the roster is pinned to their corner
    /// by claim identity (the lobby and match hubs allocate separate connection ids, so the lobby's
    /// id is no use here); anyone else spectates. Null when no fight is on that code. A seated
    /// caller arriving after the bell gets their result straight away.
    /// </summary>
    public async Task<PoBrawlMatchSnapshot?> JoinMatch(string code)
    {
        if (string.IsNullOrWhiteSpace(code)) return null;
        var match = _registry.Get(code.Trim());
        if (match is null) return null;

        var identity = RequestIdentity.Resolve(Context.User);
        // A reconnect on a live socket (or a rematch) re-pins: drop the old binding first.
        _registry.MatchFor(Context.ConnectionId)?.UnregisterConnection(Context.ConnectionId);
        var seated = match.RegisterConnectionByPrincipal(identity.UserId, Context.ConnectionId);
        _registry.BindConnection(Context.ConnectionId, match.GameCode);
        await Groups.AddToGroupAsync(Context.ConnectionId, MatchGroup(match.GameCode));
        _log.LogInformation("PoBrawl JoinMatch conn={Conn} code={Code} seated={Seated}", Context.ConnectionId, match.GameCode, seated);

        if (seated && match.FinishedAtUtc is not null)
        {
            await Clients.Caller.SendAsync("matchFinished", match.BuildResultFor(Context.ConnectionId));
        }
        return new PoBrawlMatchSnapshot
        {
            MatchId = match.MatchId,
            GameCode = match.GameCode,
            Player1 = new PoBrawlMatchPlayerInfo(match.Player1.DisplayName, match.Player1.Fighter.Id),
            Player2 = new PoBrawlMatchPlayerInfo(match.Player2.DisplayName, match.Player2.Fighter.Id),
            LocalSide = seated ? match.SideFor(Context.ConnectionId) : PoBrawlSide.Player1,
            IsSpectator = !seated,
        };
    }

    public Task SubmitInput(PoBrawlMatchInput input)
    {
        // The match pins the connection's own corner; a spectator's input is refused there.
        _registry.MatchFor(Context.ConnectionId)?.SubmitInput(Context.ConnectionId, input);
        return Task.CompletedTask;
    }

    /// <summary>
    /// After the bell: this corner wants another round. The vote count goes out to the room, and
    /// once both corners have asked, a fresh match starts on the same code with the same fighters
    /// and everyone in the room is told to re-join it.
    /// </summary>
    public async Task RequestRematch()
    {
        var match = _registry.MatchFor(Context.ConnectionId);
        // A swept room (FinishedLinger elapsed, or a rematch already replaced it) can never
        // reach two votes. Throwing — instead of the old silent return — is what lets the
        // caller's UI reset its "waiting for a rematch" state instead of showing it forever.
        if (match is null)
        {
            throw new HubException("That fight has ended and the room is gone — start a new one from the lobby.");
        }
        var agreed = match.VoteRematch(Context.ConnectionId);
        var group = Clients.Group(MatchGroup(match.GameCode));
        if (!agreed)
        {
            await group.SendAsync("matchState", match.Snapshot());
            return;
        }
        var next = _registry.Rematch(match.GameCode);
        if (next is not null) await group.SendAsync("rematch", next.GameCode);
    }

    /// <summary>
    /// Explicit leave (client-initiated, not disconnect). Same as a drop: the corner's grace
    /// clock starts, and it forfeits if it does not come back.
    /// </summary>
    public async Task LeaveMatch()
    {
        var match = _registry.MatchFor(Context.ConnectionId);
        match?.UnregisterConnection(Context.ConnectionId);
        var code = _registry.UnbindConnection(Context.ConnectionId);
        if (code is not null) await Groups.RemoveFromGroupAsync(Context.ConnectionId, MatchGroup(code));
    }
}
