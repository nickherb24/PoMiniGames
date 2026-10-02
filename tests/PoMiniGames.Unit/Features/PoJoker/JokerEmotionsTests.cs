using System.Text.Json;
using FluentAssertions;
using PoMiniGames.Features.PoJoker;
using PoMiniGames.Shared.Games.PoJoker;

namespace PoMiniGames.Unit.Features.PoJoker;

/// <summary>
/// The audience-portrait vocabulary spans three places that can drift independently: the
/// slug list in <see cref="JokerEmotions"/>, the JSON schema enum the rating model answers
/// from, and the WebP files on disk. Nothing at runtime notices a mismatch — the rating
/// model would name a reaction that has no image, and the show renders a broken portrait
/// for that joke and no error anywhere. This pins all three together.
/// </summary>
/// <remarks>
/// One <c>[Theory]</c> with a row per emotion, not a fact per
/// concern — the Unit tier is capped on method count, and a new portrait should
/// cost a row in <see cref="JokerEmotions.All"/> and nothing else.
/// <para>
/// File I/O in the hermetic tier follows the precedent set by
/// <c>PoSportsConstantsSyncTests</c>: reading the source tree to catch cross-artifact drift
/// is not the I/O the tier rule is about (no network, no storage, no clock).
/// </para>
/// </remarks>
public sealed class JokerEmotionsTests
{
    /// <summary>The emotion enum as the verdict model actually receives it.</summary>
    private static readonly string[] SchemaEmotions =
        AiJesterService.VerdictSchema
            .GetProperty("properties")
            .GetProperty("emotion")
            .GetProperty("enum")
            .EnumerateArray()
            .Select(e => e.GetString()!)
            .ToArray();

    private static DirectoryInfo RepoRoot()
    {
        // Walk up from the test bin dir to the repo root. PoMiniGames.slnx is the
        // marker; it always sits at the root.
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "PoMiniGames.slnx")))
        {
            dir = dir.Parent;
        }
        dir.Should().NotBeNull("the repo root (PoMiniGames.slnx) must be reachable from the test bin dir");
        return dir!;
    }

    public static TheoryData<string> Emotions
    {
        get
        {
            var data = new TheoryData<string>();
            foreach (var emotion in JokerEmotions.All) data.Add(emotion);
            return data;
        }
    }

    [Theory]
    [MemberData(nameof(Emotions))]
    public void EveryEmotion_HasAPortrait_AndIsOfferedToTheModel(string emotion)
    {
        // 1. A file the client will actually request. JokerEmotions.ImagePath is the same
        //    string the <img src> is built from, so this fails on a rename either side.
        var path = Path.Combine(
            RepoRoot().FullName,
            "src", "PoMiniGames.Client", "wwwroot",
            JokerEmotions.ImagePath(emotion).Replace('/', Path.DirectorySeparatorChar));
        File.Exists(path).Should().BeTrue(
            $"the '{emotion}' reaction must ship a portrait at {path}; the rating model can name it");

        // 2. Offered to the model, and nothing offered that is not on this list. Set equality
        //    rather than a containment check: an extra schema value is the dangerous direction
        //    (a name with no file behind it) and a row-scoped assertion would never see it.
        SchemaEmotions.Should().BeEquivalentTo(JokerEmotions.All,
            "the rating schema's enum is projected from JokerEmotions.All and must stay identical to it");

        // 3. Round-trips through the normalizer that guards the wire boundary.
        JokerEmotions.Normalize(emotion).Should().Be(emotion);
        JokerEmotions.Normalize(emotion.ToUpperInvariant()).Should().Be(emotion,
            "an LLM is free to shout its answer");
        JokerEmotions.Normalize($"  {emotion} ").Should().Be(emotion);
    }
}
