// terrainMesh.js — the island as one vertex-coloured mesh plus the water surface.
//
// Colours come from the biome and the live grass biomass, so grazing, fire and lava show
// up without rebuilding geometry: only the colour attribute is rewritten (per tile-sync).
//
// GFX option 7 keeps that contract and adds a surface to it. The material is still
// MeshLambertMaterial — the flat-shaded low-poly look is the art direction, not a
// limitation — but `onBeforeCompile` injects four terms the vertex colours cannot express:
//
//   GRAIN    two octaves of value noise in world space, so a tile is no longer one flat
//            facet of colour when the god stands on it.
//   STRATA   the same noise sampled without a vertical term, which smears into horizontal
//            banding on steep faces. On a cliff that reads as rock strata; on flat ground
//            it is invisible because the surface is already being grained.
//   ROCK     slope-blended grey. Anything past ~40° stops being soil regardless of biome,
//            which is what gives the mountains an edge the vertex palette never had.
//   WET      a darkening band either side of the waterline, so the beach meets the sea in
//            a damp margin instead of at a hard colour boundary.
//   SNOW     above a line set from the island's own peak height, jittered by noise and
//            held only by gentle faces — the mountains get a cap, the cliffs stay bare.
//   RIPPLES  wind lines on the beach shelf, a metre-scale sine bent by noise.
//   BUMP     a noise-gradient perturbation of the fragment normal (Lambert lights per
//            fragment since r155), so light rakes across ground that used to be one flat
//            facet per triangle. Cheap: four noise taps, high tier only.
//
// Lava and fire additionally get a real EMISSIVE channel, via a per-vertex `aGlow`
// attribute written by paint(). That is what makes them bloom in postProcess.js — before
// this they were flat orange vertex colours, which no bright-pass can find.
//
// GFX pass 2 lets the ground answer to what happens ON it:
//
//   PATHS    the WEAR channel of trails.js packs grass into bare earth along the routes
//            creatures actually walk; the FRESH channel darkens sand and cuts tracks
//            through snow.
//   WEATHER  the sim's own ground wetness (weather.js) darkens the soil, puts a sky sheen
//            on it and opens puddles on flat ground that mirror the sky and the sun, with
//            rain rings while it is still falling. Snow cover (a weather spell, or winter)
//            settles on every gentle face, not only the peaks.
//   BORDERS  each tribe's territory edge as a faint ground-projected line of its banner
//            colour that brightens after dark — the island's politics, drawn on the land.
import * as THREE from 'three';
import { TILE, TILE_STATE, tileX, tileZ } from '../sim/terrain/tiles.js';
import { createWater } from './water.js';
import { trailUniforms } from './trails.js';
import { cloudShadowGlsl, materialCloud } from './materials.js';

const MAX_TRIBES = 4;

// Base colours per tile type (linear-ish sRGB hex, picked to read at a distance).
const BIOME = {
  [TILE.OCEAN]: 0x0c4a6e, [TILE.BEACH]: 0xd8c48f, [TILE.GRASS]: 0x4e7f2f, [TILE.FOREST]: 0x1f5c2a,
  [TILE.HILL]: 0x6b7a4a, [TILE.MOUNTAIN]: 0x7a736b, [TILE.LAKE]: 0x0ea5e9, [TILE.VOLCANO]: 0x44403c,
};
const STATE_COLOUR = {
  [TILE_STATE.FIRE]: 0xf97316, [TILE_STATE.BURNT]: 0x2a2724, [TILE_STATE.LAVA]: 0xef4444,
  [TILE_STATE.COOLED]: 0x3f3a36, [TILE_STATE.BOULDER]: 0x8a8378,
  // The tribe's works: sooted hearth, tilled earth, a packed-earth tower footing. A fence
  // keeps the grass under it.
  [TILE_STATE.CAMPFIRE]: 0x5a4030, [TILE_STATE.FIELD]: 0x7a5a32, [TILE_STATE.TOWER]: 0x6b5a45,
};
// How hard each state glows. Fire flickers (the renderer drives uGlowPulse); lava is
// steady and hot; everything else is 0 and costs the shader a multiply.
const STATE_GLOW = { [TILE_STATE.FIRE]: 1.0, [TILE_STATE.LAVA]: 0.85, [TILE_STATE.CAMPFIRE]: 0.45 };
const DRY = new THREE.Color(0x8a7f4a);   // grass at zero biomass
// How far under the surface the middle of a lake's bed is DRAWN. The sim flattens a lake
// to exactly sea level (island.js), which is the water plane's own height: every wave
// trough dipped under the bed and showed it, and the rest of the lake was a zero-depth
// shoreline (full foam, full caustics) — a white sheet with a ragged blue edge. Two
// limits: deeper than the wave sum in water.js (0.36), and no steeper than the rock blend
// below starts at (a 1 m rim tile dropping 0.8 is just under it), or the bank turns grey.
// Render-only: terrain.height and heightAt still say sea level.
const LAKE_BED = -0.8;

