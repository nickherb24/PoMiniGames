namespace PoMiniGamesClient.Games.PoRacer;

public partial class PoRacerPage
{
    private int _lastLap, _lastPosition;

    // Lap and place changes: the two cues that come with a screen-reader announcement. Everything
    // a car does continuously or physically (engine, skid, crash, sand, passes, start lamps) is
    // sounded by js/poracer/audio.js straight off the snapshots, with no interop per event.
    private async Task UpdateAudioAsync()
    {
        if (Player is not { } player) return;
        if (_lastLap == 0)
        {
            _announcement = "Race started.";
            await Feedback.CueAtAsync("poracer", "rev");
        }
        else if (player.Lap > _lastLap && player.Lap <= _totalLaps)
        {
            _announcement = player.Lap == _totalLaps ? "Final lap." : $"Lap {player.Lap} of {_totalLaps}.";
            await Feedback.CueAtAsync("poracer", "checkpoint");
        }
        if (_lastPosition > 0 && player.Position < _lastPosition)
        {
            _announcement = $"Position {player.Position}.";
            await Feedback.CueAtAsync("poracer", "shift", gain: 0.85);
        }
        _lastLap = player.Lap;
        _lastPosition = player.Position;
    }
}
