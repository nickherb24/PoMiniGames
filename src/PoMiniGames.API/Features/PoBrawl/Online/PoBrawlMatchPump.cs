using Microsoft.AspNetCore.SignalR;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoBrawl.Online;

/// <summary>
/// Drives every running match's simulation tick. Hosted as a singleton service so the
/// tick survives the wiring hub connection leaving. When a match finishes the pump
/// broadcasts each corner its own result once, then leaves the match in the registry for
/// <see cref="PoBrawlMatchRegistry.FinishedLinger"/> (rematch votes, a late reconnect) before
/// sweeping it.
/// </summary>
public sealed class PoBrawlMatchPump : BackgroundService
{
    private readonly PoBrawlMatchRegistry _registry;
    private readonly IHubContext<PoBrawlMatchHub> _hubContext;
    private readonly ILogger<PoBrawlMatchPump> _log;

    public PoBrawlMatchPump(
        PoBrawlMatchRegistry registry,
        IHubContext<PoBrawlMatchHub> hubContext,
        ILogger<PoBrawlMatchPump> log)
    {
        _registry = registry;
        _hubContext = hubContext;
        _log = log;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // PeriodicTimer rather than Delay-then-work: the tick rate no longer drifts by however
        // long the broadcasts took, which matters now that the client paces its puppets on it.
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(1000 / PoBrawlMatchService.TickHz));
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                foreach (var match in _registry.All)
                {
                    try
                    {
                        await TickOnceAsync(match, stoppingToken);
                    }
                    catch (Exception ex) when (ex is not OperationCanceledException)
                    {
                        _log.LogError(ex, "PoBrawl match pump tick failed for {Code}; continuing.", match.GameCode);
                    }
                }
            }
        }
        catch (OperationCanceledException)
        {
            // Shutdown.
        }
    }

    private async Task TickOnceAsync(PoBrawlMatchService match, CancellationToken ct)
    {
        if (match.FinishedAtUtc is { } finishedAt)
        {
            if (DateTimeOffset.UtcNow - finishedAt > PoBrawlMatchRegistry.FinishedLinger) _registry.Remove(match);
            return;
        }
        var snap = match.Tick();
        if (snap is null) return;
        await _hubContext.Clients.Group(PoBrawlMatchHub.MatchGroup(match.GameCode))
            .SendAsync("matchState", snap, ct);
        if (snap.Finished)
        {
            _log.LogInformation("PoBrawl match {Code} finished: {Event}, winner {Winner}", match.GameCode, snap.LastEvent, snap.Winner);
            await BroadcastFinalResultsAsync(match, ct);
        }
    }

    /// <summary>
    /// Send each seated match-hub connection its own result (each client sees its own side as
    /// "local"). NOT the lobby roster's connection ids: those belong to the lobby hub and this
    /// context cannot address them (2026-09-23 — every result used to go nowhere). A corner that
    /// was away at the bell gets its copy from JoinMatch when it comes back.
    /// </summary>
    private async Task BroadcastFinalResultsAsync(PoBrawlMatchService match, CancellationToken ct)
    {
        foreach (var connectionId in match.ConnectionIds)
        {
            var result = match.BuildResultFor(connectionId);
            await _hubContext.Clients.Client(connectionId)
                .SendAsync("matchFinished", result, ct);
        }
    }
}
