using System.Globalization;

namespace PoMiniGames.Features.PoSports;

/// <summary>
/// Re-runs a solo meet from its key log and returns the times the server's own sim gets.
/// A solo submit used to be the client's word, checked only for range and against the
/// play session's age; the stride model is fixed-step and takes nothing but key presses,
/// so the log is the whole run and <see cref="PoSportsSim"/> — the same sim that times
/// online races — can time it.
/// </summary>
/// <remarks>
/// The wire format is a contract with <c>wwwroot/js/posports/runlog.js</c>: two legs joined
/// by <c>|</c>, each <c>F;v.v.v…</c> where <c>F</c> is 1 for a false start on the sprint
/// countdown and each <c>v</c> is base-36 of <c>tick * 5 + code</c> (code 0-3 = sequence
/// ordinal, 4 = jump; tick = fixed steps already run on that leg, so the key applies before
/// that step). It proves the time is one these keys produce, not that a person typed them.
/// </remarks>
public static class PoSportsRunVerifier
{
    /// <summary>The sim's own leg timeout (90 s) in fixed steps; a log cannot address a later tick.</summary>
    public const int MaxTicksPerLeg = 5400;
    /// <summary>Generous: 90 s at 40 keys a second. Bounds the parse, not the player.</summary>
    public const int MaxEventsPerLeg = 3600;
    private const int Codes = 5;

    public sealed record Run(double SprintSeconds, double HurdlesSeconds)
    {
        public double TotalSeconds => SprintSeconds + HurdlesSeconds;
    }

    private sealed record Leg(bool FalseStart, List<(int Tick, int Code)> Events);

    /// <summary>
    /// Replay <paramref name="inputs"/>. Null when the log is missing or malformed, or when
    /// it does not carry the runner across both finish lines.
    /// </summary>
    public static Run? Replay(string? inputs)
    {
        if (string.IsNullOrEmpty(inputs) || inputs.Length > 2 * (MaxEventsPerLeg * 5 + 2) + 1) return null;
        var parts = inputs.Split('|');
        if (parts.Length != 2 || ParseLeg(parts[0]) is not { } sprint || ParseLeg(parts[1]) is not { } hurdles) return null;

        var sim = new PoSportsSim([new PoSportsSim.LaneSetup("replay", "kim", IsAi: false)], seed: 0);
        // A key before the sprint gun holds the runner off the line. The interstitial's
        // false starts are wiped when the hurdles leg resets, on both sims, so only this
        // one is ever on the log.
        if (sprint.FalseStart) sim.HandleSequenceKey(0, 0);
        sim.SkipCountdown();
        if (!RunLeg(sim, sprint, "sprint")) return null;
        sim.AdvanceToHurdlesLeg();
        if (!RunLeg(sim, hurdles, "hurdles")) return null;

        var lane = sim.Lane(0);
        return new Run(lane.SprintSeconds, lane.HurdlesSeconds);
    }

    /// <summary>Feed one leg's keys tick by tick. True once the runner has crossed the line.</summary>
    private static bool RunLeg(PoSportsSim sim, Leg leg, string phase)
    {
        var next = 0;
        // One step short of the sim's timeout: a lane the timeout had to end never finished.
        for (var tick = 0; tick < MaxTicksPerLeg - 1; tick++)
        {
            while (next < leg.Events.Count && leg.Events[next].Tick <= tick)
            {
                var code = leg.Events[next++].Code;
                if (code == 4) sim.HandleJump(0);
                else sim.HandleSequenceKey(0, code);
            }
            sim.Tick(PoSportsConstants.Tick);
            if (sim.Phase != phase) return true;
        }
        return false;
    }

    private static Leg? ParseLeg(string text)
    {
        var semi = text.IndexOf(';');
        if (semi != 1 || text[0] is not ('0' or '1')) return null;
        var events = new List<(int, int)>();
        var body = text.AsSpan(2);
        var lastTick = 0;
        while (!body.IsEmpty)
        {
            var dot = body.IndexOf('.');
            var token = dot < 0 ? body : body[..dot];
            body = dot < 0 ? [] : body[(dot + 1)..];
            if (!TryBase36(token, out var value)) return null;
            var tick = value / Codes;
            // Ticks only ever grow in a real log; a rewind would let a forged one reorder keys.
            if (tick >= MaxTicksPerLeg || tick < lastTick || events.Count >= MaxEventsPerLeg) return null;
            lastTick = tick;
            events.Add((tick, value % Codes));
        }
        return new Leg(text[0] == '1', events);
    }

    private static bool TryBase36(ReadOnlySpan<char> token, out int value)
    {
        value = 0;
        if (token.IsEmpty || token.Length > 5) return false;
        foreach (var c in token)
        {
            var digit = c switch
            {
                >= '0' and <= '9' => c - '0',
                >= 'a' and <= 'z' => c - 'a' + 10,
                _ => -1,
            };
            if (digit < 0) return false;
            value = value * 36 + digit;
        }
        return true;
    }

    /// <summary>The UTC day key the daily-meet board is filed under.</summary>
    public static string DayKey(DateTimeOffset now) => now.UtcDateTime.ToString("yyyyMMdd", CultureInfo.InvariantCulture);
}
