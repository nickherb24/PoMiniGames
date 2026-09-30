using System.Globalization;
using System.Text.Json;
using Blazored.LocalStorage;
using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.Web;
using Microsoft.JSInterop;
using PoMiniGames.Shared.Games.PoJevArena;
using PoMiniGamesClient.Components;
using PoMiniGamesClient.Models;
using PoMiniGamesClient.Services.Play;

namespace PoMiniGamesClient.Games.PoJevArena;

/// <summary>
/// The Jev Arena page: Dual Inspector layout (Blue column · centre · Red column), three phases —
/// Draft (library in the centre, the Factory as a drawer over it), Battle (the arena), Replay (the
/// arena + Black Box, or the Jev debrief). The engine (js/pojevarena) owns physics, rendering,
/// sound and the Black Box; this page owns the server conversation, rosters, squads, banners and
/// the per-side inspectors.
/// </summary>
public partial class PoJevArenaPage : ComponentBase, IAsyncDisposable
{
    private const string CanvasId = "jevArenaCanvas";
    private const string RosterKey = "pojevarena.rosters.v1";
    private const string SquadsKey = "pojevarena.squads.v1";
    private const string AutoCameraKey = "pojevarena.autocam";
    private const int MaxSquads = 20;
    internal const string FilterAll = "all";
    /// <summary>One full 3:00 match at 1 Hz × 20 units; below this a deploy may run out mid-match.</summary>
    private const long CallsPerFullMatch = 3_600;

    private enum Phase { Intro, Draft, Battle, Replay }
    private enum TwoPlayerStep { Blue, Red, Ready }

    [Parameter] public string? ModeSegment { get; set; }

    [Inject] private IJSRuntime JS { get; set; } = default!;
    [Inject] private PoJevArenaApiClient Api { get; set; } = default!;
    [Inject] private ILocalStorageService Storage { get; set; } = default!;
    [Inject] private PlayerNameService PlayerNames { get; set; } = default!;

    private Phase _phase = Phase.Intro;
    private TwoPlayerStep _twoPlayerStep = TwoPlayerStep.Blue;
    private string _playerName = "";

    private ArenaStatus? _status;
    private List<ArenaCreature> _library = [];
    private bool _libraryOffline;
    private string _sort = "new";
    private string? _query;
    private string _filter = FilterAll;
    private List<ArenaSquad> _squads = [];

    private readonly ArenaCreature?[] _blue = new ArenaCreature?[PoJevArenaCatalog.TeamSize];
    private readonly ArenaCreature?[] _red = new ArenaCreature?[PoJevArenaCatalog.TeamSize];
    private bool _blueLocked, _redLocked;

    private bool _factoryOpen;
    private ArenaCreature? _editing;
    private ArenaCreature? _template;
    private ArenaCreature? _pendingDelete;

    private ArenaMatchTicket? _ticket;
    private bool _deploying, _pendingDeploy;
    private ArenaHudView? _hud;
    private ArenaInspectorView? _inspectBlue, _inspectRed;
    private ArenaMatchEndView? _result;
    private string? _resultNote;
    private ArenaBlackBoxView? _blackBox;
    private bool _showDebrief;
    private bool _autoCamera = true;
    private string _mobileTeam = "blue";
    private bool _statsOpen;
    private string? _error;
    private string? _toast;
    private DotNetObjectReference<PoJevArenaPage>? _self;
    private CancellationTokenSource? _demoLoop;

    private GameMode Mode => GameModes.Parse(ModeSegment);
    private bool IsDemo => Mode == GameMode.Demo;
    private bool IsTwoPlayer => Mode == GameMode.TwoPlayer;
    private bool Drafting => _phase == Phase.Draft;
    private bool Configured => _status?.Configured == true;
    private bool ShowDebrief => _showDebrief && _phase == Phase.Replay && _result?.Debrief is not null;

    private GameIntro.IntroMode IntroMode => IsDemo ? GameIntro.IntroMode.Demo
        : IsTwoPlayer ? GameIntro.IntroMode.TwoPlayer : GameIntro.IntroMode.OnePlayer;

