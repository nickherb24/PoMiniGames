using FluentAssertions;
using PoMiniGames.Features.PoCabinet;
using PoMiniGames.TestUtilities;
using Xunit;

namespace PoMiniGames.Unit.Features.PoCabinet;

public class PoCabinetLapVerifierTests
{
    /// <summary>
    /// The server re-times a browser-recorded solo race to the browser's own number (the
    /// mirror contract, as data), and refuses what the physics can't have produced: malformed
    /// or out-of-range logs, and a log that never completes a lap.
    /// </summary>
    [Theory]
    [InlineData("capitol-clean")]
    [InlineData("capitol-wild")]
    [InlineData("maralago-clean")]
    [InlineData("playground-run")]
    public void Replay_ReproducesTheBrowserLap_AndRejectsWhatPhysicsCannotProduce(string proofName)
    {
        var proof = PoCabinetLapProofs.Get(proofName);
        var inputs = PoCabinetLapVerifier.Decode(proof.Inputs);
        inputs.Should().NotBeNull();

        // Exactly, not approximately: both copies use only operations IEEE 754 pins to the last
        // bit (their own sin/cos/atan2 included). A 100-car field is chaotic, so one ulp of
        // disagreement becomes a different race, and "close" would not stay close.
        PoCabinetLapVerifier.Replay(proof.TrackId, proof.Wet, inputs!)
            .Should().Be(proof.JsBestLap, "JS and C# physics are line-for-line mirrors");

        // Same log, claimed wet: lower grip, different (valid, re-timed) race — never the dry time.
        PoCabinetLapVerifier.Replay(proof.TrackId, !proof.Wet, inputs!)
            .Should().NotBeApproximately(proof.JsBestLap, 1e-3);

        // Truncated before lap 1 ends: no lap to store.
        PoCabinetLapVerifier.Replay(proof.TrackId, proof.Wet, inputs![..300]).Should().Be(-1);

        PoCabinetLapVerifier.Decode("not base64!").Should().BeNull();
        PoCabinetLapVerifier.Decode(Convert.ToBase64String(new byte[5])).Should().BeNull("not a whole tick");
        // Throttle 2000 (> 1000): a forged log asking for twice the engine.
        PoCabinetLapVerifier.Decode(Convert.ToBase64String([0xD0, 0x07, 0, 0, 0, 0])).Should().BeNull();
    }
}
