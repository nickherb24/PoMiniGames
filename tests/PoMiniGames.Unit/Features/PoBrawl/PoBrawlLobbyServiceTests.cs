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
        var lobby = new PoBrawlLobbyService();
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
        var lobby = new PoBrawlLobbyService();
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
        var lobby = new PoBrawlLobbyService();
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
    /// The one shared room (2026-09-29, rooms-by-code removed): each start mints a fresh match
    /// code and the room frees up, so the next two arrivals fight alongside the first pair.
    /// </summary>
    [Fact]
    public void Start_MintsFreshMatchCode_SoTheNextPairFightsAlongside()
    {
        var lobby = new PoBrawlLobbyService();
        var matches = new PoBrawlMatchRegistry();

        string StartPair(string a, string b)
        {
            lobby.Open(a, a, a, isGuest: false, AnyFighter);
            lobby.Open(b, b, b, isGuest: true, AnyFighter);
            lobby.ToggleReady(a);
            lobby.ToggleReady(b);
            lobby.TryStart(a).Should().BeTrue();
            var code = lobby.CreateMatchCode();
            matches.Start(code, lobby.Players);
            lobby.End();
            // Both lobby connections close as the pair navigates to the fight.
            lobby.Leave(a);
            lobby.Leave(b);
            return code;
        }

        var first = StartPair("conn-1", "conn-2");
        var second = StartPair("conn-3", "conn-4");

        second.Should().NotBe(first);
        matches.Get(first)!.Roster.Select(p => p.ConnectionId).Should().Equal("conn-1", "conn-2");
        matches.Get(second)!.Roster.Select(p => p.ConnectionId).Should().Equal("conn-3", "conn-4");
    }

    [Fact]
    public void EndMatch_ResetsReadyFlags_AndClearsStaleMatch()
    {
        var lobby = new PoBrawlLobbyService();
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
