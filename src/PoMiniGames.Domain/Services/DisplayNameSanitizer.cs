using System.Globalization;
using System.Text;

namespace PoMiniGames.Domain.Services;

/// <summary>How a submitted display name was resolved.</summary>
public enum DisplayNameVerdict
{
    /// <summary>The name arrived clean and is stored verbatim.</summary>
    Accepted,

    /// <summary>The name was kept but rewritten (trimmed, de-spaced, invisible characters
    /// stripped, truncated). The caller must store <see cref="DisplayNameResult.Value"/>.</summary>
    Sanitized,

    /// <summary>The name must not reach a public board. The caller substitutes its fallback.</summary>
    Rejected,
}

/// <param name="Value">The name to store. On <see cref="DisplayNameVerdict.Rejected"/> this is
/// the caller-supplied fallback, so every code path has something safe to write.</param>
/// <param name="Reason">Machine-readable rejection/sanitisation cause for logs; null when accepted.</param>
public readonly record struct DisplayNameResult(DisplayNameVerdict Verdict, string Value, string? Reason)
{
    /// <summary>True when the name may be rendered on a public leaderboard.</summary>
    public bool IsPublishable => Verdict != DisplayNameVerdict.Rejected;
}

/// <summary>
/// The one place a player-supplied display name is cleaned before it reaches a public
/// leaderboard, match record or stats row.
/// </summary>
/// <remarks>
/// <para>
/// Every board on this platform renders a name the client chose — PoSports posts
/// <c>PlayerName</c>, the stats PUT carries <c>{playerName}</c> in the route, and match
/// history carries <c>OpponentName</c>. None of those were normalised or filtered, so a
/// zero-width-padded or slur-bearing name went straight onto a page anyone can read without
/// signing in (leaderboard READS are anonymous — see EndpointRouteExtensions).
/// </para>
/// <para>
/// <b>Two stages by design.</b> Stage one <i>normalises</i> and always wins: control and
/// bidi-override characters are stripped, NFKC folds full-width and mathematical-alphanumeric
/// look-alikes onto ASCII, whitespace runs collapse, and the result is capped at
/// <see cref="MaxLength"/>. Stage two <i>matches</i> against a blocklist using a separate,
/// aggressively-folded form (leetspeak undone, non-letters dropped, repeats squeezed) that is
/// used ONLY for comparison and never stored — otherwise the filter is one underscore away
/// from useless.
/// </para>
/// <para>
/// <b>On the two blocklists.</b> <c>SubstringRoots</c> holds roots long enough that a substring
/// hit is never an ordinary word; <c>ExactTokens</c> holds the short ones, matched only as a
/// whole token, because substring-matching those is the Scunthorpe problem and would reject
/// real names. Putting a short word in the wrong list is how a filter starts eating legitimate
/// players, so the split is load-bearing rather than stylistic.
/// </para>
/// </remarks>
public static class DisplayNameSanitizer
{
    /// <summary>Maximum stored length. Matches the check PoSports already enforced inline.</summary>
    public const int MaxLength = 24;

    /// <summary>Minimum stored length — a single character is not a name, it is noise.</summary>
    public const int MinLength = 2;

    /// <summary>
    /// Unambiguous roots: a substring hit on the folded form is a reject. Authored in
    /// un-squeezed form and squeezed at match time so they line up with the folded candidate.
    /// Only add a term here when no ordinary word contains it.
    /// </summary>
    private static readonly string[] SubstringRoots =
    [
        "nigg", "nigr", "fagg", "kunt", "pussi", "wank", "cunni",
        "whore", "raped", "rapist", "molest", "pedo", "paedo",
        "retard", "tranny", "chink", "kike", "wetback",
        "hitler", "nazi", "heil",
        "fuck", "shit", "bitch", "bastard", "asshole", "dickhead",
        "dildo", "cumshot", "blowjob", "handjob", "creampie",
        "killyourself",
    ];

    /// <summary>
    /// Short or otherwise ambiguous terms, matched only as a complete token. "ass" as a
    /// substring rejects "Cassandra"; as a token it rejects only the insult.
    /// </summary>
    private static readonly HashSet<string> ExactTokens = new(StringComparer.Ordinal)
    {
        "ass", "arse", "cunt", "fag", "slut", "twat", "prick", "wanker",
        "penis", "vagina", "boobs", "tits", "porn", "sex", "anal", "rape",
        "damn", "crap", "piss", "cock", "spic", "kkk", "kys", "hentai",
    };

