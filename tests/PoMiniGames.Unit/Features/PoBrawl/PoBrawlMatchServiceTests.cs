using FluentAssertions;
using PoMiniGames.Domain.Primitives;
using PoMiniGames.Features.PoBrawl.Online;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Unit.Features.PoBrawl;

/// <summary>
/// Server-side simulation tests for the live 1v1 match service. Side pinning,
/// range-gated damage resolution, deterministic damage rolls, finish conditions,
/// and the result payload shape per recipient.
/// </summary>
/// <remarks>
/// Bundled into a handful of <c>[Fact]</c>s so the Unit tier stays under its
/// 100-method ceiling. Each test covers one observable behaviour of the resolver.
/// Since 2026-09-23 the ring has spacing: the corners open 3.2 m apart, out of every
/// attack's reach, so each test that wants a hit walks in first (<see cref="CloseIn"/>).
/// </remarks>
public class PoBrawlMatchServiceTests
{
    private long _seq;

    private static PoBrawlLobbyPlayer NewPlayer(string connId, string principal, string name, PoBrawlFighter fighter) =>
        new(connId, principal, name, IsGuest: false, IsReady: true, fighter);

    private static PoBrawlMatchService StartedMatch(string matchId = "test-match")
    {
        var alice = NewPlayer("conn-1", "alice", "Alice", PoBrawlRoster.Bob);
        var bob = NewPlayer("conn-2", "bob", "Bob", PoBrawlRoster.Bob);
        var match = new PoBrawlMatchService(matchId, "BRAWL", new[] { alice, bob });
        match.RegisterConnection("conn-1", PoBrawlSide.Player1);
        match.RegisterConnection("conn-2", PoBrawlSide.Player2);
        return match;
    }

    private void Send(PoBrawlMatchService match, string conn, PoBrawlMatchAction action, PoBrawlSide claimed = PoBrawlSide.Player1) =>
        match.SubmitInput(conn, new PoBrawlMatchInput { ActorSide = claimed, Action = action, Sequence = ++_seq });

    /// <summary>Walk <paramref name="conn"/> forward until the gap is inside punch reach, then stop.</summary>
    private PoBrawlMatchState CloseIn(PoBrawlMatchService match, string conn)
    {
        Send(match, conn, PoBrawlMatchAction.MoveForward);
        PoBrawlMatchState snap = match.Tick()!;
        for (var i = 0; i < 40 && snap.Player2X - snap.Player1X > PoBrawlOnlineRules.PunchReach - 0.1; i++)
            snap = match.Tick()!;
        Send(match, conn, PoBrawlMatchAction.Idle);
        return snap;
    }

    /// <summary>Close in, then press <paramref name="attack"/> every tick until the match ends.</summary>
    private PoBrawlMatchState? FightToKo(PoBrawlMatchService match, string conn, PoBrawlMatchAction attack)
    {
        CloseIn(match, conn);
        PoBrawlMatchState? snap = null;
        for (var tick = 0; tick < 600; tick++)
        {
            // Knockback opens the gap, so keep walking back into range between swings.
            Send(match, conn, PoBrawlMatchAction.MoveForward);
            Send(match, conn, attack);
            snap = match.Tick();
            if (snap is { Finished: true }) break;
        }
        return snap;
    }

    [Fact]
    public void SideFor_ReturnsPinnedSide()
    {
        var match = StartedMatch();
        match.SideFor("conn-1").Should().Be(PoBrawlSide.Player1);
        match.SideFor("conn-2").Should().Be(PoBrawlSide.Player2);
    }

    [Fact]
    public void Tick_LandsOnlyInRange_OncePerPress_AndBlockNegatesPunch()
    {
        // Three behaviours in one test (would be three Facts without the ceiling pressure).
        // 1. Out of range: the fight opens 3.2 m apart, so a punch from spawn whiffs.
        var far = StartedMatch("far");
        Send(far, "conn-1", PoBrawlMatchAction.Punch);
        var whiff = far.Tick()!;
        whiff.Player2Hp.Should().Be(100, "a jab thrown from across the ring must not land");
        whiff.LastEvent.Should().Be("p1-whiff");

        // 2. In range, a single press lands exactly once — the old model kept the last
        //    action live and punched ten times a second off one key-down.
        var near = StartedMatch("near");
        CloseIn(near, "conn-1");
        Send(near, "conn-1", PoBrawlMatchAction.Punch);
        var landed = near.Tick()!;
        landed.Player2Hp.Should().BeLessThan(100);
        var afterOne = landed.Player2Hp;
        for (var i = 0; i < 10; i++) near.Tick();
        near.Tick()!.Player2Hp.Should().Be(afterOne, "one press is one swing");

        // 3. A held guard negates a punch in range.
        var guard = StartedMatch("guard");
        CloseIn(guard, "conn-1");
        Send(guard, "conn-2", PoBrawlMatchAction.Block);
        Send(guard, "conn-1", PoBrawlMatchAction.Punch);
        var blocked = guard.Tick()!;
        blocked.Player2Hp.Should().Be(100, "punch is fully negated by a block");
        blocked.LastEvent.Should().Be("p1-blocked");
    }

    [Fact]
    public void SubmitInput_OverridesActorWithPinnedSide()
    {
        var match = StartedMatch();
        // Malicious: conn-1 (P1) claims to be P2 and walks. The server pins it to P1, so
        // it is P1's corner that moves — P2's must not budge.
        Send(match, "conn-1", PoBrawlMatchAction.MoveForward, claimed: PoBrawlSide.Player2);
        var snap = match.Tick()!;
        snap.Player1X.Should().BeGreaterThan(-1.6, "the pinned side (P1) walked");
        snap.Player2X.Should().Be(1.6, "the claimed side (P2) must be untouched");
    }