    /// <summary>The one Jev chip: the day's allowance while drafting, this match's spend once it runs.</summary>
    private string StatusText => _status is null ? "Checking Jev…"
        : !_status.Configured ? "Jev unavailable: this arena needs Jev"
        : _hud is not null && !Drafting
            ? string.Create(CultureInfo.InvariantCulture, $"{_hud.Calls:N0} Jev calls · {_hud.Remaining ?? _status.Remaining:N0} left today")
            : string.Create(CultureInfo.InvariantCulture, $"Jev ready · {_status.Remaining:N0} calls left today");

    private string? Banner => _error ?? NoticeBanner ?? _toast;

    private string? NoticeBanner
    {
        get
        {
            var notices = _hud?.Notices ?? [];
            if (notices.Contains("allowance-exhausted")) return "Daily Jev allowance reached. Units hold their last orders; it resets at 00:00 UTC.";
            if (notices.Contains("match-expired")) return "This match expired on the server (the host restarted). Units hold their orders; redeploy for a fresh match.";
            if (notices.Contains("jev-rejected")) return "Jev rejected the request (key or credits). Units hold their last orders.";
            if (notices.Contains("jev-unavailable")) return "Jev is unavailable. Units hold their last orders.";
            return null;
        }
    }

    private bool RostersFull => _blue.All(c => c is not null) && _red.All(c => c is not null);

    /// <summary>Whether a side takes picks now: always in 1P; in hot-seat only on that player's turn.</summary>
    private bool CanDraftFor(string team) => Drafting && (team == "blue"
        ? !_blueLocked && (!IsTwoPlayer || _twoPlayerStep == TwoPlayerStep.Blue)
        : !_redLocked && (!IsTwoPlayer || _twoPlayerStep == TwoPlayerStep.Red));

    private bool CanDeploy => Configured && RostersFull && !_deploying
        && (!IsTwoPlayer || _twoPlayerStep == TwoPlayerStep.Ready);

    private string DeployHint =>
        !Configured ? "Deploy needs Jev."
        : !RostersFull ? "Fill both teams to deploy."
        : IsTwoPlayer && _twoPlayerStep != TwoPlayerStep.Ready ? "Both players must lock their team."
        : "About 1,500–3,600 Jev calls per match.";

    /// <summary>What stands between the player and Deploy, next to the button; null when nothing does.</summary>
    private string? DeployNote
    {
        get
        {
            if (!Configured) return null;
            var missing = _blue.Count(c => c is null) + _red.Count(c => c is null);
            if (IsTwoPlayer) return _twoPlayerStep == TwoPlayerStep.Ready ? null : _twoPlayerStep == TwoPlayerStep.Blue ? "Player 1 drafts Blue" : "Player 2 drafts Red";
            if (missing > 0) return $"{missing} to draft";
            return (_status?.Remaining ?? long.MaxValue) < CallsPerFullMatch
                ? string.Create(CultureInfo.InvariantCulture, $"Only {_status!.Remaining:N0} Jev calls left today")
                : null;
        }
    }

    /// <summary>Library plus the presets, pinned first, narrowed by the search and the filter.</summary>
    private List<ArenaCreature> VisibleLibrary =>
    [
        .. PoJevArenaCatalog.Presets
            .Where(p => string.IsNullOrWhiteSpace(_query) || p.Name.Contains(_query, StringComparison.OrdinalIgnoreCase))
            .Where(Matches),
        .. _library.Where(Matches),
    ];

    private bool Matches(ArenaCreature c) => _filter switch
    {
        FilterAll => true,
        "mine" => c.IsMine,
        _ when _filter.StartsWith("ability:", StringComparison.Ordinal) => c.Abilities.Contains(_filter[8..]),
        _ when _filter.StartsWith("temper:", StringComparison.Ordinal) => c.Temperament == _filter[7..],
        _ => true,
    };

    private static double Points(ArenaCreature?[] team) => team.Sum(c => c?.BuildCost ?? 0);

    private string ResultHeadline => _result is null ? "" : _result.Winner switch
    {
        "blue" => IsTwoPlayer ? "Player 1 (Blue) wins" : "Blue wins",
        "red" => IsTwoPlayer ? "Player 2 (Red) wins" : "Red wins",
        _ => "Draw",
    };

    private string ResultDetail => _result is null ? "" : string.Create(CultureInfo.InvariantCulture,
        $"{(_result.Reason == "time" ? "time" : "wipe")} at {Clock(_result.DurationSeconds)}{(_result.Arena is null ? "" : " on " + _result.Arena)} · {_result.Decisions:N0} Jev decisions · {_resultNote}");

