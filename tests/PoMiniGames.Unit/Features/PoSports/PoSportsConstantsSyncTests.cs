using System.Text.RegularExpressions;
using FluentAssertions;
using PoMiniGames.Features.PoSports;

namespace PoMiniGames.Unit.Features.PoSports;

/// <summary>
/// The stride model is implemented twice — PoSportsSim.cs (server-authoritative online
/// races) and physics.js (local 1P/2P/demo, which must work offline). This test parses
/// the CONSTANTS block out of physics.js and pins it to PoSportsConstants, so the two
/// implementations cannot drift without failing the build.
/// </summary>
/// <remarks>
/// Coverage deliberately reaches past the CONSTANTS block: the stumble-anim duration and
/// the server AI's medium-difficulty cadence (ai.js <c>DIFFICULTIES.medium</c>) are the
/// same kind of cross-language numeric contract, and were previously "mirrored" by comment
/// alone — a rebalance in ai.js silently desynced online CPU rivals from local ones.
/// New pairs go in <see cref="Pairs"/>; they are theory rows, not new test methods, so the
/// Unit tier's 100-method ceiling is unaffected.
/// </remarks>
public sealed class PoSportsConstantsSyncTests
{
    private static readonly Dictionary<string, double> JsConstants = ParseJsContract();

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

    private static string JsPath(string file) => Path.Combine(
        RepoRoot().FullName, "src", "PoMiniGames.Client", "wwwroot", "js", "posports", file);

    private static Dictionary<string, double> ParseJsContract()
    {
        var physicsPath = JsPath("physics.js");
        File.Exists(physicsPath).Should().BeTrue($"physics.js must exist at {physicsPath}");
        var physics = File.ReadAllText(physicsPath);

        var block = Regex.Match(physics, @"export const CONSTANTS = \{(?<body>[^}]*)\}",
            RegexOptions.Singleline);
        block.Success.Should().BeTrue("physics.js must export a CONSTANTS object literal");

        var values = Regex.Matches(block.Groups["body"].Value, @"(?<name>[A-Z_]+):\s*(?<value>[\d.e/-]+)")
            .ToDictionary(
                m => m.Groups["name"].Value,
                m => double.Parse(m.Groups["value"].Value, System.Globalization.CultureInfo.InvariantCulture));

        // Exported alongside the block rather than inside it, but the same contract.
        var stumble = Regex.Match(physics, @"export const STUMBLE_ANIM_SECONDS = (?<value>[\d.]+)");
        stumble.Success.Should().BeTrue("physics.js must export STUMBLE_ANIM_SECONDS");
        values["STUMBLE_ANIM_SECONDS"] = double.Parse(
            stumble.Groups["value"].Value, System.Globalization.CultureInfo.InvariantCulture);

        // The server AI mirrors ai.js's medium difficulty.
        var aiPath = JsPath("ai.js");
        File.Exists(aiPath).Should().BeTrue($"ai.js must exist at {aiPath}");
        var medium = Regex.Match(File.ReadAllText(aiPath), @"medium:\s*\{(?<body>[^}]*)\}");
        medium.Success.Should().BeTrue("ai.js must declare DIFFICULTIES.medium");
        foreach (Match m in Regex.Matches(medium.Groups["body"].Value,
                     @"(?<name>[a-zA-Z]+):\s*(?<value>[\d.]+)"))
        {
            values["medium." + m.Groups["name"].Value] = double.Parse(
                m.Groups["value"].Value, System.Globalization.CultureInfo.InvariantCulture);
        }

        return values;
    }

    public static TheoryData<string, double> Pairs => new()
    {
        { "STUMBLE_ANIM_SECONDS", PoSportsConstants.StumbleAnimSeconds },
        { "medium.keysPerSecond", PoSportsConstants.AiKeysPerSecond },
        { "medium.errorRate", PoSportsConstants.AiErrorRate },
        { "medium.jumpLookahead", PoSportsConstants.AiJumpLookahead },
        { "IMPULSE", PoSportsConstants.Impulse },
        { "DECAY", PoSportsConstants.Decay },
        { "MAX_SPEED", PoSportsConstants.MaxSpeed },
        { "JUMP_DURATION", PoSportsConstants.JumpDuration },
        { "JUMP_DRAG", PoSportsConstants.JumpDrag },
        { "STUMBLE_FACTOR", PoSportsConstants.StumbleFactor },
        { "STUMBLE_PENALTY", PoSportsConstants.StumblePenalty },
        { "FALSE_START_HOLD", PoSportsConstants.FalseStartHold },
        { "SPRINT_LENGTH", PoSportsConstants.SprintLength },
        { "HURDLES_LENGTH", PoSportsConstants.HurdlesLength },
        { "INTERSTITIAL_SECONDS", PoSportsConstants.InterstitialSeconds },
        { "TICK", PoSportsConstants.Tick },
    };

    [Theory]
    [MemberData(nameof(Pairs))]
    public void JsConstant_MatchesCSharp(string jsName, double csharpValue)
    {
        JsConstants.Should().ContainKey(jsName,
            "every C# constant must appear in the JS side of the contract");
        JsConstants[jsName].Should().BeApproximately(csharpValue, 1e-12,
            $"the JS {jsName} and PoSportsConstants must change in the same commit");
    }

    [Fact]
    public void HurdlePositions_Match()
    {
        var source = File.ReadAllText(JsPath("physics.js"));

        var m = Regex.Match(source, @"export const HURDLE_POSITIONS = \[(?<body>[^\]]*)\]");
        m.Success.Should().BeTrue();
        var js = m.Groups["body"].Value.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            .Select(double.Parse).ToArray();

        js.Should().Equal(PoSportsConstants.HurdlePositions);
    }
}
