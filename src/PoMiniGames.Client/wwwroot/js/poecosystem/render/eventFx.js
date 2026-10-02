// eventFx.js — sim events become things you can see, hear and feel (GFX options 2 and 8).
//
// The sim already announces lightning, rockslides and eruptions on the `events` channel.
// Until now the ONLY reaction was a centred audio stinger: the screen did not move, no
// dust rose, and a strike two hundred metres away was indistinguishable from one at the
// player's feet. This module is the router that was missing.
//
// It owns three things:
//
//   EVENTS    kind + tile → a world position → particles, camera trauma via
//             the app-wide impact bus, a rack focus, and a positioned stinger. Everything
//             scales with distance, so a far-off eruption is a rumble on the horizon and a
//             near one takes the screen.
//   TILES     continuous emitters for fire and lava, budgeted per frame. A burning forest
//             is the single biggest particle consumer in the game, so it is metered rather
//             than emitted per tile.
//   PROPS     the physics-visual coupling. cannon-es has been throwing logs, rocks and
//             ragdolls around since the game shipped and NOTHING reacted when they landed.
//
// WHY THE PROP IMPACTS ARE DETECTED HERE AND NOT IN THE SIM
// The obvious implementation is a cannon `collide` listener in sim/physics/world.js. That
// would mean a new worker message, a change to a module whose determinism is load-bearing,
// and a cosmetic concern living inside the simulation. Instead this watches the prop rows
// the render frame already carries and looks for a sharp drop in vertical speed. It is
// approximate — a body whose row index shifts is simply skipped that frame — and that is
// fine, because a missed dust puff is invisible and the sim stays untouched.
import * as THREE from 'three';
import { FRAME } from '../sim/frame.js';
import { PROP_CAP, PROP_KIND } from '../sim/core/config.js';
import { tileX, tileZ } from '../sim/terrain/tiles.js';

// Impact detection thresholds.
const IMPACT_SPEED = 3.2;         // m/s: below this a landing is a settle, not a hit
const IMPACT_BRAKE = 0.4;         // a hit is a frame that keeps under this share of its fall speed
const MATCH_RADIUS = 2.5;         // a row that moved further than this is a different body
const IMPACT_BUDGET = 6;          // impacts drawn per frame; a rockslide can produce dozens
const TRACK_STRIDE = 5;           // x, y, z, packed kind, vertical speed

const PROP_MATERIAL = {
  [PROP_KIND.ragdollPart]: 'flesh',
  [PROP_KIND.log]: 'wood',
  [PROP_KIND.rock]: 'stone',
  [PROP_KIND.projectile]: 'stone',
};

// Per-event presets. `reach` is the distance at which the event stops shaking the camera.
const EVENTS = {
  lightning: { reach: 90, trauma: 'heavy', rack: 0.9 },
  rockslide: { reach: 70, trauma: 'medium', rack: 0.5 },
  eruption: { reach: 200, trauma: 'heavy', rack: 1 },
};

