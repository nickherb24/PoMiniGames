using Microsoft.Playwright;

namespace PoMiniGames.E2EUI.Features.PoJevArena;

/// <summary>
/// Journey 1 end to end against the real Kestrel host under the "Test" environment, where the
/// Jev boundary is the deterministic stub (TestBudgetGuard; the stub always takes the first
/// offered option, i.e. melee_charge on the nearest threat, so matches genuinely finish):
/// guest sign-in → Factory preview per ability → draft 10 + 10 → deploy → the match plays to a
/// result → the Black Box scrubs and the inspector follows the scrubbed frame.
/// Screenshots land in artifacts/pojevarena/ for the readability review.
/// One method: this tier holds 25 in total.
/// </summary>
[Collection(KestrelServerCollection.Name)]
public class PoJevArenaUiTests
{
    private readonly KestrelServerFixture _fixture;

    public PoJevArenaUiTests(KestrelServerFixture fixture) => _fixture = fixture;

    [Fact]
    public async Task Journey_DraftDeployWatchAndScrub()
    {
        var shots = Path.Combine("artifacts", "pojevarena");
        Directory.CreateDirectory(shots);

        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync(BrowserLaunch.Options());
        var context = await browser.NewContextAsync(new BrowserNewContextOptions
        {
            ViewportSize = new ViewportSize { Width = 1440, Height = 900 },
        });
        // No context-wide fake-auth headers: they ride along on the MSAL CDN script and fail its CORS
        // preflight (a harness error, not the page's). ?autoGuest=1 below signs the browser in.
        var page = await context.NewPageAsync();
        var errors = new List<string>();
        // Generic "Failed to load resource" console lines are covered, with their URL, by the
        // response hook. The play-session mint is excluded: under ?autoGuest=1 it races the guest
        // sign-in (its antiforgery token predates the identity) and 403s on every game page — a
        // known framework issue, tolerated by PlaySessionService, not this page's.
        page.Console += (_, msg) => { if (msg.Type is "error" && !msg.Text.StartsWith("Failed to load resource", StringComparison.Ordinal)) errors.Add(msg.Text); };
        page.PageError += (_, err) => errors.Add(err);
        page.Response += (_, r) =>
        {
            if (r.Status >= 400 && !r.Url.Contains("/api/play/sessions/", StringComparison.Ordinal))
                errors.Add($"HTTP {r.Status} {r.Request.Method} {r.Url}");
        };

        var origin = _fixture.ServerAddress.TrimEnd('/');
        await page.GotoAsync($"{origin}/pojevarena/1player?autoGuest=1",
            new PageGotoOptions { WaitUntil = WaitUntilState.NetworkIdle, Timeout = 60_000 });

        await page.GetByRole(AriaRole.Button, new() { Name = "Start drafting" }).ClickAsync(new() { Timeout = 30_000 });
        await page.Locator(".jev-add--blue").Nth(4).WaitForAsync(new() { Timeout = 30_000 });
        (await page.Locator(".jev-status").InnerTextAsync()).Should().Contain("Jev ready", "the Test host serves the Jev stub");

        // Factory (a drawer over the library): one preview capture per ability chip, so every
        // ability's wind-up/stance is reviewable.
        await page.GetByRole(AriaRole.Button, new() { Name = "New creature" }).ClickAsync();
        var factory = page.Locator(".jev-factory");
        foreach (var (label, id) in new[]
                 {
                     ("Spit glob", "spit_glob"), ("Hurl boulder", "hurl_boulder"), ("Mend bolt", "mend_bolt"),
                     ("Shield brace", "shield_brace"), ("Hard shell", "hard_shell"), ("Dodge dash", "dodge_dash"),
                 })
        {
            await factory.Locator(".jev-chip-pick", new() { HasText = label }).ClickAsync();
            await page.WaitForTimeoutAsync(1_200);
            await page.Locator(".jev-factory__preview").ScreenshotAsync(new() { Path = Path.Combine(shots, $"factory-{id}.png") });
        }
        await factory.GetByRole(AriaRole.Button, new() { Name = "Close" }).ClickAsync();

        // Draft: the five presets twice into each side with the per-card + Blue / + Red buttons.
        for (var i = 0; i < 10; i++)
        {
            await page.Locator(".jev-add--blue").Nth(i % 5).ClickAsync();
            await page.Locator(".jev-add--red").Nth(i % 5).ClickAsync();
        }
        (await page.Locator(".jev-team--blue .jev-slot:not(.is-empty)").CountAsync()).Should().Be(10);
        (await page.Locator(".jev-team--red .jev-slot:not(.is-empty)").CountAsync()).Should().Be(10);
        await page.ScreenshotAsync(new() { Path = Path.Combine(shots, "draft.png") });

        await page.GetByRole(AriaRole.Button, new() { Name = "Deploy battle" }).ClickAsync();
        await page.WaitForFunctionAsync("() => (window.PoJevArena?.state()?.frames ?? 0) > 300", null,
            new() { Timeout = 60_000 });
        // The battle runs full screen; holding Tab lays the stat HUD over the arena.
        await page.ScreenshotAsync(new() { Path = Path.Combine(shots, "battle.png") });
        await page.Keyboard.DownAsync("Tab");
        await page.Locator(".jev-root[data-stats='on'] .jev-inspector--blue").WaitForAsync(new() { Timeout = 5_000 });
        await page.ScreenshotAsync(new() { Path = Path.Combine(shots, "battle-stats.png") });
        (await page.Locator(".jev-inspector--blue").InnerTextAsync()).Should().Contain("melee_charge",
            "the blue inspector shows the distribution the stub returned");
        await page.Keyboard.UpAsync("Tab");
        await page.Locator(".jev-root[data-stats='off']").WaitForAsync(new() { Timeout = 5_000 });


        await page.WaitForFunctionAsync("() => window.PoJevArena?.state()?.over === true", null,
            new() { Timeout = 240_000, PollingInterval = 500 });
        // The whistle plays the kill cam and the victory ceremony (~7 s) before the result.
        await page.WaitForTimeoutAsync(2_500);
        await page.ScreenshotAsync(new() { Path = Path.Combine(shots, "killcam.png") });
        // The match ends on the shared end-of-game modal: the result, the MVP, one way out.
        var modal = page.Locator("dialog.gps-modal[open]");
        await modal.WaitForAsync(new() { Timeout = 20_000 });
        (await modal.InnerTextAsync()).Should().MatchRegex("(Blue wins|Red wins|Draw)").And.Contain("MVP");
        (await modal.Locator("footer button").CountAsync()).Should().Be(1, "every game ends on one button");
        await page.ScreenshotAsync(new() { Path = Path.Combine(shots, "result.png") });

        // "Review the match" steps past the modal to the debrief and the Black Box.
        await modal.GetByRole(AriaRole.Button, new() { Name = "Review the match" }).ClickAsync();
        var result = page.Locator(".jev-resultbar");
        await result.WaitForAsync(new() { Timeout = 20_000 });
        (await result.InnerTextAsync()).Should().MatchRegex("(Blue wins|Red wins|Draw)").And.Contain("MVP");

        // Jev debrief: shown first after the whistle, one plain-language card per team, with
        // "Jump" links that open the Black Box on that moment.
        var debrief = page.Locator(".jev-debrief");
        await debrief.WaitForAsync(new() { Timeout = 10_000 });
        var story = await debrief.InnerTextAsync();
        story.Should().Contain("Blue played").And.Contain("Red played").And.Contain("melee charge",
            "the stub always charges, and the debrief should say so");
        await page.ScreenshotAsync(new() { Path = Path.Combine(shots, "debrief.png"), FullPage = true });
        await debrief.GetByRole(AriaRole.Button, new() { Name = "Show" }).First.ClickAsync();
        await page.Locator("#jev-bb-slider").WaitForAsync(new() { Timeout = 10_000 });

        // Black Box: scrubbing moves the inspector to the recorded frame.
        var before = await page.Locator(".jev-inspector--blue").InnerTextAsync();
        await page.Locator("#jev-bb-slider").EvaluateAsync(
            "s => { s.value = Math.floor(s.max * 0.3); s.dispatchEvent(new Event('input', { bubbles: true })); }");
        await page.WaitForFunctionAsync(
            "b => document.querySelector('.jev-inspector--blue')?.innerText !== b", before, new() { Timeout = 10_000 });
        await page.ScreenshotAsync(new() { Path = Path.Combine(shots, "blackbox.png") });

        errors.Should().BeEmpty("the arena should run without console errors");
    }
}
