using FluentAssertions;
using Microsoft.IdentityModel.Tokens;
using PoMiniGames.Features.Auth;

namespace PoMiniGames.Unit.Features.Auth;

/// <summary>
/// Tests the tenant allow-list. The validator MUST accept the well-known public
/// Entra authorities and any explicitly-configured tenant ID, and reject everything else.
/// </summary>
/// <remarks>
/// The rejection cases (unknown tenant, empty issuer, foreign authority) are
/// one theory parameterized over (issuer, allowedTenants). Accept and reject rows
/// share that one theory; every reject row also asserts the offending issuer is named in the
/// message (the empty-issuer row degenerates to the always-matching <c>**</c>).
/// </remarks>
public class MicrosoftAuthIssuerValidatorTests
{
    [Theory]
    [InlineData("https://login.microsoftonline.com/common/v2.0", "", true)]
    [InlineData("https://login.microsoftonline.com/organizations/v2.0", "", true)]
    [InlineData("https://login.microsoftonline.com/consumers/v2.0", "", true)]
    [InlineData("https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0", "", true)]
    [InlineData("https://login.microsoftonline.com/11111111-1111-1111-1111-111111111111/v2.0", "11111111-1111-1111-1111-111111111111", true)]
    [InlineData("https://login.microsoftonline.com/22222222-2222-2222-2222-222222222222/v2.0", "", false)]
    [InlineData("", "", false)]
    [InlineData("https://evil.example.com/v2.0", "", false)]
    [InlineData("https://login.microsoftonline.com/common/v2.0/extra", "11111111-1111-1111-1111-111111111111", false)]
    public void Validate_AcceptsOnlyAllowedAuthorities(string issuer, string commaSeparatedAllowedTenants, bool accepted)
    {
        var allowed = string.IsNullOrEmpty(commaSeparatedAllowedTenants)
            ? Array.Empty<string>()
            : commaSeparatedAllowedTenants.Split(',', StringSplitOptions.RemoveEmptyEntries);

        var act = () => MicrosoftAuthIssuerValidator.Validate(issuer, allowed);

        if (accepted)
        {
            act().Should().Be(issuer);
        }
        else
        {
            act.Should().Throw<SecurityTokenInvalidIssuerException>()
               .WithMessage($"*{issuer}*");
        }
    }
}
