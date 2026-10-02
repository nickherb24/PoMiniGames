using Azure.Storage.Blobs;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.DataProtection.KeyManagement;
using Microsoft.AspNetCore.DataProtection.Repositories;

namespace PoMiniGames.Infrastructure;

/// <summary>
/// Configures ASP.NET Core Data Protection with a key ring that survives app restarts and
/// multi-instance deployments.
/// </summary>
/// <remarks>
/// <para>
/// The BFF cookies must be encrypted. The framework default key ring is
/// ephemeral (in-memory, per-process), which means a redeploy silently invalidates every
/// signed-in user. This extension pins the key ring to:
/// </para>
/// <list type="bullet">
///   <item><b>Development / Test:</b> the on-disk <c>keys/</c> folder under the app root.</item>
///   <item><b>Production:</b> the shared <c>PoShared</c> storage account's
///         <c>dp-keys</c> blob container, accessed via the web app's system-assigned
///         managed identity (no shared-key credentials).</item>
/// </list>
/// <para>
/// Pattern: Singleton. The data-protection key ring is one process-wide object; this
/// extension registers a single <see cref="IDataProtectionProvider"/> whose lifetime is
/// the application lifetime. Consumers (cookie auth, antiforgery, session state) all
/// pull keys from the same provider, so swapping the backing store affects every
/// protected payload in lockstep.
/// </para>
/// <para>
/// Why a custom <c>IXmlRepository</c>? The official
/// <c>Microsoft.AspNetCore.DataProtection.AzureStorage</c> 1.0.x package pulls transitive
/// .NET Framework-only packages (Microsoft.Data.Edm / Microsoft.Data.OData / System.Spatial)
/// which break the <c>TreatWarningsAsErrors=true</c> build on .NET 10. Using
/// <see cref="AzureBlobXmlRepository"/> keeps the dependency graph clean.
/// </para>
/// </remarks>
internal static class DataProtectionExtensions
{
    /// <summary>Blob container name that holds the data-protection key ring in Production.</summary>
    public const string ProdKeyRingContainer = "dp-keys";

    /// <summary>Adds Data Protection with an environment-aware key ring.</summary>
    /// <param name="services">The service collection.</param>
    /// <param name="env">Host environment (drives dev vs. prod key ring selection).</param>
    /// <param name="storageAccountName">
    /// The storage account that hosts the <see cref="ProdKeyRingContainer"/>. Required in
    /// Production; ignored in non-Production environments.
    /// </param>
    public static IServiceCollection AddPoMiniGamesDataProtection(
        this IServiceCollection services,
        IWebHostEnvironment env,
        string? storageAccountName)
    {
        var builder = services.AddDataProtection()
            .SetApplicationName("PoMiniGames");

        if (env.IsProduction())
        {
            if (string.IsNullOrWhiteSpace(storageAccountName))
            {
                // Fail-fast: a missing storage account in Production is the same shape of
                // bug as a missing Key Vault URI. Boot into a known-broken state so an
                // operator notices, rather than silently falling back to in-memory keys
                // (which would invalidate every signed-in user on next deploy).
                throw new InvalidOperationException(
                    "PoMiniGames:Storage:TableService:AccountName is required in Production " +
                    "to back the data-protection key ring (PoShared storage account, " +
                    $"container '{ProdKeyRingContainer}').");
            }

            var blobUri = new Uri(
                $"https://{storageAccountName}.blob.core.windows.net/{ProdKeyRingContainer}");
            var containerClient = new BlobContainerClient(blobUri, new Azure.Identity.DefaultAzureCredential());

            // Single repository instance shared by both the DI container and the
            // KeyManagementOptions binding. KeyManagementOptions is configured
            // separately inside the host after the container is built (see
            // Program.cs DataProtection wire-up) so we don't need a Configure
            // hook here at all — the host reads the singleton back out of the
            // container. This replaces the previous code that `new`'d a second
            // AzureBlobXmlRepository with a NullLogger inside Configure, which
            // double-enumerated the key blobs on every startup.
            services.AddSingleton(sp => new AzureBlobXmlRepository(
                containerClient,
                sp.GetRequiredService<ILogger<AzureBlobXmlRepository>>()));
        }
        else if (env.IsEnvironment("Test"))
        {
            // Zero-waste: the Test tier simulates the Production fail-fast contracts
            // (auth scheme guards, AutoGuestLogin guard, diag-404 guard) by forcing
            // UseEnvironment("Production") in individual tests. Those boots must NOT
            // try to authenticate against the real PoShared storage account (the
            // developer's CLI credential may be a personal-account token with no
            // rights on the tenant — see AADSTS50020). Use a per-test ephemeral
            // temp-folder key ring so the host starts cleanly and tests stay
            // hermetic. Tests that specifically need persistent keys can override
            // the directory via the PERSISTED_DATA_PROTECTION_KEYS env var.
            var persistedRoot = Environment.GetEnvironmentVariable("PERSISTED_DATA_PROTECTION_KEYS");
            var keysPath = !string.IsNullOrWhiteSpace(persistedRoot)
                ? persistedRoot
                : Path.Combine(Path.GetTempPath(), $"pominigames-test-keys-{Guid.NewGuid():N}");
            Directory.CreateDirectory(keysPath);
            builder.PersistKeysToFileSystem(new DirectoryInfo(keysPath));
        }
        else
        {
            // Local-dev (Development): on-disk key ring under <contentroot>/keys.
            // The folder is created lazily by the framework if missing.
            var keysPath = Path.Combine(env.ContentRootPath, "keys");
            builder.PersistKeysToFileSystem(new DirectoryInfo(keysPath));
        }

        return services;
    }
}
