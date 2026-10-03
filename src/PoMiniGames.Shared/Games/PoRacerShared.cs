namespace PoMiniGames.Shared.Games;

/// <summary>
/// Server-canonical score payload. The host API overrides <see cref="PlayerDisplayName"/>
/// with the authenticated identity and dedupes by content hash.
/// </summary>
public sealed class PoRacerScoreDto
{
    public string PlayerDisplayName { get; set; } = "";
    /// <summary>Server-populated from auth cookie. Empty/zero on submit → server fills.</summary>
    public string UserId { get; set; } = "";
    public string TrackId { get; set; } = "circuit";
    // Keep the existing JSON field so queued scores and older clients remain readable.
    [System.Text.Json.Serialization.JsonPropertyName("totalTimeSeconds")]
    public double BestLapSeconds { get; set; }
    public int FinalPosition { get; set; }
    public DateTimeOffset AchievedAtUtc { get; set; }
    public bool IsGuest { get; set; }
    public string GameCode { get; set; } = "";
}

// ──────────────────────────────  Enums & Customization  ──────────────────────────────

public enum SurfaceKind
{
    Asphalt = 0,
    Sand = 1,
    Curbs = 2,
    BoostPad = 3
}

public sealed record PoRacerCarCustomization(string ColorHex, string LiveryPattern)
{
    public static readonly PoRacerCarCustomization Default = new("#00f0ff", "stripe");
}

public sealed class PoRacerBoostPadWire
{
    public double X { get; set; }
    public double Y { get; set; }
    public double Radius { get; set; } = 40.0;
    public double DirectionAngle { get; set; }
}

public sealed class PoRacerSurfaceZoneWire
{
    public string Name { get; set; } = "";
    public string SurfaceType { get; set; } = "asphalt";
    public double X { get; set; }
    public double Y { get; set; }
    public double Radius { get; set; }
}

// ──────────────────────────────  Lobby  ──────────────────────────────

// The lobby state and event records live in LobbyShared.cs (LobbyState<PoRacerLobbyPlayer>,
// LobbyEvent) — one wire shape for every ready/start lobby.
// TrackId is this seat's track pick. Only the host's counts (PoRacerRaceRegistry.StartMultiplayer
// reads it), but it rides on the seat so the shared lobby state carries it with no extra message.
public sealed record PoRacerLobbyPlayer(
    string ConnectionId,
    string DisplayName,
    bool IsGuest,
    bool IsReady,
    [property: System.Text.Json.Serialization.JsonIgnore] string UserId = "",
    string TrackId = PoRacerCatalog.DefaultTrackId) : ILobbyPlayer;

// ──────────────────────────────  Race  ──────────────────────────────

/// <summary>
/// What never changes during a race, per car. Sent in <see cref="PoRacerStaticWorld.Roster"/> on
/// join and re-broadcast as <c>raceRoster</c> when a driver's paint arrives, so the
/// name and colour strings do not ride every 20 Hz snapshot for all eight cars.
/// </summary>
public sealed record PoRacerCarInfo(int Id, string Name, string Color, string ColorDark, string Livery, bool IsPlayer, string Trait);

/// <summary>What a driver asks for when joining: solo mode and pace, and the paint the others will see.</summary>
public sealed class PoRacerJoinOptions
{
    /// <summary>"race" (99 rivals) or "trial" (an empty track). Solo races only.</summary>
    public string Mode { get; set; } = "race";
    /// <summary>"easy" / "medium" / "hard" bot pace. Solo races only.</summary>
    public string Difficulty { get; set; } = "medium";
    public string? ColorHex { get; set; }
    public string? Livery { get; set; }
}

