using System.Globalization;
using System.Text.Json;
using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.Web;
using Microsoft.JSInterop;

namespace PoMiniGamesClient.Games.SandPlayground;

/// <summary>
/// State container and JS-module lifecycle owner for SandPlayground.
/// Blazor owns the floating tool dock and its menu; all high-frequency input, the
/// keyboard shortcuts and the 60 FPS simulation loop live in
/// wwwroot/js/sand-playground/sand-playground-engine.js. The engine reports every
/// change it makes on its own (a shortcut, a challenge restricting the toolbox) through
/// <see cref="OnEngine"/>, so the dock is a view of engine state rather than a second copy.
/// </summary>
public partial class SandPlaygroundSandbox : ComponentBase, IAsyncDisposable
{
    [Inject] private IJSRuntime JS { get; set; } = default!;

    private ElementReference _canvas;
    private ElementReference _overlay;
    private IJSObjectReference? _module;
    private DotNetObjectReference<SandPlaygroundSandbox>? _ref;

    /// <summary>
    /// Demo (kiosk/attract) mode: ordnance rains from the sky on its own so a
    /// passer-by sees the physics without touching anything. 1-player starts
    /// with auto-drop off — the player aims every shot — but the menu toggle
    /// still turns the rain on or off in either mode.
    /// </summary>
    [Parameter] public bool IsDemo { get; set; }

    protected string ActiveTool { get; private set; } = "dig";
    protected int BrushSize { get; private set; } = 8;
    protected bool Paused { get; private set; }
    protected bool DemoOn { get; private set; }
    protected bool MenuOpen { get; private set; }
    protected int UndoDepth { get; private set; }
    protected double Speed { get; private set; } = 1;
    protected string Sun { get; private set; } = "Auto";
    protected int Wind { get; private set; }
    protected int Rain { get; private set; }
    protected double Gravity { get; private set; } = 1;
    protected bool Tilt { get; private set; }
    protected bool Recording { get; private set; }
    protected string Preset { get; private set; } = "classic";
    protected long Seed { get; private set; }
    protected long[] SlotTimes { get; private set; } = [0, 0, 0];
    protected string? ChallengeId { get; private set; }
    protected int View { get; private set; }
    protected string Fuse { get; private set; } = "5";
    protected bool BigCharge { get; private set; } = true;
    protected int RemoteBombs { get; private set; }
    /// <summary>False only in the attract reel, until someone touches the view.</summary>
    protected bool DockShown { get; private set; } = true;
    /// <summary>Tools the running challenge allows; null when no challenge restricts them.</summary>
    private string[]? _challengeTools;

    private string _toast = "";
    private int _toastId;
    private bool _toastUndo;

    protected sealed record ToolDef(string Id, string Icon, string Label, string Hint, int Key);
    /// <summary>One dock chip. A group with several tools opens a tray to choose between them.</summary>
    protected sealed record Group(string Label, ToolDef[] Tools);
    protected sealed record Choice(string Id, string Label, string Hint);
    protected sealed record Level(double Value, string Label);
    protected sealed record ChallengeInfo(string Id, string Name, string Hint, double Best);

    // Key is the engine's shortcut digit (TOOL_KEYS in the engine, same order).
    protected static readonly Group[] Groups =
    [
        new("Dig", [new("dig", "⛏️", "Dig Vacuum", "drag to extract sand and water (concrete is immune); a right-drag digs with any tool", 1)]),
        new("Pour",
        [
            new("sand", "🟫", "Sand", "drag to pour cohesive sand", 2),
            new("water", "💧", "Water", "drag to pour water", 3),
            new("fire", "🔥", "Fire", "hold to heat: sand glows and fuses to glass, water boils off as steam", 4),
        ]),
        new("Bar", [new("concrete", "🧱", "Concrete Bar", "drag out a rigid bar; the brush size sets its thickness", 5)]),
        new("Sling",
        [
            new("tnt", "🧨", "TNT", "drag in open air to slingshot a bomb", 6),
            new("balloon", "🎈", "Water Balloon", "drag in open air to slingshot an impact balloon", 7),
        ]),
        new("Inspect", [new("inspect", "🔍", "Inspect", "hover to read a cell's material, wetness and stress", 8)]),
    ];

    protected static readonly Choice[] Fuses =
    [
        new("impact", "Impact", "Goes off on the first thing it hits; dropped in water it sinks first"),
        new("2", "2 s", "Two-second fuse"),
        new("5", "5 s", "Five-second fuse"),
        new("remote", "Radio", "Lies where it lands until you press Detonate (Enter)"),
    ];

