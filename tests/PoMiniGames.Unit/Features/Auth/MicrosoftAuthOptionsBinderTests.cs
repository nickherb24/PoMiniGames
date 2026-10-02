using FluentAssertions;
using Microsoft.Extensions.Configuration;
using PoMiniGames.Features.Auth;

namespace PoMiniGames.Unit.Features.Auth;

/// <summary>
/// Tests that a deployment with ClientId + ApiClientId
/// correctly populated must surface Microsoft sign-in WITHOUT requiring a separate
/// <c>MicrosoftAuth:Enabled=true</c> secret in KV. The binder promotes <c>Enabled</c>
/// to true whenever FullyConfigured is true and the flag was absent from config.
/// </summary>
/// <remarks>
/// Two [Theory]s cover the auto-promote / explicit-override
/// matrix; one [Fact] covers FullyConfigured semantics.
/// </remarks>
public class MicrosoftAuthOptionsBinderTests
{
    private const string Section = "PoMiniGames:MicrosoftAuth";

    [Theory]
    [InlineData(true, true, false, true,  // both client ids present, Enabled absent → binder promotes
                  "promote to true on a fully-wired deployment without an explicit flag")]
    [InlineData(true, true, true, false, // both client ids present, Enabled=false explicit → binder honours kill-switch
                  "explicit Enabled=false wins over the FullyConfigured fallback")]
    [InlineData(true, false, false, false, // only ClientId set → not fully wired → binder leaves false
                  "an incomplete wiring must NOT auto-enable sign-in")]
    [InlineData(false, true, false, false, // only ApiClientId set → not fully wired → binder leaves false
                  "an incomplete wiring must NOT auto-enable sign-in")]
    [InlineData(false, false, false, false, // nothing set → not fully wired → binder leaves false
                  "an empty configuration leaves Enabled=false")]
    public void Binder_ResolvesEnabledFlag(
        bool hasClientId, bool hasApiClientId,
        bool hasExplicitEnabled, bool expectedEnabled,
        string because)
    {
        var dict = new Dictionary<string, string?>();
        if (hasClientId) dict[$"{Section}:ClientId"] = "12a819d2-ac45-45ff-991b-6f27e6dd3dfb";
        if (hasApiClientId) dict[$"{Section}:ApiClientId"] = "12a819d2-ac45-45ff-991b-6f27e6dd3dfb";
        if (hasExplicitEnabled) dict[$"{Section}:Enabled"] = "false"; // explicit false is the only kill-switch case the binder tests

        var config = new ConfigurationBuilder().AddInMemoryCollection(dict).Build();

        var options = new MicrosoftAuthOptions
        {
            ClientId = hasClientId ? "12a819d2-ac45-45ff-991b-6f27e6dd3dfb" : string.Empty,
            ApiClientId = hasApiClientId ? "12a819d2-ac45-45ff-991b-6f27e6dd3dfb" : string.Empty,
        };

        new MicrosoftAuthOptionsBinder(config).PostConfigure(name: null, options);

        options.Enabled.Should().Be(expectedEnabled, because);
    }

    [Fact]
    public void FullyConfigured_MatchesBothClientIdsNonEmpty()
    {
        new MicrosoftAuthOptions { ClientId = "x", ApiClientId = "y" }
            .FullyConfigured.Should().BeTrue("both ids present → fully wired");

        new MicrosoftAuthOptions { ClientId = "", ApiClientId = "y" }
            .FullyConfigured.Should().BeFalse("empty ClientId → not wired");
        new MicrosoftAuthOptions { ClientId = "x", ApiClientId = "   " }
            .FullyConfigured.Should().BeFalse("whitespace ApiClientId → not wired");
        new MicrosoftAuthOptions().FullyConfigured.Should().BeFalse("default ctor → not wired");
    }
}
