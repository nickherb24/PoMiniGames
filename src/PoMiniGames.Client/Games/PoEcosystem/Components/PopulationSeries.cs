using System.Globalization;
using PoMiniGamesClient.Games.PoEcosystem.Models;

namespace PoMiniGamesClient.Games.PoEcosystem.Components;

/// <summary>
/// Turns the flat population history (<c>[sample * 4 + species]</c>, as the sim worker sends
/// it) into SVG polyline points. Shared by the always-on sparkline and the dashboard chart,
/// which differ only in plot size.
/// </summary>
internal static class PopulationSeries
{
    /// <summary>
    /// Invariant-culture SVG coordinate. A comma decimal separator silently voids the whole
    /// path, so the culture is pinned rather than left to the browser's locale.
    /// </summary>
    /// <remarks>
    /// Kept local to PoEcosystem: it is the only chart-geometry helper the game needs.
    /// </remarks>
    private static string N(double value) => value.ToString("F2", CultureInfo.InvariantCulture);

    /// <summary>Largest count anywhere in the history, floored at 1 so the axis never divides by zero.</summary>
    public static int Max(int[]? history)
    {
        var max = 1;
        if (history is null) return max;
        for (var i = 0; i < history.Length; i++) if (history[i] > max) max = history[i];
        return max;
    }

    /// <summary>
    /// Polyline points for one species over the whole history, scaled into a
    /// <paramref name="width"/> × <paramref name="height"/> box. Samples are thinned to at
    /// most one per horizontal pixel — a 320 px chart cannot show 1 800 of them, and the
    /// string is rebuilt on every render.
    /// </summary>
    public static string? Points(int[]? history, int species, double width, double height, int max)
    {
        if (history is null || history.Length < EcoSpeciesInfo.Count * 2) return null;
        var samples = history.Length / EcoSpeciesInfo.Count;
        var step = Math.Max(1, (int)Math.Ceiling(samples / width));
        var sb = new System.Text.StringBuilder((int)(width * 12));
        for (var k = 0; k < samples; k += step)
        {
            var x = samples == 1 ? 0 : width * k / (samples - 1);
            var y = height - height * history[k * EcoSpeciesInfo.Count + species] / max;
            if (sb.Length > 0) sb.Append(' ');
            sb.Append(N(x)).Append(',').Append(N(y));
        }
        return sb.Length == 0 ? null : sb.ToString();
    }

    /// <summary>
    /// Polylines for every species, scaled to one shared maximum so the series are
    /// comparable — and so the history is scanned for that maximum once per render, not
    /// once per species.
    /// </summary>
    // Returns "" rather than null for an empty series: Razor's parser reads the `?[` of a
    // `string?[]` return type as a null-conditional index and fails to compile.
    public static string[] AllSeries(int[]? history, double width, double height)
    {
        var max = Max(history);
        var series = new string[EcoSpeciesInfo.Count];
        for (var s = 0; s < series.Length; s++) series[s] = Points(history, s, width, height, max) ?? string.Empty;
        return series;
    }

    /// <summary>The spoken form of the current counts, for the chart's aria-live summary.</summary>
    public static string Summary(EcoStats? stats) =>
        stats?.Counts is not { Length: EcoSpeciesInfo.Count } counts
            ? "Population chart, no data yet"
            : $"Year {stats.Year}: " + string.Join(", ", Enumerable.Range(0, EcoSpeciesInfo.Count)
                .Select(s => $"{counts[s]} {EcoSpeciesInfo.PluralOf(s).ToLowerInvariant()}"));
}