    /// <summary>"Red-04 Boulder Brute · 2 KOs · 312 dmg": the engine's MVP, named from the frozen roster.</summary>
    private string? MvpLine
    {
        get
        {
            if (_result is not { Mvp: >= 0 and < PoJevArenaCatalog.TeamSize * 2 } r || _ticket is null) return null;
            var blue = r.Mvp < PoJevArenaCatalog.TeamSize;
            var slot = r.Mvp % PoJevArenaCatalog.TeamSize;
            var creature = (blue ? _ticket.Blue : _ticket.Red).ElementAtOrDefault(slot);
            var stats = r.Units?.FirstOrDefault(u => u.Slot == r.Mvp);
            var line = $"MVP {ArenaUnits.Label(blue, slot)} {creature?.Name}";
            if (stats is null) return line;
            line += string.Create(CultureInfo.InvariantCulture, $" · {stats.Kills} KO{(stats.Kills == 1 ? "" : "s")} · {stats.Damage:0} dmg");
            return stats.Healed >= 1 ? line + string.Create(CultureInfo.InvariantCulture, $" · {stats.Healed:0} healed") : line;
        }
    }

    private IEnumerable<ArenaMoment> Moments => _result?.Debrief is { } d ? d.Blue.Moments.Concat(d.Red.Moments) : [];

    private string BlueSharePct
    {
        get
        {
            var (b, r) = (_hud?.BlueHp ?? 1, _hud?.RedHp ?? 1);
            return (b + r <= 0 ? 50 : 100 * b / (b + r)).ToString("0.0", CultureInfo.InvariantCulture);
        }
    }

    private string HpShareLabel => string.Create(CultureInfo.InvariantCulture,
        $"Health: Blue {100 * (_hud?.BlueHp ?? 1):0}%, Red {100 * (_hud?.RedHp ?? 1):0}%");

    // ── Lifecycle ────────────────────────────────────────────────────────────

