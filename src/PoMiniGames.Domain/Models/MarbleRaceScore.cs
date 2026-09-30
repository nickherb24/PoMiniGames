namespace PoMiniGames.Domain.Models;

/// <summary>
/// A PoMarbleRace run total — placement points for consecutive top-10 finishes, with a streak
/// multiplier (see MarbleRaceRunVerifier) — that cannot
/// exist outside its legal range. Parsing an untrusted <see cref="int"/> into this type is the only
/// way to obtain one, so the range rule lives with the value instead of being re-checked (or
/// forgotten) at each call site.
/// </summary>
/// <remarks>
/// <see cref="Max"/> is a sanity ceiling, not a bound on real play: a genuine run tops out far
/// below it. It exists to reject a tampered submission (<c>int.MaxValue</c>) that would otherwise
/// own the board forever.
/// </remarks>
public readonly record struct MarbleRaceScore
{
    public const int Min = 0;
    public const int Max = 1_000_000;

    private MarbleRaceScore(int value) => Value = value;

    public int Value { get; }

    public static bool TryCreate(int value, out MarbleRaceScore score)
    {
        score = default;
        if (value is < Min or > Max) return false;
        score = new MarbleRaceScore(value);
        return true;
    }

    /// <summary>Parses a trusted value (one already persisted, or produced in-process).</summary>
    public static MarbleRaceScore Clamp(int value) => new(Math.Clamp(value, Min, Max));

    public static implicit operator int(MarbleRaceScore score) => score.Value;

    public override string ToString() => Value.ToString();
}
