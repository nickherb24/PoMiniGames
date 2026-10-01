namespace PoMiniGames.TestUtilities;

/// <summary>
/// Solo lap proofs recorded by the real browser engine (<c>js/pocabinet/physics.js</c> +
/// <c>track.js</c>, driven headlessly through the same loop as <c>race.js</c> soloTick), each
/// with the best lap the JS side timed. PoCabinetLapVerifier must reproduce that time from
/// the input log alone — these are the JS↔C# mirror contract pinned as data. Every run is the
/// full 100-car solo race (the player from grid slot 50), so the AI, the grid and the hull
/// contacts are all in the replay; "wild" also throws itself at the barrier every eight
/// seconds. Regenerate (don't hand-edit) if either physics copy changes on purpose.
/// </summary>
public static class PoCabinetLapProofs
{
    public sealed record Proof(string TrackId, bool Wet, string Inputs, double JsBestLap);

    private static readonly Lazy<Dictionary<string, Proof>> All = new(() =>
        File.ReadAllLines(Path.Combine(AppContext.BaseDirectory, "Fixtures", "pocabinet-lap-proofs.txt"))
            .Select(l => l.Split(' '))
            .ToDictionary(p => p[0], p => new Proof(p[1], p[2] == "1", p[3],
                double.Parse(p[4], System.Globalization.CultureInfo.InvariantCulture))));

    /// <summary>capitol-clean · capitol-messy (faster) · capitol-wild (slower) · maralago-clean ·
    /// playground-run (point-to-point: one lap that ends at the finish knot, the field parking past it).</summary>
    public static Proof Get(string name) => All.Value[name];
}