const COMMON_VERT = `
#include <common>
attribute float aGlow;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying float vGlow;
`;

const COMMON_FRAG = `
#include <common>
uniform float uGlowPulse;
uniform float uDetail;      // 0 disables every injected term — the low-tier escape hatch
uniform float uSnowLine;    // world y where snow starts; huge on an island with no peak
uniform sampler2D uTrail;   // trails.js: R = worn path, G = fresh tracks
uniform float uTrailSpan;
uniform float uWet;         // 0..1 ground wetness (the sim's)
uniform float uRain;        // 0..1 rain still falling (puddle rings)
uniform float uSnowCover;   // 0..1 lowland snow (weather spell / winter)
uniform vec3 uSkyCol;
uniform vec3 uSunDirW;
uniform vec3 uSunCol;
uniform float uNight;
uniform float uTerrainTime;
uniform vec4 uTribe[${MAX_TRIBES}];      // x, z, territory radius, 1 = present
uniform vec3 uTribeCol[${MAX_TRIBES}];
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying float vGlow;

float tHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float tNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(tHash(i), tHash(i + vec2(1.0, 0.0)), u.x),
             mix(tHash(i + vec2(0.0, 1.0)), tHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
${cloudShadowGlsl('tNoise')}
`;

export function createTerrainMesh(terrain, { tier = 'high' } = {}) {
  const { size, height } = terrain;
  const cs = size + 1;
  const drawn = Float32Array.from(height);
  // Lake tiles touching each corner, 0..4. Non-zero is the lake mask water.js bakes; only a
  // corner with lake on all four sides is sunk. The rim stays where the sim put it, because
  // it is shared with land tiles, and creatures, trees and huts stand at the sim's height.
  const lake = new Uint8Array(cs * cs);
  for (let t = 0; t < size * size; t++) {
    if (terrain.type[t] !== TILE.LAKE) continue;
    const o = tileZ(t, size) * cs + tileX(t, size);
    lake[o]++; lake[o + 1]++; lake[o + cs]++; lake[o + cs + 1]++;
  }
  for (let k = 0; k < drawn.length; k++) if (lake[k] === 4) drawn[k] = Math.min(drawn[k], LAKE_BED);
  const geometry = new THREE.PlaneGeometry(size, size, size, size);
  geometry.rotateX(-Math.PI / 2);
  const pos = geometry.attributes.position;
  // PlaneGeometry rows run +x then -z; translate so tile (0,0) sits at world (0,0).
  for (let j = 0; j < cs; j++) {
    for (let i = 0; i < cs; i++) {
      const v = j * cs + i;
      pos.setX(v, i);
      pos.setZ(v, j);
      pos.setY(v, drawn[v]);
    }
  }
  pos.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(cs * cs * 3), 3));
  const glowAttr = new THREE.BufferAttribute(new Float32Array(cs * cs), 1);
  glowAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('aGlow', glowAttr);

  const material = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  // Held outside onBeforeCompile so the renderer can drive them per frame: the callback
  // runs once, at first compile, and the uniform objects it captures are these.
  // The snow line follows the island's own relief: a low island gets none, a tall one
  // gets a cap on its top fifth. 1e6 disables the term without a branch in the shader.
  let peak = 0;
  for (let i = 0; i < height.length; i++) if (height[i] > peak) peak = height[i];
  const uniforms = {
    uGlowPulse: { value: 1 },
    uDetail: { value: tier === 'low' ? 0 : 1 },
    uSnowLine: { value: peak > 16 ? peak * 0.78 : 1e6 },
    uTrail: trailUniforms.uTrail,
    uTrailSpan: trailUniforms.uTrailSpan,
    uWet: { value: 0 },
    uRain: { value: 0 },
    uSnowCover: { value: 0 },
    uSkyCol: { value: new THREE.Color(0x8ec5ff) },
    uSunDirW: { value: new THREE.Vector3(0, 1, 0) },
    uSunCol: { value: new THREE.Color(0xfff2df) },
    uNight: { value: 0 },
    uTerrainTime: { value: 0 },
    uTribe: { value: Array.from({ length: MAX_TRIBES }, () => new THREE.Vector4(0, 0, 0, 0)) },
    uTribeCol: { value: Array.from({ length: MAX_TRIBES }, () => new THREE.Color(0xffffff)) },
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, materialCloud);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', COMMON_VERT)
      .replace('#include <beginnormal_vertex>', `
        #include <beginnormal_vertex>
        vWorldNormal = normalize(mat3(modelMatrix) * objectNormal);
      `)
      .replace('#include <begin_vertex>', `
        #include <begin_vertex>
        vWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vGlow = aGlow;
      `);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', COMMON_FRAG)
      .replace('#include <color_fragment>', `
        #include <color_fragment>
        if (uDetail > 0.5) {
          // Grain: two octaves, the second at a prime-ish ratio so the pattern does not
          // beat against the 1 m tile grid.
          float g = tNoise(vWorldPos.xz * 0.65) * 0.62 + tNoise(vWorldPos.xz * 2.7) * 0.38;
          diffuseColor.rgb *= 0.86 + g * 0.28;

          // Strata: no vertical term in the sample, so on a cliff this smears into bands.
          // On flat ground the slope mask below is ~0 and it never shows.
          float slope = 1.0 - clamp(vWorldNormal.y, 0.0, 1.0);
          float steep = smoothstep(0.22, 0.62, slope);
          float bands = tNoise(vec2(vWorldPos.y * 3.1, (vWorldPos.x + vWorldPos.z) * 0.18));
          vec3 rock = vec3(0.36, 0.34, 0.32) * (0.72 + bands * 0.5);
          diffuseColor.rgb = mix(diffuseColor.rgb, rock, steep * 0.72);

          // Wet margin: darker and slightly more saturated where the tide would reach.
          float wet = 1.0 - smoothstep(-0.15, 1.1, vWorldPos.y);
          diffuseColor.rgb *= 1.0 - wet * 0.34;

          // Snow: a noise-jittered line, held only where the face is gentle enough.
          float snowLine = uSnowLine + tNoise(vWorldPos.xz * 0.21) * 4.0;
          float snow = smoothstep(snowLine, snowLine + 3.5, vWorldPos.y) * (1.0 - steep * 0.85);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.95, 0.98) * (0.9 + g * 0.1), snow);

          // Sand ripples: wind lines on the flat of the beach, bent by the same noise.
          float beach = smoothstep(-0.2, 0.4, vWorldPos.y) * (1.0 - smoothstep(1.2, 2.4, vWorldPos.y)) * (1.0 - steep);
          float ripple = sin((vWorldPos.x * 0.9 + vWorldPos.z * 0.35 + tNoise(vWorldPos.xz * 0.5) * 2.0) * 6.0) * 0.5 + 0.5;
          diffuseColor.rgb *= 1.0 - beach * ripple * 0.09;

          // Cloud shadows: the deck overhead, projected down the sun's ray, so
          // the patches sliding over the hills are the clouds you can see above them. Lava
          // and fire are their own light and stay bright.
          diffuseColor.rgb *= mix(cloudLight(vWorldPos), 1.0, step(0.01, vGlow));
        }

        // ── GFX pass 2: paths, tracks, wet ground, lowland snow ──
        float tSteep = smoothstep(0.22, 0.62, 1.0 - clamp(vWorldNormal.y, 0.0, 1.0));
        float tDry = smoothstep(0.1, 0.7, vWorldPos.y) * (1.0 - step(0.01, vGlow));
        vec2 tTrail = texture2D(uTrail, vWorldPos.xz / uTrailSpan).rg;
        // Worn earth only where the ground is vegetated (greener than it is red): a path
        // across the beach is sand either way, and a burnt tile has nothing left to wear.
        float tVeg = smoothstep(0.0, 0.08, diffuseColor.g - diffuseColor.r);
        float tWorn = smoothstep(0.06, 0.55, tTrail.r) * tVeg * (1.0 - tSteep) * tDry;
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.31, 0.24, 0.16) * (0.9 + tNoise(vWorldPos.xz * 3.0) * 0.2), tWorn * 0.78);
        diffuseColor.rgb *= 1.0 - tTrail.g * 0.16 * tDry;

        float tSnowCov = 0.0;
        if (uSnowCover > 0.01) {
          float drift = tNoise(vWorldPos.xz * 0.33) * 0.6 + tNoise(vWorldPos.xz * 1.7) * 0.4;
          // The threshold walks down the noise as cover grows, so a dusting is a few drifts
          // in the hollows and a full winter is a blanket with the odd bare patch.
          float line = 1.02 - uSnowCover * 1.1;
          tSnowCov = smoothstep(line, line + 0.16, drift) * (1.0 - tSteep * 0.9) * tDry;
          // Tracks and paths show the ground through it: a wolf's route across a snowfield.
          tSnowCov *= (1.0 - tTrail.g * 0.85) * (1.0 - tTrail.r * 0.6);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.9, 0.93, 0.97), tSnowCov * 0.9);
        }

        float tPuddle = 0.0;
        if (uWet > 0.01) {
          diffuseColor.rgb *= 1.0 - uWet * 0.26 * tDry * (1.0 - tSnowCov);
          float flatness = pow(clamp(vWorldNormal.y, 0.0, 1.0), 12.0);
          // Puddles are the hollows of a finer noise; a drier island needs a deeper hollow to
          // hold one, so they shrink back as the ground dries rather than all at once.
          float hollow = tNoise(vWorldPos.xz * 0.6 + 11.0) * 0.7 + tNoise(vWorldPos.xz * 1.9 - 4.0) * 0.3;
          float pool = smoothstep(0.7, 0.75, hollow - (1.0 - uWet) * 0.3);
          tPuddle = pool * flatness * uWet * tDry * (1.0 - tSnowCov) * (1.0 - tWorn * 0.5);
        }
      `)
      .replace('#include <normal_fragment_begin>', `
        #include <normal_fragment_begin>
        if (uDetail > 0.5) {
          // Bump: the gradient of a world-space noise field, rotated into view space (the
          // Lambert normal lives there), so the ground catches light unevenly.
          float e = 0.35;
          float hx = tNoise((vWorldPos.xz + vec2(e, 0.0)) * 1.9) - tNoise((vWorldPos.xz - vec2(e, 0.0)) * 1.9);
          float hz = tNoise((vWorldPos.xz + vec2(0.0, e)) * 1.9) - tNoise((vWorldPos.xz - vec2(0.0, e)) * 1.9);
          vec3 bump = mat3(viewMatrix) * vec3(-hx, 0.0, -hz);
          normal = normalize(normal + bump * 0.55);
        }
      `)
      .replace('#include <emissivemap_fragment>', `
        #include <emissivemap_fragment>
        // vGlow is 0 for all but burning and molten tiles, so this is a multiply-add for
        // the whole island and a real light source for the handful of tiles that are lit.
        totalEmissiveRadiance += diffuseColor.rgb * vGlow * uGlowPulse * 2.4;
        // Territory borders: a soft line at each tribe's radius, breathing slowly, faint by
        // day and a real glow after dark.
        for (int k = 0; k < ${MAX_TRIBES}; k++) {
          if (uTribe[k].w < 0.5) continue;
          float edge = abs(distance(vWorldPos.xz, uTribe[k].xy) - uTribe[k].z);
          float line = exp(-edge * edge * 1.4);
          float pulse = 0.75 + 0.25 * sin(uTerrainTime * 0.9 + float(k) * 2.1 + vWorldPos.x * 0.05);
          // 0.3 after dark: seen along the ground through the night bloom, a stronger
          // border washes a third of the frame out.
          totalEmissiveRadiance += uTribeCol[k] * line * pulse * (0.05 + uNight * 0.3) * (1.0 - tSteep * 0.5);
        }
      `)
      // Puddles and wet sheen are reflections, so they go after the lighting sum.
      .replace('#include <opaque_fragment>', `
        if (tPuddle > 0.001 || uWet > 0.01) {
          vec3 tView = normalize(cameraPosition - vWorldPos);
          float tFres = 0.04 + 0.96 * pow(1.0 - clamp(tView.y, 0.0, 1.0), 5.0);
          vec3 tN = vec3(0.0, 1.0, 0.0);
          if (uRain > 0.02 && tPuddle > 0.001) {
            // Rain rings: one expanding ring per cell, at a hashed phase.
            vec2 cell = floor(vWorldPos.xz * 1.6);
            vec2 local = fract(vWorldPos.xz * 1.6) - 0.5;
            float ph = fract(uTerrainTime * 0.9 + tHash(cell) * 7.0);
            float ringD = length(local - (vec2(tHash(cell + 3.1), tHash(cell + 7.7)) - 0.5) * 0.5);
            float ring = exp(-pow((ringD - ph * 0.5) * 22.0, 2.0)) * (1.0 - ph) * step(tHash(cell + 1.3), uRain);
            tN = normalize(tN + vec3(local.x, 0.0, local.y) * ring * 1.5);
          }
          vec3 refl = reflect(-tView, tN);
          float sunSpec = pow(max(dot(refl, normalize(uSunDirW)), 0.0), 220.0);
          vec3 mirror = uSkyCol * 0.85 + uSunCol * sunSpec * 3.0;
          outgoingLight = mix(outgoingLight, mirror, tPuddle * (0.45 + 0.5 * tFres));
          outgoingLight += uSkyCol * tFres * uWet * 0.1 * tDry;
        }
        #include <opaque_fragment>
      `);
  };

  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.name = 'island';

  const water = createWater({ size, height: drawn, lake }, { tier });

  const colour = new THREE.Color();

  /** Recolour every vertex from the tile type, its state and the grass biomass (0..255). */
  function paint(tileState, grass) {
    const colours = geometry.attributes.color;
    const glow = geometry.attributes.aGlow;
    for (let j = 0; j < cs; j++) {
      for (let i = 0; i < cs; i++) {
        // A corner takes the colour of the tile down-right of it (clamped at the edges).
        const t = Math.min(size - 1, i) + Math.min(size - 1, j) * size;
        const state = tileState?.[t] ?? 0;
        const stateColour = STATE_COLOUR[state];
        if (stateColour !== undefined) colour.setHex(stateColour);
        else {
          colour.setHex(BIOME[terrain.type[t]] ?? 0x555555);
          // lerp does not mutate its argument, so the constant can be passed directly.
          if (grass && (terrain.type[t] === TILE.GRASS || terrain.type[t] === TILE.HILL)) colour.lerp(DRY, 1 - grass[t] / 255);
        }
        const v = j * cs + i;
        colours.setXYZ(v, colour.r, colour.g, colour.b);
        glow.setX(v, STATE_GLOW[state] ?? 0);
      }
    }
    colours.needsUpdate = true;
    glow.needsUpdate = true;
  }
  paint(null, null);

  return {
    mesh,
    water: water.mesh,
    paint,
    /**
     * Per frame. `time` drives the fire flicker on the emissive channel and the water's
     * wave clock; `sky` is the object lighting.update() returns.
     */
    update(time, sky, surface = null) {
      // One shared flicker for every burning tile: fires on an island genuinely do pulse
      // together at a distance, and a per-tile phase would need a second attribute upload.
      uniforms.uGlowPulse.value = 0.78 + Math.sin(time * 7.3) * 0.14 + Math.sin(time * 11.9) * 0.08;
      uniforms.uTerrainTime.value = time;
      if (sky) {
        uniforms.uSkyCol.value.copy(sky.sky);
        uniforms.uSunDirW.value.copy(sky.sunDir);
        uniforms.uSunCol.value.copy(sky.sunColour);
        uniforms.uNight.value = sky.night;
      }
      if (surface) {
        uniforms.uWet.value = surface.wet;
        uniforms.uRain.value = surface.rain;
        uniforms.uSnowCover.value = surface.snow;
      }
      water.update(time, sky, surface);
    },
    /** Tribe territories: [{ id, centerX, centerZ, territoryRadius }] with a banner colour each. */
    setTribes(tribes, colourOf) {
      for (let k = 0; k < MAX_TRIBES; k++) {
        const t = tribes?.[k];
        const v = uniforms.uTribe.value[k];
        if (!t || !(t.territoryRadius > 0)) { v.w = 0; continue; }
        v.set(t.centerX, t.centerZ, t.territoryRadius, 1);
        uniforms.uTribeCol.value[k].setHex(colourOf(t.id));
      }
    },
    dispose() { geometry.dispose(); material.dispose(); water.dispose(); },
    tileAt: (x, z) => Math.min(size - 1, Math.max(0, x | 0)) + Math.min(size - 1, Math.max(0, z | 0)) * size,
    tileX: (i) => tileX(i, size), tileZ: (i) => tileZ(i, size),
  };
}
