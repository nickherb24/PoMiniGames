// grass.js — a field of real blades over the grass tiles (GFX pass 2, idea 2).
//
// Until this the grass was a vertex colour: green where the biomass was high, straw where
// the rabbits had grazed it. That colour is still the ground under the blades; what this
// adds is height. A grazed meadow is now visibly SHORTER, a storm lays it over, and a herd
// walking through leaves a flattened wake (the FRESH channel of trails.js).
//
// ZERO CPU PER FRAME
// Every blade is one instance of a seven-vertex strip, placed in a square patch that rides
// the camera. The patch is not re-seeded as the god moves: each blade's world position is
// `camera + mod(seed - camera, patch)`, so a blade stays put in the world and simply
// wraps to the far side when the camera has moved a patch-width past it. The heightmap,
// the biomass mask and the trail texture are all sampled in the vertex shader. The CPU
// touches this module only on a tile sync (1 Hz), to repack the biomass mask.
//
// WHY A HOOKED LAMBERT RATHER THAN A SHADERMATERIAL
// The blades have to sit in the ground they grow out of. A hand-rolled lighting model is
// always slightly wrong against MeshLambertMaterial (the terrain) at some hour of the day,
// and the seam is exactly where the eye looks. Hooking Lambert gets the same lights, the
// same fog, the same shadows and the same tone mapping for free. The normal is forced to
// world-up so a blade is lit like the ground under it rather than like a vertical card.
//
// Low tier: not built at all.
import * as THREE from 'three';
import { TILE, TILE_STATE } from '../sim/terrain/tiles.js';
import { cloudShadowGlsl, materialClock, materialCloud, materialSeason, materialSnow } from './materials.js';
import { trailUniforms } from './trails.js';

const TIER = {
  high: { blades: 56000, patch: 64 },
  medium: { blades: 22000, patch: 46 },
};

// Strip profile: t (0 base → 1 tip) and side (-0.5 / +0.5). Three rungs and a tip.
const RUNGS = [0, 0.38, 0.72];

function bladeGeometry(count) {
  const positions = [];
  for (const t of RUNGS) positions.push(-0.5, t, 0, 0.5, t, 0);
  positions.push(0, 1, 0);
  const index = [];
  for (let r = 0; r < RUNGS.length - 1; r++) {
    const a = r * 2;
    index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const top = (RUNGS.length - 1) * 2;
  index.push(top, top + 1, top + 2);

  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(index);
  // Seeds are stratified on a jittered grid rather than pure random: pure random clumps,
  // and a clumped meadow reads as patchy at exactly the distance the blades are visible.
  const seeds = new Float32Array(count * 3);
  const side = Math.ceil(Math.sqrt(count));
  let s = 0x9e3779b9;
  const rand = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 100000) / 100000; };
  for (let i = 0; i < count; i++) {
    const gx = i % side; const gz = Math.floor(i / side);
    seeds[i * 3] = (gx + rand()) / side;
    seeds[i * 3 + 1] = (gz + rand()) / side;
    seeds[i * 3 + 2] = rand();
  }
  geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 3));
  geo.instanceCount = count;
  return geo;
}

const VERT_HEAD = `
#include <common>
uniform vec2 uCam;
uniform float uPatch;
uniform float uGrassTime;
uniform vec2 uWind;
uniform sampler2D uHeight;
uniform float uSize;
uniform sampler2D uMask;
uniform sampler2D uTrail;
uniform float uTrailSpan;
uniform float uGrassSnow;
uniform float uGrassSeason;
uniform vec3 uGreen;
uniform vec3 uDry;
attribute vec3 aSeed;
varying vec3 vGrassCol;
varying float vBladeT;
varying vec3 vViewUp;

float grassHeightAt(vec2 p) {
  vec2 q = clamp(p, vec2(0.0), vec2(uSize - 0.001));
  ivec2 i = ivec2(floor(q));
  vec2 f = q - vec2(i);
  float h00 = texelFetch(uHeight, i, 0).r;
  float h10 = texelFetch(uHeight, i + ivec2(1, 0), 0).r;
  float h01 = texelFetch(uHeight, i + ivec2(0, 1), 0).r;
  float h11 = texelFetch(uHeight, i + ivec2(1, 1), 0).r;
  return mix(mix(h00, h10, f.x), mix(h01, h11, f.x), f.y);
}
// The clouds' shade, per blade: the same field the terrain under it samples (materials.js).
float gHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float gNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(gHash(i), gHash(i + vec2(1.0, 0.0)), u.x),
             mix(gHash(i + vec2(0.0, 1.0)), gHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
${cloudShadowGlsl('gNoise')}
`;

