using System.Diagnostics.CodeAnalysis;
using System.Text.RegularExpressions;
using PoMiniGames.Shared.Games.PoJoker;

namespace PoMiniGames.Features.PoJoker;

/// <summary>
/// Swaps harsh vocabulary in a joke for cheerful stand-ins so a joke that would
/// otherwise be dropped can still be performed.
/// </summary>
/// <remarks>
/// The Jester runs with JokeAPI safe-mode OFF (see <c>JesterStage.StartPerformance</c>),
/// so crude and explicit jokes arrive intact. Rather than
/// skipping the harshest ones, they are rewritten and played.
///
/// <para><b>Limitation, by construction:</b> this substitutes <i>words</i>. A joke
/// whose premise rather than vocabulary is the offensive part survives the rewrite
/// with its structure intact — a cleaned racist joke is a racist joke with nicer
/// nouns. Word substitution is a vocabulary filter, not a meaning filter, and it is
/// not a safety control. The <see cref="JokeDto.Sanitized"/> flag records that a
/// rewrite happened so callers never mistake a cleaned joke for a clean one.</para>
///
/// <para>The default map covers common profanity. Extend <see cref="Replacements"/>
/// with any further terms you want swapped — matching is whole-word and
/// case-insensitive, and the replacement inherits the original's capitalisation.</para>
/// </remarks>
public static class JokeSanitizer
{
    /// <summary>
    /// Harsh term -> cheerful stand-in. Whole-word, case-insensitive. Longer keys are
    /// matched before shorter ones so "motherfucker" does not first match "fuck".
    /// </summary>
    private static readonly Dictionary<string, string> Replacements = new(StringComparer.OrdinalIgnoreCase)
    {
        ["motherfucker"] = "marshmallow",
        ["motherfucking"] = "marvellous",
        ["fucking"] = "delightful",
        ["fucker"] = "sweetheart",
        ["fucked"] = "hugged",
        ["fuck"] = "hug",
        ["shitty"] = "lovely",
        ["shit"] = "sunshine",
        ["bullshit"] = "birdsong",
        ["asshole"] = "cuddlebug",
        ["arsehole"] = "cuddlebug",
        ["bastard"] = "buddy",
        ["bitches"] = "butterflies",
        ["bitch"] = "butterfly",
        ["bollocks"] = "blossoms",
        ["wanker"] = "wombat",
        ["prick"] = "petal",
        ["twat"] = "tulip",
        ["cunt"] = "cupcake",
        ["dickhead"] = "daffodil",
        ["dick"] = "daisy",
        ["piss"] = "sprinkle",
        ["pissed"] = "sprinkled",
        ["crap"] = "cake",
        ["damn"] = "bless",
        ["goddamn"] = "goodness",
        ["hell"] = "heck",
        ["slut"] = "sweetie",
        ["whore"] = "poppet",
        ["retard"] = "rascal",
        ["retarded"] = "rascally",
        ["rape"] = "surprise",
        ["raped"] = "surprised",
        ["kill"] = "tickle",
        ["killed"] = "tickled",
        ["murder"] = "cuddle",
        ["murdered"] = "cuddled",
        ["dead"] = "sleepy",
        ["die"] = "nap",
        ["died"] = "napped",
    };

    // Built once: alternation of every key, longest first so multi-word and compound
    // terms win over their substrings.
    private static readonly Regex Pattern = new(
        @"\b(" + string.Join("|", Replacements.Keys
            .OrderByDescending(k => k.Length)
            .Select(Regex.Escape)) + @")\b",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);

    /// <summary>
    /// Whether a joke is harsh enough to rewrite rather than play as-is. Religious and
    /// political flags are opinions rather than vocabulary, so they play untouched.
    /// </summary>
    public static bool NeedsSanitizing(JokeFlags? flags) =>
        flags is not null && (flags.Racist || flags.Sexist || flags.Nsfw || flags.Explicit);

    /// <summary>Replaces every mapped term in <paramref name="text"/>.</summary>
    [return: NotNullIfNotNull(nameof(text))]
    public static string? Clean(string? text)
    {
        if (string.IsNullOrEmpty(text)) return text;
        return Pattern.Replace(text, static match => MatchCase(match.Value, Replacements[match.Value]));
    }

    /// <summary>
    /// Rewrites the joke when <see cref="NeedsSanitizing"/> says so; otherwise returns
    /// it untouched. Always returns a playable joke — nothing is dropped.
    /// </summary>
    public static JokeDto SanitizeIfNeeded(JokeDto joke)
    {
        if (!NeedsSanitizing(joke.Flags)) return joke;

        var setup = Clean(joke.Setup);
        var punchline = Clean(joke.Punchline);
        var single = Clean(joke.Joke);

        // Nothing in the map appeared — the flag was about the premise, not the words.
        // Report that honestly rather than claiming a rewrite that never happened.
        var changed = !string.Equals(setup, joke.Setup, StringComparison.Ordinal)
                   || !string.Equals(punchline, joke.Punchline, StringComparison.Ordinal)
                   || !string.Equals(single, joke.Joke, StringComparison.Ordinal);

        return joke with
        {
            Setup = setup,
            Punchline = punchline,
            Joke = single,
            Sanitized = changed,
        };
    }

    /// <summary>
    /// Gives the replacement the original's capitalisation, so a shouted punchline
    /// stays shouted and a sentence-initial term stays capitalised.
    /// </summary>
    private static string MatchCase(string original, string replacement)
    {
        // All-caps only counts when there is more than one letter — otherwise every
        // single-letter match would be treated as shouting.
        if (original.Length > 1 && original.All(c => !char.IsLetter(c) || char.IsUpper(c)))
        {
            return replacement.ToUpperInvariant();
        }
        if (char.IsUpper(original[0]))
        {
            return char.ToUpperInvariant(replacement[0]) + replacement[1..];
        }
        return replacement;
    }
}
