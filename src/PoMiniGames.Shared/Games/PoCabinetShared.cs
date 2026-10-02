namespace PoMiniGames.Shared.Games;

// ──────────────────────────────  Career state  ──────────────────────────────

/// <summary>
/// Player's championship progress. Persisted client-side via Blazored.LocalStorage
/// (T7) and optionally synced to the server via <c>/api/pocabinet/career</c> (T4).
/// </summary>
public sealed class PoCabinetCareerDto
{
    public int CurrentStageIndex { get; set; }   // 0 = Capitol, 1 = Mar-a-Lago, 2 = Press Briefing, 3 = Playground (final)
    public bool TrophyUnlocked { get; set; }
    public bool GoldLiveryUnlocked { get; set; }
    public IReadOnlyList<int> CompletedStages { get; set; } = new List<int>();
    public DateTimeOffset UpdatedAtUtc { get; set; } = DateTimeOffset.UtcNow;

    public static PoCabinetCareerDto New() => new()
    {
        CurrentStageIndex = 0,
        TrophyUnlocked = false,
        GoldLiveryUnlocked = false,
        CompletedStages = new List<int>(),
        UpdatedAtUtc = DateTimeOffset.UtcNow,
    };
}

// ──────────────────────────────  Atmosphere wire  ──────────────────────────────

public sealed class PoCabinetAtmosphereWire
{
    public string SkyHex { get; set; } = "#0f1a3a";
    public double FogStart { get; set; }
    public double FogEnd { get; set; }
    public string FogHex { get; set; } = "#0f1a3a";
    public double AmbientIntensity { get; set; } = 0.5;
    public string GroundHex { get; set; } = "#888";
    /// <summary>Asphalt tint for the road ribbon (the ground is grass/sand/marble around it).</summary>
    public string RoadHex { get; set; } = "#3a3a40";
    public string AccentHex { get; set; } = "#888";
}

// ──────────────────────────────  Per-car state  ──────────────────────────────

/// <summary>
/// Wire shape for a single car in a snapshot. Trim-safe: every property is a
/// value type or a string — no reflection-heavy serialization shapes.
/// There is deliberately no dark/trim colour: the client derives it from
/// <see cref="Color"/>, and the per-car copy cost ~170 bytes of the 2 KB frame at 8 cars.
/// </summary>
public sealed class PoCabinetCarState
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    public string OfficialId { get; set; } = "";
    public string Color { get; set; } = "#ffffff";
    public double X { get; set; }
    public double Y { get; set; }
    public double Heading { get; set; }
    public double SpeedKmh { get; set; }
    public int Lap { get; set; }
    public double LapProgress { get; set; }
    public int Position { get; set; }
    public bool IsPlayer { get; set; }
    public bool Finished { get; set; }
    /// <summary>
    /// Highest <see cref="PoCabinetInput.Seq"/> the server has applied to this car (0 for AI
    /// officials and in solo races). The owning client drops acknowledged inputs from its
    /// prediction history and replays the rest on top of this server state.
    /// </summary>
    public int AckSeq { get; set; }
}

// ──────────────────────────────  Dialogue event  ──────────────────────────────

public sealed class PoCabinetDialogueEvent
{
    public string OfficialId { get; set; } = "";
    public string Kind { get; set; } = "PreRace";
    public string Text { get; set; } = "";
    public long RaceTick { get; set; }
}

// ──────────────────────────────  Race snapshot  ──────────────────────────────

/// <summary>
/// Hub → client broadcast at 30 Hz. Sized for ≤ 2 KB at 8 cars: the eight
/// <see cref="PoCabinetCarState"/> rows are 11 doubles + 4 strings + 5 int/bool,
/// which System.Text.Json serializes at roughly 200 bytes each — well under the
/// budget. The contract test in <c>PoCabinetSharedContractTests</c> measures
/// the actual byte count and fails the build if it slips.
/// </summary>
public sealed class PoCabinetRaceSnapshot
{
    public string GameCode { get; set; } = "";
    public long ServerTimeMs { get; set; }
    public double ElapsedRaceTime { get; set; }
    public bool Started { get; set; }
    public int CountdownSeconds { get; set; }
    public bool Finished { get; set; }
    public int? LocalCarId { get; set; }
    public IReadOnlyList<PoCabinetCarState> Cars { get; set; } = new List<PoCabinetCarState>();
    public PoCabinetDialogueEvent? LatestDialogue { get; set; }
    public PoCabinetStaticWorld? Static { get; set; }
    // The player's best lap, populated on the solo path
    // (the JS ticker) and on the server path (the registry). The page reads
    // this value on `Finished=true` to compute the leaderboard submission.
    public double? BestLapSeconds { get; set; }
}