    protected static readonly string[] Views = ["Off", "Support", "Pressure", "Moisture"];

    // The tool each group last used, so its chip brings back what you had.
    private readonly Dictionary<Group, ToolDef> _current = [];

    protected ToolDef CurrentOf(Group g) => _current.TryGetValue(g, out var t) ? t : g.Tools[0];

    protected static Group? GroupOf(string toolId) =>
        Array.Find(Groups, g => Array.Exists(g.Tools, t => t.Id == toolId));

    protected static ToolDef? ToolOf(string toolId) =>
        GroupOf(toolId) is { } g ? Array.Find(g.Tools, t => t.Id == toolId) : null;

    /// <summary>The tray's tools: the active group's, when it has a choice to offer.</summary>
    protected ToolDef[]? TrayTools => GroupOf(ActiveTool) is { Tools.Length: > 1 } g ? g.Tools : null;

    private void Remember(string toolId)
    {
        if (GroupOf(toolId) is { } g && ToolOf(toolId) is { } t) _current[g] = t;
    }

    protected static readonly Choice[] Presets =
    [
        new("classic", "Ant farm", "A lake over a tunnel maze, with buried concrete"),
        new("dunes", "Dunes", "Open desert with one oasis"),
        new("dam", "Dam", "A reservoir held back above a village"),
        new("tower", "Tower", "Five storeys of concrete to bring down"),
        new("caverns", "Caverns", "Three tiers of galleries and sealed water chambers"),
    ];

    protected static readonly Level[] Speeds = [new(0.25, "¼×"), new(1, "1×"), new(2, "2×")];
    protected static readonly Level[] Gravities = [new(0.4, "Low"), new(1, "Normal"), new(1.8, "High")];
    protected static readonly string[] Skies = ["Auto", "Day", "Night"];
    private static readonly int[] BrushSteps = [3, 8, 16, 28];

    protected List<ChallengeInfo> Challenges { get; private set; } = [];

    // Blazor renders a bool attribute as present/absent; ARIA wants the literal words.
    protected static string Pressed(bool on) => on ? "true" : "false";

    protected bool ToolAllowed(string id) =>
        _challengeTools is null || id == "inspect" || Array.IndexOf(_challengeTools, id) >= 0;

    protected static string FormatTime(double seconds) =>
        $"{(int)(seconds / 60)}:{seconds % 60:00.0}";

    protected override void OnInitialized()
    {
        DemoOn = IsDemo;
        DockShown = !IsDemo;
    }

    protected void WakeDock() => DockShown = true;

    protected override async Task OnAfterRenderAsync(bool firstRender)
    {
        if (!firstRender) return;

        _ref = DotNetObjectReference.Create(this);
        _module = await JS.InvokeAsync<IJSObjectReference>("import", "./js/sand-playground/sand-playground-engine.js");
        await _module.InvokeVoidAsync("init", _canvas, _overlay, _ref);
        await _module.InvokeVoidAsync("setTool", ActiveTool);
        await _module.InvokeVoidAsync("setBrush", BrushSize);
        await _module.InvokeVoidAsync("setDemo", DemoOn);
    }

    // ── Engine → Blazor ──────────────────────────────────────────────────

    /// <summary>
    /// The one callback the engine uses. <paramref name="kind"/> is one of: tool, brush,
    /// paused, undo, world ("preset:seed"), challenge (JSON, or "" when it ends),
    /// challenge-done (JSON), recording, toast, view (x-ray index), remote (radio bombs lying about).
    /// </summary>
    [JSInvokable]
    public void OnEngine(string kind, string value)
    {
        switch (kind)
        {
            case "tool":
                ActiveTool = value;
                Remember(value);
                break;
            case "view":
                if (int.TryParse(value, out var view)) View = view;
                break;
            case "remote":
                if (int.TryParse(value, out var bombs)) RemoteBombs = bombs;
                break;
            case "brush":
                if (int.TryParse(value, out var b)) BrushSize = b;
                break;
            case "paused":
                Paused = value == "true";
                break;
            case "undo":
                if (int.TryParse(value, out var u)) UndoDepth = u;
                break;
            case "world":
                var parts = value.Split(':');
                Preset = parts[0];
                if (parts.Length > 1 && long.TryParse(parts[1], out var seed)) Seed = seed;
                break;
            case "challenge":
                ReadChallenge(value);
                break;
            case "challenge-done":
                ReadChallengeDone(value);
                break;
            case "recording":
                Recording = value == "true";
                break;
            case "toast":
                ShowToast(value);
                break;
            default:
                return;
        }
        InvokeAsync(StateHasChanged);
    }

