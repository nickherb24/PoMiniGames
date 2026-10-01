using FluentAssertions;
using PoMiniGames.Features.PoSports;
using PoMiniGames.TestUtilities;

namespace PoMiniGames.Integration;

/// <summary>
/// The solo-run verifier against key logs recorded by the browser engine. Hermetic (no
/// Docker, no host) — it lives in the Integration tier beside PoSportsRaceServiceTests
/// because the Unit tier is at its 100-method ceiling.
/// </summary>
public sealed class PoSportsRunVerifierTests
{
    [Fact]
    public void Replay_ReproducesTheBrowserEnginesTimes_AndRejectsWhatIsNotARun()
    {
        // The mirror: the server's sim, fed the same keys on the same ticks, times each leg
        // exactly as physics.js did. Both run the same doubles through the same operations,
        // so this is equality to rounding noise, not a tolerance band.
        foreach (var name in new[] { "clean", "sloppy", "slow" })
        {
            var proof = PoSportsRunProofs.Get(name);
            var run = PoSportsRunVerifier.Replay(proof.Inputs);
            run.Should().NotBeNull($"the '{name}' log is a complete run");
            run!.SprintSeconds.Should().BeApproximately(proof.JsSprintSeconds, 1e-9, $"'{name}' sprint");
            run.HurdlesSeconds.Should().BeApproximately(proof.JsHurdlesSeconds, 1e-9, $"'{name}' hurdles");
        }

        // A faster cadence is a faster meet — the helper the HTTP tests lean on.
        PoSportsRunVerifier.Replay(PoSportsRunProofs.Steady(3))!.TotalSeconds
            .Should().BeLessThan(PoSportsRunVerifier.Replay(PoSportsRunProofs.Steady(8))!.TotalSeconds);

        // Not runs: nothing, garbage, one leg, keys that never reach the line, a rewound
        // clock, a tick past the leg timeout, and an out-of-alphabet token.
        PoSportsRunVerifier.Replay(null).Should().BeNull();
        PoSportsRunVerifier.Replay("").Should().BeNull();
        PoSportsRunVerifier.Replay("hello").Should().BeNull();
        PoSportsRunVerifier.Replay("0;0.6.c.i").Should().BeNull();
        PoSportsRunVerifier.Replay("0;0.6.c.i|0;0.6.c.i").Should().BeNull("four keys do not carry a runner 100 m");
        var clean = PoSportsRunProofs.Get("clean").Inputs;
        PoSportsRunVerifier.Replay("0;a0.5" + clean[3..]).Should().BeNull("ticks must never go backwards");
        PoSportsRunVerifier.Replay("0;zzzz|0;0").Should().BeNull();
        PoSportsRunVerifier.Replay("0;0.Q.1|0;0").Should().BeNull();
    }
}