const VERT_BODY = `
  vec2 seedPos = aSeed.xy * uPatch;
  vec2 wp = uCam + mod(seedPos - uCam + 0.5 * uPatch, uPatch) - 0.5 * uPatch;
  float rnd = aSeed.z;
  float camDist = length(wp - uCam);
  // Fade to nothing well inside the patch edge, so the wrap never shows as a line.
  float fade = 1.0 - smoothstep(uPatch * 0.28, uPatch * 0.47, camDist);
  vec2 muv = wp / uSize;
  float inside = step(0.0, muv.x) * step(muv.x, 1.0) * step(0.0, muv.y) * step(muv.y, 1.0);
  float biomass = texture2D(uMask, muv).r * inside;
  vec2 tr = texture2D(uTrail, wp / uTrailSpan).rg;
  float bladeH = (0.2 + 0.46 * rnd) * smoothstep(0.06, 0.55, biomass) * fade
               * (1.0 - tr.r * 0.8) * (1.0 - clamp(uGrassSnow, 0.0, 1.0) * 0.92);
  float t = position.y;
  float width = 0.06 * (0.7 + rnd * 0.6) * (1.0 - t * 0.85) * step(0.02, bladeH);
  float yaw = rnd * 43.0;
  vec2 across = vec2(cos(yaw), sin(yaw));
  float phase = uGrassTime * (1.3 + rnd * 0.7) + wp.x * 0.35 + wp.y * 0.21;
  // A slow travelling gust front: the field moves in waves, not in unison.
  float gust = 0.55 + 0.45 * sin(uGrassTime * 0.6 + wp.x * 0.07 - wp.y * 0.05);
  vec2 sway = uWind * (0.45 + 0.55 * sin(phase)) * gust + vec2(sin(phase * 1.3), cos(phase * 0.9)) * 0.03;
  // Trample: fresh tracks lay the blade down along its own facing.
  float laid = tr.g;
  vec2 lay = vec2(-across.y, across.x) * laid * 0.8;
  vec2 bend = (sway + lay) * t * t * bladeH * 2.4;
  float rise = t * bladeH * (1.0 - laid * 0.7);
  vec3 transformed = vec3(wp.x + across.x * position.x * width + bend.x,
                          grassHeightAt(wp) - 0.03 + rise,
                          wp.y + across.y * position.x * width + bend.y);
  vec3 tint = mix(uDry, uGreen, clamp(biomass * 1.2, 0.0, 1.0)) * (0.82 + rnd * 0.36);
  if (uGrassSeason > 1.5 && uGrassSeason < 2.5) tint *= vec3(1.22, 0.86, 0.5);
  vGrassCol = tint * mix(0.5, 1.18, t) * cloudLight(transformed);
  vBladeT = t;
  vViewUp = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
`;

