using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoMarbleRace;

/// <summary>
/// Recomputes a PoMarbleRace run total from the races it claims, so the board stores the server's
/// arithmetic rather than the client's number. This is the second copy of game.js <c>_resolve</c>:
/// a change to SCORE_TOP, the dominant-win bonus or the streak multiplier must land in both.
/// </summary>
/// <remarks>
/// The places themselves are still the client's word — there is no server-side physics to re-run
/// (cannon-es, variable dt). What a forged run can no longer do is claim a total its races do not
/// add up to, or a finish no marble could physically reach: every race has to be a top-10 (a miss
/// ends a run at zero) and take at least the course's finish distance at twice the engine's speed
/// cap. The play-session guard then bounds how many such races fit in the time actually played.
/// </remarks>
public static class MarbleRaceRunVerifier
{
    public const int ScoreTop = 10;          // game.js SCORE_TOP
    public const int DominantBonus = 4;      // game.js DOMINANT_BONUS
    public const double DominantGap = 1.5;   // game.js DOMINANT_GAP
    public const int MaxStreakSteps = 4;     // game.js MAX_STREAK_STEPS
    public const double RaceTimeout = 180;   // game.js RACE_TIMEOUT
    public const int MaxRaces = 500;

    // Finish-line arclength per map slot: maps.js finishS for Spiral Works, the baked ARCLENGTH ×
    // SCALE minus the 16-unit backoff for Grand Spiral, 0.995 × LENGTH for the procedural maps
    // (Neon Chute 1800, Canyon Run 2200). Move a finish line and this moves with it.
    private static readonly Dictionary<int, double> FinishDistance = new()
    {
        [1] = 1791,
        [2] = 2230,
        [3] = 3881,
        [4] = 2189,
    };

    // ponytail: a speed bound, not a replay — marbles.js MAX_SPEED (85) doubled, because a marble
    // that drops off one ring of a spiral onto the next advances `s` faster than it moves. Proves a
    // time is reachable, not that a human steered it; a server-side sim is the upgrade path.
    private const double FastestUnitsPerSecond = 170;

    /// <summary>
    /// Is this a finish time a marble could actually post on this map? The same physical bound the
    /// run check applies per race, used on its own for the per-map world record.
    /// </summary>
    public static bool IsPlausibleFinish(int mapId, double seconds) =>
        FinishDistance.TryGetValue(mapId, out var distance)
        && seconds >= distance / FastestUnitsPerSecond && seconds <= RaceTimeout;

    /// <returns>The recomputed total, or null when the run is malformed or physically impossible.</returns>
    public static int? Score(int mapId, IReadOnlyList<MarbleRaceRunRace>? races)
    {
        if (races is null || races.Count is 0 or > MaxRaces) return null;
        if (!FinishDistance.TryGetValue(mapId, out var distance)) return null;

        var fastest = distance / FastestUnitsPerSecond;
        var total = 0;
        for (var i = 0; i < races.Count; i++)
        {
            var race = races[i];
            if (race.Place is < 1 or > ScoreTop) return null;
            if (!(race.FinishSeconds >= fastest && race.FinishSeconds <= RaceTimeout)) return null;

            var points = ScoreTop - race.Place + 1;
            if (race.Place == 1 && race.LeadSeconds >= DominantGap) points += DominantBonus;
            var multiplier = 1 + Math.Min(i, MaxStreakSteps) * 0.5;
            // JS Math.round rounds .5 up; every value here is positive, so AwayFromZero agrees.
            total += (int)Math.Round(points * multiplier, MidpointRounding.AwayFromZero);
        }
        return total;
    }
}