export function createEventFx(particles, audio, { tier = 'high' } = {}) {
  // Deliberately no flash light for lightning or eruptions: a whole-screen strobe on every
  // weather event reads as the screen flickering rather than as lightning. A strike has its
  // particles, its stinger and its camera trauma, and an eruption its ash column.

  // Previous frame's props, for the impact watcher. Sized to the cap once: the frame can
  // never carry more rows than PROP_CAP, so this never reallocates.
  const track = new Float32Array(PROP_CAP * TRACK_STRIDE);
  let prevCount = 0;
  let prevAt = 0;

  // Fire/lava emission is metered by a residual accumulator so a low frame rate does not
  // silently reduce how smoky the island is.
  let smokeDebt = 0;
  let lavaDebt = 0;

  const tmp = new THREE.Vector3();

  function shake(dist, preset) {
    // Distance falloff for the physical layer. impactBus owns trauma/haptics/hitstop;
    // impactFx routes the flash effects and is already tier- and flashing-gated, so this
    // module must not second-guess either.
    const near = Math.max(0, 1 - dist / preset.reach);
    if (near <= 0.02) return 0;
    const scale = near * near;           // squared, same curve impactBus uses for trauma
    window.PoImpactFx?.hit?.('hit', scale);
    if (window.PoImpact?.impact) window.PoImpact.impact(preset.trauma, scale);
    return scale;
  }

  return {
    /**
     * @param {{kind:string, tile:number}} ev a drained sim event
     * @param {{x:number,y:number,z:number}} at its world position
     * @param {{x:number,y:number,z:number}} player where the god is standing
     * @param {object} post the postProcess facade, for the rack focus
     */
    event(ev, at, player, post) {
      const preset = EVENTS[ev.kind];
      if (!preset) return;
      const dist = Math.hypot(at.x - player.x, at.y - player.y, at.z - player.z);
      const scale = shake(dist, preset);

      audio?.stinger(ev.kind, at);

      // A rack focus is a full second scene re-render, so it is spent only on events the
      // player is close enough to be looking at.
      if (scale > 0.25) post?.rack(Math.max(6, dist), preset.rack, Math.min(1, scale + 0.3));

      if (!particles?.enabled) return;
      if (ev.kind === 'lightning') {
        particles.emit('spark', at.x, at.y + 0.4, at.z, { count: 34, scale: 1.2, spread: 1.5 });
        particles.emit('ember', at.x, at.y + 0.5, at.z, { count: 18, spread: 1.1 });
        particles.emit('smoke', at.x, at.y + 0.8, at.z, { count: 14, radius: 1.6, scale: 0.8 });
        particles.emit('splinter', at.x, at.y + 1.2, at.z, { count: 12, radius: 1.0 });
      } else if (ev.kind === 'rockslide') {
        // Emitted along a short downhill trail rather than at a point: a rockslide is a
        // line of dust, and a single puff at the trigger tile reads as a small explosion.
        for (let k = 0; k < 5; k++) {
          particles.emit('dust', at.x + k * 0.9, at.y + 0.4, at.z + k * 0.9, { count: 14, radius: 2.2, scale: 1.3 });
        }
        particles.emit('splinter', at.x, at.y + 0.5, at.z, { count: 10, radius: 2 });
      } else if (ev.kind === 'eruption') {
        particles.column('ash', at.x, at.y + 1, at.z, 34, tier === 'high' ? 90 : 45, { radius: 2.4, scale: 1.4 });
        particles.column('smoke', at.x, at.y + 1, at.z, 26, tier === 'high' ? 60 : 30, { radius: 3.0, scale: 1.8 });
        particles.emit('lava', at.x, at.y + 2, at.z, { count: 46, scale: 1.5, spread: 1.0, radius: 1.5 });
        particles.emit('ember', at.x, at.y + 3, at.z, { count: 40, scale: 1.3, spread: 1.2 });
      }
    },

    /**
     * Continuous emission from burning and molten tiles. `tiles` is the sim's tile message;
     * `fireTiles` and `lavaTiles` are the index lists the renderer already walked to place
     * the flame instances, so this does not re-scan the 40 000-tile array.
     */
    ambient(dt, { fireTiles, lavaTiles, player, dayFraction }) {
      if (!particles?.enabled) return;

      if (fireTiles?.length) {
        // Rate is per-fire but the total is capped: 400 burning tiles must not emit 400
        // plumes a second. Nearby fires win the budget by being sampled first.
        smokeDebt += dt * Math.min(fireTiles.length, 28) * 2.2;
        const n = Math.min(14, Math.floor(smokeDebt));
        smokeDebt -= n;
        for (let k = 0; k < n; k++) {
          const t = fireTiles[(Math.random() * fireTiles.length) | 0];
          particles.emit('smoke', t.x, t.y + 1.1, t.z, { count: 1, scale: 0.9, radius: 0.4 });
          if (Math.random() < 0.5) particles.emit('ember', t.x, t.y + 0.7, t.z, { count: 2, radius: 0.3, scale: 0.8 });
        }
      }

      if (lavaTiles?.length) {
        lavaDebt += dt * Math.min(lavaTiles.length, 20) * 0.9;
        const n = Math.min(8, Math.floor(lavaDebt));
        lavaDebt -= n;
        for (let k = 0; k < n; k++) {
          const t = lavaTiles[(Math.random() * lavaTiles.length) | 0];
          particles.emit('ember', t.x, t.y + 0.3, t.z, { count: 1, scale: 0.7, spread: 0.5 });
          if (Math.random() < 0.25) particles.emit('smoke', t.x, t.y + 0.5, t.z, { count: 1, scale: 0.6 });
        }
      }

      // Pollen: the ambient life of a bright afternoon, seeded around the god so it is
      // always where the camera is rather than uniformly over 40 000 tiles.
      const day = Math.max(0, Math.sin((dayFraction - 0.25) * Math.PI * 2));
      if (day > 0.45 && tier === 'high' && Math.random() < dt * 6) {
        particles.emit('pollen', player.x + (Math.random() - 0.5) * 40, player.y + Math.random() * 6 - 2, player.z + (Math.random() - 0.5) * 40, { count: 1 });
      }

      // Nocturnal Bioluminescence: fireflies and mystical spores, pulsed by audio bass
      const night = 1.0 - day;
      if (night > 0.60 && tier !== 'low' && Math.random() < dt * 8) {
        let bassBoost = 1.0;
        try {
          const b = parseFloat(document.documentElement.style.getPropertyValue('--audio-bass') || '0');
          if (b > 0.2) bassBoost = 1.0 + b * 1.5;
        } catch {}
        if (Math.random() < 0.6) {
          particles.emit('firefly', player.x + (Math.random() - 0.5) * 45, player.y + Math.random() * 4 + 0.5, player.z + (Math.random() - 0.5) * 45, { count: 1, scale: bassBoost });
        } else {
          particles.emit('spore', player.x + (Math.random() - 0.5) * 40, player.y + Math.random() * 5 + 0.2, player.z + (Math.random() - 0.5) * 40, { count: 1, scale: bassBoost });
        }
      }
    },

    /**
     * The physics-visual coupling. Compares this SIM frame's prop rows against the last
     * and raises dust plus a material thud wherever something stopped falling hard.
     *
     * MUST be called once per NEW sim frame, not once per rendered frame. Prop rows only
     * change when a frame arrives (20 Hz); calling this at display rate would see a
     * repeated row as a body that had come to a dead stop, and every falling rock would
     * trail dust all the way down. `now` is therefore the frame's ARRIVAL time.
     */
    props(view, count, now, terrainApi) {
      // Not gated on particles: the loop is 256 rows and the audio half is worth having on
      // every tier. Only the emits themselves are skipped when there is no particle field.
      const dust = particles?.enabled;
      const n = Math.min(count, PROP_CAP);
      const dt = (now - prevAt) / 1000;
      // A first frame, a resumed tab or a stalled one: record the rows and judge nothing.
      // Velocity across a two-second gap is not velocity.
      const usable = prevCount > 0 && dt > 0.001 && dt < 0.25;
      let drawn = 0;

      for (let k = 0; k < n; k++) {
        const o = k * FRAME.PROP_STRIDE;
        const x = view[o]; const y = view[o + 1]; const z = view[o + 2]; const packed = view[o + 7];
        const t = k * TRACK_STRIDE;
        let vy = 0;

        // Rows are matched by index and re-checked by kind and proximity: props are
        // appended and only spliced on expiry, so the index is stable nearly always, and
        // a row that fails either check is simply skipped this frame.
        if (usable && k < prevCount && track[t + 3] === packed) {
          const px = track[t]; const py = track[t + 1]; const pz = track[t + 2];
          const moved = Math.hypot(x - px, y - py, z - pz);
          if (moved < MATCH_RADIUS) {
            vy = (y - py) / dt;                       // negative while falling
            const wasFalling = track[t + 4];
            // The landing test: it WAS coming down fast and this frame it kept only a
            // fraction of that speed. Comparing consecutive velocities rather than reading
            // a contact normal is what lets this work with no collision data at all.
            const braked = wasFalling < -IMPACT_SPEED && vy > wasFalling * IMPACT_BRAKE;
            const nearGround = !terrainApi || y - terrainApi.heightAt(x, z) < 1.4;
            if (braked && nearGround && drawn < IMPACT_BUDGET) {
              drawn++;
              const kind = Math.floor(packed / 8);
              const speed = Math.min(1, -wasFalling / 14);
              if (dust) {
                particles.emit('dust', x, y, z, { count: 4 + Math.round(speed * 10), scale: 0.6 + speed, radius: 0.4, spread: 1.45 });
                if (kind === PROP_KIND.log) particles.emit('splinter', x, y + 0.2, z, { count: 3, scale: 0.8 });
              }
              audio?.impact(PROP_MATERIAL[kind] ?? 'stone', x, y, z, 0.25 + speed * 0.75);
              // The physical layer too, but only for the heavy ones — impactBus owns the
              // rest of the decision (distance is not its business, trauma decay is).
              if (speed > 0.55 && kind !== PROP_KIND.ragdollPart) window.PoImpact?.impact?.('light', speed * 0.5);
            }
          }
        }

        track[t] = x; track[t + 1] = y; track[t + 2] = z; track[t + 3] = packed; track[t + 4] = vy;
      }
      prevCount = n;
      prevAt = now;
    },

    /**
     * Tile index → the world point a plume should rise from. Returns a SHARED vector:
     * callers consume it immediately (event() does) and must never hold on to it.
     */
    worldOf(tile, terrainApi, size) {
      const x = tileX(tile, size) + 0.5;
      const z = tileZ(tile, size) + 0.5;
      tmp.set(x, terrainApi ? terrainApi.heightAt(x, z) : 0, z);
      return tmp;
    },
  };
}