    private void ReadChallenge(string json)
    {
        if (string.IsNullOrEmpty(json))
        {
            ChallengeId = null;
            _challengeTools = null;
            return;
        }
        // JsonDocument rather than a typed deserialize: no reflection for the trimmer to chase.
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        ChallengeId = root.GetProperty("id").GetString();
        _challengeTools = [.. root.GetProperty("tools").EnumerateArray().Select(t => t.GetString() ?? "")];
        DemoOn = false;
        Paused = false;
        ShowToast($"{root.GetProperty("name").GetString()} — {root.GetProperty("hint").GetString()}");
    }

    private void ReadChallengeDone(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;
        var seconds = root.GetProperty("seconds").GetDouble();
        var record = root.GetProperty("record").GetBoolean();
        var id = root.GetProperty("id").GetString();
        _challengeTools = null; // the world is a sandbox again once the goal is met
        Challenges = [.. Challenges.Select(c => c.Id == id && record ? c with { Best = seconds } : c)];
        ShowToast(record
            ? $"🏆 {root.GetProperty("name").GetString()} in {FormatTime(seconds)} — new best!"
            : $"✔ {root.GetProperty("name").GetString()} in {FormatTime(seconds)} (best {FormatTime(root.GetProperty("best").GetDouble())})");
    }

    private void ShowToast(string text, bool undo = false)
    {
        _toast = text;
        _toastUndo = undo;
        _toastId++;
    }

    // ── Dock ─────────────────────────────────────────────────────────────

    protected async Task SelectToolAsync(string tool)
    {
        ActiveTool = tool;
        Remember(tool);
        MenuOpen = false;
        if (ToolOf(tool) is { } def) ShowToast($"{def.Label}: {def.Hint}");
        if (_module is not null) await _module.InvokeVoidAsync("setTool", tool);
    }

    protected async Task CycleBrushAsync()
    {
        var next = Array.Find(BrushSteps, s => s > BrushSize);
        BrushSize = next == 0 ? BrushSteps[0] : next;
        if (_module is not null) await _module.InvokeVoidAsync("setBrush", BrushSize);
    }

    protected async Task TogglePauseAsync()
    {
        Paused = !Paused;
        if (_module is not null) await _module.InvokeVoidAsync("setPaused", Paused);
    }

    protected async Task StepAsync()
    {
        if (_module is not null) await _module.InvokeVoidAsync("stepOnce");
    }

    protected async Task UndoAsync()
    {
        _toast = "";
        if (_module is not null) await _module.InvokeVoidAsync("undo");
    }

    protected async Task DetonateAsync()
    {
        if (_module is not null) await _module.InvokeVoidAsync("detonateRemote");
    }

    protected async Task SetFuseAsync(string fuse)
    {
        Fuse = fuse;
        if (_module is not null) await _module.InvokeVoidAsync("setFuse", fuse);
    }

    protected async Task SetChargeAsync(bool big)
    {
        BigCharge = big;
        if (_module is not null) await _module.InvokeVoidAsync("setCharge", big);
    }

    // ── Menu ─────────────────────────────────────────────────────────────

    protected async Task ToggleMenuAsync()
    {
        MenuOpen = !MenuOpen;
        if (!MenuOpen || _module is null) return;
        // Read on open, not on a timer: slot stamps and bests only change through this menu.
        SlotTimes = await _module.InvokeAsync<long[]>("slots");
        using var doc = JsonDocument.Parse(await _module.InvokeAsync<string>("challengesJson"));
        Challenges = [.. doc.RootElement.EnumerateArray().Select(c => new ChallengeInfo(
            c.GetProperty("id").GetString() ?? "",
            c.GetProperty("name").GetString() ?? "",
            c.GetProperty("hint").GetString() ?? "",
            c.GetProperty("best").GetDouble()))];
    }

    protected void OnMenuKey(KeyboardEventArgs e)
    {
        if (e.Key == "Escape") MenuOpen = false;
    }

    // Replacing the world is one click with no confirmation, because it is one click to take back.
    protected async Task LoadWorldAsync(string preset)
    {
        MenuOpen = false;
        if (_module is null) return;
        await _module.InvokeVoidAsync("loadWorld", preset, Random.Shared.Next());
        ShowToast("New world", undo: true);
    }

    protected async Task ResetAsync()
    {
        MenuOpen = false;
        if (_module is null) return;
        await _module.InvokeVoidAsync("reset");
        ShowToast("New world", undo: true);
    }

