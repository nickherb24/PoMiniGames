using System.Text.Json;
using System.Text.Json.Serialization;

namespace PoMiniGames.Features.PoVoxelStrike;

/// <summary>
/// Author-sidecar schema for voxel-painted assets ("Voxel painter").
/// A drop-folder author writes <c>MyAsset.glb.pvx-mat.json</c> next to the GLB to:
/// <list type="bullet">
/// <item>give the palette entries human-readable names ("oak", "ice", "brick") so the
/// asset picker can show them instead of hex codes;</item>
/// <item>override the physics constants the stress solver reads — density,
/// compressive strength, tensile strength per material id.</item>
/// </list>
/// Without the sidecar the asset is still produced; the voxelizer's default "concrete"
/// material applies. A malformed sidecar is logged and skipped — never blocks ingestion.
/// </summary>
public sealed class PvxSidecar
{
    /// <summary>Material id (matches <see cref="PvxPaletteEntry.MaterialId"/> on the wire) → display name + overrides.</summary>
    public List<PvxSidecarMaterial> Materials { get; set; } = new();

    /// <summary>
    /// Optional RGBA → material id map. When present, palette entries whose RGBA is within
    /// the configured tolerance (default 8/255 per channel) are stamped with the named id
    /// instead of the GLB-derived id. Lets an author re-skin without editing the GLB.
    /// </summary>
    public List<PvxSidecarPaletteEntry> PaletteEntries { get; set; } = new();

    /// <summary>Per-channel tolerance for RGBA matching. Defaults to 8/255.</summary>
    public byte Tolerance { get; set; } = 8;

    public sealed class PvxSidecarMaterial
    {
        public byte MaterialId { get; set; }
        public string DisplayName { get; set; } = "";
        /// <summary>Optional — when present overrides the voxelizer's default density.</summary>
        public float? Density { get; set; }
        public float? CompressiveStrength { get; set; }
        public float? TensileStrength { get; set; }
    }

    public sealed class PvxSidecarPaletteEntry
    {
        public byte R { get; set; }
        public byte G { get; set; }
        public byte B { get; set; }
        public byte A { get; set; } = 255;
        public byte MaterialId { get; set; }
        /// <summary>Optional human-readable color name. Not used by the engine yet (v1).</summary>
        public string? DisplayName { get; set; }
    }
}

/// <summary>
/// Parses and validates a sidecar JSON file. Bad inputs return null so the caller can
/// log-and-skip without aborting ingestion (per-file failures are never fatal).
/// </summary>
internal static partial class PvxSidecarLoader
{
    public static PvxSidecar? TryLoad(string sidecarPath, ILogger log)
    {
        try
        {
            var json = File.ReadAllText(sidecarPath);
            var sidecar = JsonSerializer.Deserialize(json, PvxJsonContext.Default.PvxSidecar);
            if (sidecar is null) return null;
            return Validate(sidecar, sidecarPath, log) ? sidecar : null;
        }
        catch (Exception ex)
        {
            Log.BadSidecar(log, sidecarPath, ex);
            return null;
        }
    }

    private static bool Validate(PvxSidecar sidecar, string path, ILogger log)
    {
        var ok = true;
        // MaterialId must fit in a byte (0..255). A sidecar can ship fewer materials than
        // the volume ends up with — voxelizer pads with the default material.
        foreach (var m in sidecar.Materials)
        {
            if (string.IsNullOrWhiteSpace(m.DisplayName))
            {
                Log.MaterialNameMissing(log, path, m.MaterialId);
                ok = false;
            }
            if (m.Density is <= 0)
            {
                Log.MaterialDensityInvalid(log, path, m.MaterialId);
                ok = false;
            }
            if (m.CompressiveStrength is <= 0 || m.TensileStrength is <= 0)
            {
                Log.MaterialStrengthInvalid(log, path, m.MaterialId);
                ok = false;
            }
        }
        foreach (var p in sidecar.PaletteEntries)
        {
            if (p.MaterialId > 16)
            {
                // Material table is u8 in the .pvx format; the strict cap is 256, but a
                // sane author keeps the table small enough to type by hand. > 16 is a
                // sign of confusion (mixing palette-index and material-id).
                Log.PaletteMaterialIdSuspicious(log, path, p.MaterialId);
            }
        }
        return ok;
    }

    internal static partial class Log
    {
        [LoggerMessage(Level = LogLevel.Warning, Message = "PoVoxelStrike sidecar: {Path} malformed; ignored")]
        public static partial void BadSidecar(ILogger logger, string path, Exception ex);

        [LoggerMessage(Level = LogLevel.Warning, Message = "PoVoxelStrike sidecar: {Path} material id={Id} has no DisplayName")]
        public static partial void MaterialNameMissing(ILogger logger, string path, byte id);

        [LoggerMessage(Level = LogLevel.Warning, Message = "PoVoxelStrike sidecar: {Path} material id={Id} density must be > 0")]
        public static partial void MaterialDensityInvalid(ILogger logger, string path, byte id);

        [LoggerMessage(Level = LogLevel.Warning, Message = "PoVoxelStrike sidecar: {Path} material id={Id} strength must be > 0")]
        public static partial void MaterialStrengthInvalid(ILogger logger, string path, byte id);

        [LoggerMessage(Level = LogLevel.Warning, Message = "PoVoxelStrike sidecar: {Path} palette entry references material id={Id} > 16; ignoring")]
        public static partial void PaletteMaterialIdSuspicious(ILogger logger, string path, byte id);
    }
}
