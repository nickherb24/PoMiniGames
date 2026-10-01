using System.Globalization;
using PoMiniGames.Shared.Games;
using PoMiniGamesClient.Services.Play;

namespace PoMiniGamesClient.Games.PoRacer;

/// <summary>This browser's PoRacer choices and personal bests. Plain strings in localStorage, validated on the way out.</summary>
internal static class PoRacerPreferences
{
    private const string Key = "PoRacer.Customization";
    public static PoRacerCarCustomization LoadCustomization()
    {
        var parts = LocalStorageService.GetItem<string>(Key)?.Split('|');
        return parts is { Length: 2 } && parts[0].Length == 7 && parts[0][0] == '#' &&
            parts[0].Skip(1).All(Uri.IsHexDigit) && PoRacerCatalog.Liveries.Contains(parts[1])
            ? new(parts[0], parts[1]) : PoRacerCarCustomization.Default;
    }
    public static void SaveCustomization(PoRacerCarCustomization customization) =>
        LocalStorageService.SetItem(Key, $"{customization.ColorHex}|{customization.LiveryPattern}");

    public static string LoadDifficulty() =>
        LocalStorageService.GetItem<string>("PoRacer.Difficulty") is { } tier && PoRacerCatalog.Difficulties.Contains(tier) ? tier : "medium";
    public static void SaveDifficulty(string tier) => LocalStorageService.SetItem("PoRacer.Difficulty", tier);

    public static bool LoadTrial() => LocalStorageService.GetItem<string>("PoRacer.Mode") == "trial";
    public static void SaveTrial(bool trial) => LocalStorageService.SetItem("PoRacer.Mode", trial ? "trial" : "race");

    /// <summary>Best lap per track id, for the tracks that have one.</summary>
    public static Dictionary<string, double> LoadBests() => PoRacerCatalog.Tracks
        .Select(t => (t.Id, Lap: Best(t.Id)))
        .Where(b => b.Lap > 0)
        .ToDictionary(b => b.Id, b => b.Lap);

    private static double Best(string trackId) =>
        double.TryParse(LocalStorageService.GetItem<string>("PoRacer.Best." + trackId), NumberStyles.Float, CultureInfo.InvariantCulture, out var lap)
        && double.IsFinite(lap) && lap > 0 ? lap : 0;

    /// <summary>Keep the lap if it beats the stored one. Returns the best that stood BEFORE this lap (0 = none).</summary>
    public static double SaveBest(string trackId, double lapSeconds)
    {
        var previous = Best(trackId);
        if (previous <= 0 || lapSeconds < previous)
            LocalStorageService.SetItem("PoRacer.Best." + trackId, lapSeconds.ToString("R", CultureInfo.InvariantCulture));
        return previous;
    }
}
