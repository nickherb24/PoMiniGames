using FluentAssertions;
using PoMiniGames.Domain.Primitives;
using PoMiniGames.Features.PoBrawl.Online;

namespace PoMiniGames.Unit.Features.PoBrawl;

/// <summary>
/// State-machine tests for the live 1v1 lobby. Host assignment, cap-2 rejection,
/// ready toggling, host migration, and the TryStart gates that protect the match
/// service from launching on a half-formed roster.
/// </summary>
/// <remarks>
/// Bundled into a handful of <c>[Fact]</c>s / <c>[Theory]</c>s so the Unit tier
/// stays under its 100-method ceiling. Each test covers one observable behaviour.
/// </remarks>
public class PoBrawlLobbyServiceTests
{
    private static PoBrawlFighter AnyFighter => PoBrawlRoster.Bob;

    // Host assignment and the cap-2 bounce share one arrangement, so they are one
    // fact (2026-09-14: the slot went to the turn-match service tests).
    [Fact]
    public void Open_AssignsFirstArrivalAsHost_AndBouncesThirdAtCap()
    {
        var lobby = new PoBrawlLobbyService("TEST", isPublic: true);
        lobby.Open("conn-1", "alice", "Alice", isGuest: false, AnyFighter);
        lobby.Open("conn-2", "bob", "Bob", isGuest: true, AnyFighter);
        lobby.State.HostConnectionId.Should().Be("conn-1");
        lobby.State.Players.Should().HaveCount(2);

        var (state, msg) = lobby.Open("conn-3", "eve", "Eve", isGuest: true, AnyFighter);
        state.Players.Should().HaveCount(2);
        msg.Should().Contain("full");
    }

    [Fact]
    public void RejoinSameConnection_RefreshesPlayerRow_PreservesHost()
    {
        var lobby = new PoBrawlLobbyService("TEST", isPublic: true);
        lobby.Open("conn-1", "alice", "Alice", isGuest: false, AnyFighter);
        lobby.ToggleReady("conn-1");
        var (state, _) = lobby.Open("conn-1", "alice", "Alice2", isGuest: false, AnyFighter);
        state.HostConnectionId.Should().Be("conn-1");
        state.Players.Should().HaveCount(1);
        state.Players[0].DisplayName.Should().Be("Alice2");
    }

    [Fact]
    public void TryStart_RequiresHostAndAllReady_AndIsIdempotent()
    {
        var lobby = new PoBrawlLobbyService("TEST", isPublic: true);
        lobby.Open("conn-1", "alice", "Alice", isGuest: false, AnyFighter);
        lobby.Open("conn-2", "bob", "Bob", isGuest: true, AnyFighter);
        lobby.ToggleReady("conn-1");
        lobby.TryStart("conn-2").Should().BeFalse("only the host can start");
        lobby.TryStart("conn-1").Should().BeFalse("bob is not ready");
        lobby.ToggleReady("conn-2");
        lobby.TryStart("conn-1").Should().BeTrue();
        lobby.TryStart("conn-1").Should().BeFalse("a second start cannot re-enter the gate");
    }

    /// <summary>
    /// Rooms (2026-09-29): quick match still pairs two strangers, a private room is never handed
    /// to quick match or listed, and the browser shows waiting public rooms and live fights.
    /// </summary>
    [Fact]
    public void Rooms_QuickMatchPairs_PrivateStaysHidden_ListShowsWaitingAndLive()
    {
        var rooms = new PoBrawlRooms();
        var matches = new PoBrawlMatchRegistry();

        var hidden = rooms.Create(isPublic: false);
        hidden.Open("conn-p", "carol", "Carol", isGuest: false, AnyFighter);

        var first = rooms.QuickMatch();
        first.Should().NotBeSameAs(hidden, "quick match never seats a stranger in a private room");
        first.Open("conn-1", "alice", "Alice", isGuest: false, AnyFighter);
        rooms.QuickMatch().Should().BeSameAs(first, "the second arrival is paired with the first");

        rooms.ListOpen(matches).Should().ContainSingle(r => r.Code == first.GameCode && !r.InProgress)
            .And.NotContain(r => r.Code == hidden.GameCode);
        rooms.Get(hidden.GameCode.ToLowerInvariant()).Should().BeSameAs(hidden, "codes are case-insensitive");

        first.Open("conn-2", "bob", "Bob", isGuest: true, AnyFighter);
        matches.Start(first.GameCode, first.Players);
        rooms.ListOpen(matches).Should().ContainSingle(r => r.Code == first.GameCode && r.InProgress, "a live public fight can be watched");
    }

    [Fact]
    public void EndMatch_ResetsReadyFlags_AndClearsStaleMatch()
    {
        var lobby = new PoBrawlLobbyService("TEST", isPublic: true);
        lobby.Open("conn-1", "alice", "Alice", isGuest: false, AnyFighter);
        lobby.Open("conn-2", "bob", "Bob", isGuest: true, AnyFighter);
        lobby.ToggleReady("conn-1");
        lobby.ToggleReady("conn-2");
        lobby.TryStart("conn-1");
        lobby.End();
        lobby.State.Players.Should().OnlyContain(p => !p.IsReady);
        lobby.IsStarted.Should().BeFalse();
    }
}
