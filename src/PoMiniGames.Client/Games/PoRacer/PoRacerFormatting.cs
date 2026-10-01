namespace PoMiniGamesClient.Games.PoRacer;

internal static class PoRacerFormatting
{
    public static string Time(double seconds) =>
        !double.IsFinite(seconds) || seconds <= 0 || seconds > 3600
            ? "—" : $"{(int)(seconds / 60)}:{seconds % 60:00.000}";

    /// <summary>A lap against a reference lap, e.g. "+0.312" or "−0.045".</summary>
    public static string Delta(double seconds) => (seconds < 0 ? "−" : "+") + Math.Abs(seconds).ToString("0.000");

    public static string MedalLabel(string? medal) => medal switch
    {
        "gold" => "🥇 Gold",
        "silver" => "🥈 Silver",
        "bronze" => "🥉 Bronze",
        _ => "",
    };
}