    /// <summary>
    /// Names that would let a player impersonate the platform or a moderator on a public board.
    /// Matched as a whole token AND against the entire folded name.
    /// </summary>
    private static readonly HashSet<string> ReservedTokens = new(StringComparer.Ordinal)
    {
        "admin", "administrator", "moderator", "mod", "staff", "system", "root",
        "official", "support", "pominigames", "pomini", "server", "owner",
        "anonymous", "null", "undefined",
    };

    /// <summary>
    /// Leet / homoglyph substitutions undone before matching. Applied to the comparison form
    /// only — "L33T" is a name someone may legitimately want; "sh1t" is not.
    /// </summary>
    private static readonly Dictionary<char, char> LeetFolds = new()
    {
        ['0'] = 'o',
        ['1'] = 'i',
        ['3'] = 'e',
        ['4'] = 'a',
        ['5'] = 's',
        ['7'] = 't',
        ['8'] = 'b',
        ['9'] = 'g',
        ['@'] = 'a',
        ['$'] = 's',
        ['!'] = 'i',
        ['|'] = 'i',
        ['+'] = 't',
    };

    /// <summary>
    /// Cleans <paramref name="raw"/> for storage on a public surface.
    /// </summary>
    /// <param name="raw">The client-supplied name.</param>
    /// <param name="fallback">What to return when the name is unusable. Callers pass the
    /// server-derived identity ("Player", "Guest") so a rejection still produces a writable
    /// row rather than a 400 that would silently cost the player their score.</param>
    public static DisplayNameResult Sanitize(string? raw, string fallback = "Player")
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return new DisplayNameResult(DisplayNameVerdict.Rejected, fallback, "empty");
        }

        var normalized = Normalize(raw);
        if (normalized.Length < MinLength)
        {
            return new DisplayNameResult(DisplayNameVerdict.Rejected, fallback, "too-short");
        }

        var folded = Fold(normalized);
        var unsqueezed = Fold(normalized, squeeze: false);
        if (folded.Length == 0)
        {
            // Nothing but punctuation and digits survived folding ("---", "12345"). Not a name,
            // and impossible to moderate — the blocklist has nothing to match against.
            return new DisplayNameResult(DisplayNameVerdict.Rejected, fallback, "no-letters");
        }

        if (IsBlocked(folded, unsqueezed, normalized, out var reason))
        {
            return new DisplayNameResult(DisplayNameVerdict.Rejected, fallback, reason);
        }

        return string.Equals(normalized, raw, StringComparison.Ordinal)
            ? new DisplayNameResult(DisplayNameVerdict.Accepted, normalized, null)
            : new DisplayNameResult(DisplayNameVerdict.Sanitized, normalized, "normalized");
    }

    /// <summary>Convenience predicate for callers that only need a yes/no (e.g. a validation gate).</summary>
    public static bool IsPublishable(string? raw) =>
        Sanitize(raw).Verdict != DisplayNameVerdict.Rejected;

    /// <summary>
    /// Stage one: produce the string that will actually be stored. Strips characters that
    /// render as nothing (and therefore defeat both moderation and the length cap), folds
    /// compatibility look-alikes onto ASCII, and collapses whitespace.
    /// </summary>
    private static string Normalize(string raw)
    {
        // NFKC first: it maps full-width and mathematical-alphanumeric look-alikes onto plain
        // ASCII, which is what makes the blocklist worth having at all.
        var form = raw.Normalize(NormalizationForm.FormKC);

        var sb = new StringBuilder(form.Length);
        var lastWasSpace = false;
        foreach (var ch in form)
        {
            // Zero-width, bidi overrides and word joiners: invisible on a leaderboard, but
            // enough to split a blocked word into two halves that match nothing.
            if (IsInvisible(ch))
            {
                continue;
            }

            var category = CharUnicodeInfo.GetUnicodeCategory(ch);
            if (category is UnicodeCategory.Control or UnicodeCategory.Format
                or UnicodeCategory.Surrogate or UnicodeCategory.PrivateUse
                or UnicodeCategory.LineSeparator or UnicodeCategory.ParagraphSeparator)
            {
                continue;
            }

            if (char.IsWhiteSpace(ch))
            {
                // Collapse runs, and never let the name open with one.
                if (!lastWasSpace && sb.Length > 0)
                {
                    sb.Append(' ');
                    lastWasSpace = true;
                }
                continue;
            }

            lastWasSpace = false;
            sb.Append(ch);
            if (sb.Length >= MaxLength)
            {
                break;
            }
        }

        return sb.ToString().Trim();
    }

    /// <summary>
    /// Stage two: the comparison-only form. Lowercased, leet undone, every non-letter dropped,
    /// and runs of a repeated letter squeezed so "fuuuuuck" folds onto "fuck".
    /// </summary>
    private static string Fold(string normalized, bool squeeze = true)
    {
        var sb = new StringBuilder(normalized.Length);
        var previous = '\0';
        foreach (var raw in normalized)
        {
            var ch = char.ToLowerInvariant(raw);
            if (LeetFolds.TryGetValue(ch, out var folded))
            {
                ch = folded;
            }

            if (!char.IsLetter(ch))
            {
                continue;
            }

            // Squeezing is aggressive, but this string is never stored — only compared — so the
            // cost of over-folding is a false positive on a name like "Aaron" ("aron"), which
            // no blocklist entry matches anyway.
            if (squeeze && ch == previous)
            {
                continue;
            }

            previous = ch;
            sb.Append(ch);
        }

        return sb.ToString();
    }

    private static bool IsBlocked(string folded, string unsqueezed, string normalized, out string reason)
    {
        foreach (var root in SubstringRoots)
        {
            if (folded.Contains(SqueezeRepeats(root), StringComparison.Ordinal))
            {
                reason = "blocked";
                return true;
            }
        }

        // Whole-name match catches the single-token case ("cunt") plus spaced-out evasions
        // ("c u n t"), which fold down to one token.
        if (MatchesToken(ReservedTokens, unsqueezed))
        {
            reason = "reserved";
            return true;
        }

        if (MatchesToken(ExactTokens, unsqueezed))
        {
            reason = "blocked";
            return true;
        }

        foreach (var token in normalized.Split(' ', StringSplitOptions.RemoveEmptyEntries))
        {
            var foldedToken = Fold(token, squeeze: false);
            if (foldedToken.Length == 0)
            {
                continue;
            }

            if (MatchesToken(ReservedTokens, foldedToken))
            {
                reason = "reserved";
                return true;
            }

            if (MatchesToken(ExactTokens, foldedToken))
            {
                reason = "blocked";
                return true;
            }
        }

        reason = string.Empty;
        return false;
    }

    /// <summary>
    /// Whole-token match that also catches a stretched spelling ("asss", "rooot"). Both sides
    /// are squeezed, but the candidate must be at least as long as the listed word: "as"
    /// squeezes to the same letters as "ass" and is an ordinary word, not an evasion.
    /// </summary>
    private static bool MatchesToken(HashSet<string> tokens, string candidate)
    {
        var squeezed = SqueezeRepeats(candidate);
        foreach (var token in tokens)
        {
            if (candidate.Length >= token.Length && SqueezeRepeats(token) == squeezed)
            {
                return true;
            }
        }

        return false;
    }

    private static string SqueezeRepeats(string value)
    {
        var sb = new StringBuilder(value.Length);
        var previous = '\0';
        foreach (var ch in value)
        {
            if (ch == previous) continue;
            previous = ch;
            sb.Append(ch);
        }

        return sb.ToString();
    }

    /// <summary>
    /// Characters that occupy no visual space. <see cref="char.IsWhiteSpace"/> does not cover
    /// these, and the Format category misses U+2800 (Braille blank), which renders as a gap in
    /// every browser font and is the usual way a name is padded to look like someone else's.
    /// </summary>
    private static bool IsInvisible(char ch) => ch is
        '\u200B' or '\u200C' or '\u200D' or '\u200E' or '\u200F' or   // ZWSP, ZWNJ, ZWJ, LRM, RLM
        '\u202A' or '\u202B' or '\u202C' or '\u202D' or '\u202E' or   // bidi embeddings + overrides
        '\u2060' or '\u2061' or '\u2062' or '\u2063' or '\u2064' or   // word joiner + invisible operators
        '\u206A' or '\u206B' or '\u206C' or '\u206D' or '\u206E' or '\u206F' or
        '\u00AD' or '\uFEFF' or '\u180E' or '\u2800' or '\u3164' or '\uFFA0';
}
