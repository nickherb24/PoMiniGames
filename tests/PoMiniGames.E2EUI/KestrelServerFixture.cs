using Azure.Data.Tables;
using Azure.Storage.Blobs;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;
using PoMiniGames.AI;
using PoMiniGames.TestUtilities;
using Testcontainers.Azurite;

namespace PoMiniGames.E2EUI;

/// <summary>
/// One hermetic Azurite container shared by every E2E-UI fixture for the lifetime of the
/// test process. Browser E2E is heavy; starting a separate container per fixture multiplied
/// Docker startup cost and starved WASM-boot timing. A single dedicated container (still NOT
/// the shared dev <c>pominigames</c> container, so cross-run state stays clean) keeps the tier
/// hermetic AND fast. Testcontainers' resource reaper removes it on process exit.
/// </summary>
internal static class E2EUiAzurite
{
    private static readonly SemaphoreSlim Gate = new(1, 1);
    private static AzuriteContainer? _container;

    public static async Task<string> GetConnectionStringAsync()
    {
        if (_container is not null)
            return _container.GetConnectionString();

        await Gate.WaitAsync();
        try
        {
            if (_container is null)
            {
                var c = new AzuriteBuilder("mcr.microsoft.com/azure-storage/azurite:3.33.0").Build();
                await c.StartAsync();
                _container = c;
            }
        }
        finally
        {
            Gate.Release();
        }

        return _container.GetConnectionString();
    }
}

/// <summary>
/// Boots the real host on a live Kestrel port so Playwright can drive it over
/// HTTP. <see cref="WebApplicationFactory{TEntryPoint}"/>'s default TestServer is
/// in-memory (no socket), which a real browser cannot reach — so this fixture
/// uses the documented dual-host trick: it builds the in-memory test host the
/// base class expects, then builds and starts a second Kestrel host and exposes
/// its bound address via <see cref="ServerAddress"/>.
/// </summary>
/// <remarks>
/// <para>Pattern: Test Fixture (xUnit) + Server Façade. Storage is fully hermetic:
/// the fixture starts its <b>own</b> Azurite container via Testcontainers (like the
/// integration tier) rather than binding the shared host container on a fixed port.
/// This eliminates stale cross-run state and removes the manual "docker compose up"
/// precondition. Requires Docker and Playwright browsers installed
/// (<c>pwsh bin/Debug/net10.0/playwright.ps1 install</c>). See README.md.</para>
/// </remarks>
public class KestrelServerFixture : WebApplicationFactory<Program>, IAsyncLifetime
{
    private string _azuriteConnectionString = string.Empty;
    private IHost? _kestrelHost;

    /// <summary>
    /// When true, the host boots with <c>FeatureFlags:UseMockData=true</c> so the
    /// "USING MOCK DATA" nav banner renders. Overridden by the mock-data fixture.
    /// </summary>
    protected virtual bool UseMockDataBanner => false;

    public async Task InitializeAsync() =>
        _azuriteConnectionString = await E2EUiAzurite.GetConnectionStringAsync();

    Task IAsyncLifetime.DisposeAsync() => Task.CompletedTask;

    /// <summary>The base URL Playwright should navigate to (e.g. http://127.0.0.1:51234).</summary>
    public string ServerAddress
    {
        get
        {
            EnsureServer();
            return ClientOptions.BaseAddress.ToString();
        }
    }

    private void EnsureServer()
    {
        if (_kestrelHost is null)
            _ = Server; // forces CreateHost() below
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        // E2E-UI tests run under the "Test" environment
        // so the FakeAuth scheme is opt-in (via Auth:EnableFakeAuth below), the
        // DevCookie path is registered for the SPA's auto-guest flow, and
        // StartupSecretValidator skips its secrets check.
        builder.UseEnvironment("Test");

        builder.ConfigureAppConfiguration((_, cfg) =>
        {
            var overrides = new Dictionary<string, string?>(TestBudgetGuard.Overrides);

            // BFF header overrides: enable the FakeAuth scheme so e2e tests can
            // inject identity variations through X-Fake-User / X-Fake-Roles headers.
            overrides["Auth:EnableFakeAuth"] = "true";
            // Browser tests run against the login-gated SPA; auto-sign-in as Guest so
            // the home page renders without a manual auth step.
            overrides["Auth:AutoGuestLogin"] = "true";
            // Mirror Azurite to BOTH TableService and BlobService sections.
            foreach (var (k, v) in TestBudgetGuard.StorageOverrides(_azuriteConnectionString, "pominigames-e2eui"))
            {
                overrides[k] = v;
            }
            // FeatureFlags.UseMockData drives the "USING MOCK DATA" banner — driven
            // by the fixture variant (banner-on vs banner-off) for the two suites.
            overrides["FeatureFlags:UseMockData"] = UseMockDataBanner ? "true" : "false";

            cfg.AddInMemoryCollection(overrides);
        });

        builder.ConfigureTestServices(services =>
        {
            services.AddSingleton(_ => new TableServiceClient(_azuriteConnectionString));
            services.AddSingleton(_ => new BlobServiceClient(_azuriteConnectionString));
        });
    }

    protected override IHost CreateHost(IHostBuilder builder)
    {
        // The in-memory host the base class wires up (kept so DI/seed still runs).
        var testHost = builder.Build();

        // A second host bound to a real, OS-assigned (port 0) Kestrel port for the browser.
        // An explicit dynamic port avoids colliding on the host's default :5000 when multiple
        // fixtures (e.g. the mock-data variant) boot in parallel collections.
        builder.ConfigureWebHost(webHostBuilder => webHostBuilder
            .UseKestrel()
            .UseUrls("http://127.0.0.1:0"));
        _kestrelHost = builder.Build();
        _kestrelHost.Start();

        var addresses = _kestrelHost.Services.GetRequiredService<IServer>()
            .Features.Get<IServerAddressesFeature>()!;
        ClientOptions.BaseAddress = new Uri(addresses.Addresses.First());

        testHost.Start();
        return testHost;
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (disposing)
            _kestrelHost?.Dispose();
    }
}

[CollectionDefinition(Name)]
public sealed class KestrelServerCollection : ICollectionFixture<KestrelServerFixture>
{
    public const string Name = "PoMiniGames.E2EUI";
    // The namespace stays stable for cross-assembly refs.
}

/// <summary>
/// Variant fixture that boots with <c>FeatureFlags:UseMockData=true</c> so UI tests can
/// assert the prominent "USING MOCK DATA" nav banner is injected into the render tree.
/// Separate collection (and separate Azurite container) to keep banner-on / banner-off
/// states fully isolated.
/// </summary>
public sealed class MockDataKestrelServerFixture : KestrelServerFixture
{
    protected override bool UseMockDataBanner => true;
}

[CollectionDefinition(Name)]
public sealed class MockDataKestrelServerCollection : ICollectionFixture<MockDataKestrelServerFixture>
{
    public const string Name = "PoMiniGames.E2EUI.MockData";
    // The namespace stays stable for cross-assembly refs.
}
