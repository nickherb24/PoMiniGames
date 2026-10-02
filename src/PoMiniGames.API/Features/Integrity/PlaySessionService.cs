using System.Buffers.Text;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.Extensions.Options;
using PoMiniGames.Domain.Primitives;

namespace PoMiniGames.Features.Integrity;

/// <summary>A freshly minted play session handed to the client.</summary>
/// <param name="Token">Opaque, signed, and bound to one game and one identity.</param>
public sealed record PlaySessionTicket(string Token, DateTimeOffset IssuedAtUtc, DateTimeOffset ExpiresAtUtc);

/// <summary>Outcome of presenting a play session alongside a score.</summary>
public enum PlaySessionStatus
{
    Valid,

    /// <summary>No token on the request at all — the common case for an offline replay.</summary>
    Missing,

    /// <summary>Present but not something this server issued (tampered, or signed by a rotated key).</summary>
    Malformed,

    /// <summary>Issued by this server, but older than the configured TTL.</summary>
    Expired,

    /// <summary>A real session for a different game — a token minted on one board, spent on another.</summary>
    WrongGame,

    /// <summary>A real session belonging to someone else.</summary>
    WrongIdentity,
}

/// <param name="Elapsed">Server-measured time between minting and submission, capped at
/// <see cref="IntegrityOptions.MaxCredited"/>. Zero unless <see cref="Status"/> is
/// <see cref="PlaySessionStatus.Valid"/>.</param>
public readonly record struct PlaySessionRedemption(PlaySessionStatus Status, TimeSpan Elapsed)
{
    public bool IsValid => Status == PlaySessionStatus.Valid;
}

/// <summary>
/// Data Protection-backed play sessions: the server's own record of when a player started, in a
/// form the client can hold but cannot author or edit.
/// </summary>
/// <remarks>
/// <para>
/// The problem this solves: every board here accepts a number the client chose, so the only
/// thing separating a real run from a typed one is whether the claim is consistent with time
/// the server itself observed. A session is minted when the player opens a game, carried back
/// on the submission, and unprotected here — giving the guard an issue time that did not come
/// from the client.
/// </para>
/// <para>
/// <b>Signed, not stored.</b> The whole payload rides in the token, protected by the same
/// Data Protection key-ring that encrypts the auth cookies, so there is no table to read on the
/// submission path and nothing to clean up. It also means the app's existing key-ring semantics
/// apply: a key rotation invalidates outstanding sessions, which presents as
/// <see cref="PlaySessionStatus.Malformed"/> and, in Observe mode, is a logged non-event.
/// </para>
/// <para>
/// <b>Deliberately reusable.</b> Marking a session single-use is the obvious hardening and is
/// wrong here: a player who runs three marble races without leaving the page submits three
/// scores against one session, and rounds two and three would be rejected. The token's value is
/// the start timestamp, and reusing it only ever yields a LONGER elapsed — the conservative
/// direction — so reuse costs the guard nothing. The stale-token hole that opens up (mint,
/// wait an hour, claim an hour's worth of points) is closed by capping credited elapsed at
/// <see cref="IntegrityOptions.MaxCredited"/> instead.
/// </para>
/// <para>
/// <b>What this is not.</b> It is a deterrent tier, not a proof of play: a determined attacker
/// can mint a session, wait the honest duration, and submit a plausible score. Ranking that out
/// requires per-round minting with a server-held round record, which is the upgrade path. What
/// this does buy is that a forged score must now be paced in real time and stay inside the
/// board's physics, which removes the entire class of "POST 999999999 once" attacks.
/// </para>
/// </remarks>
public sealed class PlaySessionService
{
    /// <summary>
    /// Purpose string for the protector. Versioned so a future payload change can be introduced
    /// without silently accepting the old shape under the new parser.
    /// </summary>
    private const string ProtectorPurpose = "PoMiniGames.PlaySession.v1";

    /// <summary>Field separator inside the payload. Not legal in a game key or a base64url hash.</summary>
    private const char Separator = '|';

    private readonly IDataProtector _protector;
    private readonly IOptionsMonitor<IntegrityOptions> _options;
    private readonly TimeProvider _clock;