    [Fact]
    public void Tick_AppliesDamageDeterministically_PerMatchId()
    {
        var first = StartedMatch("dup-match");
        var second = StartedMatch("dup-match");
        var hp = new List<int>();
        foreach (var m in new[] { first, second })
        {
            CloseIn(m, "conn-1");
            for (var i = 0; i < 5; i++)
            {
                Send(m, "conn-1", PoBrawlMatchAction.Punch);
                for (var t = 0; t < PoBrawlMatchService.PunchCooldownTicks; t++) m.Tick();
            }
            hp.Add(m.Tick()!.Player2Hp);
        }
        hp[0].Should().BeLessThan(100);
        hp[0].Should().Be(hp[1], "same match id + same inputs must roll the same damage");
    }

    [Fact]
    public void Tick_FinishesByKo_ThenReturnsNull_AndRejectsFurtherInputs()
    {
        var match = StartedMatch();
        var final = FightToKo(match, "conn-2", PoBrawlMatchAction.Kick);
        final.Should().NotBeNull();
        final!.Finished.Should().BeTrue();
        final.Winner.Should().Be(PoBrawlSide.Player2);
        final.LastEvent.Should().Be("ko");
        // Once finished, subsequent ticks must report null so the pump stops broadcasting.
        match.Tick().Should().BeNull();
        // Post-finish: SubmitInput is a no-op so a stale client cannot keep firing hits.
        var accepted = match.SubmitInput("conn-1", new PoBrawlMatchInput { ActorSide = PoBrawlSide.Player1, Action = PoBrawlMatchAction.Special, Sequence = 999 });
        accepted.Should().BeFalse();
    }

    /// <summary>
    /// The 2026-09-29 lifecycle in one fact (Unit ceiling): the pre-roll holds the fight, each tick
    /// reports what each corner's swing did (the 3D view lands exactly that), a corner that stays
    /// away forfeits, and the rematch needs both corners' votes.
    /// </summary>
    [Fact]
    public void Lifecycle_PreRoll_SwingReport_Forfeit_AndRematchVotes()
    {
        // Pre-roll: nothing moves and a press made during the count is dropped.
        var alice = NewPlayer("conn-1", "alice", "Alice", PoBrawlRoster.Bob);
        var bob = NewPlayer("conn-2", "bob", "Bob", PoBrawlRoster.Bob);
        var counted = new PoBrawlMatchService("count", "ROOM1", new[] { alice, bob }, countdownSeconds: 1);
        counted.RegisterConnection("conn-1", PoBrawlSide.Player1);
        counted.RegisterConnection("conn-2", PoBrawlSide.Player2);
        Send(counted, "conn-1", PoBrawlMatchAction.MoveForward);
        Send(counted, "conn-1", PoBrawlMatchAction.Kick);
        var pre = counted.Tick()!;
        pre.ElapsedSeconds.Should().BeLessThan(0);
        pre.Player1X.Should().Be(-1.6, "the count holds everyone on their marks");
        for (var i = 0; i < 10; i++) counted.Tick();
        var live = counted.Tick()!;
        live.Player1X.Should().BeGreaterThan(-1.6, "a key held through the count walks on the bell");
        live.Player1Swing.Should().BeNull("the kick pressed during the count was dropped");

        // Swing report: the corner, the attack, the outcome and the exact damage dealt.
        var match = StartedMatch("report");
        CloseIn(match, "conn-1");
        Send(match, "conn-1", PoBrawlMatchAction.Punch);
        var hit = match.Tick()!;
        hit.Player1Swing.Should().Be(PoBrawlMatchAction.Punch);
        hit.Player1Outcome.Should().Be("hit");
        hit.Player1Damage.Should().Be(100 - hit.Player2Hp);
        hit.Player2Swing.Should().BeNull();

        // Forfeit: P2 drops and never comes back.
        match.UnregisterConnection("conn-2");
        PoBrawlMatchState? end = null;
        for (var i = 0; i < (PoBrawlMatchService.ReconnectGraceSeconds + 1) * PoBrawlMatchService.TickHz && end is not { Finished: true }; i++)
            end = match.Tick();
        end!.Finished.Should().BeTrue();
        end.LastEvent.Should().Be("forfeit");
        end.Winner.Should().Be(PoBrawlSide.Player1);
        match.BuildResultFor("conn-1").Forfeit.Should().BeTrue();

        // Rematch: P2 comes back after the bell; one vote is not enough, two start it.
        match.RegisterConnection("conn-2", PoBrawlSide.Player2);
        match.VoteRematch("conn-1").Should().BeFalse();
        match.Snapshot().RematchVotes.Should().Be(1);
        match.VoteRematch("conn-2").Should().BeTrue();
    }

    [Fact]
    public void BuildResultFor_ShapesOutcomePerConnection()
    {
        var match = StartedMatch();
        FightToKo(match, "conn-2", PoBrawlMatchAction.Punch);
        var p1Result = match.BuildResultFor("conn-1");
        var p2Result = match.BuildResultFor("conn-2");
        p1Result.LocalSide.Should().Be(PoBrawlSide.Player1);
        p1Result.Outcome.Should().Be(PoBrawlOutcome.Loss);
        p2Result.LocalSide.Should().Be(PoBrawlSide.Player2);
        p2Result.Outcome.Should().Be(PoBrawlOutcome.Win);
        p1Result.OpponentId.Should().Be("bob");
        p2Result.OpponentId.Should().Be("alice");
        // The pump sends results to these, not to the lobby roster's connection ids.
        match.ConnectionIds.Should().BeEquivalentTo(new[] { "conn-1", "conn-2" });
    }
}
