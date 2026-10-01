using Microsoft.AspNetCore.SignalR;
using PoMiniGames.Features.Auth;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoRacer;

public sealed class PoRacerRaceHub(PoRacerRaceRegistry registry) : Hub
{
    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        registry.RemoveConnection(Context.ConnectionId);
        await base.OnDisconnectedAsync(exception);
    }

    public async Task<PoRacerRaceSnapshot> JoinRace(string code, bool asPlayer = false, string? trackId = null, PoRacerJoinOptions? options = null)
    {
        var identity = RequestIdentity.Resolve(Context.User);
        if (string.IsNullOrEmpty(identity.UserId)) throw new HubException("Sign in or continue as a guest to race.");
        var player = new PoRacerLobbyPlayer(Context.ConnectionId, identity.DisplayName, identity.IsGuest, true, identity.UserId);
        var race = registry.Join(code, asPlayer, player, trackId, options);
        int? localCarId = null;
        var repainted = false;
        if (asPlayer)
        {
            localCarId = race.BindPlayer(Context.ConnectionId, identity.UserId);
            if (localCarId is null) throw new HubException("You do not have a seat in this race. Return to the lobby.");
            repainted = race.SetPaint(identity.UserId, options?.ColorHex, options?.Livery);
        }
        var oldCode = registry.CodeFor(Context.ConnectionId);
        if (oldCode is not null && !string.Equals(oldCode, race.GameCode, StringComparison.OrdinalIgnoreCase))
            await Groups.RemoveFromGroupAsync(Context.ConnectionId, PoRacerRaceRegistry.RaceGroup(oldCode));
        registry.RegisterConnection(race.GameCode, Context.ConnectionId);
        await Groups.AddToGroupAsync(Context.ConnectionId, PoRacerRaceRegistry.RaceGroup(race.GameCode));
        var snapshot = race.Snapshot();
        snapshot.Static = race.GetStaticWorld();
        snapshot.LocalCarId = localCarId;
        snapshot.Result = race.Result;
        // The drivers already racing got their roster before this car had its paint.
        if (repainted)
            await Clients.OthersInGroup(PoRacerRaceRegistry.RaceGroup(race.GameCode)).SendAsync("raceRoster", snapshot.Static.Roster);
        return snapshot;
    }

    public Task SendInput(PoRacerInput input)
    {
        var code = registry.CodeFor(Context.ConnectionId);
        if (code is not null) registry.GetByCode(code)?.SetInput(Context.ConnectionId, input);
        return Task.CompletedTask;
    }

    /// <summary>Pause or resume a solo race. A shared race has no pause: one driver cannot stop the clock for the rest.</summary>
    public Task SetPaused(bool paused)
    {
        var code = registry.CodeFor(Context.ConnectionId);
        if (code is not null && code.StartsWith("solo-", StringComparison.OrdinalIgnoreCase))
            registry.GetByCode(code)?.SetPaused(Context.ConnectionId, paused);
        return Task.CompletedTask;
    }
}
