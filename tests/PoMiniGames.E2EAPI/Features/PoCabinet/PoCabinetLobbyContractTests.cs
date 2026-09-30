using FluentAssertions;
using PoMiniGames.Features.PoCabinet;

namespace PoMiniGames.E2EAPI.Features.PoCabinet;

/// <summary>
/// Contract tests for the PoCabinet lobby service. One method by design — the E2E-API tier is
/// capped at 25 (the 100/50/25/25 rule) and the service's surface is small enough to exercise
/// in one Fact: there is one lobby and no join codes, so the first arrival hosts, the next
/// arrivals share that lobby, the ninth is bounced, and ready toggling, host migration on
/// leave, the rematch loop (the lobby reopens when its race ends), AI officials filling free
/// seats so a lone host can race, and seats that survive a dropped connection all hold.
/// </summary>
public sealed class PoCabinetLobbyContractTests
{
    [Fact]
    public void Lobby_FirstArrivalHosts_LaterArrivalsShareIt_And_BouncesAtCap()
    {
        var service = new PoCabinetLobbyService();
        service.Current.Should().BeNull("nobody has arrived yet");

        var hostConn = "conn-host";
        var lobby = service.Join(hostConn, "Alice", isGuest: false, trackId: "capitol");
        lobby.Should().NotBeNull();
        lobby!.HostId.Should().Be(hostConn, "the first arrival hosts");
        lobby.TrackId.Should().Be("capitol", "the first arrival's track opens the lobby");
        lobby.Players.Should().HaveCount(1);
        lobby.Players[0].IsReady.Should().BeTrue("the host is auto-ready");
        lobby.IsStarted.Should().BeFalse();

        // ── A second identity lands in the SAME lobby, not a new one ────────
        var second = service.Join("conn-2", "Bob", isGuest: true, trackId: "maralago");
        second.Should().BeSameAs(lobby, "there is one lobby — no codes, no second room");
        second!.Players.Should().HaveCount(2);
        second.HostId.Should().Be(hostConn, "a later arrival never takes the host seat");
        second.TrackId.Should().Be("capitol", "a later arrival's track choice is ignored");
        second.Players[1].IsReady.Should().BeFalse("guests ready up themselves");

        // ── 6 more players join (fill the 8-seat lobby) ────────────────────
        for (var i = 0; i < 6; i++)
        {
            service.Join($"conn-{i + 3}", $"Player{i + 3}", isGuest: true).Should().NotBeNull();
        }
        service.Current!.Players.Should().HaveCount(8, "PoCabinet caps at 8 cars");

        // ── A 9th player is bounced with a null return ────────────────────
        service.Join("conn-9", "Eve", isGuest: true).Should().BeNull("the lobby is at the 8-seat cap and rejects new joiners");
        service.View()!.Players.Should().HaveCount(8);

        // ── Toggle ready on the second player ──────────────────────────────
        service.ToggleReady("conn-2").Should().BeTrue();
        service.Current!.Players.First(p => p.PlayerId == "conn-2").IsReady.Should().BeTrue();

        // ── Host can't start yet — the other six aren't ready ──────────────
        service.CanStart(hostConn).Should().BeFalse("not everyone is ready");
        for (var i = 0; i < 6; i++) service.ToggleReady($"conn-{i + 3}");
        service.CanStart(hostConn).Should().BeTrue();

        // ── Non-host cannot start ────────────────────────────────────────────
        service.CanStart("conn-2").Should().BeFalse("only the host can start");

        // ── Start locks the lobby and a second start is rejected ───────────
        service.Start(hostConn).Should().NotBeNull();
        service.Current!.IsStarted.Should().BeTrue();
        service.Start(hostConn).Should().BeNull("a started lobby cannot re-enter Start");

        // ── Join after start is rejected; the lobby still exists for the waiter ─
        service.Join("conn-late", "Latecomer", isGuest: true).Should().BeNull();
        service.View()!.InRace.Should().BeTrue("a latecomer sees the race in progress");

        // ── Host leaves → a remaining player is promoted ───────────────────
        service.Leave(hostConn);
        service.Current!.HostId.Should().NotBe(hostConn,
            "host migration: the next player in the roster becomes host");

        // ── Everyone leaves mid-race → the lobby waits for the race to end, then closes ─
        foreach (var p in service.Current!.Players.ToList()) service.Leave(p.PlayerId);
        service.Current.Should().NotBeNull("a running race keeps its lobby so no second race can start under the same id");
        service.MarkRaceFinished().Should().BeNull();
        service.Current.Should().BeNull("an empty lobby is purged");

        // ── Solo host + AI officials: startable, grid filled by bots ─────────
        service.Join("solo-host", "Hana", isGuest: true, trackId: "maralago", connectionId: "c-solo")!
            .HostId.Should().Be("solo-host", "the next first arrival hosts the fresh lobby");
        service.CanStart("solo-host").Should().BeTrue("a lone host races the default AI officials");
        service.SetBots("solo-host", 0).Should().BeTrue();
        service.CanStart("solo-host").Should().BeFalse("one car is not a race");
        service.SetBots("solo-host", 2);
        service.SetBots("someone-else", 4).Should().BeFalse("only the host changes the grid");

        // A guest joins, drops mid-race and reconnects: same seat, not a second one.
        service.Join("guest-1", "Gil", isGuest: true, connectionId: "c-g1").Should().NotBeNull();
        service.ToggleReady("guest-1");
        service.Start("solo-host").Should().NotBeNull();
        var grid = service.BuildGrid();
        grid.Should().HaveCount(4, "two humans plus the two officials asked for");
        grid.Take(2).Should().OnlyContain(d => d.IsPlayer);
        grid.Skip(2).Should().OnlyContain(d => !d.IsPlayer && d.Personality != null);
        service.DropConnection("c-g1").Should().BeTrue();
        service.Current!.Players.Should().HaveCount(2, "a drop mid-race keeps the seat until the race ends");
        service.Join("guest-1", "Gil", isGuest: true, connectionId: "c-g1b").Should().NotBeNull("rejoining your own seat works mid-race");

        // Race over → the lobby reopens with the same roster for a rematch.
        var reopened = service.MarkRaceFinished();
        reopened.Should().NotBeNull();
        reopened!.IsStarted.Should().BeFalse();
        reopened.Players.Should().HaveCount(2);
        reopened.Players.Single(p => p.PlayerId == "guest-1").IsReady.Should().BeFalse("guests ready up again for the rematch");
        service.View("guest-1")!.YourSeatId.Should().Be(PoCabinetLobbyService.SeatIdFor("guest-1"))
            .And.NotContain("guest-1", "seat ids never expose the claim id");
    }
}