export function createGrass(scene, terrain, { tier = 'high' } = {}) {
  const cfg = TIER[tier];
  if (!cfg) return null;
  const { size } = terrain;
  const cs = size + 1;

  const heights = new Float32Array(cs * cs);
  for (let i = 0; i < heights.length; i++) heights[i] = terrain.height[i];
  const heightTex = new THREE.DataTexture(heights, cs, cs, THREE.RedFormat, THREE.FloatType);
  heightTex.minFilter = heightTex.magFilter = THREE.NearestFilter;
  heightTex.unpackAlignment = 1;
  heightTex.needsUpdate = true;

  const mask = new Uint8Array(size * size);
  const maskTex = new THREE.DataTexture(mask, size, size, THREE.RedFormat, THREE.UnsignedByteType);
  maskTex.minFilter = maskTex.magFilter = THREE.LinearFilter;
  maskTex.unpackAlignment = 1;
  maskTex.needsUpdate = true;

  const uniforms = {
    uCam: { value: new THREE.Vector2(size / 2, size / 2) },
    uPatch: { value: cfg.patch },
    uGrassTime: materialClock,
    uWind: { value: new THREE.Vector2(0.08, 0.03) },
    uHeight: { value: heightTex },
    uSize: { value: size },
    uMask: { value: maskTex },
    uTrail: trailUniforms.uTrail,
    uTrailSpan: trailUniforms.uTrailSpan,
    uGrassSnow: materialSnow,
    uGrassSeason: materialSeason,
    uGreen: { value: new THREE.Color(0x5a9434) },
    uDry: { value: new THREE.Color(0x9a8c52) },
  };

  const material = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, materialCloud);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', VERT_HEAD)
      // Up-facing normal: the blade is lit like the ground it stands on.
      .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);')
      .replace('#include <begin_vertex>', VERT_BODY);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `
        #include <common>
        varying vec3 vGrassCol;
        varying float vBladeT;
        varying vec3 vViewUp;
      `)
      .replace('#include <color_fragment>', `
        #include <color_fragment>
        diffuseColor.rgb *= vGrassCol;
      `)
      // DoubleSide flips the normal on the back face, which would light the far side of
      // every blade as if it faced the ground. Re-seat it on world-up.
      .replace('#include <normal_fragment_begin>', `
        #include <normal_fragment_begin>
        normal = normalize(vViewUp);
      `)
      // Translucency: a low sun behind the field lights the tips — the one term that makes
      // grass read as grass rather than green fur.
      .replace('#include <opaque_fragment>', `
        #if NUM_DIR_LIGHTS > 0
          vec3 grassSun = normalize(directionalLights[0].direction);
          float backlit = pow(clamp(dot(-normalize(vViewPosition), grassSun), 0.0, 1.0), 3.0);
          outgoingLight += directionalLights[0].color * diffuseColor.rgb * backlit * vBladeT * 0.35;
        #endif
        #include <opaque_fragment>
      `);
  };
  material.customProgramCacheKey = () => 'poeco-grass';

  const geometry = bladeGeometry(cfg.blades);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;       // positions are made in the shader; the box is meaningless
  mesh.receiveShadow = true;
  mesh.name = 'grass';
  scene.add(mesh);

  const windAngle = { value: 0.6 };

  return {
    mesh,
    /** Tile sync: repack biomass onto the tiles that can carry a meadow. */
    setTiles(tileState, grass) {
      if (!grass) return;
      for (let t = 0; t < mask.length; t++) {
        const type = terrain.type[t];
        const state = tileState ? tileState[t] : 0;
        const meadow = type === TILE.GRASS ? 1 : type === TILE.HILL ? 0.7 : 0;
        const open = state === TILE_STATE.NORMAL || state === TILE_STATE.FENCE;
        mask[t] = meadow && open ? grass[t] * meadow : 0;
      }
      maskTex.needsUpdate = true;
    },
    /** Per frame: the patch follows the camera; wind is 0..1 (calm → gale). */
    update(dt, player, wind) {
      uniforms.uCam.value.set(player.x, player.z);
      // The wind veers slowly; a gale holds its direction better than a breeze.
      windAngle.value += dt * 0.012;
      const strength = 0.06 + wind * 0.34;
      uniforms.uWind.value.set(Math.cos(windAngle.value) * strength, Math.sin(windAngle.value) * strength);
    },
    dispose() {
      scene.remove(mesh);
      geometry.dispose(); material.dispose(); heightTex.dispose(); maskTex.dispose();
    },
  };
}
