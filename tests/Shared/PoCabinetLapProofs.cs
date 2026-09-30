namespace PoMiniGames.TestUtilities;

/// <summary>
/// Solo lap proofs recorded by the real browser engine (<c>js/pocabinet/physics.js</c> +
/// <c>track.js</c>, driven headlessly through the same loop as <c>race.js</c> soloTick), each
/// with the best lap the JS side timed. PoCabinetLapVerifier must reproduce that time from
/// the input log alone — these are the JS↔C# mirror contract pinned as data. "wild" hits the
/// barrier repeatedly and every run trades paint with the officials, so walls and contacts are
/// both covered. Regenerate (don't hand-edit) if either physics copy changes on purpose.
/// </summary>
public static class PoCabinetLapProofs
{
    public sealed record Proof(string TrackId, bool Wet, string Inputs, double JsBestLap);

    private static readonly Lazy<Dictionary<string, Proof>> All = new(() =>
        File.ReadAllLines(Path.Combine(AppContext.BaseDirectory, "Fixtures", "pocabinet-lap-proofs.txt"))
            .Select(l => l.Split(' '))
            .ToDictionary(p => p[0], p => new Proof(p[1], p[2] == "1", p[3],
                double.Parse(p[4], System.Globalization.CultureInfo.InvariantCulture))));

    /// <summary>capitol-clean · capitol-messy (faster) · capitol-wild (slower) · maralago-clean.</summary>
    public static Proof Get(string name) => All.Value[name];
}
