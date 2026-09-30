// pocabinet/index.js
//
// Facade module. Blazor's IJSRuntime can only invoke functions reachable from
// `window`, so the engine's named ES exports are re-exported under a single
// `window.PoCabinet` namespace (the same JS.InvokeAsync dance as the other
// engines); the modules themselves stay directly importable.
//
// Contract surface (called from src/PoMiniGames.Client/Games/PoCabinet/...):
//   PoCabinet.mount(canvasId, world) -> sceneHandle      — world = PoCabinetStaticWorld
//   PoCabinet.unmount(handle)
//   PoCabinet.mountDialogue(parentId, officialId) / showDialogue / hideDialogue / unmountDialogue
//   PoCabinet.officialName(officialId)
//   PoCabinet.mountMinimap(canvasId, world, opts) / unmountMinimap(handle)
//   PoCabinet.mountEnvironment(sceneHandle) / unmountEnvironment(handle)
//
//   PoCabinet.startRace(dotnetRef, scene, minimap, opts)  — race.js driver
//   PoCabinet.stopRace() / pauseRace() / resumeRace()
//   PoCabinet.pushServerSnapshot(snap)                     — multiplayer
//   PoCabinet.updateRaceSettings(settings) / cycleCamera()
//   PoCabinet.showTelemetry(canvasId) -> summary text
//   PoCabinet.startReplay() / replayCommand(cmd, value) / stopReplay()
//   PoCabinet.recordClip() -> 'shared' | 'downloaded' | 'unavailable'
//   PoCabinet.lapProof() -> { inputs, wet }               — solo score verification
//   PoCabinet.setBanter(lines) / speak(officialId, text)  — officials' radio (AI pool, voices)
//
//   PoCabinet.loadSettings() / saveSettings(patch) / applySettings(scene, settings)
//   PoCabinet.getRecords(trackId) / recordTrackResult(trackId, bestLap, sectors)
//   PoCabinet.initAudio() / setAudioSuspended(bool) / countdownBeep / blip / lapChime / fanfare
//   PoCabinet.shareResult(payload)
//   PoCabinet.showModal(id)                                — pause dialog (focus trap, inert page)

import { mount as sceneMount, unmount as sceneUnmount } from './scene.js';
import { mount as mountDialogue, unmount as unmountDialogue, show, hide, officialName, speak } from './dialogue.js';
import {
    startRace, stopRace, pauseRace, resumeRace, pushServerSnapshot, updateRaceSettings, cycleCamera,
    showTelemetry, startReplay, replayCommand, stopReplay, recordClip, lapProof, setBanter,
} from './race.js';
import { loadSettings, saveSettings, getRecords, recordTrackResult } from './settings.js';
import * as audio from './audio.js';
import { mountMinimap, unmountMinimap } from './minimap.js';
import { mountEnvironment, unmountEnvironment } from './environment.js';

