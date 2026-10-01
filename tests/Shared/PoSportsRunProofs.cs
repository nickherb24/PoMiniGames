using System.Globalization;
using System.Text;

namespace PoMiniGames.TestUtilities;

/// <summary>
/// PoSports solo-run key logs recorded with the real browser engine's modules
/// (<c>js/posports/physics.js</c>, <c>input.js</c>, <c>runlog.js</c>, driven the way
/// <c>game.js</c> drives a human lane), each with the leg times the JS side got.
/// PoSportsRunVerifier must reproduce those times from the log alone — the JS↔C# mirror
/// pinned as data. "sloppy" false-starts, fat-fingers 6% of its keys and clips hurdles;
/// "slow" never jumps at all. Regenerate (don't hand-edit) if the stride model changes
/// on purpose.
/// </summary>
public static class PoSportsRunProofs
{
    public sealed record Proof(string Inputs, double JsSprintSeconds, double JsHurdlesSeconds);

    private static readonly Lazy<Dictionary<string, Proof>> All = new(() =>
        File.ReadAllLines(Path.Combine(AppContext.BaseDirectory, "Fixtures", "posports-run-proofs.txt"))
            .Where(l => l.Length > 0)
            .Select(l => l.Split('\t'))
            .ToDictionary(p => p[0], p => new Proof(p[3],
                double.Parse(p[1], CultureInfo.InvariantCulture),
                double.Parse(p[2], CultureInfo.InvariantCulture))));

    /// <summary>clean (fastest) · sloppy · slow (slowest).</summary>
    public static Proof Get(string name) => All.Value[name];

    /// <summary>
    /// A synthetic log for tests that only need "a valid run of roughly this pace": the four
    /// keys in order, one every <paramref name="ticksPerKey"/> fixed steps, never jumping.
    /// Fewer ticks per key is a faster meet.
    /// </summary>
    public static string Steady(int ticksPerKey)
    {
        var leg = new StringBuilder("0;");
        for (var tick = 0; tick < 5000; tick += ticksPerKey)
        {
            if (tick > 0) leg.Append('.');
            leg.Append(Base36((tick * 5) + (tick / ticksPerKey % 4)));
        }
        return $"{leg}|{leg}";
    }

    private static string Base36(int value)
    {
        const string digits = "0123456789abcdefghijklmnopqrstuvwxyz";
        if (value == 0) return "0";
        var s = "";
        for (; value > 0; value /= 36) s = digits[value % 36] + s;
        return s;
    }
}
