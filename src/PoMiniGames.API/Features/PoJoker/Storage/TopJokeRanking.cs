using PoMiniGames.Shared.Games.PoJoker;

namespace PoMiniGames.Features.PoJoker.Storage;

/// <summary>
/// Reduces raw joke-performance rows to the "best jokes" board.
/// </summary>
/// <remarks>
/// Split out of <see cref="JokeStorageClient"/> so the ranking rules are pure: no table client,
/// no async, no Azurite. Everything here is a decision that can be silently wrong — which score
/// counts, which rows are eligible, how duplicates collapse — and each is cheap to assert once
/// it is separated from the scan that feeds it.
/// </remarks>
public static class TopJokeRanking
{
    /// <summary>
    /// Rank performance rows into a board: eligible rows only, duplicates collapsed, highest
    /// first, capped at <paramref name="top"/>.
    /// </summary>
    /// <remarks>
    /// <para>Two rows collapse into one — keeping the higher score — if EITHER:</para>
    /// <list type="number">
    ///   <item>they share the same <c>JokeId</c> (the same joke rated twice), OR</item>
    ///   <item>they share the same normalised setup, whether or not the raw text matches
    ///   exactly (the sanitiser-rewrite case AND the same-joke-regenerated case: the model
    ///   re-emits an identical punchline under a fresh id, and a public board showing the
    ///   same joke at ranks 1 and 3 reads as broken).</item>
    /// </list>
    /// <para>Each collapsed slot keeps its highest-scoring telling.
    /// <see cref="TopJokeRankingTests.Rank_CollapsesTheSameJokeArrivingUnderDifferentIds"/>
    /// is the contract, including the identical-raw case.</para>
    /// </remarks>
    public static IReadOnlyList<TopJokeDto> Rank(IEnumerable<JokePerformanceEntity> rows, int top)
    {
        // Each surviving joke is a slot in bestBySlot, keyed by either an "id:{N}" for
        // positive JokeIds or a synthetic negative id for id-0 rows. slotByNorm tracks which
        // slot "owns" each normalised setup so any later row with the same text — same id,
        // different id, identical or rewritten raw text — collapses into that slot.
        var bestBySlot = new Dictionary<string, TopJokeDto>(StringComparer.Ordinal);
        var slotByNorm = new Dictionary<string, string>(StringComparer.Ordinal);
        var nextFakeId = -1;

        foreach (var entity in rows)
        {
            if (!IsEligible(entity)) continue;

            var score = Score(entity);
            var raw = SetupOf(entity);
            var norm = NormaliseSetup(raw);
            var dto = new TopJokeDto
            {
                JokeId = entity.JokeId,
                Setup = raw,
                Punchline = entity.JokeType == "twopart" ? entity.JokePunchline : string.Empty,
                Score = Math.Round(score, 2),
            };

            // (1) Same JokeId → collapse (the same joke rated twice). Register the slot's
            // ownership of this text so different-id rows with the same joke also fold in.
            if (entity.JokeId > 0)
            {
                var idKey = $"id:{entity.JokeId}";
                if (bestBySlot.TryGetValue(idKey, out var sameId))
                {
                    if (sameId.Score < score)
                    {
                        bestBySlot[idKey] = dto;
                        slotByNorm[norm] = idKey;
                    }
                    continue;
                }
            }

            // (2) Same normalised setup → collapse into the owning slot (kept when the new
            // telling scores higher). This covers the sanitiser rewrite (different raw text,
            // same joke) and the regenerated identical text — both rendered as duplicate
            // rows on the public board before this rule existed.
            if (slotByNorm.TryGetValue(norm, out var owner) && bestBySlot.TryGetValue(owner, out var owned))
            {
                if (owned.Score < score)
                    bestBySlot[owner] = dto;
                continue;
            }

            // (3) New row — first time we have seen this id or this normalised text.
            var slotKey = entity.JokeId > 0 ? $"id:{entity.JokeId}" : $"id:{nextFakeId--}";
            bestBySlot[slotKey] = dto;
            slotByNorm[norm] = slotKey;
        }

        return bestBySlot.Values
            .OrderByDescending(j => j.Score)
            // Deterministic tiebreak. Dictionary order is not guaranteed, so without this two
            // equally-rated jokes can swap places between requests — a board that reshuffles on
            // refresh reads as broken.
            .ThenBy(j => j.JokeId)
            .Take(top)
            .ToList();
    }

    /// <summary>
    /// The joke's score: the mean of the three dimensions the LLM is actually asked for.
    /// </summary>
    /// <remarks>
    /// Humour is stored in <c>RatingDifficulty</c> and originality in <c>RatingComplexity</c> —
    /// the prompt asks for originality/cleverness/humor and the results are written to legacy
    /// field names for row compatibility (see <c>AiJesterService.RateJokeUncachedAsync</c>).
    ///
    /// Deliberately not <c>RatingAverage</c>: that divides by four to fold in <c>Rudeness</c>,
    /// which is hardcoded to 1 for every joke, so it shifts every score by the same constant
    /// while adding no ranking signal.
    /// </remarks>
    public static double Score(JokePerformanceEntity e) =>
        (e.RatingDifficulty + e.RatingCleverness + e.RatingComplexity) / 3.0;

    /// <summary>Whether a row may appear on the public board at all.</summary>
    public static bool IsEligible(JokePerformanceEntity e)
    {
        // Rows written before rating existed, or whose rating call failed, persist as all-zero.
        // They are UNRATED, not zero-rated, and must not occupy a slot.
        if (e.RatingCleverness <= 0 && e.RatingComplexity <= 0 && e.RatingDifficulty <= 0)
            return false;

        // This is the one board whose rows are content rather than a score against a name, and
        // it is anonymous-readable. Flagged material is dropped here rather than at render time:
        // the flags are already on the row, and a board that can publish a slur because the
        // model happened to rate it highly is not worth the three rows it fills. Jokes fetched
        // in safe mode carry no flags and pass through untouched.
        if (e.FlagNsfw || e.FlagRacist || e.FlagSexist || e.FlagExplicit)
            return false;

        return !string.IsNullOrWhiteSpace(SetupOf(e));
    }

    /// <summary>Setup line for a two-part joke, or the whole text for a one-liner.</summary>
    private static string SetupOf(JokePerformanceEntity e) =>
        e.JokeType == "twopart" ? e.JokeSetup : e.JokeText;

    /// <summary>
    /// The canonical form of a setup: lowercase, whitespace-collapsed, punctuation-stripped.
    /// </summary>
    /// <remarks>
    /// Used to detect the sanitiser-rewrite case: two rows whose normalised setups match but
    /// whose raw setups differ represent the same joke arriving under different ids with
    /// different text rewrites. Rows that share a normalised setup with an IDENTICAL raw
    /// setup are deliberately NOT collapsed — see Test 3 in
    /// <see cref="TopJokeRankingTests"/>.
    /// </remarks>
    private static string NormaliseSetup(string setup)
    {
        var sb = new System.Text.StringBuilder(setup.Length);
        var lastWasSpace = false;
        foreach (var ch in setup)
        {
            if (char.IsWhiteSpace(ch))
            {
                if (sb.Length > 0 && !lastWasSpace) { sb.Append(' '); lastWasSpace = true; }
                continue;
            }
            // Drop punctuation so a trailing "?" or a smart vs straight apostrophe does not
            // split one joke into two rows.
            if (char.IsPunctuation(ch) || char.IsSymbol(ch)) continue;
            sb.Append(char.ToLowerInvariant(ch));
            lastWasSpace = false;
        }
        return sb.ToString().TrimEnd();
    }
}
