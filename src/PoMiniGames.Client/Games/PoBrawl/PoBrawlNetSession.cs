using Microsoft.AspNetCore.SignalR.Client;
using PoMiniGames.Shared.Games;
using PoMiniGamesClient.Services.Http;

namespace PoMiniGamesClient.Games.PoBrawl;

/// <summary>
/// The client half of one online PoBrawl room on the match hub: join (or re-join) the fight on a
/// code, stream the local corner's inputs, and surface the snapshots, the result and the rematch.
/// <see cref="PoBrawlPage"/> hosts it in online mode and hands each snapshot to the arena engine,
/// which plays the fight as a puppet of them (wwwroot/js/pobrawl/netplay.js).
/// </summary>
/// <remarks>
/// A reconnect — SignalR's automatic one, or a page refresh on <c>/pobrawl/online?code=…</c> —
/// is just <c>JoinMatch</c> again: the server re-pins the corner by claim identity and its
/// forfeit clock stops. A corner that stays away past the grace window forfeits.
/// </remarks>
public sealed class PoBrawlNetSession : IAsyncDisposable
{
    private readonly ApiEndpoints _endpoints;
    private readonly List<IDisposable> _subs = [];
    private HubConnection? _hub;
    private long _sequence;

    public PoBrawlNetSession(ApiEndpoints endpoints) => _endpoints = endpoints;

    public string Code { get; private set; } = "";
    /// <summary>Who is fighting and which corner (if any) is ours. Replaced on every join.</summary>
    public PoBrawlMatchSnapshot? Snapshot { get; private set; }
    public PoBrawlMatchState? State { get; private set; }
    public HubConnectionState ConnectionState => _hub?.State ?? HubConnectionState.Disconnected;

    /// <summary>A (re-)join answered: a new snapshot, or null when no fight is on the code.</summary>
    public event Action<PoBrawlMatchSnapshot?>? Joined;
    public event Action<PoBrawlMatchState>? StateReceived;
    public event Action<PoBrawlMatchResult>? Finished;
    /// <summary>Both corners asked for a rematch and the server started it; re-join to get the new fight.</summary>
    public event Action? RematchStarted;
    public event Action<HubConnectionState>? ConnectionChanged;

    public async Task<PoBrawlMatchSnapshot?> ConnectAsync(string code)
    {
        Code = code.Trim().ToUpperInvariant();
        _hub = HubConnectionFactory.Create(_endpoints.Hub("pobrawl/match-hub"));
        _subs.Add(_hub.On<PoBrawlMatchState>("matchState", s =>
        {
            // Snapshots of the fight we joined only: a rematch's first ticks can race its "rematch" call.
            if (Snapshot is not null && s.MatchId != Snapshot.MatchId) return;
            State = s;
            StateReceived?.Invoke(s);
        }));
        _subs.Add(_hub.On<PoBrawlMatchResult>("matchFinished", r =>
        {
            if (Snapshot is null || r.MatchId == Snapshot.MatchId) Finished?.Invoke(r);
        }));
        _subs.Add(_hub.On<string>("rematch", _ => RematchStarted?.Invoke()));
        _hub.Reconnecting += _ => { ConnectionChanged?.Invoke(HubConnectionState.Reconnecting); return Task.CompletedTask; };
        _hub.Reconnected += async _ =>
        {
            ConnectionChanged?.Invoke(HubConnectionState.Connected);
            try { await JoinAsync(); } catch { /* the next reconnect or the forfeit clock settles it */ }
        };
        _hub.Closed += _ => { ConnectionChanged?.Invoke(HubConnectionState.Disconnected); return Task.CompletedTask; };
        await _hub.StartAsync();
        ConnectionChanged?.Invoke(_hub.State);
        return await JoinAsync();
    }

    /// <summary>Join (or re-join) the fight on <see cref="Code"/>.</summary>
    public async Task<PoBrawlMatchSnapshot?> JoinAsync()
    {
        if (_hub is null) return null;
        var snapshot = await _hub.InvokeAsync<PoBrawlMatchSnapshot?>("JoinMatch", Code);
        Snapshot = snapshot;
        _sequence = 0;
        Joined?.Invoke(snapshot);
        return snapshot;
    }

    /// <summary>
    /// A held-key change from the arena ('left' | 'right' | 'block' | 'idle'). Screen-relative:
    /// 'right' walks the left corner (P1) in and the right corner out.
    /// </summary>
    public Task SendHeldAsync(string state)
    {
        var towardRight = Snapshot?.LocalSide != PoBrawlSide.Player2;
        return SendAsync(state switch
        {
            "block" => PoBrawlMatchAction.Block,
            "right" => towardRight ? PoBrawlMatchAction.MoveForward : PoBrawlMatchAction.MoveBack,
            "left" => towardRight ? PoBrawlMatchAction.MoveBack : PoBrawlMatchAction.MoveForward,
            _ => PoBrawlMatchAction.Idle,
        });
    }

    /// <summary>An attack press ('punch' | 'kick' | 'special'); the server buffers one behind the cooldown.</summary>
    public Task SendPressAsync(string attack) => attack switch
    {
        "punch" => SendAsync(PoBrawlMatchAction.Punch),
        "kick" => SendAsync(PoBrawlMatchAction.Kick),
        "special" => SendAsync(PoBrawlMatchAction.Special),
        _ => Task.CompletedTask,
    };

    private async Task SendAsync(PoBrawlMatchAction action)
    {
        if (_hub is not { State: HubConnectionState.Connected } || Snapshot is not { IsSpectator: false }) return;
        try
        {
            await _hub.InvokeAsync("SubmitInput", new PoBrawlMatchInput
            {
                ActorSide = Snapshot.LocalSide,
                Action = action,
                Sequence = ++_sequence,
            });
        }
        catch
        {
            // Dropped mid-fight: the reconnect re-joins, and the server let go of the held keys.
        }
    }

    public async Task RequestRematchAsync()
    {
        if (_hub is { State: HubConnectionState.Connected }) await _hub.InvokeAsync("RequestRematch");
    }

    public async ValueTask DisposeAsync()
    {
        var hub = _hub;
        _hub = null;
        foreach (var s in _subs) s.Dispose();
        _subs.Clear();
        if (hub is null) return;
        try { await hub.InvokeAsync("LeaveMatch"); } catch { /* already gone */ }
        try { await hub.DisposeAsync(); } catch { /* already gone */ }
    }
}