/// <summary>
/// Server-authoritative state of one car, numbers only. Broadcast hub → client at ~20 Hz;
/// identity and paint are in <see cref="PoRacerCarInfo"/>.
/// </summary>
public sealed class PoRacerCarState
{
    public int Id { get; set; }
    public double X { get; set; }
    public double Y { get; set; }
    public double Heading { get; set; }
    public double Speed { get; set; }
    public int Lap { get; set; }
    public double FinishTime { get; set; } = -1;
    /// <summary>Fastest single lap so far, in seconds. -1 until the first lap completes.</summary>
    public double BestLapSeconds { get; set; } = -1;
    public double CurrentLapSeconds { get; set; }
    public double LastLapSeconds { get; set; } = -1;
    public double LapProgress { get; set; }
    public bool Finished { get; set; }
    public int Position { get; set; }
    public double SkidIntensity { get; set; }
    public double BoostGlow { get; set; }
    public double BoostTimer { get; set; }
    public string Surface { get; set; } = "asphalt";
    /// <summary>0..1, added by impacts only. Costs up to a tenth of top speed.</summary>
    public double Damage { get; set; }
    /// <summary>True while the car sits in another car's tow (more push, 4% more top speed).</summary>
    public bool Drafting { get; set; }
    /// <summary>0..1 drift charge. Letting go of a drift at 0.3 or more pays it out as a short boost.</summary>
    public double Drift { get; set; }
}

/// <summary>
/// Wire frame broadcast from hub → clients at ~20 Hz.
/// </summary>
public sealed class PoRacerRaceSnapshot
{
    public string GameCode { get; set; } = "";
    public double ServerTimeMs { get; set; }
    public IReadOnlyList<PoRacerCarState> Cars { get; set; } = new List<PoRacerCarState>();
    public double ElapsedRaceTime { get; set; }
    public int? LocalCarId { get; set; }
    public PoRacerFinalResult? Result { get; set; }
    public bool Started { get; set; }
    public int CountdownSeconds { get; set; }
    /// <summary>Milliseconds until lights out; the start gantry lights one lamp per 600 ms of it.</summary>
    public int CountdownMs { get; set; }
    public bool Paused { get; set; }
    public bool Finished { get; set; }
    public PoRacerStaticWorld? Static { get; set; }
}

/// <summary>Track geometry — sent once per race on join so the client can render statically.</summary>
public sealed class PoRacerStaticWorld
{
    public string TrackId { get; set; } = "circuit";
    public string TrackName { get; set; } = "Grand Prix Circuit";
    public string Theme { get; set; } = "circuit";
    public IReadOnlyList<double> CenterXY { get; set; } = new List<double>();
    public IReadOnlyList<double> WallsXY { get; set; } = new List<double>();
    public IReadOnlyList<PoRacerBoostPadWire> BoostPads { get; set; } = new List<PoRacerBoostPadWire>();
    public IReadOnlyList<PoRacerSurfaceZoneWire> SurfaceZones { get; set; } = new List<PoRacerSurfaceZoneWire>();
    public IReadOnlyList<PoRacerCarInfo> Roster { get; set; } = new List<PoRacerCarInfo>();
    public double TrackWidth { get; set; }
    public double MinX { get; set; }
    public double MinY { get; set; }
    public double MaxX { get; set; }
    public double MaxY { get; set; }
    public int TotalLaps { get; set; } = 3;
}

/// <summary>
/// Client → hub input packet. The booleans are the keyboard + touch shape; a gamepad also sends
/// the analog trio, and a non-zero analog value wins over its boolean (the sim clamps all three).
/// </summary>
public sealed class PoRacerInput
{
    public bool Up { get; set; }
    public bool Down { get; set; }
    public bool Left { get; set; }
    public bool Right { get; set; }
    public bool Space { get; set; }
    /// <summary>-1 (full left) … 1 (full right).</summary>
    public double Steer { get; set; }
    public double Throttle { get; set; }
    public double Brake { get; set; }
}

public sealed record PoRacerFinalResult(
    string GameCode,
    IReadOnlyList<PoRacerFinalEntry> Standings,
    DateTimeOffset FinishedAtUtc);

public sealed record PoRacerFinalEntry(
    int Position,
    string Name,
    int CarId,
    bool IsGuest,
    double TotalTimeSeconds,
    bool Finished,
    double BestLapSeconds = -1);
