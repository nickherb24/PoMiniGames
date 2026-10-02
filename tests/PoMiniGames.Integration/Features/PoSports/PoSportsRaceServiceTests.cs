using System.Collections.Concurrent;
using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using PoMiniGames.Domain.Models;
using PoMiniGames.Domain.Abstractions;
using PoMiniGames.Features.PoSports;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Integration;

/// <summary>
/// Online-path coverage for the PoSports race service with no live hub and no
/// timers (startTimers:false + manual Advance): lobby-seeded lane layout, key
/// routing, phase flow, and score persistence through a capturing storage fake.
/// Lives in the Integration tier — the Unit tier is at its 100-method ceiling.
/// </summary>
public sealed class PoSportsRaceServiceTests
{
    private const double Dt = 1.0 / 60.0;

    /// <summary>Captures saved PoSports scores; every other member is inert.</summary>
    private sealed class CapturingStorage : IStorageService
    {
        public readonly ConcurrentBag<PoSportsHighScore> Saved = [];

        public Task<List<PoSportsHighScore>> GetPoSportsHighScoresAsync(int limit = 10, string? day = null) =>
            Task.FromResult(Saved.OrderBy(s => s.TotalTimeSeconds).Take(limit).ToList());

        public Task<PoSportsHighScore> SavePoSportsHighScoreAsync(PoSportsHighScore entry, string? day = null)
        {
            Saved.Add(entry);
            return Task.FromResult(entry);
        }

        // Inert surface — PoSports never touches these.
        public IAsyncEnumerable<PlayerStatsDto> GetAllPlayerStatsAsync(CancellationToken ct = default) =>
            throw new NotSupportedException();
        public Task<PlayerStats?> GetPlayerStatsAsync(string game, string playerName) =>
            Task.FromResult<PlayerStats?>(null);
        public Task SavePlayerStatsAsync(string game, string playerName, PlayerStats stats) => Task.CompletedTask;
        public Task<List<(string Name, PlayerStats Stats)>> GetLeaderboardAsync(string game, int limit, string? difficulty = null) =>
            Task.FromResult(new List<(string, PlayerStats)>());
        public Task<List<MarbleRaceHighScore>> GetMarbleRaceHighScoresAsync(int limit = 10) =>
            Task.FromResult(new List<MarbleRaceHighScore>());
        public Task<MarbleRaceHighScore> SaveMarbleRaceHighScoreAsync(MarbleRaceHighScore entry) => Task.FromResult(entry);
        public Task<List<MarbleRaceMapRecord>> GetMarbleRaceMapRecordsAsync() => Task.FromResult(new List<MarbleRaceMapRecord>());
        public Task<MarbleRaceMapRecord> SaveMarbleRaceMapRecordAsync(MarbleRaceMapRecord entry) => Task.FromResult(entry);
        public Task<List<PoBrawlHighScore>> GetPoBrawlHighScoresAsync(int limit = 10) =>
            Task.FromResult(new List<PoBrawlHighScore>());
        public Task<PoBrawlHighScore> SavePoBrawlHighScoreAsync(PoBrawlHighScore entry) => Task.FromResult(entry);
        public Task<List<PoRacerHighScore>> GetPoRacerHighScoresAsync(int limit = 10, string? trackId = null) =>
            Task.FromResult(new List<PoRacerHighScore>());
        public Task<PoRacerHighScore> SavePoRacerHighScoreAsync(PoRacerHighScore entry) => Task.FromResult(entry);
        // T5: PoCabinet surface — inert for PoSports tests.
        public Task<List<PoCabinetHighScore>> GetPoCabinetHighScoresAsync(int limit = 10, string? trackId = null) =>
            Task.FromResult(new List<PoCabinetHighScore>());
        public Task<PoCabinetHighScore> SavePoCabinetHighScoreAsync(PoCabinetHighScore entry) => Task.FromResult(entry);
        public Task<List<PoBrawlLadderEntry>> GetPoBrawlLadderAsync(int limit = 10) =>
            Task.FromResult(new List<PoBrawlLadderEntry>());
        public Task<PoBrawlLadderEntry> SavePoBrawlLadderAsync(PoBrawlLadderEntry entry) => Task.FromResult(entry);

        public Task<List<PoBrawlFighterRating>> GetPoBrawlFighterRatingsAsync(int limit = 10) =>
            Task.FromResult(new List<PoBrawlFighterRating>());

        public Task RecordPoBrawlDemoResultAsync(
            string winnerFighterId, string loserFighterId, bool isDraw) =>
            Task.CompletedTask;

