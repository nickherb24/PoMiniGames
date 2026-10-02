using System.Security.Claims;
using FluentAssertions;
using PoMiniGames.Features.Auth;

namespace PoMiniGames.Unit;

/// <summary>
/// Exercises the dev-login intake rules directly — the sanitisation, ANON-suffixing, and claim
/// shape, reachable here without going over HTTP.
/// </summary>
public class DevLoginIntakeTests
{
    // The six-digit suffix below is not incidental: EVERY dev
    // login gets one, so two tabs of the same browser produce distinct identities
    // instead of colliding on one name-keyed session (see DevLoginIntake). These
    // assertions therefore pin the stem and the shape of the suffix, never the
    // whole literal — the suffix is Random.Shared and differs per call.
    [Theory]
    // No input at all → the Local Developer fallback. UserId and Email are slugged from
    // the suffixed display name, so they carry the same suffix — that is what keeps the
    // two tabs distinct all the way down to the leaderboard row.
    [InlineData(false, null, null, null, null,
        "^Local Developer-[0-9]{6}$", "^dev-local-developer-[0-9]{6}$", @"^local-developer-[0-9]{6}@local\.dev$")]
    // A signed-in userName seeds the stem; ANON still gets the six-digit suffix appended.
    [InlineData(false, null, null, null, "ANON",
        "^ANON[0-9]{6}$", "^dev-anon", null)]
    // Disallowed characters are stripped from the display name, not escaped — and nothing
    // of the tag survives between the stem and the suffix.
    [InlineData(true, null, "Bob<script>", null, null,
        "^Bobscript-[0-9]{6}$", null, null)]
    // An explicit UserId/Email is taken verbatim (trimmed) and never suffixed — the caller
    // asked for that exact identity. Only the display name, which the caller does not own
    // the uniqueness of, picks up the suffix.
    [InlineData(true, "  custom-id ", "Alice", " alice@x.io ", null,
        "^Alice-[0-9]{6}$", "^custom-id$", @"^alice@x\.io$")]
    public void BuildProfile_SanitisesNames_SuffixesDisplayName_AndSlugsDerivedFields(
        bool sendRequest, string? requestUserId, string? requestDisplayName, string? requestEmail,
        string? userName, string displayNamePattern, string? userIdPattern, string? emailPattern)
    {
        var request = sendRequest
            ? new DevLoginRequest(UserId: requestUserId, DisplayName: requestDisplayName, Email: requestEmail)
            : null;

        var profile = DevLoginIntake.BuildProfile(request, userName);

        profile.DisplayName.Should().MatchRegex(displayNamePattern);
        if (userIdPattern is not null)
        {
            profile.UserId.Should().MatchRegex(userIdPattern);
        }
        if (emailPattern is not null)
        {
            profile.Email.Should().MatchRegex(emailPattern);
        }
    }

    [Fact]
    public void BuildClaims_CarriesIdNameAndEmailUnderBothSchemes()
    {
        var profile = new AuthenticatedUserProfile("dev-alice", "Alice", "alice@local.dev");

        var claims = DevLoginIntake.BuildClaims(profile);

        claims.Should().Contain(c => c.Type == "oid" && c.Value == "dev-alice");
        claims.Should().Contain(c => c.Type == ClaimTypes.NameIdentifier && c.Value == "dev-alice");
        claims.Should().Contain(c => c.Type == "name" && c.Value == "Alice");
        claims.Should().Contain(c => c.Type == "preferred_username" && c.Value == "alice@local.dev");
        claims.Should().Contain(c => c.Type == ClaimTypes.Email && c.Value == "alice@local.dev");
    }
}