const api = {
    mount: sceneMount,
    unmount: sceneUnmount,
    mountDialogue,
    showDialogue: (handle, text, durationMs) => show(handle, text, durationMs),
    hideDialogue: hide,
    unmountDialogue,
    officialName,
    speak,

    startRace,
    stopRace,
    pauseRace,
    resumeRace,
    pushServerSnapshot,
    updateRaceSettings,
    cycleCamera,
    showTelemetry,
    startReplay,
    replayCommand,
    stopReplay,
    recordClip,
    lapProof,
    setBanter,

    loadSettings,
    saveSettings,
    getRecords,
    recordTrackResult,

    initAudio: audio.init,
    setAudioSuspended: audio.setSuspended,
    countdownBeep: audio.countdownBeep,
    blip: audio.blip,
    lapChime: audio.lapChime,
    fanfare: audio.fanfare,

    mountMinimap,
    unmountMinimap,

    /**
     * Open a rendered <dialog> as modal. Its own Esc-close is cancelled: Esc is input.js's
     * pause toggle, and letting both act would close the dialog without resuming the race.
     */
    showModal(id) {
        const d = document.getElementById(id);
        if (!d || d.open || typeof d.showModal !== 'function') return;
        d.addEventListener('cancel', e => e.preventDefault());
        d.showModal();
    },

    mountEnvironment,
    unmountEnvironment,

    /** Push persisted prefs into the live scene, audio graph and race driver. */
    applySettings(sceneHandle, settings) {
        if (sceneHandle && !sceneHandle.disposed) sceneHandle.applyView(settings);
        audio.setVolume(settings?.masterVolume);
        audio.setMuted(settings?.muted);
        updateRaceSettings(settings);
    },

    /**
     * Unlock the AudioContext on the first user gesture. Covers entry paths
     * that never click "Start race" (auto-starting demo, guests joining a
     * multiplayer race from a link).
     */
    armAudioOnGesture() {
        if (armAudioInstalled) return;
        armAudioInstalled = true;
        const unlock = () => {
            audio.init();
            window.removeEventListener('pointerdown', unlock);
            window.removeEventListener('keydown', unlock);
        };
        window.addEventListener('pointerdown', unlock, { once: true });
        window.addEventListener('keydown', unlock, { once: true });
    },

    /**
     * Render a 1200×630 shareable result card and hand it to the Web Share
     * API (when file sharing is available) or fall back to a download.
     * Returns 'shared' | 'downloaded' | 'unavailable' for the page's toast.
     */
    async shareResult(payload) {
        try {
            const p = payload && typeof payload === 'object' ? payload : {};
            const c = document.createElement('canvas');
            c.width = 1200;
            c.height = 630;
            const g = c.getContext('2d');
            if (!g) return 'unavailable';

            const accent = typeof p.accent === 'string' ? p.accent : '#c6a35a';
            g.fillStyle = '#101a2e';
            g.fillRect(0, 0, c.width, c.height);
            g.fillStyle = accent;
            g.fillRect(0, 0, c.width, 14);
            g.fillRect(0, c.height - 14, c.width, 14);

            g.fillStyle = '#ffffff';
            g.font = '700 64px system-ui, sans-serif';
            g.fillText('🏛️ Cabinet', 70, 150);
            g.fillStyle = accent;
            g.font = '600 40px system-ui, sans-serif';
            g.fillText(String(p.trackName || 'Race'), 70, 215);

            g.fillStyle = '#ffffff';
            g.font = '800 190px system-ui, sans-serif';
            const posText = `P${Number(p.position) || 1}`;
            g.fillText(posText, 70, 430);
            g.font = '500 44px system-ui, sans-serif';
            g.fillStyle = 'rgba(255,255,255,0.75)';
            g.fillText(`of ${Number(p.totalCars) || 1} cars  ·  ${String(p.playerName || 'Player')}`, 70, 490);

            const lap = Number(p.bestLapSeconds);
            g.fillStyle = '#ffffff';
            g.font = '700 56px system-ui, sans-serif';
            const mins = lap > 0 ? Math.floor(lap / 60) : 0;
            const rest = lap > 0 ? (lap - mins * 60).toFixed(1) : '0.0';
            g.fillText(`Best lap  ${mins}:${rest}`, 640, 430);
            if (p.isPb) {
                g.fillStyle = '#2ecc71';
                g.font = '800 48px system-ui, sans-serif';
                g.fillText('★ NEW PERSONAL BEST', 640, 490);
            }
            g.fillStyle = 'rgba(255,255,255,0.55)';
            g.font = '400 30px system-ui, sans-serif';
            g.fillText('PoMiniGames · Cabinet', 70, 575);

            const blob = await new Promise(resolve => c.toBlob(resolve, 'image/png'));
            if (!blob) return 'unavailable';
            const file = new File([blob], 'pocabinet-result.png', { type: 'image/png' });
            if (navigator.canShare && navigator.canShare({ files: [file] })) {
                await navigator.share({ files: [file], title: 'Cabinet — race result' });
                return 'shared';
            }
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'pocabinet-result.png';
            a.click();
            window.setTimeout(() => URL.revokeObjectURL(a.href), 5000);
            return 'downloaded';
        } catch (e) {
            // A user-cancelled share sheet (AbortError) is not a failure.
            if (e && e.name === 'AbortError') return 'shared';
            return 'unavailable';
        }
    },
};

let armAudioInstalled = false;

window.PoCabinet = api;
