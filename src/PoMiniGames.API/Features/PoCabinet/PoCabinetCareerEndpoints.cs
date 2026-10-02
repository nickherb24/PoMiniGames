using System.Text.Json;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoCabinet;

/// <summary>
/// Career endpoints for cross-device resume of the PoCabinet championship.
/// Authed writes (PUT); anonymous reads (GET) return a fresh state for guests.
/// Storage: Azure Table Storage <c>PoCabinetCareer</c>, partitioned by user id
/// hash. T5 extends <see cref="StorageService"/> with this table.
/// </summary>
public static class PoCabinetCareerEndpoints
{
    private const string TableName = "PoCabinetCareer";

    public static void MapPoCabinetCareerEndpoints(this IEndpointRouteBuilder routes)
    {
        // PoCabinet writes are authed (all game-data writes require auth; anti-forgery
        // token on top per AntiforgeryExtensions). Reads are anonymous so the UI can render a
        // guest's local-only state without an auth roundtrip.
        var authed = routes.MapGroup("/api/pocabinet").RequireAuthorization();

        authed.MapGet("/career", GetCareerAsync);
        authed.MapPut("/career", PutCareerAsync);
    }

    private static async Task<IResult> GetCareerAsync(
        HttpContext ctx,
        ILoggerFactory logFactory)
    {
        // For now, return a fresh state. The storage path lands in T5 once
        // StorageService is extended with the PoCabinetCareer descriptor.
        var dto = PoCabinetCareerDto.New();
        return Results.Ok(dto);
    }

    private static async Task<IResult> PutCareerAsync(
        HttpContext ctx,
        ILoggerFactory logFactory)
    {
        PoCabinetCareerDto? dto;
        try
        {
            dto = await JsonSerializer.DeserializeAsync<PoCabinetCareerDto>(
                ctx.Request.Body,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
        }
        catch (JsonException ex)
        {
            return Results.BadRequest(new { error = "invalid_json", detail = ex.Message });
        }
        if (dto is null) return Results.BadRequest(new { error = "empty_body" });
        if (dto.CurrentStageIndex < 0 || dto.CurrentStageIndex > 3)
            return Results.BadRequest(new { error = "current_stage_index_out_of_range" });

        // Echo the saved state for now. T5 wires Azure Table Storage here.
        dto.UpdatedAtUtc = DateTimeOffset.UtcNow;
        return Results.Ok(dto);
    }
}
