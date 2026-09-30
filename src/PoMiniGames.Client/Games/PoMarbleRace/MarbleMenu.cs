using System.Text.Json.Serialization;

namespace PoMiniGamesClient.Games.PoMarbleRace;

/// <summary>
/// What the intro card offers, as reported by <c>PoMarbleRace.menu()</c> (wwwroot/js/pomarblerace/
/// index.js). The engine owns all of it — maps.js the track list, marbles.js the skins and
/// weights, localStorage the stats — so the page describes nothing itself.
/// </summary>
public sealed class MarbleMenu
{
    public MarbleMapOption[] Maps { get; set; } = [];
    public int DefaultMap { get; set; } = 2;
    public MarbleSkinOption[] Skins { get; set; } = [];
    public MarbleWeightOption[] Weights { get; set; } = [];
    public int Best { get; set; }
    public Dictionary<string, MarbleTrackStat> Stats { get; set; } = [];
    public string Skin { get; set; } = "swirl";
    public string Weight { get; set; } = "balanced";
}

public sealed class MarbleMapOption
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public string Blurb { get; set; } = "";
    /// <summary>How the map was built (code generator, Blender by hand, Blender by script).</summary>
    public string Made { get; set; } = "";
    /// <summary>Vertices the map renders — measured, see maps.js.</summary>
    public int Vertices { get; set; }
}

public sealed class MarbleSkinOption
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    /// <summary>Best run score that unlocks it.</summary>
    public int Need { get; set; }
}

public sealed class MarbleWeightOption
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Hint { get; set; } = "";
}

public sealed class MarbleTrackStat
{
    public int Races { get; set; }
    public int Top10 { get; set; }
    public int Wins { get; set; }
    public int BestPlace { get; set; }
    public double BestTime { get; set; }
}

/// <summary>Source-generated, so the menu survives the WASM trim without reflection metadata.</summary>
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(MarbleMenu))]
internal sealed partial class MarbleMenuJsonContext : JsonSerializerContext;
