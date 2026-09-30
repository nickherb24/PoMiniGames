using Microsoft.Playwright;

namespace PoMiniGames.E2EUI.Features.PoCabinet;

/// <summary>
/// Two browsers, one lobby: PoCabinet has no join codes (2026-09-29), so two identities that
/// open <c>/pocabinet/multi</c> and press Join lobby must land in the same lobby — the first
/// as host (start button), the second seated beside them (ready button) — without a JS error.
///
/// <para>
/// One Fact, inside the 25-method E2E-UI cap. The race hand-off itself is covered by the
/// hub contract test (<c>PoCabinetRaceHubContractTests</c>) and the service contract test
/// (<c>PoCabinetLobbyContractTests</c>); this one exercises the real
/// <c>PoCabinetSession</c> path end to end.
/// </para>
/// </summary>
[Collection(KestrelServerCollection.Name)]
public sealed class PoCabinetTwoBrowserRaceTests(KestrelServerFixture fixture)
{
    [Fact]
    public async Task TwoBrowsers_LandInTheSameLobby_FirstArrivalHosts()
    {
        using var playwright = await Playwright.CreateAsync();
        var launch = BrowserLaunch.Options();
        // SwiftShader for headless WebGL — without it the GameShell falls back
        // to its "needs 3D graphics" panel and the racing canvas never mounts.
        launch.Args = ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"];
        launch.SlowMo = 0;
        await using var browser = await playwright.Chromium.LaunchAsync(launch);

        var pageErrors = new List<string>();
        var host = await JoinLobbyAsync(browser, "cabinet-host", pageErrors);
        await host.Locator(".pocabinet-lobby__start").WaitForAsync(new() { Timeout = 30_000 });

        var guest = await JoinLobbyAsync(browser, "cabinet-guest", pageErrors);
        await guest.Locator(".pocabinet-lobby__ready").WaitForAsync(new() { Timeout = 30_000 });

        // Both browsers see the same two humans: the host's seat plus the guest's.
        foreach (var page in new[] { host, guest })
        {
            await Assertions.Expect(page.Locator(".pocabinet-seat--filled")).ToHaveCountAsync(2, new() { Timeout = 30_000 });
            await Assertions.Expect(page.Locator(".pocabinet-seat--filled .pocabinet-seat__badge")).ToHaveTextAsync("Host");
        }
        (await host.Locator(".pocabinet-lobby__start").CountAsync()).Should().Be(1, "the first arrival hosts");
        (await guest.Locator(".pocabinet-lobby__start").CountAsync()).Should().Be(0, "a later arrival is not the host");

        pageErrors.Should().BeEmpty("neither browser may raise a JS error joining the lobby");
    }

    /// <summary>A fresh context with its own fake identity, on the multiplayer start screen, past Join lobby.</summary>
    private async Task<IPage> JoinLobbyAsync(IBrowser browser, string user, List<string> pageErrors)
    {
        var ctx = await browser.NewContextAsync(new() { ViewportSize = MobileViewport.Portrait });
        // Per-request headers for the app origin only — context-wide headers
        // would force a CORS preflight on the three.js import-map fetches and
        // stall the engine loader. PoEcosystemUiTests uses the same trick.
        var origin = fixture.ServerAddress.TrimEnd('/');
        await ctx.RouteAsync($"{origin}/**", async route =>
        {
            var headers = new Dictionary<string, string>(route.Request.Headers)
            {
                ["X-Fake-User"] = user,
                ["X-Fake-Roles"] = "Player",
            };
            await route.ContinueAsync(new() { Headers = headers });
        });

        var page = await ctx.NewPageAsync();
        page.Console += (_, msg) => { if (msg.Type is "error") Console.WriteLine($"[{user}:error] {msg.Text}"); };
        page.PageError += (_, err) => pageErrors.Add($"{user}: {err}");

        await page.GotoAsync($"{origin}/pocabinet/multi?autoGuest=1",
            new() { WaitUntil = WaitUntilState.NetworkIdle, Timeout = 90_000 });
        var join = page.GetByRole(AriaRole.Button, new() { Name = "Join lobby", Exact = true });
        await join.WaitForAsync(new() { Timeout = 60_000 });
        await join.ClickAsync();
        await page.Locator(".pocabinet-lobby").WaitForAsync(new() { Timeout = 30_000 });
        return page;
    }
}
