namespace PoMiniGames.Domain.Models;

/// <summary>
/// One completed CPU-vs-CPU demo match. On a draw the winner/loser split is arbitrary —
/// the two fighters are interchangeable and <see cref="IsDraw"/> decides the scoring.
/// </summary>
/// <remarks>
/// Lives here rather than in the endpoints file so it sits with the other PoBrawl models
/// (<see cref="PoBrawlFighterRating"/>, <see cref="PoBrawlHighScore"/>,
/// <see cref="PoBrawlLadderEntry"/>) instead of being the one request shape declared
/// beside its route.
///
/// Carries who fought and who won, and nothing else: ratings and deltas are all resolved
/// server-side, so there is no field here to forge a rating in.
/// </remarks>
public sealed record PoBrawlDemoResultRequest(string WinnerFighterId, string LoserFighterId, bool IsDraw);
