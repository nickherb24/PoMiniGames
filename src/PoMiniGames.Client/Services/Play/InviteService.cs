using System.Net.Http.Json;
using Microsoft.JSInterop;
using PoMiniGamesClient.Services.Http;

namespace PoMiniGamesClient.Services.Play;

public sealed record PushKeyDto(string Key);

public sealed record PushSubscriptionDto(string Endpoint);

public sealed record InviteRequestDto(string Owner, string OpponentName, string Game);

public sealed record InviteResultDto(int Sent);

/// <summary>Whether this browser will show a game invite.</summary>
public enum InviteState
{
    /// <summary>No service worker or no Push API (or the worker failed to register).</summary>
    Unsupported,
    /// <summary>The player blocked notifications for this site; only the browser's own settings undo that.</summary>
    Denied,
    Off,
    On,
}

/// <summary>
/// Game invites from the page's side: turning them on for this device, and inviting someone
/// from the head-to-head list. The browser calls are <c>window.poPush</c> (js/pwa.js); the API
/// calls ride the app <see cref="HttpClient"/> so they carry credentials and the antiforgery token.
/// </summary>
/// <remarks>
/// A subscription is filed under the display name the player had when they turned invites on,
/// because that is how an opponent's head-to-head row names them. Signing in as someone else
/// afterwards leaves it under the old name until invites are switched off and on again.
/// </remarks>
public sealed class InviteService(IJSRuntime js, HttpClient http, MatchHistoryService history)
{
    private string? _publicKey;

    /// <summary>
    /// Fetch the server's push key ahead of the click that will need it. A browser shows its
    /// permission prompt only while that click is still the active user gesture, so the one
    /// network round trip <see cref="EnableAsync"/> would otherwise start with is done here,
    /// when the settings sheet opens.
    /// </summary>
    public async Task PrepareAsync()
    {
        if (_publicKey is not null) return;
        try
        {
            _publicKey = (await http.GetFromJsonAsync("/api/push/key", ApiJsonContext.Default.PushKeyDto))?.Key;
        }
        catch
        {
            // Signed out, offline or storage down: EnableAsync tries once more and reports it.
        }
    }

    public async Task<InviteState> StateAsync()
    {
        try
        {
            return await js.InvokeAsync<string>("poPush.state") switch
            {
                "on" => InviteState.On,
                "off" => InviteState.Off,
                "denied" => InviteState.Denied,
                _ => InviteState.Unsupported,
            };
        }
        catch
        {
            return InviteState.Unsupported;
        }
    }

    /// <summary>
    /// Ask for notification permission and register this device. Must be called from a click.
    /// False when the player declined, the browser cannot, or the server did not take it.
    /// </summary>
    public async Task<bool> EnableAsync()
    {
        try
        {
            await PrepareAsync();
            if (string.IsNullOrEmpty(_publicKey)) return false;

            var endpoint = await js.InvokeAsync<string?>("poPush.subscribe", _publicKey);
            if (string.IsNullOrEmpty(endpoint)) return false;

            using var response = await http.PostAsJsonAsync(
                "/api/push/subscriptions", new PushSubscriptionDto(endpoint), ApiJsonContext.Default.PushSubscriptionDto);
            if (response.IsSuccessStatusCode) return true;

            // The server never heard of it, so the browser must not think it is subscribed.
            await js.InvokeAsync<string?>("poPush.unsubscribe");
            return false;
        }
        catch
        {
            return false;
        }
    }

    public async Task DisableAsync()
    {
        try
        {
            var endpoint = await js.InvokeAsync<string?>("poPush.unsubscribe");
            if (string.IsNullOrEmpty(endpoint)) return;
            using var _ = await http.PostAsJsonAsync(
                "/api/push/unsubscribe", new PushSubscriptionDto(endpoint), ApiJsonContext.Default.PushSubscriptionDto);
        }
        catch
        {
            // Best-effort: the browser side is already off, and a row the server still holds
            // is dropped the first time a push to it comes back Gone.
        }
    }

    /// <summary>
    /// Invite a past online opponent to a game's lobby. Returns how many of their devices were
    /// reached (0 = they have not turned invites on), or null when the request failed.
    /// </summary>
    public async Task<int?> InviteAsync(string opponentName, string gameSlug)
    {
        try
        {
            using var response = await http.PostAsJsonAsync(
                "/api/invites",
                new InviteRequestDto(history.ResolveOwner().Owner, opponentName, gameSlug),
                ApiJsonContext.Default.InviteRequestDto);
            if (!response.IsSuccessStatusCode) return null;
            return (await response.Content.ReadFromJsonAsync(ApiJsonContext.Default.InviteResultDto))?.Sent;
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// Route slug for a game as match history names it. The two quizzes record under their
    /// <c>po</c>-prefixed keys but live at <c>/funquiz</c> and <c>/couplequiz</c>.
    /// </summary>
    public static string SlugFor(string matchHistoryGame) => matchHistoryGame.ToLowerInvariant() switch
    {
        "pofunquiz" => "funquiz",
        "pocouplequiz" => "couplequiz",
        var key => key,
    };
}
