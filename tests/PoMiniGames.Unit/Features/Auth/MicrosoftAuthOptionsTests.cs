using FluentAssertions;
using PoMiniGames.Features.Auth;

namespace PoMiniGames.Unit.Features.Auth;

/// <summary>
/// Tests for <see cref="MicrosoftAuthOptions.EffectiveScope"/>. The dev template
/// shipped in <c>appsettings.Development.json</c> contains the literal placeholder
/// <c>api://&lt;your-api-client-id&gt;/access_as_user</c> — if that placeholder is
/// forwarded verbatim to <c>login.microsoftonline.com</c> the OAuth server returns
/// <c>AADSTS90013 Invalid input received from the user</c>. <see cref="MicrosoftAuthOptions.EffectiveScope"/>
/// must detect placeholder patterns and fall back to a scope constructed from
/// <see cref="MicrosoftAuthOptions.ApiClientId"/>.
/// </summary>
/// <remarks>
/// Five [Theory] rows cover the placeholder matrix;
/// one [Fact] validates <see cref="MicrosoftAuthOptions.LooksLikePlaceholder"/> in
/// isolation.
/// </remarks>
public class MicrosoftAuthOptionsTests
{
    private const string SampleApiClientId = "12a819d2-ac45-45ff-991b-6f27e6dd3dfb";
    private const string DevTemplateScope = "api://<your-api-client-id>/access_as_user";
    private const string ConstructedScope = "api://12a819d2-ac45-45ff-991b-6f27e6dd3dfb/access_as_user";

    [Theory]
    [InlineData(DevTemplateScope, SampleApiClientId, ConstructedScope, // shipped dev template
                  "the dev template placeholder must NOT leak to MSAL")]
    [InlineData("api://<APP_ID>/foo", SampleApiClientId, ConstructedScope, // Helm-style placeholder
                  "<APP_ID>-style placeholders must be detected and replaced")]
    [InlineData("api://{{api_client_id}}", SampleApiClientId, ConstructedScope, // Mustache placeholder
                  "Mustache placeholders must be detected and replaced")]
    [InlineData("REPLACE_ME/api", SampleApiClientId, ConstructedScope, // explicit REPLACE marker
                  "explicit REPLACE markers must be detected and replaced")]
    [InlineData("", SampleApiClientId, ConstructedScope, // empty Scope → construct
                  "an empty configured Scope falls back to the constructed scope")]
    [InlineData(DevTemplateScope, "", "",               // placeholder AND no ApiClientId
                  "no ApiClientId + placeholder Scope → empty scope, never the placeholder")]
    [InlineData("api://other-app/foo", SampleApiClientId, "api://other-app/foo", // custom valid scope
                  "a non-placeholder Scope is honoured verbatim")]
    public void EffectiveScope_HandlesPlaceholderAndFallback(
        string scope, string apiClientId, string expected, string because)
    {
        var options = new MicrosoftAuthOptions
        {
            Scope = scope,
            ApiClientId = apiClientId,
        };

        options.EffectiveScope.Should().Be(expected, because);
    }

    [Fact]
    public void LooksLikePlaceholder_DetectsCommonTemplates()
    {
        MicrosoftAuthOptions.LooksLikePlaceholder(null).Should().BeFalse();
        MicrosoftAuthOptions.LooksLikePlaceholder("").Should().BeFalse();
        MicrosoftAuthOptions.LooksLikePlaceholder("   ").Should().BeFalse();

        // Detected.
        MicrosoftAuthOptions.LooksLikePlaceholder(DevTemplateScope).Should().BeTrue("<...> placeholders are detected");
        MicrosoftAuthOptions.LooksLikePlaceholder("api://<APP_ID>/access_as_user").Should().BeTrue();
        MicrosoftAuthOptions.LooksLikePlaceholder("api://<your-app>/.default").Should().BeTrue();
        MicrosoftAuthOptions.LooksLikePlaceholder("api://{{api_client_id}}/access_as_user").Should().BeTrue();
        MicrosoftAuthOptions.LooksLikePlaceholder("REPLACE_ME").Should().BeTrue();
        MicrosoftAuthOptions.LooksLikePlaceholder("api://CHANGEME/foo").Should().BeTrue();

        // Not detected.
        MicrosoftAuthOptions.LooksLikePlaceholder("api://12a819d2-ac45-45ff-991b-6f27e6dd3dfb/access_as_user")
            .Should().BeFalse("real GUIDs are not placeholders");
        MicrosoftAuthOptions.LooksLikePlaceholder("openid profile email")
            .Should().BeFalse("OIDC scopes are not placeholders");
        MicrosoftAuthOptions.LooksLikePlaceholder("https://graph.microsoft.com/.default")
            .Should().BeFalse("real resource URIs are not placeholders");
    }
}