    public PlaySessionService(
        IDataProtectionProvider protectionProvider,
        IOptionsMonitor<IntegrityOptions> options,
        TimeProvider clock)
    {
        _protector = protectionProvider.CreateProtector(ProtectorPurpose);
        _options = options;
        _clock = clock;
    }

    public PlaySessionTicket Issue(GameKey game, string identityKey)
    {
        var options = _options.CurrentValue;
        var issuedAt = _clock.GetUtcNow();

        // The nonce is not used for replay detection (sessions are reusable by design — see the
        // class remarks); it is here so two sessions minted in the same second for the same
        // game and identity are still distinct tokens, which keeps them from collapsing in
        // caches and logs.
        var nonce = Convert.ToHexString(RandomNumberGenerator.GetBytes(8));

        var payload = string.Join(
            Separator,
            nonce,
            game.Value,
            HashIdentity(identityKey),
            issuedAt.ToUnixTimeSeconds().ToString(System.Globalization.CultureInfo.InvariantCulture));

        return new PlaySessionTicket(
            _protector.Protect(payload),
            issuedAt,
            issuedAt + options.SessionTtl);
    }

    public PlaySessionRedemption Redeem(string? token, GameKey game, string identityKey)
    {
        if (string.IsNullOrWhiteSpace(token))
        {
            return new PlaySessionRedemption(PlaySessionStatus.Missing, TimeSpan.Zero);
        }

        string payload;
        try
        {
            payload = _protector.Unprotect(token);
        }
        catch (CryptographicException)
        {
            // Tampered, truncated, or signed by a key this ring no longer holds. All three are
            // "not a session I issued", and none of them should throw out of the submit path.
            return new PlaySessionRedemption(PlaySessionStatus.Malformed, TimeSpan.Zero);
        }

        var parts = payload.Split(Separator);
        if (parts.Length != 4
            || !long.TryParse(parts[3], System.Globalization.NumberStyles.Integer,
                              System.Globalization.CultureInfo.InvariantCulture, out var issuedUnix))
        {
            return new PlaySessionRedemption(PlaySessionStatus.Malformed, TimeSpan.Zero);
        }

        // Game before identity: a token spent on the wrong board is the more interesting signal,
        // and reporting it as WrongIdentity would send the reader looking at auth instead.
        if (new GameKey(parts[1]) != game)
        {
            return new PlaySessionRedemption(PlaySessionStatus.WrongGame, TimeSpan.Zero);
        }

        if (!CryptographicOperations.FixedTimeEquals(
                Encoding.UTF8.GetBytes(parts[2]),
                Encoding.UTF8.GetBytes(HashIdentity(identityKey))))
        {
            return new PlaySessionRedemption(PlaySessionStatus.WrongIdentity, TimeSpan.Zero);
        }

        var options = _options.CurrentValue;
        var issuedAt = DateTimeOffset.FromUnixTimeSeconds(issuedUnix);
        var age = _clock.GetUtcNow() - issuedAt;

        if (age > options.SessionTtl)
        {
            return new PlaySessionRedemption(PlaySessionStatus.Expired, TimeSpan.Zero);
        }

        // A negative age means the client's submission raced ahead of the mint timestamp, which
        // only happens on clock skew. Floor at zero so the rate check reads it as "no time has
        // passed" — the strictest interpretation — rather than as a negative ceiling.
        if (age < TimeSpan.Zero)
        {
            age = TimeSpan.Zero;
        }

        return new PlaySessionRedemption(
            PlaySessionStatus.Valid,
            age > options.MaxCredited ? options.MaxCredited : age);
    }

    /// <summary>
    /// Binds the token to an identity without putting the identity in it. The identity key is an
    /// Entra object id or, for a guest, a display name — neither belongs in a value that is
    /// handed to a browser and may end up in a log or a bug report.
    /// </summary>
    private static string HashIdentity(string identityKey)
    {
        Span<byte> hash = stackalloc byte[32];
        SHA256.HashData(Encoding.UTF8.GetBytes(identityKey ?? string.Empty), hash);

        // First 16 bytes is 128 bits of collision resistance on a value that is only ever
        // compared for equality — ample, and it keeps the token short.
        Span<byte> encoded = stackalloc byte[24];
        Base64Url.EncodeToUtf8(hash[..16], encoded, out _, out var written);
        return Encoding.UTF8.GetString(encoded[..written]);
    }
}
