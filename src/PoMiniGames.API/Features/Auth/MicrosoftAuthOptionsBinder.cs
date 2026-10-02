using Microsoft.Extensions.Options;

namespace PoMiniGames.Features.Auth;

/// <summary>
/// Post-configuration binder for <see cref="MicrosoftAuthOptions"/>. Without it, a deployment
/// with ClientId + ApiClientId correctly populated would still show "Authentication is not
/// configured" because the <see cref="MicrosoftAuthOptions.Enabled"/> flag defaults to false.
/// </summary>
/// <remarks>
/// <para>
/// Behaviour:
/// <list type="bullet">
///   <item>If <see cref="MicrosoftAuthOptions.Enabled"/> was explicitly set to
///         <c>true</c> or <c>false</c> via configuration (KV, appsettings, or env
///         var), honour it as a deliberate operator decision.</item>
///   <item>If the field was not supplied (the common case in production) AND
///         <see cref="MicrosoftAuthOptions.FullyConfigured"/> is true, default
///         <c>Enabled</c> to <c>true</c> so the deployment surfaces Microsoft
///         sign-in without needing a separate <c>Enabled=true</c> secret.</item>
/// </list>
/// </para>
/// <para>
/// Implemented as <see cref="IPostConfigureOptions{TOptions}"/> so it runs AFTER
/// configuration binding (which sets <see cref="MicrosoftAuthOptions.Enabled"/>
/// to whatever JSON / env provided, or leaves it at the default false) but
/// BEFORE consumers resolve the options.
/// </para>
/// </remarks>
public sealed class MicrosoftAuthOptionsBinder : IPostConfigureOptions<MicrosoftAuthOptions>
{
    /// <summary>
    /// Marker key used to detect whether <c>MicrosoftAuth:Enabled</c> was present
    /// in the configuration sources. We probe this rather than relying on the
    /// post-configure time because by then <see cref="MicrosoftAuthOptions.Enabled"/>
    /// has already been set to its default false and we cannot distinguish
    /// "absent" from "explicitly false".
    /// </summary>
    public const string EnabledConfigKey = "PoMiniGames:MicrosoftAuth:Enabled";

    private readonly IConfiguration _configuration;

    public MicrosoftAuthOptionsBinder(IConfiguration configuration)
    {
        _configuration = configuration;
    }

    public void PostConfigure(string? name, MicrosoftAuthOptions options)
    {
        // The "absent from configuration" path is the safe default — promote Enabled
        // to true whenever the deployment is fully wired. An explicit operator override
        // (a KV secret, an env var, or appsettings.Development.json) still wins because
        // configuration binding runs BEFORE this post-configure step.
        var explicitEnabled = _configuration.GetValue<bool?>(EnabledConfigKey);
        if (explicitEnabled is null && options.FullyConfigured)
        {
            options.Enabled = true;
        }
    }
}
