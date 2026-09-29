using System.Collections.Concurrent;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoBrawl.Online;

/// <summary>
/// Process-local registry of running PoBrawl 1v1 matches, one per room code.
/// </summary>
/// <remarks>
/// <para>
/// 2026-09-29: rooms came back. This held one match for the one global "BRAWL" room, so a
/// second pair could not fight until the first finished, and a start threw away whatever was
/// running. Now each lobby room's code owns at most one match, and a start only replaces the
/// match on its own code.
/// </para>
/// <para>
/// A finished match lingers for <see cref="FinishedLinger"/> so both corners can vote for the
/// rematch and a player who reconnects after the bell still gets their result. The pump
/// sweeps it after that.
/// </para>
/// </remarks>
public sealed class PoBrawlMatchRegistry
{
    /// <summary>How long a finished match is kept for rematch votes and late result delivery.</summary>
    public static readonly TimeSpan FinishedLinger = TimeSpan.FromSeconds(90);

    private readonly ConcurrentDictionary<string, PoBrawlMatchService> _byCode = new(StringComparer.OrdinalIgnoreCase);
    private readonly ConcurrentDictionary<string, string> _connectionToCode = new(StringComparer.Ordinal);

    /// <summary>Start a fresh match on <paramref name="code"/>, replacing any match that code held.</summary>
    public PoBrawlMatchService Start(string code, IReadOnlyList<PoBrawlLobbyPlayer> roster)
    {
        var match = new PoBrawlMatchService(Guid.NewGuid().ToString("N"), code, roster, PoBrawlMatchService.CountdownSeconds);
        _byCode[code] = match;
        return match;
    }

    /// <summary>
    /// Both corners asked for another round: the same roster (and fighters) on the same code. The
    /// connections stay bound to the code, so the clients only have to call JoinMatch again.
    /// </summary>
    public PoBrawlMatchService? Rematch(string code) =>
        _byCode.TryGetValue(code, out var old) && old.FinishedAtUtc is not null ? Start(code, old.Roster) : null;

    public PoBrawlMatchService? Get(string code) =>
        !string.IsNullOrWhiteSpace(code) && _byCode.TryGetValue(code, out var m) ? m : null;

    /// <summary>Every match, running or lingering. The pump ticks the running ones.</summary>
    public IReadOnlyCollection<PoBrawlMatchService> All => _byCode.Values.ToArray();

    /// <summary>Drop a match — only if it is still the one on that code (a rematch may have replaced it).</summary>
    public void Remove(PoBrawlMatchService match) =>
        _byCode.TryRemove(new KeyValuePair<string, PoBrawlMatchService>(match.GameCode, match));

    public void BindConnection(string connectionId, string code) => _connectionToCode[connectionId] = code;

    /// <summary>Forget a connection's binding; returns the code it was bound to.</summary>
    public string? UnbindConnection(string connectionId) =>
        _connectionToCode.TryRemove(connectionId, out var code) ? code : null;

    public PoBrawlMatchService? MatchFor(string connectionId) =>
        _connectionToCode.TryGetValue(connectionId, out var code) ? Get(code) : null;
}
