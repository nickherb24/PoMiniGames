using Microsoft.AspNetCore.SignalR;
using PoMiniGames.Features.Auth;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoCabinet;

/// <summary>
/// SignalR hub for a running PoCabinet race, at <c>/pocabinet/race-hub</c>. After the lobby
/// hands off, each client calls <see cref="JoinRace"/> (seated players get their car id,
/// anyone else spectates), streams one numbered <see cref="PoCabinetInput"/> per 30 Hz tick
/// through <see cref="SubmitInput"/>, and receives <c>RaceSnapshot</c> every tick plus one
/// <c>RaceFinished</c>. <see cref="PoCabinetRaceRegistry"/> runs the sim; this is a thin layer.
/// </summary>
public sealed class PoCabinetRaceHub(PoCabinetRaceRegistry registry) : Hub
{
    public async Task<PoCabinetRaceSnapshot> JoinRace(string gameCode)
    {
        var identity = RequestIdentity.Resolve(Context.User);
        if (string.IsNullOrEmpty(identity.UserId))
            throw new HubException("Sign in or continue as a guest to race.");
        var snapshot = registry.Join(gameCode, Context.ConnectionId, identity.UserId)
            ?? throw new HubException("That race is over. Head back to the lobby for a rematch.");
        await Groups.AddToGroupAsync(Context.ConnectionId, PoCabinetRaceRegistry.RaceGroup(gameCode));
        return snapshot;
    }

    /// <summary>One tick of input. The connection's own binding (set by <see cref="JoinRace"/>)
    /// decides which car it drives, so it takes no game code.</summary>
    public Task SubmitInput(PoCabinetInput input)
    {
        registry.SubmitInput(Context.ConnectionId, input);
        return Task.CompletedTask;
    }

    /// <summary>
    /// Round-trip latency probe for the HUD's ping badge. Returns a value so the client's
    /// InvokeAsync genuinely waits for the reply. Takes no arguments — the client used to pass
    /// the game code, which SignalR rejected, so the badge never showed.
    /// </summary>
    public long Ping() => Environment.TickCount64;

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        registry.Leave(Context.ConnectionId);
        await base.OnDisconnectedAsync(exception);
    }
}
