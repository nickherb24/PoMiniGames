using Microsoft.AspNetCore.SignalR;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoVoxelStrike;

/// <summary>
/// Drains every active lockstep session once per <see cref="PoVoxelStrikeLockstepService.TickIntervalMs"/>
/// and broadcasts the resulting frame to the session's SignalR group.
/// </summary>
/// <remarks>
/// <para><b>Host-independent pump:</b> a hub method that depends on the host's SignalR
/// connection to fire the timer would silently freeze every peer's input application on a
/// transient host disconnect (the 60s client timeout path clears the lobby). As a hosted
/// service the timer survives a host reconnect — peers see a brief gap in frames, not
/// a dead simulation.</para>
/// </remarks>
public sealed class PoVoxelStrikeLockstepPump : BackgroundService
{
    private readonly PoVoxelStrikeLockstepService _lockstep;
    private readonly IHubContext<PoVoxelStrikeLockstepHub> _hubContext;
    private readonly ILogger<PoVoxelStrikeLockstepPump> _log;

    public PoVoxelStrikeLockstepPump(
        PoVoxelStrikeLockstepService lockstep,
        IHubContext<PoVoxelStrikeLockstepHub> hubContext,
        ILogger<PoVoxelStrikeLockstepPump> log)
    {
        _lockstep = lockstep;
        _hubContext = hubContext;
        _log = log;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var interval = TimeSpan.FromMilliseconds(PoVoxelStrikeLockstepService.TickIntervalMs);
        // Drift-corrected loop: Period is the deadline, not the sleep. Without this,
        // a 1–2 ms drift per tick accumulates to ~80 ms lost over 20 minutes — visible
        // as the simulation gradually falling behind reality under sustained play.
        using var timer = new PeriodicTimer(interval);
        _log.LogInformation("PoVoxelStrike lockstep pump started; tick={Ms}ms",
            PoVoxelStrikeLockstepService.TickIntervalMs);
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await PumpOnceAsync(stoppingToken);
            }
            catch (OperationCanceledException) { break; }
            catch (Exception ex)
            {
                // Never let a single broadcast exception kill the pump — the next tick
                // will pick up the queued inputs and clients will desync-detect at worst.
                _log.LogError(ex, "PoVoxelStrike lockstep pump tick failed; continuing.");
            }

            try
            {
                if (_lockstep.IsIdle)
                {
                    // Idle backoff: the pump starts at process boot
                    // but the co-op game is rarely in play, and a 50ms PeriodicTimer wake
                    // with no session to drain is 20 pointless wakes/sec for the entire
                    // process lifetime. With no session, sleep at 1/10th the tick rate;
                    // the first GetOrCreateSession call lands a frame within 500ms, well
                    // inside lobby/start tolerances. Once a session exists the drift-
                    // corrected PeriodicTimer cadence below takes over again.
                    await Task.Delay(interval * 10, stoppingToken);
                }
                else
                {
                    await timer.WaitForNextTickAsync(stoppingToken);
                }
            }
            catch (OperationCanceledException) { break; }
        }
        _log.LogInformation("PoVoxelStrike lockstep pump stopped.");
    }

    /// <summary>Drain every session and broadcast a frame. Returns the number of frames pushed.</summary>
    public async Task<int> PumpOnceAsync(CancellationToken ct)
    {
        var pushed = 0;
        foreach (var session in _lockstep.Sessions)
        {
            var frame = session.DrainFrame();
            if (frame is null) continue;
            var group = PoVoxelStrikeLockstepService.GroupPrefix + "-" + session.GameCode;
            await _hubContext.Clients.Group(group).SendAsync("frame", frame, ct);
            pushed++;
        }
        return pushed;
    }
}