        // Inert stubs for the online player-Elo interface members.
        // PoSports never touches the online player-Elo board, so these exist
        // purely to keep the interface contract satisfied.
        public Task<List<PoBrawlPlayerRating>> GetPoBrawlPlayerRatingsAsync(int limit = 10) =>
            Task.FromResult(new List<PoBrawlPlayerRating>());
        public Task RecordPoBrawlOnlineMatchAsync(
            string winnerPrincipalId, string loserPrincipalId,
            string winnerDisplayName, string loserDisplayName, bool isDraw) =>
            Task.CompletedTask;

        public Task<List<PoVoxelStrikeHighScore>> GetPoVoxelStrikeHighScoresAsync(int limit = 10, string? day = null) =>
            Task.FromResult(new List<PoVoxelStrikeHighScore>());
        public Task<PoVoxelStrikeHighScore> SavePoVoxelStrikeHighScoreAsync(PoVoxelStrikeHighScore entry, string? day = null) =>
            Task.FromResult(entry);

        public bool IsStorageHealthy() => true;
    }

    private static (PoSportsRaceService race, PoSportsLobbyService lobby, CapturingStorage storage) StartedRace()
    {
        var lobby = new PoSportsLobbyService();
        // Alice is signed in (a stable id); Bob is a guest with none — the race binds the
        // first by identity and falls back to the sanitized name for the second.
        lobby.Open("conn-alice", "Alice", isGuest: false, userId: "user-alice");
        lobby.Open("conn-bob", "Bob", isGuest: true);
        lobby.PickCharacter("conn-alice", "kim");
        lobby.PickCharacter("conn-bob", "matt");
        lobby.SetReady("conn-bob", true);
        lobby.TryStart("conn-alice").Should().BeTrue();

        var storage = new CapturingStorage();
        var race = new PoSportsRaceService(
            "LOBBY", lobby.Seats, lobby, storage,
            NullLogger<PoSportsRaceService>.Instance, startTimers: false, seed: 11);
        return (race, lobby, storage);
    }

    private static void Advance(PoSportsRaceService race, double seconds)
    {
        for (var i = 0; i < (int)(seconds / Dt); i++) race.Advance(Dt);
    }

    [Fact]
    public void LobbySeeding_HumansFirst_AiFillsRemainingLanes()
    {
        var (race, _, _) = StartedRace();

        var snap = race.Snapshot();

        snap.Phase.Should().Be("countdown");
        snap.Lanes.Should().HaveCount(4);
        snap.Lanes[0].Should().Match<PoSportsLaneState>(l => l.Name == "Alice" && l.Character == "kim" && !l.IsAi);
        snap.Lanes[1].Should().Match<PoSportsLaneState>(l => l.Name == "Bob" && l.Character == "matt" && !l.IsAi);
        snap.Lanes.Skip(2).Should().OnlyContain(l => l.IsAi, "unpicked family members fill the track");
        snap.Lanes.Select(l => l.Character).Should().OnlyHaveUniqueItems();
    }

    [Fact]
    public void KeyRouting_AdvancesOnlyTheSendersLane()
    {
        var (race, _, _) = StartedRace();
        race.RegisterOwner("conn-alice", "Alice", "user-alice", isGuest: false);
        race.RegisterOwner("conn-bob", "Bob", "", isGuest: true);
        Advance(race, 3.1); // countdown over, gun fired

        // Alice types a full correct cycle; Bob types one wrong-order key.
        for (var step = 0; step < 4; step++) race.SendSequenceKey("conn-alice", step);
        race.SendSequenceKey("conn-bob", 2);
        race.Advance(Dt);

        var snap = race.Snapshot();
        snap.Lanes[0].Speed.Should().BeGreaterThan(0, "a completed cycle injects an impulse");
        snap.Lanes[1].Speed.Should().Be(0);
        snap.Lanes[1].SeqProgress.Should().Be(0, "an out-of-order key resets the cycle");
    }

    [Fact]
    public void MeetFlow_InterstitialAutoAdvances_And_PersistsHumanScores()
    {
        var (race, lobby, storage) = StartedRace();
        race.RegisterOwner("conn-alice", "Alice", "user-alice", isGuest: false);
        race.RegisterOwner("conn-bob", "Bob", "", isGuest: true);

        var finished = false;
        race.Finished += _ => finished = true;

        // Humans idle; the 90s leg timeout + AI lanes carry the meet to the podium.
        // countdown 3 + sprint ≤90 + interstitial 8 + hurdles ≤90 + margin.
        Advance(race, 3 + 90 + 8 + 90 + 2);

        var snap = race.Snapshot();
        snap.Phase.Should().Be("podium");
        finished.Should().BeTrue();
        snap.Lanes.Select(l => l.Placing).Should().BeEquivalentTo([1, 2, 3, 4]);

        // Exactly the two human lanes persisted — guest and authed shapes intact.
        storage.Saved.Should().HaveCount(2);
        var alice = storage.Saved.Single(s => s.PlayerName == "Alice");
        alice.UserId.Should().Be("user-alice");
        alice.IsGuest.Should().BeFalse();
        var bob = storage.Saved.Single(s => s.PlayerName == "Bob");
        bob.IsGuest.Should().BeTrue();
        storage.Saved.Should().OnlyContain(s =>
            Math.Abs(s.SprintSeconds + s.HurdlesSeconds - s.TotalTimeSeconds) < 0.001
            && s.GameCode == "LOBBY");

        // The meet's end resets the lobby for the next ready round.
        lobby.IsStarted.Should().BeFalse();
    }

