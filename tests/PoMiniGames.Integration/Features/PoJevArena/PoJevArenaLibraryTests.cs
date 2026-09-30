using Azure.Data.Tables;
using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using PoMiniGames.Features.PoJevArena;
using PoMiniGames.Shared.Games.PoJevArena;

namespace PoMiniGames.Integration.Features.PoJevArena;

/// <summary>
/// The creature library against real Azurite. Store-level rather than over HTTP because the claims
/// are about Table Storage behaviour: owner-only writes, the per-owner cap, and that result
/// counters are commuting increments under an ETag (two matches finishing at once both land, and a
/// creature deleted mid-match is not resurrected). One method: this tier is at 49/50 before it.
/// </summary>
public sealed class PoJevArenaLibraryTests : IClassFixture<TestWebApplicationFactory>
{
    private readonly TestWebApplicationFactory _factory;

    public PoJevArenaLibraryTests(TestWebApplicationFactory factory) => _factory = factory;

    [Theory]
    [InlineData("round-trip")]
    [InlineData("owner-only")]
    [InlineData("owner-cap")]
    [InlineData("results-commute")]
    [InlineData("deleted-not-resurrected")]
    public async Task CreatureLibrary_HoldsItsStorageContracts(string scenario)
    {
        if (!_factory.DockerAvailable) return;

        var store = new CreatureLibraryStore(
            _factory.Services.GetRequiredService<TableServiceClient>(), NullLogger<CreatureLibraryStore>.Instance);
        // A fresh owner per run: the table is shared with every other test and prior runs.
        var me = CreatureLibraryStore.OwnerKeyFor($"int-{Guid.NewGuid():N}");
        var them = CreatureLibraryStore.OwnerKeyFor($"int-{Guid.NewGuid():N}");
        var design = PoJevArenaRules.Validate(PoJevArenaCatalog.Presets[2].ToDraft() with { Name = "Swamp Gob" }).Creature!;

        try
        {
            await RunScenarioAsync(scenario, store, me, them, design);
        }
        finally
        {
            // This tier's storage override can land after the host has already bound its
            // TableServiceClient, so these rows may be in the developer's local Azurite, where
            // they would show up in the game's library. Leave nothing behind.
            await DeleteOwnedAsync(store, me);
            await DeleteOwnedAsync(store, them);
        }
    }

    private static async Task DeleteOwnedAsync(CreatureLibraryStore store, string owner)
    {
        foreach (var name in new[] { "Swamp Gob", "Bog Gob" })
        {
            foreach (var mine in (await store.ListAsync(owner, "new", name) ?? []).Where(c => c.IsMine))
            {
                await store.DeleteAsync(owner, mine.Id);
            }
        }
    }

    private static async Task RunScenarioAsync(string scenario, CreatureLibraryStore store, string me, string them, ArenaCreature design)
    {
        switch (scenario)
        {
            case "round-trip":
                {
                    var (result, saved) = await store.CreateAsync(me, "Tester", design);
                    result.Should().Be(LibraryWrite.Ok);
                    saved!.Id.Should().NotBeNullOrEmpty();
                    saved.IsMine.Should().BeTrue();

                    var listed = (await store.ListAsync(them, "new", "Swamp Gob"))!;
                    var row = listed.Should().ContainSingle(c => c.Id == saved.Id).Subject;
                    row.IsMine.Should().BeFalse("another viewer sees it, but not as theirs");
                    row.OwnerName.Should().Be("Tester");
                    row.Abilities.Should().Equal(design.Abilities);

                    var fetched = await store.GetManyAsync([saved.Id, "no-such-id"]);
                    fetched.Should().ContainKey(saved.Id).And.NotContainKey("no-such-id");
                    break;
                }
            case "owner-only":
                {
                    var (_, saved) = await store.CreateAsync(me, "Tester", design);
                    var renamed = design with { Name = "Bog Gob" };

                    (await store.UpdateAsync(them, saved!.Id, renamed)).Result.Should().Be(LibraryWrite.Forbidden);
                    (await store.DeleteAsync(them, saved.Id)).Should().Be(LibraryWrite.Forbidden);

                    var (updated, after) = await store.UpdateAsync(me, saved.Id, renamed);
                    updated.Should().Be(LibraryWrite.Ok);
                    after!.Name.Should().Be("Bog Gob");

                    (await store.DeleteAsync(me, saved.Id)).Should().Be(LibraryWrite.Ok);
                    (await store.DeleteAsync(me, saved.Id)).Should().Be(LibraryWrite.NotFound);
                    break;
                }
            case "owner-cap":
                {
                    for (var i = 0; i < PoJevArenaRules.MaxCreaturesPerOwner; i++)
                    {
                        (await store.CreateAsync(me, "Tester", design)).Result.Should().Be(LibraryWrite.Ok);
                    }
                    (await store.CreateAsync(me, "Tester", design)).Result.Should().Be(LibraryWrite.LimitReached);
                    (await store.CreateAsync(them, "Other", design)).Result.Should().Be(LibraryWrite.Ok,
                        "the cap is per owner, not global");
                    break;
                }
            case "results-commute":
                {
                    var saved = (await store.CreateAsync(me, "Tester", design)).Creature!;
                    var team = Enumerable.Repeat(saved, 10).ToArray();
                    var presets = Enumerable.Repeat(PoJevArenaCatalog.Presets[0], 10).ToArray();

                    // Six matches finishing at once: 3 wins as Blue, 2 losses as Red, 1 draw. The
                    // first also carries careers: two units' KOs and damage, and slot 0 as MVP.
                    ArenaUnitStats[] units = [new(0, 2, 150.4, 0), new(1, 1, 50, 12), new(10, 3, 999, 0)];
                    await Task.WhenAll(
                        store.ApplyResultAsync(team, presets, "blue", units, mvp: 0),
                        store.ApplyResultAsync(team, presets, "blue"),
                        store.ApplyResultAsync(team, presets, "blue"),
                        store.ApplyResultAsync(presets, team, "blue"),
                        store.ApplyResultAsync(presets, team, "blue"),
                        store.ApplyResultAsync(team, presets, "draw"));

                    var row = (await store.GetManyAsync([saved.Id]))![saved.Id];
                    row.Deployed.Should().Be(6, "a creature fielded ten times in one match is deployed once");
                    row.Wins.Should().Be(3);
                    row.Losses.Should().Be(2);
                    row.Draws.Should().Be(1);
                    // Every match priced the same frozen seed rating against an all-preset (seed)
                    // side: ±12 at K 24 for a win/loss, 0 for an even draw, applied as increments.
                    row.Rating.Should().Be(CreatureLibraryStore.SeedRating + 3 * 12 - 2 * 12);
                    row.Kills.Should().Be(3, "slot 10 is a preset, which keeps no career");
                    row.DamageDealt.Should().Be(200);
                    row.Mvps.Should().Be(1);
                    break;
                }
            case "deleted-not-resurrected":
                {
                    var (_, saved) = await store.CreateAsync(me, "Tester", design);
                    (await store.DeleteAsync(me, saved!.Id)).Should().Be(LibraryWrite.Ok);

                    (await store.ApplyResultAsync([saved], [PoJevArenaCatalog.Presets[0]], "blue")).Should().BeTrue();
                    (await store.GetManyAsync([saved.Id]))!.Should().NotContainKey(saved.Id,
                        "a result for a creature deleted mid-match must not recreate its row");
                    break;
                }
            default:
                throw new ArgumentOutOfRangeException(nameof(scenario), scenario, null);
        }
    }
}
