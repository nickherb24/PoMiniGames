using System.Security.Claims;

namespace PoMiniGames.Features.Auth;

/// <summary>
/// The pure rules of a development sign-in: how a request (or a display name) becomes a
/// normalised <see cref="AuthenticatedUserProfile"/>, and how that profile becomes claims.
/// Lifted out of the endpoint lambda so the sanitisation, ANON-suffixing, and claim shape are
/// exercised directly — the only HTTP-bound step (issuing the cookie) stays in the endpoint.
/// </summary>
/// <remarks>
/// Pattern: extracted deep module. The endpoint becomes a thin adapter over this intake; the
/// behaviour worth testing now sits behind one small interface instead of inside a request handler.
/// </remarks>
public static class DevLoginIntake
{
    /// <summary>Builds a normalised dev profile from an optional request body and/or display name.</summary>
    public static AuthenticatedUserProfile BuildProfile(DevLoginRequest? request, string? userName)
    {
        var fallbackName = string.IsNullOrWhiteSpace(userName) ? "Local Developer" : "Dev Admin";
        var rawName = request?.DisplayName ?? userName;
        var displayName = SanitizeDisplayName(rawName, fallbackName);

        // Every dev login gets a random 6-digit suffix so two tabs of the
        // same browser — or two kiosks auto-spawning "Guest" — produce distinct
        // identities. Without it, several Couple Quiz tabs in one browser
        // would collide on one name and the server's name-keyed session
        // would merge them into one player. With a per-login suffix, "Alice" becomes
        // "Alice-463443" on tab 1, "Alice-781029" on tab 2, and the leaderboard
        // distinguishes them automatically.
        var suffix = Random.Shared.Next(100_000, 999_999);
        if (string.Equals(displayName, "ANON", StringComparison.OrdinalIgnoreCase))
        {
            displayName = $"ANON{suffix}";
        }
        else
        {
            displayName = $"{displayName}-{suffix}";
        }

        var slug = displayName.ToLowerInvariant().Replace(" ", "-", StringComparison.Ordinal);
        var userId = string.IsNullOrWhiteSpace(request?.UserId) ? $"dev-{slug}" : request!.UserId!.Trim();
        var email = string.IsNullOrWhiteSpace(request?.Email) ? $"{slug}@local.dev" : request!.Email!.Trim();
        return new AuthenticatedUserProfile(userId, displayName, email);
    }

    /// <summary>The claim set a dev session carries — mirrors the shape real Microsoft tokens produce.</summary>
    public static Claim[] BuildClaims(AuthenticatedUserProfile profile) =>
    [
        new Claim("oid", profile.UserId),
        new Claim(ClaimTypes.NameIdentifier, profile.UserId),
        new Claim(ClaimTypes.Name, profile.DisplayName),
        new Claim("name", profile.DisplayName),
        new Claim("preferred_username", profile.Email ?? string.Empty),
        new Claim(ClaimTypes.Email, profile.Email ?? string.Empty),
    ];

    private static string SanitizeDisplayName(string? rawName, string fallback)
    {
        var source = string.IsNullOrWhiteSpace(rawName) ? fallback : rawName.Trim();
        var cleaned = new string(source.Where(c => char.IsLetterOrDigit(c) || c == ' ' || c == '-').ToArray());
        return string.IsNullOrWhiteSpace(cleaned) ? fallback : cleaned;
    }
}