    protected override async Task OnInitializedAsync()
    {
        _playerName = PlayerNames.GetPlayerName();
        _self = DotNetObjectReference.Create(this);
        await Task.WhenAll(LoadStatusAsync(), LoadLibraryAsync(), LoadPrefsAsync());
        if (!IsDemo && !IsTwoPlayer) await RestoreRostersAsync();
    }

    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        if (!_pendingDeploy || _ticket is null) return;
        _pendingDeploy = false;
        try
        {
            if (!await JS.InvokeAsync<bool>("loadEngine", "pojevarena"))
            {
                _error = "The arena engine failed to load. Reload the page to try again.";
                StateHasChanged();
                return;
            }

            var ticketJson = JsonSerializer.Serialize(_ticket, PoJevArenaJsonContext.Default.ArenaMatchTicket);
            var abilitiesJson = JsonSerializer.Serialize(PoJevArenaCatalog.Abilities, PoJevArenaJsonContext.Default.ArenaAbilityArray);
            var options = _autoCamera ? """{"autoCamera":true}""" : """{"autoCamera":false}""";
            await JS.InvokeAsync<bool>("PoJevArena.deploy", CanvasId, _self, ticketJson, abilitiesJson, options);
        }
        catch (JSException ex)
        {
            _error = "The arena failed to start: " + ex.Message;
            StateHasChanged();
        }
    }

    public async ValueTask DisposeAsync()
    {
        _demoLoop?.Cancel();
        await StopEngineAsync();
        _self?.Dispose();
    }

    private async Task StartAsync()
    {
        _phase = Phase.Draft;
        if (IsDemo) await RunDemoAsync();
    }

    // ── Server state ─────────────────────────────────────────────────────────

    private async Task LoadStatusAsync() => _status = await Api.StatusAsync();

    private async Task LoadLibraryAsync()
    {
        // Null means the server could not reach storage (a 503), which is not the same as an empty library.
        var items = await Api.ListCreaturesAsync(_sort, _query);
        _libraryOffline = items is null;
        _library = [.. items ?? []];
    }

    private async Task OnSortAsync(string? sort)
    {
        _sort = sort is "used" or "rating" ? sort : "new";
        await LoadLibraryAsync();
    }

    private async Task OnQueryAsync(string? query)
    {
        _query = string.IsNullOrWhiteSpace(query) ? null : query.Trim();
        await LoadLibraryAsync();
    }

    // ── Drafting ─────────────────────────────────────────────────────────────

    private ArenaCreature?[] TeamOf(string team) => team == "blue" ? _blue : _red;

    private async Task DraftAsync((ArenaCreature Creature, string Team) pick)
    {
        if (!CanDraftFor(pick.Team)) return;
        var team = TeamOf(pick.Team);
        var free = Array.IndexOf(team, null);
        if (free < 0) { _toast = $"{(pick.Team == "blue" ? "Blue" : "Red")} is full. Click a slot to free it."; return; }

        team[free] = pick.Creature;
        _toast = null;
        await SaveRostersAsync();
    }

    private async Task OnSlotAsync(string team, int slot)
    {
        if (Drafting)
        {
            TeamOf(team)[slot] = null;
            await SaveRostersAsync();
            return;
        }

        var index = (team == "blue" ? 0 : PoJevArenaCatalog.TeamSize) + slot;
        await SafeJsAsync("PoJevArena.select", index);
    }

    private async Task ClearTeam(string team)
    {
        Array.Clear(TeamOf(team));
        await SaveRostersAsync();
    }

    /// <summary>Fills a side's empty slots with random picks from the presets and the loaded library.</summary>
    private async Task FillAsync(string team)
    {
        var slots = TeamOf(team);
        ArenaCreature[] pool = [.. PoJevArenaCatalog.Presets, .. _library];
        for (var i = 0; i < slots.Length; i++) slots[i] ??= pool[Random.Shared.Next(pool.Length)];
        await SaveRostersAsync();
    }

    private async Task CopyBlueAsync()
    {
        Array.Copy(_blue, _red, _red.Length);
        await SaveRostersAsync();
    }

    /// <summary>Hot-seat: Blue's lock hands the device straight to Player 2; Red's lock deploys.</summary>
    private async Task LockAsync(string team)
    {
        if (team == "blue")
        {
            _blueLocked = true;
            _twoPlayerStep = TwoPlayerStep.Red;
            _toast = "Blue is locked and hidden. Pass the device to Player 2.";
            return;
        }

        _redLocked = true;
        _twoPlayerStep = TwoPlayerStep.Ready;
        _toast = null;
        if (CanDeploy) await DeployAsync();
    }

    // ── Squads (localStorage) ────────────────────────────────────────────────

    private async Task SaveSquadAsync(string team, string name)
    {
        name = name.Trim();
        if (name.Length == 0) return;
        _squads.RemoveAll(s => s.Name.Equals(name, StringComparison.OrdinalIgnoreCase));
        _squads.Insert(0, new ArenaSquad(name, [.. TeamOf(team)]));
        if (_squads.Count > MaxSquads) _squads.RemoveRange(MaxSquads, _squads.Count - MaxSquads);
        _toast = $"Saved squad \"{name}\".";
        await SaveSquadsAsync();
    }

    private async Task LoadSquadAsync(string team, string name)
    {
        if (_squads.Find(s => s.Name == name) is not { } squad) return;
        var fresh = FreshCreatures();
        var slots = TeamOf(team);
        for (var i = 0; i < slots.Length; i++)
        {
            var c = squad.Slots.ElementAtOrDefault(i);
            slots[i] = c is null ? null : fresh.GetValueOrDefault(c.Id) ?? c;
        }
        await SaveRostersAsync();
    }

    private async Task DeleteSquadAsync(string name)
    {
        _squads.RemoveAll(s => s.Name == name);
        await SaveSquadsAsync();
    }

    private async Task SaveSquadsAsync()
    {
        try { await Storage.SetItemAsStringAsync(SquadsKey, JsonSerializer.Serialize(_squads, ArenaUiJsonContext.Default.ListArenaSquad)); }
        catch { /* storage blocked: squads just don't persist */ }
    }

    // ── Factory & library writes ─────────────────────────────────────────────

    private void NewCreature() { _editing = null; _template = null; _factoryOpen = true; }

    private void Edit(ArenaCreature creature) { _editing = creature; _template = null; _factoryOpen = true; }

    /// <summary>Any library card (or preset) opens the Factory pre-filled as a new creature of your own.</summary>
    private void Fork(ArenaCreature creature) { _editing = null; _template = creature; _factoryOpen = true; }

    private void CloseFactory() { _factoryOpen = false; _editing = null; _template = null; }

    private void OnDrawerKey(KeyboardEventArgs e)
    {
        if (e.Key == "Escape") CloseFactory();
    }

    private async Task OnCreatureSavedAsync(ArenaCreature saved)
    {
        CloseFactory();
        _toast = $"Saved {saved.Name} to the public library.";
        await LoadLibraryAsync();
    }

    private void AskDelete(ArenaCreature creature) => _pendingDelete = creature;

    private async Task ConfirmDeleteAsync()
    {
        if (_pendingDelete is not { } doomed) return;
        _pendingDelete = null;
        var error = await Api.DeleteAsync(doomed.Id);
        _toast = error is null ? $"Deleted {doomed.Name}." : "Couldn't delete that creature right now.";
        if (error is null)
        {
            for (var i = 0; i < PoJevArenaCatalog.TeamSize; i++)
            {
                if (_blue[i]?.Id == doomed.Id) _blue[i] = null;
                if (_red[i]?.Id == doomed.Id) _red[i] = null;
            }
            await SaveRostersAsync();
            await LoadLibraryAsync();
        }
    }

    // ── Rosters and prefs in localStorage (rosters 1P only; 2P starts clean so neither player sees the other's) ──

    private async Task SaveRostersAsync()
    {
        if (IsDemo || IsTwoPlayer) return;
        var saved = new ArenaSavedRosters([.. _blue], [.. _red]);
        try { await Storage.SetItemAsStringAsync(RosterKey, JsonSerializer.Serialize(saved, ArenaUiJsonContext.Default.ArenaSavedRosters)); }
        catch { /* storage blocked (private mode): rosters just don't persist */ }
    }

    private async Task RestoreRostersAsync()
    {
        ArenaSavedRosters? saved = null;
        try
        {
            var raw = await Storage.GetItemAsStringAsync(RosterKey);
            if (!string.IsNullOrEmpty(raw)) saved = JsonSerializer.Deserialize(raw, ArenaUiJsonContext.Default.ArenaSavedRosters);
        }
        catch { return; }
        if (saved is null) return;

        // Snapshots, refreshed from the current library page when the creature is on it. A
        // creature deleted since is only discovered at deploy, where the server says so.
        var fresh = FreshCreatures();
        void Fill(ArenaCreature?[]? from, ArenaCreature?[] into)
        {
            if (from is null) return;
            for (var i = 0; i < Math.Min(from.Length, into.Length); i++)
            {
                if (from[i] is { } c) into[i] = fresh.GetValueOrDefault(c.Id) ?? c;
            }
        }
        Fill(saved.Blue, _blue);
        Fill(saved.Red, _red);
    }

    private Dictionary<string, ArenaCreature> FreshCreatures() =>
        PoJevArenaCatalog.Presets.Concat(_library).DistinctBy(c => c.Id).ToDictionary(c => c.Id);

    private async Task LoadPrefsAsync()
    {
        try
        {
            _autoCamera = await Storage.GetItemAsStringAsync(AutoCameraKey) != "0";
            var raw = await Storage.GetItemAsStringAsync(SquadsKey);
            if (!string.IsNullOrEmpty(raw)) _squads = JsonSerializer.Deserialize(raw, ArenaUiJsonContext.Default.ListArenaSquad) ?? [];
        }
        catch { /* storage blocked or a corrupt entry: defaults */ }
    }

    private async Task ToggleCameraAsync()
    {
        _autoCamera = !_autoCamera;
        await SafeJsAsync("PoJevArena.setAutoCamera", _autoCamera);
        try { await Storage.SetItemAsStringAsync(AutoCameraKey, _autoCamera ? "1" : "0"); }
        catch { /* not remembered, still applied */ }
    }

    // ── Battle ───────────────────────────────────────────────────────────────

    /// <returns>True when the match was registered and the arena is about to mount.</returns>
    private async Task<bool> DeployAsync()
    {
        _deploying = true;
        _error = null;
        _toast = null;
        var (ticket, error) = await Api.RegisterMatchAsync(new ArenaMatchRequest(
            IsDemo ? ArenaMode.Demo : IsTwoPlayer ? ArenaMode.TwoPlayer : ArenaMode.OnePlayer,
            _blue.Select(c => c!.Id).ToArray(),
            _red.Select(c => c!.Id).ToArray()));
        _deploying = false;

        if (ticket is null)
        {
            _error = error switch
            {
                "jev-unavailable" => "Jev isn't configured on this server, so the arena can't run.",
                "unknown-creature" => "A creature in your roster no longer exists. Replace it and deploy again.",
                "library-offline" => "The creature library is unreachable right now.",
                _ => "Couldn't start the match. Try again in a moment.",
            };
            return false;
        }

        _ticket = ticket;
        _result = null;
        _resultNote = null;
        _hud = null;
        _blackBox = null;
        _inspectBlue = _inspectRed = null;
        _factoryOpen = false;
        _statsOpen = false;
        _phase = Phase.Battle;
        _pendingDeploy = true;
        return true;
    }

    private async Task RematchAsync()
    {
        await StopEngineAsync();
        await DeployAsync();
    }

    private async Task BackToDraftAsync()
    {
        await StopEngineAsync();
        _phase = Phase.Draft;
        _result = null;
        _hud = null;
        if (IsTwoPlayer)
        {
            // A new hot-seat round: both teams unlock and Player 1 drafts first again.
            _blueLocked = _redLocked = false;
            _twoPlayerStep = TwoPlayerStep.Blue;
        }
        await Task.WhenAll(LoadStatusAsync(), LoadLibraryAsync());
    }

    private async Task StopEngineAsync() => await SafeJsAsync("PoJevArena.stop");

    private Task ShareClipAsync() => SafeJsAsync("PoJevArena.shareClip");

    // ── Engine callbacks ─────────────────────────────────────────────────────

    /// <summary>The engine's only road to the server, so every Jev batch rides the app HttpClient.</summary>
    [JSInvokable]
    public Task<string> DecideAsync(string batchJson) =>
        _ticket is null ? Task.FromResult("""{"error":"match-expired"}""") : Api.DecideRawAsync(_ticket.MatchId, batchJson);

    [JSInvokable]
    public Task OnHud(string json)
    {
        _hud = JsonSerializer.Deserialize(json, ArenaUiJsonContext.Default.ArenaHudView);
        return InvokeAsync(StateHasChanged);
    }

    [JSInvokable]
    public Task OnInspector(string json)
    {
        var view = JsonSerializer.Deserialize(json, ArenaUiJsonContext.Default.ArenaInspectorView);
        if (view?.Team == "blue") _inspectBlue = view;
        else if (view?.Team == "red") _inspectRed = view;
        return InvokeAsync(StateHasChanged);
    }

    /// <summary>A unit was clicked in the arena: the phone layout's single inspector follows its side.</summary>
    [JSInvokable]
    public Task OnSelected(string team)
    {
        if (team is "blue" or "red") _mobileTeam = team;
        return InvokeAsync(StateHasChanged);
    }

    /// <summary>Tab held (true) or released (false) during the live match: the stat HUD over the arena.</summary>
    [JSInvokable]
    public Task OnStats(bool open)
    {
        _statsOpen = open;
        return InvokeAsync(StateHasChanged);
    }

    [JSInvokable]
    public Task OnBlackBox(string json)
    {
        _blackBox = JsonSerializer.Deserialize(json, ArenaUiJsonContext.Default.ArenaBlackBoxView);
        return InvokeAsync(StateHasChanged);
    }

    [JSInvokable]
    public async Task OnMatchEnded(string json)
    {
        _result = JsonSerializer.Deserialize(json, ArenaUiJsonContext.Default.ArenaMatchEndView);
        _phase = Phase.Replay;
        // The debrief is the first thing a player sees after the whistle (the demo goes straight to its highlight replay).
        _showDebrief = !IsDemo;
        _resultNote = "recording…";
        await InvokeAsync(StateHasChanged);

        if (_result is not null && _ticket is not null)
        {
            var error = await Api.ReportResultAsync(_ticket.MatchId,
                new ArenaMatchResult(_result.Winner, _result.DurationSeconds, _result.Units, _result.Mvp));
            _resultNote = error switch
            {
                null => "creature records updated",
                "too-few-decisions" => "too short to count toward records",
                "match-expired" => "stats not recorded (match expired)",
                _ => "stats not recorded",
            };
        }
        await LoadStatusAsync();
        await InvokeAsync(StateHasChanged);
    }

    private async Task OnBlackBoxCommandAsync((string Command, double Value) cmd)
    {
        switch (cmd.Command)
        {
            case "scrub": await SafeJsAsync("PoJevArena.scrub", (int)cmd.Value); break;
            case "step": await SafeJsAsync("PoJevArena.step", (int)cmd.Value); break;
            case "play": await SafeJsAsync("PoJevArena.play"); break;
            case "pause": await SafeJsAsync("PoJevArena.pause"); break;
            case "speed": await SafeJsAsync("PoJevArena.setSpeed", cmd.Value); break;
            case "prevDecision": await SafeJsAsync("PoJevArena.jumpDecision", -1); break;
            case "nextDecision": await SafeJsAsync("PoJevArena.jumpDecision", 1); break;
        }
    }

    /// <summary>Debrief "Jump": switch to the Black Box on that frame with that creature in its side's inspector.</summary>
    private async Task JumpToMomentAsync(ArenaMoment moment)
    {
        _showDebrief = false;
        _mobileTeam = moment.UnitIndex < PoJevArenaCatalog.TeamSize ? "blue" : "red";
        await SafeJsAsync("PoJevArena.jumpTo", moment.Frame, moment.UnitIndex);
    }

    // ── Demo ─────────────────────────────────────────────────────────────────

    /// <summary>
    /// Preset squads plus up to six random library creatures per side, fight, show the result,
    /// replay the last 20 s from the Black Box, repeat — until the allowance can't cover a match.
    /// </summary>
    private async Task RunDemoAsync()
    {
        _demoLoop?.Cancel();
        _demoLoop = new CancellationTokenSource();
        var ct = _demoLoop.Token;
        var rng = new Random();

        while (!ct.IsCancellationRequested)
        {
            await LoadStatusAsync();
            if (!Configured) { _error = "Jev isn't configured on this server, so the demo can't run."; return; }
            if (_status!.Remaining < CallsPerFullMatch)
            {
                _error = "Daily Jev allowance reached for this account. The demo resumes tomorrow (00:00 UTC).";
                await InvokeAsync(StateHasChanged);
                return;
            }

            FillDemoTeam(_blue, rng);
            FillDemoTeam(_red, rng);
            if (!await DeployAsync()) return;
            await InvokeAsync(StateHasChanged);

            // Wait for the whistle (the engine calls OnMatchEnded), with a hard ceiling past 3:00.
            var deadline = DateTime.UtcNow.AddMinutes(4);
            while (_result is null && DateTime.UtcNow < deadline && !ct.IsCancellationRequested) await Delay(500, ct);
            if (ct.IsCancellationRequested) return;

            await Delay(8_000, ct);
            var frames = _blackBox?.Frames ?? 0;
            await SafeJsAsync("PoJevArena.scrub", Math.Max(0, frames - 20 * 60));
            await SafeJsAsync("PoJevArena.play");
            await Delay(20_000, ct);
            await StopEngineAsync();
        }
    }

    /// <summary>Up to six random library creatures, the rest random presets, in shuffled slots.</summary>
    private void FillDemoTeam(ArenaCreature?[] team, Random rng)
    {
        var picks = _library.OrderBy(_ => rng.Next()).Take(6).ToList();
        while (picks.Count < team.Length) picks.Add(PoJevArenaCatalog.Presets[rng.Next(PoJevArenaCatalog.Presets.Length)]);
        var shuffled = picks.OrderBy(_ => rng.Next()).ToArray();
        Array.Copy(shuffled, team, team.Length);
    }

    private static async Task Delay(int ms, CancellationToken ct)
    {
        try { await Task.Delay(ms, ct); }
        catch (OperationCanceledException) { }
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private async Task SafeJsAsync(string identifier, params object?[] args)
    {
        try { await JS.InvokeVoidAsync(identifier, args); }
        catch (JSException) { }
        catch (JSDisconnectedException) { }
        catch (InvalidOperationException) { /* prerender / disposed circuit */ }
    }

    /// <summary>Blazor renders a bool attribute as present-or-absent; aria-pressed needs the literal words.</summary>
    private static string Pressed(bool on) => on ? "true" : "false";

    private static string Clock(double seconds)
    {
        var t = TimeSpan.FromSeconds(Math.Max(0, seconds));
        return t.ToString(@"m\:ss", CultureInfo.InvariantCulture);
    }
}