/// <summary>
/// Static world payload — sent once on join, and built locally for solo races, both via
/// <see cref="PoCabinetTrackGeometry.BuildStaticWorld"/>. CenterXY is a flat double array
/// (PoRacer pattern). WallsXY is unused: walls are the centerline offset by TrackWidth/2 plus
/// the run-off, which both physics implementations derive themselves.
/// </summary>
public sealed class PoCabinetStaticWorld
{
    public string TrackId { get; set; } = "capitol";
    public string TrackName { get; set; } = "";
    public PoCabinetAtmosphereWire Atmosphere { get; set; } = new();
    public IReadOnlyList<double> CenterXY { get; set; } = new List<double>();
    public IReadOnlyList<double> WallsXY { get; set; } = new List<double>();
    public double TrackWidth { get; set; }
    public double MinX { get; set; }
    public double MinY { get; set; }
    public double MaxX { get; set; }
    public double MaxY { get; set; }
    public int TotalLaps { get; set; } = PoCabinetCatalog.TotalLaps;
    /// <summary>Road height per centerline sample (sim units); empty on a flat track. Drawn only.</summary>
    public IReadOnlyList<double> CenterZ { get; set; } = new List<double>();
    /// <summary>Point-to-point tracks: the centerline sample the finish line is on (0 = a circuit).
    /// Both physics copies turn it into the lap length.</summary>
    public int FinishIndex { get; set; }
    /// <summary>Centerline samples <c>[HiddenFrom, HiddenTo)</c> are the return link of a
    /// point-to-point track and are not drawn.</summary>
    public int HiddenFrom { get; set; }
    public int HiddenTo { get; set; }
    /// <summary>Cross slope per centerline sample (tan of the bank, + = right side higher); empty
    /// on an unbanked track. Drawn only.</summary>
    public IReadOnlyList<double> CenterBank { get; set; } = new List<double>();
    /// <summary>The centerline sample the scene starts laying tarmac at (0 = the whole track);
    /// before it the track is an open chute in place of a model's gutter. Drawn only.</summary>
    public int RoadFrom { get; set; }
}

// ──────────────────────────────  Player input  ──────────────────────────────

/// <summary>
/// One tick of player intent. Analog fields (keyboard ramp, gamepad, touch) win; the digital
/// Up/Down/Left/Right flags remain for callers that only have keys. Steer is +1 = right,
/// i.e. the heading-increasing direction in the sim's frame. Seq increases by one per client
/// tick and is echoed back as <see cref="PoCabinetCarState.AckSeq"/>.
/// </summary>
public sealed class PoCabinetInput
{
    public bool Up { get; set; }
    public bool Down { get; set; }
    public bool Left { get; set; }
    public bool Right { get; set; }
    public double Throttle { get; set; }
    public double Brake { get; set; }
    public double Steer { get; set; }
    public int Seq { get; set; }
}

// ──────────────────────────────  Multiplayer lobby  ──────────────────────────────

/// <summary>
/// One lobby seat as other players see it. <see cref="SeatId"/> is a hash of the
/// player's claim id — never the claim itself, which is an Entra object id.
/// </summary>
public sealed class PoCabinetLobbySeat
{
    public string SeatId { get; set; } = "";
    public string DisplayName { get; set; } = "";
    public bool IsGuest { get; set; }
    public bool IsReady { get; set; }
    public bool IsHost { get; set; }
    public string Color { get; set; } = "";
}

/// <summary>Full lobby state, broadcast as <c>LobbyState</c> after every change.</summary>
public sealed class PoCabinetLobbyView
{
    /// <summary>Internal id of the lobby's race (what <c>JoinRace</c> takes). Never shown — there are no join codes.</summary>
    public string Code { get; set; } = "";
    public string TrackId { get; set; } = PoCabinetCatalog.DefaultTrackId;
    /// <summary>AI officials the host asked for; the race seats min(BotCount, free seats).</summary>
    public int BotCount { get; set; }
    /// <summary>True while a race for this lobby is running; the lobby reopens when it ends.</summary>
    public bool InRace { get; set; }
    public IReadOnlyList<PoCabinetLobbySeat> Players { get; set; } = new List<PoCabinetLobbySeat>();
    /// <summary>The caller's own seat — set only on the Join reply (null there when no seat was free), null in broadcasts.</summary>
    public string? YourSeatId { get; set; }
}

// ──────────────────────────────  Final result  ──────────────────────────────

public sealed record PoCabinetFinalResult(
    string GameCode,
    IReadOnlyList<PoCabinetFinalEntry> Standings,
    DateTimeOffset FinishedAtUtc);

/// <summary>
/// One finisher. <see cref="TotalTimeSeconds"/> is race time from GO to the line (-1 when the
/// car was still running at the cut-off); <see cref="CarId"/> lets a client find its own row
/// by the <c>LocalCarId</c> it was given on join.
/// </summary>
public sealed record PoCabinetFinalEntry(
    int Position,
    string Name,
    string OfficialId,
    bool IsPlayer,
    bool Finished,
    double TotalTimeSeconds,
    double BestLapSeconds = -1,
    int CarId = -1);

// ──────────────────────────────  AI: banter + debrief  ──────────────────────────────

/// <summary>
/// The officials' radio lines for one track (GET /api/pocabinet/banter?track=): official id →
/// kind (<c>preRace</c>, <c>passed</c>, <c>lead</c>, <c>finish</c>) → lines. The solo race picks
/// from it client-side, so a whole race costs at most this one request. <see cref="Mock"/>
/// marks the scripted fallback.
/// </summary>
public sealed class PoCabinetBanterPool
{
    public Dictionary<string, Dictionary<string, List<string>>> Lines { get; set; } = new();
    public bool Mock { get; set; }
}

/// <summary>
/// Numbers only (POST /api/pocabinet/debrief) — the server clamps them and writes every word the
/// model sees. <see cref="SectorDeltas"/> is seconds vs the personal-best lap per third of the
/// lap (+ = slower); empty when there is no reference lap. Percentages are 0–100;
/// <see cref="WorstPointPct"/> is where on the lap the most time went (-1 = unknown).
/// </summary>
public sealed record PoCabinetDebriefRequest(
    string TrackId,
    int Position,
    int TotalCars,
    double BestLapSeconds,
    double PbSeconds,
    double[] SectorDeltas,
    int FullThrottlePct,
    int BrakePct,
    int TopKmh,
    int SlowestKmh,
    int WorstPointPct,
    int WallHits,
    int Laps);

/// <summary>The race engineer's read: a satirical headline and up to three concrete tips.</summary>
public sealed record PoCabinetDebriefReply(string Headline, IReadOnlyList<string> Tips, bool Mock);
