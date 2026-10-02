namespace PoMiniGames.Features.PoVoxelStrike;

/// <summary>
/// Configuration for the PoVoxelStrike asset pipeline. Paths are resolved against the
/// host content root when relative; deployed environments override <see cref="ConvertedPath"/>
/// with an absolute writable location because WEBSITE_RUN_FROM_PACKAGE=1 mounts the
/// deployment package read-only (the drop folder ships inside the package, the converted
/// output cannot).
/// </summary>
public sealed class PoVoxelStrikeOptions
{
    public const string SectionName = "PoVoxelStrike";

    /// <summary>Folder scanned for author-supplied .glb files on startup.</summary>
    public string AssetDropPath { get; set; } = "App_Data/povoxelstrike/drop";

    /// <summary>Folder the converted .pvx volumes (and their .json sidecars) are written to.</summary>
    public string ConvertedPath { get; set; } = "App_Data/povoxelstrike/converted";

    /// <summary>
    /// Voxel count along the model's longest axis. Fixed detail is a product decision,
    /// so this is a single knob rather than a per-asset setting.
    /// </summary>
    public int VoxelResolution { get; set; } = 64;
}
