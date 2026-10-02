// filepath: tests/E2EUI/MobileViewport.cs
using Microsoft.Playwright;

namespace PoMiniGames.E2EUI;

/// <summary>
/// Mobile viewport constants for the E2E-UI tier. The platform is mobile-first;
/// every browser MUST be opened at a portrait phone viewport so layout assertions
/// exercise the production render path, not the desktop fallback.
/// </summary>
/// <remarks>
/// <b>Mobile-first rule.</b> <c>browser.NewPageAsync()</c> without a viewport override
/// leaves Chromium at its default 1280×720 desktop layout. That layout differs from the
/// production mobile render tree in CSS-grid order, top-bar density, and chip wrap behaviour
/// — so a "mobile-first smoke" would really be a desktop test. Pinning the
/// viewport at the canonical phone dimensions (iPhone 14 logical resolution) makes
/// the suite honest about what it covers.
/// </remarks>
public static class MobileViewport
{
    /// <summary>iPhone 14 logical portrait dimensions.</summary>
    public static readonly ViewportSize Portrait = new() { Width = 390, Height = 844 };

    /// <summary>Hard ceiling — any wider than this is treated as desktop. Asserted
    /// by <see cref="MobileViewportGuard"/> before navigation.</summary>
    public const int MaxPortraitWidth = 414;
}
