// drives.js — hunger, thirst, age and health integration. Pure over the
// entity store; the caller decides death via lifecycle.checkVitals().
import { YEAR_SECONDS } from '../core/config.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function stepDrives(e, i, species, dt) {
  e.hunger[i] = clamp01(e.hunger[i] + species.hungerRate * dt);
  e.thirst[i] = clamp01(e.thirst[i] + species.thirstRate * dt);
  e.age[i] += dt / YEAR_SECONDS;
  if (e.hunger[i] > 0.9 || e.thirst[i] > 0.9) {
    e.health[i] -= species.starveDamage * dt;
  } else if (e.hunger[i] < 0.5 && e.thirst[i] < 0.5 && e.health[i] < 1) {
    e.health[i] = Math.min(1, e.health[i] + species.regenRate * dt);
  }
}

export function feed(e, i, amount) { e.hunger[i] = clamp01(e.hunger[i] - amount); }
export function drink(e, i, amount) { e.thirst[i] = clamp01(e.thirst[i] - amount); }

/** 'hunger' | 'thirst' | 'content' — used by templated thoughts and goal scoring. */
export function dominantDrive(e, i) {
  const h = e.hunger[i]; const t = e.thirst[i];
  if (h < 0.4 && t < 0.4) return 'content';
  return t > h ? 'thirst' : 'hunger';
}
