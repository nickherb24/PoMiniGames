using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace PoMiniGames.Features.PoVoxelStrike;

/// <summary>
/// Startup GLB → .pvx ingestion. One scan per boot — restart-to-ingest is the
/// product contract; there is deliberately no folder watcher.
///
/// Invariants this class owns:
/// <list type="bullet">
/// <item>Identity is the SHA-256 of the source bytes — a rename re-uses the conversion,
/// an edit produces a new one.</item>
/// <item>Output is written to a temp name and atomically renamed, and the catalog only
/// learns about an asset after the rename — a crashed conversion is invisible, never a
/// truncated payload served to a client.</item>
/// <item>Per-file failures are logged and skipped; ingestion never fails host boot.</item>
/// <item>Conversion parallelism is bounded to half the cores so an F1-tier host still
/// serves traffic during a large first-time scan.</item>
/// </list>
/// </summary>
internal sealed partial class AssetIngestionHostedService(
    IOptions<PoVoxelStrikeOptions> options,
    IHostEnvironment environment,
    VoxelAssetCatalog catalog,
    ILogger<AssetIngestionHostedService> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await IngestAsync(stoppingToken);
        }
        catch (OperationCanceledException)
        {
            // Host shutdown mid-scan — nothing partial is visible (atomic rename), nothing to do.
        }
        catch (Exception ex)
        {
            // Belt-and-braces: even a failure outside the per-file guard must not take the host down.
            Log.ScanFailed(logger, ex);
        }
    }

    private async Task IngestAsync(CancellationToken ct)
    {
        var dropDir = ResolvePath(options.Value.AssetDropPath);
        var convertedDir = ResolvePath(options.Value.ConvertedPath);
        Directory.CreateDirectory(dropDir);
        Directory.CreateDirectory(convertedDir);

        IndexExisting(convertedDir);

        var glbFiles = Directory.EnumerateFiles(dropDir, "*.glb", SearchOption.TopDirectoryOnly).ToList();
        if (glbFiles.Count == 0)
        {
            Log.ScanComplete(logger, 0, 0, 0, 0, catalog.All.Count);
            return;
        }

        var converted = 0;
        var skipped = 0;
        var failed = 0;

        using var gate = new SemaphoreSlim(Math.Max(1, Environment.ProcessorCount / 2));
        var work = glbFiles.Select(async glbPath =>
        {
            await gate.WaitAsync(ct);
            try
            {
                switch (await ConvertOneAsync(glbPath, convertedDir, ct))
                {
                    case ConversionOutcome.Converted: Interlocked.Increment(ref converted); break;
                    case ConversionOutcome.Skipped: Interlocked.Increment(ref skipped); break;
                    default: Interlocked.Increment(ref failed); break;
                }
            }
            finally
            {
                gate.Release();
            }
        });
        await Task.WhenAll(work);

        Log.ScanComplete(logger, glbFiles.Count, converted, skipped, failed, catalog.All.Count);
    }

    private enum ConversionOutcome { Converted, Skipped, Failed }

    private async Task<ConversionOutcome> ConvertOneAsync(string glbPath, string convertedDir, CancellationToken ct)
    {
        try
        {
            var hash = await HashFileAsync(glbPath, ct);
            var pvxPath = Path.Combine(convertedDir, hash + ".pvx");
            if (catalog.TryGet(hash, out _) || File.Exists(pvxPath))
            {
                return ConversionOutcome.Skipped;
            }

            var name = Path.GetFileNameWithoutExtension(glbPath);
            // Voxel painter: the optional sidecar <name>.glb.pvx-mat.json sits next
            // to the GLB in the drop folder. A malformed file logs and is skipped — never
            // blocks ingestion. Identity is GLB-content hash, not sidecar, so
            // a stray sidecar edit doesn't invalidate the existing .pvx on a restart.
            var sidecarPath = glbPath + ".pvx-mat.json";
            var sidecar = File.Exists(sidecarPath)
                ? PvxSidecarLoader.TryLoad(sidecarPath, logger)
                : null;
            var volume = await Task.Run(() => GlbVoxelizer.Voxelize(glbPath, options.Value.VoxelResolution, sidecar), ct);

            var tmpPath = pvxPath + ".tmp";
            await using (var stream = File.Create(tmpPath))
            {
                PvxSerializer.Write(volume, stream);
            }
            File.Move(tmpPath, pvxPath, overwrite: true);

            // Build the catalog row from the resolved material table so the manifest can
            // surface author names + override constants. Without a sidecar the table
            // is just the default "concrete" material.
            var materials = BuildAssetMaterials(volume, sidecar);
            var names = sidecar?.Materials.ToDictionary(m => m.MaterialId, m => m.DisplayName)
                ?? new Dictionary<byte, string>();
            var info = new VoxelAssetInfo(hash, name, volume.DimX, volume.DimY, volume.DimZ,
                new FileInfo(pvxPath).Length, pvxPath, materials, names);
            WriteSidecar(info);
            catalog.Add(info);
            Log.Converted(logger, name, hash, volume.DimX, volume.DimY, volume.DimZ, info.SizeBytes);
            return ConversionOutcome.Converted;
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception ex)
        {
            Log.ConversionFailed(logger, Path.GetFileName(glbPath), ex);
            return ConversionOutcome.Failed;
        }
    }

    private static IReadOnlyList<VoxelAssetMaterial> BuildAssetMaterials(PvxVolume volume, PvxSidecar? sidecar)
    {
        var result = new List<VoxelAssetMaterial>(volume.Materials.Count);
        for (var i = 0; i < volume.Materials.Count; i++)
        {
            var m = volume.Materials[i];
            var id = (byte)(i + 1);
            var displayName = sidecar?.Materials.FirstOrDefault(x => x.MaterialId == id)?.DisplayName ?? $"Material {id}";
            result.Add(new VoxelAssetMaterial(id, displayName, m.Density, m.CompressiveStrength, m.TensileStrength));
        }
        return result;
    }

    /// <summary>
    /// Pre-existing conversions from earlier boots go straight into the catalog. The
    /// sidecar carries the display name; if it is missing (crash between the .pvx rename
    /// and the sidecar write) the dims are re-read from the .pvx header and the name
    /// falls back to the hash prefix — the asset stays servable either way.
    /// </summary>
    private void IndexExisting(string convertedDir)
    {
        foreach (var pvxPath in Directory.EnumerateFiles(convertedDir, "*.pvx", SearchOption.TopDirectoryOnly))
        {
            try
            {
                var hash = Path.GetFileNameWithoutExtension(pvxPath);
                var sidecarPath = pvxPath + ".json";
                VoxelAssetInfo info;
                if (File.Exists(sidecarPath)
                    && JsonSerializer.Deserialize(File.ReadAllText(sidecarPath), PvxJsonContext.Default.SidecarMeta) is { } meta)
                {
                    info = new VoxelAssetInfo(hash, meta.Name, meta.DimX, meta.DimY, meta.DimZ,
                        new FileInfo(pvxPath).Length, pvxPath,
                        meta.Materials ?? Array.Empty<VoxelAssetMaterial>(),
                        meta.MaterialNames ?? new Dictionary<byte, string>());
                }
                else
                {
                    using var stream = File.OpenRead(pvxPath);
                    var (dx, dy, dz) = PvxSerializer.ReadDimensions(stream);
                    info = new VoxelAssetInfo(hash, hash[..8], dx, dy, dz, new FileInfo(pvxPath).Length, pvxPath,
                        Array.Empty<VoxelAssetMaterial>(), new Dictionary<byte, string>());
                    WriteSidecar(info);
                }
                catalog.Add(info);
            }
            catch (Exception ex)
            {
                Log.IndexFailed(logger, Path.GetFileName(pvxPath), ex);
            }
        }
    }

    private void WriteSidecar(VoxelAssetInfo info)
    {
        var sidecarPath = info.PayloadPath + ".json";
        var tmp = sidecarPath + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(
            new SidecarMeta(info.Name, info.DimX, info.DimY, info.DimZ, info.Materials, info.MaterialNames),
            PvxJsonContext.Default.SidecarMeta));
        File.Move(tmp, sidecarPath, overwrite: true);
    }

    private string ResolvePath(string path) =>
        Path.IsPathRooted(path) ? path : Path.Combine(environment.ContentRootPath, path);

    private static async Task<string> HashFileAsync(string path, CancellationToken ct)
    {
        await using var stream = File.OpenRead(path);
        var hash = await SHA256.HashDataAsync(stream, ct);
        return Convert.ToHexStringLower(hash);
    }

    internal sealed record SidecarMeta(string Name, int DimX, int DimY, int DimZ,
    IReadOnlyList<VoxelAssetMaterial>? Materials = null,
    IReadOnlyDictionary<byte, string>? MaterialNames = null);

    private static partial class Log
    {
        [LoggerMessage(Level = LogLevel.Information,
            Message = "PoVoxelStrike ingest: converted {Name} ({Hash}) → {DimX}×{DimY}×{DimZ}, {SizeBytes} bytes")]
        public static partial void Converted(ILogger logger, string name, string hash, int dimX, int dimY, int dimZ, long sizeBytes);

        [LoggerMessage(Level = LogLevel.Information,
            Message = "PoVoxelStrike ingest: scan done — {Total} GLB(s): {Converted} converted, {Skipped} up to date, {Failed} failed; catalog now {CatalogCount} asset(s)")]
        public static partial void ScanComplete(ILogger logger, int total, int converted, int skipped, int failed, int catalogCount);

        [LoggerMessage(Level = LogLevel.Warning, Message = "PoVoxelStrike ingest: {File} failed to convert and was skipped")]
        public static partial void ConversionFailed(ILogger logger, string file, Exception ex);

        [LoggerMessage(Level = LogLevel.Warning, Message = "PoVoxelStrike ingest: {File} could not be indexed")]
        public static partial void IndexFailed(ILogger logger, string file, Exception ex);

        [LoggerMessage(Level = LogLevel.Error, Message = "PoVoxelStrike ingest: scan aborted")]
        public static partial void ScanFailed(ILogger logger, Exception ex);
    }
}

[System.Text.Json.Serialization.JsonSerializable(typeof(AssetIngestionHostedService.SidecarMeta))]
[System.Text.Json.Serialization.JsonSerializable(typeof(PvxSidecar))]
internal sealed partial class PvxJsonContext : System.Text.Json.Serialization.JsonSerializerContext;
