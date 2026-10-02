namespace PoMiniGames.Features.Auth;

public sealed class MicrosoftAuthOptions
{
    public const string SectionName = "PoMiniGames:MicrosoftAuth";

    public string Authority { get; init; } = "https://login.microsoftonline.com/common/v2.0";

    public string ClientId { get; init; } = string.Empty;

    public string ApiClientId { get; init; } = string.Empty;

    public string Scope { get; init; } = string.Empty;

    public string RedirectPath { get; init; } = "/auth/callback";

    /// <summary>
    /// Additional tenant IDs allowed to issue tokens for this API. Combine with the well-known
    /// public authorities (common / organizations / consumers) which are always allowed.
    /// Example: <c>[ "11111111-1111-1111-1111-111111111111" ]</c>.
    /// </summary>
    public string[] AllowedTenantIds { get; init; } = Array.Empty<string>();

    /// <summary>
    /// Controls whether the Microsoft sign-in button surfaces in the SPA. It can be set
    /// (<c>Enabled=true</c> in dev) even before the App Registration is wired, but it is
    /// brittle in production: a deployment with <see cref="ClientId"/> +
    /// <see cref="ApiClientId"/> correctly populated must NOT require a separate
    /// <c>Enabled=true</c> secret in KV to function — otherwise the user sees the
    /// "Authentication is not configured" screen even though every required value is
    /// present.
    /// <para>
    /// Resolution: when the option is deserialised from configuration, the
    /// <see cref="MicrosoftAuthOptionsBinder"/> post-processor treats the field as
    /// <c>true</c> when <see cref="FullyConfigured"/> is true AND no explicit
    /// <c>Enabled</c> value was supplied. An explicit <c>Enabled=false</c> still wins
    /// (e.g. for a deliberate kill-switch during an outage).
    /// </para>
    /// </summary>
    public bool Enabled { get; set; }

    /// <summary>
    /// Returns <c>true</c> when sign-in can actually complete (the App Registration
    /// client IDs are present). Use this in the SPA to decide whether the Microsoft
    /// button is enabled vs. visible-but-disabled.
    /// </summary>
    public bool FullyConfigured => !string.IsNullOrWhiteSpace(ClientId) && !string.IsNullOrWhiteSpace(ApiClientId);

    /// <summary>
    /// Scope to request from MSAL.js for the API access token.
    /// <para>
    /// If <see cref="Scope"/> looks like a placeholder/template (e.g.
    /// <c>api://&lt;your-api-client-id&gt;/access_as_user</c> shipped in
    /// <c>appsettings.Development.json</c>) the value is ignored even when non-empty —
    /// sending the literal <c>&lt;your-api-client-id&gt;</c> segment to
    /// <c>login.microsoftonline.com</c> produces <c>AADSTS90013 Invalid input
    /// received from the user</c> because the resource identifier does not resolve
    /// to an app registration. In that case the canonical scope is constructed from
    /// <see cref="ApiClientId"/>.
    /// </para>
    /// </summary>
    public string EffectiveScope
    {
        get
        {
            if (LooksLikePlaceholder(Scope))
            {
                return string.IsNullOrWhiteSpace(ApiClientId)
                    ? string.Empty
                    : $"api://{ApiClientId}/access_as_user";
            }

            return !string.IsNullOrWhiteSpace(Scope)
                ? Scope
                : string.IsNullOrWhiteSpace(ApiClientId)
                    ? string.Empty
                    : $"api://{ApiClientId}/access_as_user";
        }
    }

    /// <summary>
    /// True when <paramref name="value"/> still contains a templating token such as
    /// <c>&lt;your-api-client-id&gt;</c>, <c>&lt;APP_ID&gt;</c>, or <c>{{...}}</c> —
    /// i.e. it was clearly never substituted before being shipped to a running app.
    /// </summary>
    public static bool LooksLikePlaceholder(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return false;
        // `<...>` tokens (the dev template, Helm chart placeholders, etc.)
        if (System.Text.RegularExpressions.Regex.IsMatch(
                value, @"<\s*[A-Za-z][A-Za-z0-9_\-\.]*\s*>"))
        {
            return true;
        }
        // `{{...}}` Mustache-style placeholders.
        if (value.Contains("{{", StringComparison.Ordinal)
            && value.Contains("}}", StringComparison.Ordinal))
        {
            return true;
        }
        // Explicit REPLACE-me markers (e.g. from copied README snippets).
        if (value.Contains("REPLACE", StringComparison.OrdinalIgnoreCase)
            || value.Contains("CHANGEME", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }
        return false;
    }
}
