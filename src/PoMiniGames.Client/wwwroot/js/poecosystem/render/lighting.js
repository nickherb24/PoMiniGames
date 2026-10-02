// lighting.js — sun, sky, atmosphere and the day/night cycle (120 s per cycle).
// The shadow camera follows the player, so a 2048 map covers the ~80 m the god can
// actually see rather than the whole 200 m island (the trick from povoxelstrike/game.js).
//
// Publishes the sun and fog settings shared by water and post-processing.
import * as THREE from 'three';

const SHADOW_HALF = 120; // Encloses the full 200m island (plus margins) to eliminate frustum clipping lines

// Night is deliberately mild — the sky darkens slightly and the
// sun dims, but light floors stay high enough that creatures and terrain remain clearly
// observable around the clock. The scene must never become a dark screen.
const DAY_SKY = new THREE.Color(0x8ec5ff);
const NIGHT_SKY = new THREE.Color(0x2a3c5a);
const DUSK_SKY = new THREE.Color(0xf59e0b);
const DAY_SUN = new THREE.Color(0xfff2df);
const NIGHT_SUN = new THREE.Color(0x9db4d8);
// A closed storm deck greys the sky and the haze together (weather).
const OVERCAST_SKY = new THREE.Color(0x7d8894);

export function createLighting(scene, { shadows = true, shadowMapSize = 2048 } = {}) {
  const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x2f3a2a, 1.1);
  const ambient = new THREE.AmbientLight(0xc8d4e8, 0.35);
  const sun = new THREE.DirectionalLight(0xfff2df, 2.0);
  sun.castShadow = shadows;
  if (shadows) {
    sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);
    sun.shadow.camera.left = -SHADOW_HALF; sun.shadow.camera.right = SHADOW_HALF;
    sun.shadow.camera.top = SHADOW_HALF; sun.shadow.camera.bottom = -SHADOW_HALF;
    sun.shadow.camera.near = 10; sun.shadow.camera.far = 420;
    sun.shadow.bias = -0.00008; sun.shadow.normalBias = 0.04;
  }
  scene.add(hemi, ambient, sun, sun.target);

  // The fog is owned here rather than by the renderer: its colour and density both track
  // the same `elevation` the sun does, and splitting that across two files is how a sky
  // and its haze end up disagreeing about what time it is.
  const fog = new THREE.FogExp2(DAY_SKY.getHex(), 0.0045);
  scene.fog = fog;

  // No camera-following mist plane: its broad noise patches obscure the island.

  const islandCenter = new THREE.Vector3(100, 0, 100);
  const sky = new THREE.Color();
  const sunColour = new THREE.Color();
  const sunDir = new THREE.Vector3(0, 1, 0);
  // Reused so update() allocates nothing at 60 fps — it is called every frame.
  const info = { sky, sunColour, sunDir, night: 0, day: 1, dusk: 0, fogDensity: 0.0045 };

  return {
    sun, hemi, ambient, fog,

    setWorldSize(size) {
      if (!size || size <= 0) return;
      islandCenter.set(size / 2, 0, size / 2);
      if (sun.shadow?.camera) {
        const half = size * 0.6;
        sun.shadow.camera.left = -half;
        sun.shadow.camera.right = half;
        sun.shadow.camera.top = half;
        sun.shadow.camera.bottom = -half;
        sun.shadow.camera.updateProjectionMatrix();
      }
    },

    /**
     * dayFraction 0..1 (0 = midnight). Returns the shared sky description: the renderer
     * uses `sky` for the clear colour, the water shader takes the sun and the night
     * factor, and the god-ray pass takes the sun's world position off `sun`.
     */
    update(dayFraction, player, time = 0, overcast = 0) {
      const angle = (dayFraction - 0.25) * Math.PI * 2;      // 0.25 = sunrise
      const elevation = Math.sin(angle);
      const dist = 180;
      sun.position.set(islandCenter.x + Math.cos(angle) * dist, Math.max(12, elevation * dist), islandCenter.z + 60);
      sun.target.position.set(islandCenter.x, 0, islandCenter.z);
      sun.target.updateMatrixWorld();
      sunDir.set(sun.position.x - islandCenter.x, sun.position.y, sun.position.z - islandCenter.z).normalize();

      const day = Math.max(0, elevation);
      const dusk = Math.max(0, 1 - Math.abs(elevation) * 4);  // brief warm band at the horizon
      const night = 1 - day;
      sky.copy(NIGHT_SKY).lerp(DAY_SKY, day).lerp(DUSK_SKY, dusk * 0.5).lerp(OVERCAST_SKY, overcast * 0.55);
      sunColour.copy(NIGHT_SUN).lerp(DAY_SUN, day);
      sun.color.copy(sunColour);
      // Cloud cover takes the sun first and the sky light barely: under a storm the island
      // goes flat and grey, never dark (the night floor rule above still holds).
      sun.intensity = (0.55 + day * 1.6) * (1 - 0.5 * overcast);
      hemi.intensity = 0.55 + day * 0.6;
      ambient.intensity = 0.34 + day * 0.12;

      // Haze thickens at both ends of the day. The dusk term dominates because that is
      // when the shafts are longest and the fog is what they scatter through.
      fog.density = 0.0040 + dusk * 0.0085 + night * 0.0035 + overcast * 0.0055;
      fog.color.copy(sky);


      info.night = night; info.day = day; info.dusk = dusk; info.fogDensity = fog.density;
      return info;
    },

    dispose() {
      scene.remove(hemi, ambient, sun, sun.target);
      sun.dispose?.();
      scene.fog = null;
    },
  };
}
