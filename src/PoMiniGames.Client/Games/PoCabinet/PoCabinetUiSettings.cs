using System.Globalization;
using System.Text.Json;

namespace PoMiniGamesClient.Games.PoCabinet;

/// <summary>
/// Player-tunable presentation settings for PoCabinet, mirrored from the JS
/// store (<c>wwwroot/js/pocabinet/settings.js</c>). JavaScript owns the disk
/// format (localStorage + sanitisation); this class is the Blazor-side view
/// model the settings panel binds to. Both directions go through the
/// source-generated <see cref="PoCabinetJsonContext"/> (camelCase), so a property
/// here IS its JS key: no hand-written key list left to drift (2026-09-29; it was a
/// GetDouble/GetBool mapper plus an anonymous projection, each spelling every key).
/// </summary>
public sealed class PoCabinetUiSettings
{
    public double MasterVolume { get; set; } = 0.7;
    public bool Muted { get; set; }
    public bool Music { get; set; } = true;
    public double HudScale { get; set; } = 1;
    public bool ReducedMotion { get; set; }
    public bool ColorSafe { get; set; }
    public string Weather { get; set; } = "clear";
    public string TouchControls { get; set; } = "auto";
    public string SteerMode { get; set; } = "pad";
    public double SteerSensitivity { get; set; } = 1;
    public string SteeringAssist { get; set; } = "off";
    public bool AutoBrake { get; set; }
    public bool RacingLine { get; set; }

    /// <summary>Parse the stored JSON; defaults for anything missing, unknown keys ignored.</summary>
    public static PoCabinetUiSettings FromJson(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return new();
        try { return JsonSerializer.Deserialize(json, PoCabinetJsonContext.Default.PoCabinetUiSettings) ?? new(); }
        catch (JsonException) { return new(); }
    }

    /// <summary>The camelCase shape <c>PoCabinet.saveSettings</c>/<c>applySettings</c> read.</summary>
    public JsonElement ToJs() => JsonSerializer.SerializeToElement(this, PoCabinetJsonContext.Default.PoCabinetUiSettings);

    /// <summary>HudScale formatted invariantly for the <c>--pocabinet-hud</c> CSS custom property.</summary>
    public string HudScaleCss => HudScale.ToString(CultureInfo.InvariantCulture);
}