    [Fact]
    public void LaneBinding_SurvivesNameTruncationAndRefreshDefault()
    {
        var lobby = new PoSportsLobbyService();
        // Longer than the lobby's 24-char cap, so the lane name is NOT what the client sends.
        const string longName = "Bartholomew Fitzgerald-Montgomery";
        lobby.Open("conn-long", longName, isGuest: false, userId: "user-long");
        lobby.PickCharacter("conn-long", "kim");
        lobby.TryStart("conn-long").Should().BeTrue();

        var race = new PoSportsRaceService(
            "LOBBY", lobby.Seats, lobby, new CapturingStorage(),
            NullLogger<PoSportsRaceService>.Instance, startTimers: false, seed: 5);

        race.Snapshot().Lanes[0].Name.Should().NotBe(longName, "the lobby truncates to 24 chars");

        // The raw (untruncated) name never equals the lane name, and a page refresh sends
        // the client's default name — identity is what makes both of these bind.
        race.RegisterOwner("conn-race", longName, "user-long", isGuest: false).Should().Be(0);
        race.RemoveConnection("conn-race");
        race.RegisterOwner("conn-after-refresh", "Player", "user-long", isGuest: false).Should().Be(0);

        // Keys from the rebound connection drive that lane.
        Advance(race, 3.1);
        for (var step = 0; step < 4; step++) race.SendSequenceKey("conn-after-refresh", step);
        race.Advance(Dt);
        race.Snapshot().Lanes[0].Speed.Should().BeGreaterThan(0);
    }

    [Fact]
    public void FinishedRace_IsMarkedFinished_AndPersistsSeatIdentityAfterDisconnect()
    {
        var (race, _, storage) = StartedRace();
        race.RegisterOwner("conn-alice", "Alice", "user-alice", isGuest: false);

        // Alice drops before the podium: her run must still be attributed from her seat.
        race.RemoveConnection("conn-alice");
        Advance(race, 3 + 90 + 8 + 90 + 2);

        race.Snapshot().Phase.Should().Be("podium");
        race.IsFinished.Should().BeTrue("the registry refuses a finished race to the next meet's joiners");
        storage.Saved.Single(s => s.PlayerName == "Alice").UserId.Should().Be("user-alice");
    }

    [Fact]
    public void DisconnectDecays_RejoinResetsSequenceProgress()
    {
        var (race, _, _) = StartedRace();
        race.RegisterOwner("conn-alice", "Alice", "user-alice", isGuest: false);
        Advance(race, 3.1);

        // Build speed and a partial sequence.
        for (var step = 0; step < 4; step++) race.SendSequenceKey("conn-alice", step);
        race.SendSequenceKey("conn-alice", 0);
        race.SendSequenceKey("conn-alice", 1);
        race.Snapshot().Lanes[0].SeqProgress.Should().Be(2);
        var speedAtDrop = race.Snapshot().Lanes[0].Speed;

        // Disconnect: the lane keeps running and decays; keys from the dead conn are ignored.
        race.RemoveConnection("conn-alice");
        race.SendSequenceKey("conn-alice", 2);
        Advance(race, 1.0);
        var decayed = race.Snapshot().Lanes[0];
        decayed.Speed.Should().BeLessThan(speedAtDrop).And.BeGreaterThan(0);

        // Rejoin from a new connection rebinds the lane and resets the rhythm.
        race.RegisterOwner("conn-alice-2", "Alice", "user-alice", isGuest: false).Should().Be(0);
        race.Snapshot().Lanes[0].SeqProgress.Should().Be(0);
        for (var step = 0; step < 4; step++) race.SendSequenceKey("conn-alice-2", step);
        race.Advance(Dt);
        race.Snapshot().Lanes[0].Speed.Should().BeGreaterThan(decayed.Speed - 0.2,
            "the rebound connection's keys drive the same lane");
    }
}
