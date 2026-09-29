using System.Text.Json.Serialization;
// Alias, not a namespace import: PoMiniGamesClient.Models mirrors several other Domain
// types by name, so importing the namespace wholesale would make them all ambiguous.
using PoSportsHighScore = PoMiniGames.Domain.Models.PoSportsHighScore;
using PoBrawlFighterRating = PoMiniGames.Domain.Models.PoBrawlFighterRating;
using PoMiniGamesClient.Models;
using PoMiniGames.Shared.Games;

using PoMiniGamesClient.Services.Auth;
using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGamesClient.Services.Http;

/// <summary>
/// Source-generated <see cref="JsonSerializerContext"/> for the DTOs exchanged by
/// <see cref="ApiService"/>. Using generated metadata for these hot leaderboard/stats
/// payloads avoids the reflection-based serializer's per-type startup cost and is trim/AOT
/// friendly (no IL2026). It is chained ahead of a reflection fallback in
/// <see cref="ApiService"/>, so any type not listed here still serializes correctly — this
/// is an additive fast path, not a wire-format change.
/// </summary>
[JsonSerializable(typeof(List<PendingScore>))]
[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    PropertyNameCaseInsensitive = true,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    UseStringEnumConverter = true)]
// Auth
[JsonSerializable(typeof(AuthClientConfiguration))]
[JsonSerializable(typeof(AuthenticatedUserProfile))]
[JsonSerializable(typeof(DevLoginRequest))]
[JsonSerializable(typeof(AuthHandshake))]
// §2 CSRF: AntiforgeryHandler deserializes the token endpoint's payload through this
// context so the token fetch stays trim-safe (it runs on the WASM HttpClient pipeline).
[JsonSerializable(typeof(AntiforgeryTokenDto))]
// §2 /health status page
[JsonSerializable(typeof(HealthReportDto))]
// Score integrity + account data. Source-generated like everything else on this path:
// the mint runs on the WASM HttpClient pipeline and the erase result is read back on the
// profile page, both of which the trim analyzer sees.
[JsonSerializable(typeof(PlaySessionTicketDto))]
[JsonSerializable(typeof(AccountDeletionDto))]
// Stats + leaderboards
[JsonSerializable(typeof(PlayerStatsDto))]
[JsonSerializable(typeof(PlayerStatsDto[]))]
[JsonSerializable(typeof(PlayerStats))]
[JsonSerializable(typeof(AdaptiveRating))]
[JsonSerializable(typeof(MarbleRaceHighScore))]
[JsonSerializable(typeof(MarbleRaceHighScore[]))]
[JsonSerializable(typeof(MarbleRaceHighScoreRequest))]
// PoCabinet (T11, 2026-09-17): the per-track leaderboard ratchets on lap time;
// the request shape carries only the score + the contextual track/position,
// identity is resolved server-side.
[JsonSerializable(typeof(PoCabinetHighScore))]
[JsonSerializable(typeof(PoCabinetHighScore[]))]
[JsonSerializable(typeof(PoCabinetHighScoreRequest))]
[JsonSerializable(typeof(PoBrawlHighScore))]
[JsonSerializable(typeof(PoBrawlHighScore[]))]
// Single entry only — the client POSTs ladder progress but never reads the board back
// (the unified /api/leaderboards/pobrawl route serves it). The array registration went
// with GetPoBrawlLadderAsync on 2026-08-11.
[JsonSerializable(typeof(PoBrawlLadderEntry))]
[JsonSerializable(typeof(PoBrawlFighterRating))]
[JsonSerializable(typeof(PoBrawlFighterRating[]))]
[JsonSerializable(typeof(PoBrawlDemoResultRequest))]
[JsonSerializable(typeof(PoSportsHighScore))]
[JsonSerializable(typeof(PoSportsHighScore[]))]
[JsonSerializable(typeof(PoMiniGames.Domain.Models.PoVoxelStrikeHighScore))]
[JsonSerializable(typeof(PoMiniGames.Domain.Models.PoVoxelStrikeHighScore[]))]
[JsonSerializable(typeof(PoVoxelStrikeRunRequest))]
[JsonSerializable(typeof(PendingPlayerStats))]
[JsonSerializable(typeof(LeaderboardEntryDto))]
[JsonSerializable(typeof(GameLeaderboardDto))]
[JsonSerializable(typeof(GameLeaderboardDto[]))]
// Matches
[JsonSerializable(typeof(MatchRecordRequest))]
[JsonSerializable(typeof(MatchRecordDto))]
[JsonSerializable(typeof(MatchRecordDto[]))]
// PoFunQuiz
[JsonSerializable(typeof(QuizQuestion))]
[JsonSerializable(typeof(List<QuizQuestion>))]
[JsonSerializable(typeof(FunQuizLeaderboardRow))]
[JsonSerializable(typeof(List<FunQuizLeaderboardRow>))]
[JsonSerializable(typeof(FunQuizLeaderboardRow[]))]
[JsonSerializable(typeof(FunQuizLeaderboardSubmission))]
// PoJoker
[JsonSerializable(typeof(PoMiniGames.Shared.Games.PoJoker.JokeDto))]
[JsonSerializable(typeof(PoMiniGames.Shared.Games.PoJoker.JokeFlags))]
[JsonSerializable(typeof(PoMiniGames.Shared.Games.PoJoker.JokeAnalysisDto))]
// Disambiguate from client-side LeaderboardEntryDto: name the source-gen
// metadata property JokerLeaderboardEntryDto so the PoJoker leaderboard page
// resolves it.
[JsonSerializable(typeof(PoMiniGames.Shared.Games.PoJoker.LeaderboardEntryDto), TypeInfoPropertyName = "JokerLeaderboardEntryDto")]
[JsonSerializable(typeof(List<PoMiniGames.Shared.Games.PoJoker.LeaderboardEntryDto>), TypeInfoPropertyName = "ListJokerLeaderboardEntryDto")]
// PoRacer
[JsonSerializable(typeof(PoRacerScoreDto))]
[JsonSerializable(typeof(List<PoRacerScoreDto>))]
// §PoBrawlOnline (2026-09-14): match result ingest + the live player-Elo board.
// The result POSTs through MatchHistory internally, so a generic MatchRecordRequest
// already covers the read path; only the DTO shapes for the new endpoint are new here.
[JsonSerializable(typeof(PoMiniGames.Shared.Games.PoBrawlMatchResultDto))]
[JsonSerializable(typeof(PoMiniGames.Domain.Models.PoBrawlPlayerRating))]
[JsonSerializable(typeof(List<PoMiniGames.Domain.Models.PoBrawlPlayerRating>))]
// PoBrawl post-fight press conference (2026-09-23).
[JsonSerializable(typeof(PoMiniGames.Shared.Games.PoBrawlPresserRequest))]
[JsonSerializable(typeof(PoMiniGames.Shared.Games.PoBrawlPresserReply))]
// PoBrawl ring introduction + cross-device ladder progress (2026-09-29).
[JsonSerializable(typeof(PoMiniGames.Shared.Games.PoBrawlIntroRequest))]
[JsonSerializable(typeof(PoMiniGames.Shared.Games.PoBrawlProgressDto))]
// Player Card & Online MMR
[JsonSerializable(typeof(PoMiniGames.Domain.Models.PlayerCardDto))]
internal partial class ApiJsonContext : JsonSerializerContext
{
}
