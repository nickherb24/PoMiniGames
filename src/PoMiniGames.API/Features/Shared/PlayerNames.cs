namespace PoMiniGames.Features.Shared;

/// <summary>
/// The one display-name rule for every lobby and match seat: trimmed, 24 characters,
/// "Player" when blank. Race services compare client-supplied names against seats through
/// it too, so a long name matches its own truncated seat.
/// </summary>
public static class PlayerNames
{
    public static string Sanitize(string raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return "Player";
        var trimmed = raw.Trim();
        return trimmed.Length > 24 ? trimmed[..24] : trimmed;
    }
}