    protected async Task DailyAsync()
    {
        MenuOpen = false;
        if (_module is null) return;
        await _module.InvokeVoidAsync("loadDaily");
        ShowToast("Today's world", undo: true);
    }

    protected async Task CopyLinkAsync()
    {
        if (_module is null) return;
        var ok = await _module.InvokeAsync<bool>("copyLink");
        ShowToast(ok ? "Link copied: it opens this exact world" : "The browser would not let the link be copied");
    }

    protected async Task ExportAsync()
    {
        MenuOpen = false;
        if (_module is not null && !await _module.InvokeAsync<bool>("exportWorld")) ShowToast("This browser cannot export the world");
    }

    protected async Task ImportAsync()
    {
        MenuOpen = false;
        // The engine opens the file picker and reports the outcome as a toast.
        if (_module is not null) await _module.InvokeVoidAsync("importWorld");
    }

    protected async Task SetViewAsync(int view)
    {
        View = view;
        if (_module is not null) await _module.InvokeVoidAsync("setView", view);
    }

    protected async Task ReplaySeedAsync()
    {
        MenuOpen = false;
        if (_module is not null) await _module.InvokeVoidAsync("loadWorld", Preset, Seed);
    }

    protected async Task StartChallengeAsync(string id)
    {
        MenuOpen = false;
        if (_module is not null) await _module.InvokeVoidAsync("startChallenge", id);
    }

    protected async Task SaveSlotAsync(int slot)
    {
        if (_module is null) return;
        var ok = await _module.InvokeAsync<bool>("saveSlot", slot);
        if (ok) SlotTimes = await _module.InvokeAsync<long[]>("slots");
        ShowToast(ok ? $"Saved to slot {slot}" : "Could not save — browser storage is full or unavailable");
    }

    protected async Task LoadSlotAsync(int slot)
    {
        if (_module is null) return;
        var ok = await _module.InvokeAsync<bool>("loadSlot", slot);
        MenuOpen = !ok;
        ShowToast(ok ? $"Loaded slot {slot}" : "That save could not be read");
    }

    protected async Task SetSpeedAsync(double speed)
    {
        Speed = speed;
        if (_module is not null) await _module.InvokeVoidAsync("setSpeed", speed);
    }

    protected Task SetSunAsync(string sky)
    {
        Sun = sky;
        return SetEnvAsync("sun", sky.ToLowerInvariant());
    }

    protected Task OnWindAsync(ChangeEventArgs e)
    {
        Wind = Math.Clamp(ParseInt(e), -100, 100);
        return SetEnvAsync("wind", Wind / 100.0);
    }

    protected Task OnRainAsync(ChangeEventArgs e)
    {
        Rain = Math.Clamp(ParseInt(e), 0, 100);
        return SetEnvAsync("rain", Rain / 100.0);
    }

    protected Task SetGravityAsync(double gravity)
    {
        Gravity = gravity;
        return SetEnvAsync("gravity", gravity);
    }

    protected Task ToggleTiltAsync()
    {
        Tilt = !Tilt;
        return SetEnvAsync("tilt", Tilt);
    }

    protected async Task ToggleDemoAsync()
    {
        DemoOn = !DemoOn;
        if (_module is not null) await _module.InvokeVoidAsync("setDemo", DemoOn);
    }

    protected async Task ShotAsync()
    {
        MenuOpen = false;
        if (_module is not null) await _module.InvokeVoidAsync("shareShot");
    }

    protected async Task ClipAsync()
    {
        MenuOpen = false;
        if (_module is null) return;
        if (!await _module.InvokeAsync<bool>("recordClip", 8)) ShowToast("This browser cannot record the canvas");
    }

    private static int ParseInt(ChangeEventArgs e) =>
        int.TryParse(e.Value?.ToString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var v) ? v : 0;

    // One key and a primitive per call: an anonymous object would be serialised by
    // reflection, and the trimmed client build is free to drop its properties.
    private async Task SetEnvAsync(string key, object value)
    {
        if (_module is not null) await _module.InvokeVoidAsync("setEnvKey", key, value);
    }

    public async ValueTask DisposeAsync()
    {
        if (_module is not null)
        {
            try
            {
                // dispose() cancels the rAF loop, drops the key/resize listeners and releases
                // the audio graph. Without it the simulation keeps running (and sounding)
                // after navigation away.
                await _module.InvokeVoidAsync("dispose");
                await _module.DisposeAsync();
            }
            catch (JSDisconnectedException)
            {
                // Circuit/page already gone; nothing to clean up.
            }
        }

        _ref?.Dispose();
        GC.SuppressFinalize(this);
    }
}
