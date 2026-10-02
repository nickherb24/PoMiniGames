using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;

namespace PoMiniGames.Integration;

/// <summary>
/// WebApplicationFactory that keeps the production auth pipeline intact while
/// running in Development so local dev-login endpoints can be tested.
/// Explicitly disables DevBypass to enforce proper authentication for tests.
/// </summary>
public class LocalAuthWebApplicationFactory : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        // Integration tests run under the "Test"
        // environment so the Test branches of StartupSecretValidator + AuthExtensions
        // activate. The DevBypass flag below enforces real-auth flow in tests that
        // opt into this harness.
        builder.UseEnvironment("Test");
        builder.ConfigureAppConfiguration((_, cfg) =>
        {
            cfg.AddInMemoryCollection(new Dictionary<string, string?>
            {
                // Disable DevBypass to enforce auth enforcement in tests
                ["PoMiniGames:DevBypassAuth"] = "false",
            });
        });
    }
}
