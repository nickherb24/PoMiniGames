// fighters.js — the president caricatures as hierarchical three.js primitive rigs.
//
// Likeness comes from four layers, all cheap primitives + canvas textures:
//   1. Facial geometry — brows/eyes/nose/mouth/chin/jowls, parameterized per
//      president (Nixon's ski-jump nose and heavy brows, Clinton's bulb nose…).
//   2. A canvas-painted face-detail plate — tan lines, blush, wrinkles,
//      stubble — laid over the front of the skull.
//   3. Bespoke hair geometry per president (the Trump sweep, Reagan's
//      pompadour, Obama's grey temples) instead of shared generic styles.
//   4. Body caricature — per-part belly/shoulder/head scales layered on the
//      base build, plus accessories (flag pins, Bush Sr.'s round glasses,
//      Carter's cardigan, Clinton's loosened tie).
//
// Engine contracts that must NOT change (foot IK, ragdolls and hit capsules
// depend on them): joint names, joint positions, and refs.skull.scale staying
// (1,1,1) at build time (the engine writes absolute swell scales into it).
//
// Each character exposes `mass`, `attackPower`, and `moveAccel` so the engine
// can drive weight/momentum/knockback without per-character special cases.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

// Face parameter reference (all optional, defaults in buildFace):
//   brow:  { color, angle (rad; − = stern inner-down, + = raised), thick, w }
//   eyes:  { squint (0..1), color (iris) }
//   nose:  { type: 'straight'|'ski'|'bulb'|'wide'|'button', size }
//   mouth: { w, smile (0..1), frown (0..1), smirk (bool), teeth (bool) }
//   chin:  scale (1 = subtle, 1.5 = Ford jaw), jowls/cheeks: bool
//   Painted detail: tanLines (Trump goggles), blush (0..1), wrinkles (0..1),
//   stubble (bool), faceTint (face-only skin tone override).
export const CHARACTERS = {
  trump: {
    id: 'trump', name: 'Trump',
    skin: 0xefae7f, faceTint: 0xea9a5e, suit: 0x1b2a52, tie: 0xd62828, tieLength: 1.4,
    hair: 0xf7d98c, hairStyle: 'trumpSweep',
    heightScale: 1.02, buildScale: 1.15,
    headScale: 1.02, bellyScale: 1.22,
    face: {
      brow: { color: 0xd8b36a, angle: -0.22, thick: 1.1 },
      eyes: { squint: 0.35, color: 0x5d7fa3 },
      nose: { type: 'straight', size: 1.0 },
      mouth: { w: 0.72, frown: 0.25 },
      cheeks: true, tanLines: true, blush: 0.25, wrinkles: 0.25,
    },
    lapelPin: true,
    stance: { torso: { x: -0.05 }, head: { x: -0.14 } },
    mass: 1.18, attackPower: 1.10, moveAccel: 11,
    entrance: 'trumpPump',
  },
  biden: {
    id: 'biden', name: 'Biden',
    skin: 0xeec9ae, suit: 0x24365e, tie: 0x7fb2e5, tieLength: 1.0,
    hair: 0xf5f5f5, hairStyle: 'combover',
    heightScale: 1.0, buildScale: 0.95, aviators: true,
    face: {
      brow: { color: 0xcfcfcf, angle: -0.05, thick: 0.8 },
      eyes: { squint: 0.55, color: 0x6f93b5 },
      nose: { type: 'straight', size: 0.9 },
      mouth: { w: 1.15, smile: 0.5, teeth: true },
      wrinkles: 0.8,
    },
    lapelPin: true,
    stance: { head: { x: 0.03, z: 0.05 } },
    mass: 0.95, attackPower: 0.92, moveAccel: 13,
    entrance: 'aviator',
  },
  obama: {
    id: 'obama', name: 'Obama',
    skin: 0x8d5524, suit: 0x3a3f44, tie: 0x2456c9, tieLength: 1.0,
    hair: 0x2b2b2b, hairStyle: 'crop', greyTemples: true,
    heightScale: 1.04, buildScale: 0.95,
    headW: 0.245, headH: 0.305, earR: 0.052,
    face: {
      brow: { color: 0x1f1f1f, angle: -0.1, thick: 1.0 },
      eyes: { color: 0x33231a },
      nose: { type: 'wide', size: 1.0 },
      mouth: { w: 1.0, smile: 0.25 },
      chin: 1.05, wrinkles: 0.2,
    },
    lapelPin: true,
    stance: { shoulderL: { x: 0.22 }, shoulderR: { x: 0.22 }, elbowL: { x: 0.3 }, elbowR: { x: 0.3 } },
    mass: 1.0, attackPower: 1.05, moveAccel: 14,
    entrance: 'fistbump',
  },
  bush: {
    id: 'bush', name: 'Bush',
    skin: 0xe3b18e, suit: 0x17181c, tie: 0xb02323, tieLength: 0.85,
    hair: 0x8a8073, hairStyle: 'sidePart',
    heightScale: 0.97, buildScale: 1.08, earR: 0.05,
    face: {
      brow: { color: 0x6e6357, angle: 0.14, thick: 0.9 },
      eyes: { squint: 0.45, color: 0x51708d },
      nose: { type: 'straight', size: 0.9 },
      mouth: { w: 0.85, smirk: true, smile: 0.2 },
      chin: 1.1, wrinkles: 0.45,
    },
    lapelPin: true,
    stance: { head: { z: 0.07 } },
    mass: 1.12, attackPower: 1.0, moveAccel: 10,
    entrance: 'cowboy',
  },
  clinton: {
    id: 'clinton', name: 'Clinton',
    skin: 0xeec39a, suit: 0x2c3e6b, tie: 0xc0392b, tieLength: 1.05,
    hair: 0xe3e3e3, hairStyle: 'silverSweep',
    heightScale: 1.03, buildScale: 1.06,
    headW: 0.275, bellyScale: 1.12,
    face: {
      brow: { color: 0xb9b9b9, thick: 0.9 },
      eyes: { color: 0x74808d },
      nose: { type: 'bulb', size: 1.1 },
      mouth: { w: 1.05, smile: 0.35 },
      cheeks: true, blush: 0.5, wrinkles: 0.35,
    },
    lapelPin: true, tieLoose: true,
    stance: { head: { z: -0.05 }, torso: { x: 0.02 } },
    mass: 1.08, attackPower: 1.02, moveAccel: 12,
    entrance: 'thumbsup',
  },
  bushsr: {
    id: 'bushsr', name: 'Bush Sr.',
    skin: 0xe5c0a0, suit: 0x3b4a63, tie: 0x30549c, tieLength: 0.95,
    hair: 0xbfb8ae, hairStyle: 'comb',
    heightScale: 1.04, buildScale: 0.92, headH: 0.3,
    face: {
      brow: { color: 0x9d9689, thick: 0.85 },
      eyes: { color: 0x5f7a94 },
      nose: { type: 'straight', size: 1.0 },
      mouth: { w: 0.9 },
      wrinkles: 0.6,
    },
    glasses: 'round', lapelPin: true,
    stance: { torso: { x: -0.05 } },
    mass: 0.98, attackPower: 0.98, moveAccel: 13,
    entrance: 'golf',
  },
  reagan: {
    id: 'reagan', name: 'Reagan',
    skin: 0xe0a884, suit: 0x5a3a35, tie: 0x99282e, tieLength: 1.0,
    hair: 0x3d2a1c, hairStyle: 'pompadour', hairShine: true,
    heightScale: 1.02, buildScale: 1.0,
    face: {
      brow: { color: 0x53402e, thick: 1.0 },
      eyes: { color: 0x4c6078 },
      nose: { type: 'straight', size: 1.0 },
      mouth: { w: 1.0, smile: 0.4 },
      chin: 1.1, blush: 0.55, wrinkles: 0.6,
    },
    lapelPin: true,
    stance: { head: { x: -0.04, z: 0.04 }, torso: { x: -0.02 } },
    mass: 1.05, attackPower: 1.08, moveAccel: 12,
    entrance: 'point',
  },
  carter: {
    id: 'carter', name: 'Carter',
    skin: 0xe6bd9d, suit: 0xb59a72, tie: 0x3f7a4d, tieLength: 0.95,
    hair: 0x9c9587, hairStyle: 'sidePart',
    heightScale: 0.99, buildScale: 0.9, headW: 0.245,
    face: {
      brow: { color: 0x8a8378, thick: 0.85 },
      eyes: { color: 0x557089 },
      nose: { type: 'button', size: 1.0 },
      mouth: { w: 1.25, smile: 0.7, teeth: true },
      wrinkles: 0.5,
    },
    cardigan: true,
    stance: { head: { x: 0.04 } },
    mass: 0.92, attackPower: 0.95, moveAccel: 14,
    entrance: 'wave',
  },
  ford: {
    id: 'ford', name: 'Ford',
    skin: 0xe8c2a4, suit: 0x2f3a4a, tie: 0x8f6b2f, tieLength: 0.9,
    hair: 0xcdb98e, hairStyle: 'balding',
    heightScale: 1.05, buildScale: 1.1, shoulderScale: 1.15,
    face: {
      brow: { color: 0xb5a173, thick: 0.95 },
      eyes: { color: 0x5a7590 },
      nose: { type: 'straight', size: 1.05 },
      mouth: { w: 0.95 },
      chin: 1.5, wrinkles: 0.4,
    },
    lapelPin: true,
    stance: { torso: { x: 0.05 }, shoulderL: { z: 0.06 }, shoulderR: { z: -0.06 } },
    mass: 1.15, attackPower: 1.06, moveAccel: 11,
    entrance: 'stumble',
  },
  nixon: {
    id: 'nixon', name: 'Nixon',
    skin: 0xe2b492, suit: 0x23252b, tie: 0x5d6d7e, tieLength: 1.0,
    hair: 0x3a3129, hairStyle: 'widow',
    heightScale: 1.0, buildScale: 1.12, headD: 0.27,
    face: {
      brow: { color: 0x241d15, angle: -0.35, thick: 1.6 },
      eyes: { squint: 0.2, color: 0x3a2f26 },
      nose: { type: 'ski', size: 1.15 },
      mouth: { w: 0.9, frown: 0.35 },
      chin: 1.15, jowls: true, stubble: true, wrinkles: 0.55,
    },
    lapelPin: true,
    stance: { torso: { x: 0.16 }, head: { x: -0.1 }, shoulderL: { z: 0.12 }, shoulderR: { z: -0.12 } },
    mass: 1.2, attackPower: 1.12, moveAccel: 12,
    entrance: 'victory',
  },
  lbj: {
    id: 'lbj', name: 'LBJ',
    skin: 0xe5c19a, suit: 0x2b3e5e, tie: 0xc0392b, tieLength: 1.05,
    hair: 0x6a5a48, hairStyle: 'brushBack',
    heightScale: 1.05, buildScale: 1.18, headW: 0.28, headD: 0.28, earR: 0.058,
    bellyScale: 1.25,
    face: {
      brow: { color: 0x4a3a28, angle: -0.18, thick: 1.25 },
      eyes: { squint: 0.4, color: 0x5a7a96 },
      nose: { type: 'wide', size: 1.1 },
      mouth: { w: 1.05, smile: 0.15 },
      chin: 1.2, wrinkles: 0.5, blush: 0.3,
    },
    lapelPin: true,
    stance: { torso: { x: 0.05 }, head: { z: 0.05 },
              shoulderL: { z: 0.08 }, shoulderR: { z: -0.08 } },
    mass: 1.25, attackPower: 1.18, moveAccel: 9,
    entrance: 'lbjTreatment',
  },
  jfk: {
    id: 'jfk', name: 'JFK',
    skin: 0xefcfa6, suit: 0x1a2a4e, tie: 0x4a7ba8, tieLength: 1.0,
    hair: 0x8a7050, hairStyle: 'bouffant', hairShine: true,
    heightScale: 1.06, buildScale: 0.92,
    face: {
      brow: { color: 0x6a5238, thick: 0.95 },
      eyes: { squint: 0.18, color: 0x6b8aab },
      nose: { type: 'straight', size: 0.95 },
      mouth: { w: 1.05, smile: 0.55, teeth: true },
      chin: 1.05, blush: 0.45, wrinkles: 0.15,
    },
    lapelPin: true,
    stance: { head: { x: 0.05, y: 0.02 }, torso: { x: -0.03 } },
    mass: 0.9, attackPower: 0.98, moveAccel: 14,
    entrance: 'jfkNod',
  },
  eisenhower: {
    id: 'eisenhower', name: 'Eisenhower',
    skin: 0xeec9a8, suit: 0x4a5a6a, tie: 0x8a6028, tieLength: 0.95,
    hair: 0xb0a89a, hairStyle: 'crop', greyTemples: true,
    heightScale: 1.05, buildScale: 1.1, shoulderScale: 1.2,
    face: {
      brow: { color: 0x9a948a, angle: 0.05, thick: 1.05 },
      eyes: { squint: 0.35, color: 0x5e7a92 },
      nose: { type: 'straight', size: 1.0 },
      mouth: { w: 1.0, smile: 0.3 },
      chin: 1.2, wrinkles: 0.5, blush: 0.2,
    },
    lapelPin: true,
    stance: { torso: { x: 0.02 }, shoulderL: { z: 0.05 }, shoulderR: { z: -0.05 },
              head: { x: -0.04 } },
    mass: 1.18, attackPower: 1.15, moveAccel: 10,
    entrance: 'eisenhowerSalute',
  },
  truman: {
    id: 'truman', name: 'Truman',
    skin: 0xeec5a0, suit: 0x3a3f4a, tie: 0x8a7a5a, tieLength: 0.95,
    hair: 0xa8a099, hairStyle: 'balding',
    heightScale: 0.98, buildScale: 0.95, headW: 0.255,
    face: {
      brow: { color: 0x7a7468, thick: 0.95 },
      eyes: { squint: 0.4, color: 0x6080a0 },
      nose: { type: 'straight', size: 0.9 },
      mouth: { w: 1.1, smile: 0.5, teeth: true },
      cheeks: true, blush: 0.4, wrinkles: 0.4,
    },
    glasses: 'round', lapelPin: true,
    stance: { head: { x: 0.05 }, torso: { x: -0.02 } },
    mass: 0.94, attackPower: 1.05, moveAccel: 13,
    entrance: 'giveEmHell',
  },
  fdr: {
    id: 'fdr', name: 'FDR',
    skin: 0xe6bea0, suit: 0x1c2538, tie: 0x4a5a8a, tieLength: 1.1,
    hair: 0xe8e4dc, hairStyle: 'combBack', hairShine: true,
    heightScale: 1.1, buildScale: 0.95,
    face: {
      brow: { color: 0xb0aea6, thick: 0.9 },
      eyes: { squint: 0.3, color: 0x6c8aa8 },
      nose: { type: 'straight', size: 1.0 },
      mouth: { w: 0.95, smile: 0.45 },
      chin: 1.15, wrinkles: 0.55, blush: 0.2,
    },
    glasses: 'round', lapelPin: true,
    stance: { head: { x: 0.04, y: 0.03 }, torso: { x: -0.04 } },
    mass: 0.96, attackPower: 1.1, moveAccel: 12,
    entrance: 'fdrCane',
  },
  // BOB — the 1-player everyman hero, built with `outfit: 'casual'` (no suit).
  bob: {
    id: 'bob', name: 'BOB',
    skin: 0xdfae8f, hair: 0x5a3d24, hairStyle: 'spiky',
    outfit: 'casual', shirtColor: 0xe9e6de, jeans: 0x3566a8, sneaker: 0xf0f0ee,
    heightScale: 1.0, buildScale: 1.0,
    face: {
      brow: { color: 0x4a3320, thick: 1.0 },
      eyes: { color: 0x4a3a28 },
      nose: { type: 'button', size: 1.0 },
      mouth: { w: 1.0, smile: 0.3 },
    },
    mass: 1.0, attackPower: 1.0, moveAccel: 12,
    entrance: 'ready',
  },
};

export const CHARACTER_IDS = Object.keys(CHARACTERS);

// ── Color helpers (canvas painting) ────────────────────────────────────────
function cssHex(hex) {
  return `#${hex.toString(16).padStart(6, '0')}`;
}
// f > 0 lightens toward white, f < 0 darkens toward black.
function shade(hex, f) {
  const r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
  const t = f < 0 ? 0 : 255, a = Math.abs(f);
  const m = (ch) => Math.round(ch + (t - ch) * a);
  return `rgb(${m(r)},${m(g)},${m(b)})`;
}
function mixHex(h1, h2, t) {
  const r = Math.round(((h1 >> 16) & 255) + ((((h2 >> 16) & 255)) - ((h1 >> 16) & 255)) * t);
  const g = Math.round(((h1 >> 8) & 255) + ((((h2 >> 8) & 255)) - ((h1 >> 8) & 255)) * t);
  const b = Math.round((h1 & 255) + ((h2 & 255) - (h1 & 255)) * t);
  return (r << 16) | (g << 8) | b;
}

// Rounded boxes read as tailored cloth instead of voxels; the bevel also
// catches the rim light so limb silhouettes separate from the suit body.
function box(w, h, d, mat) {
  const r = Math.min(w, h, d) * 0.24;
  const m = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 2, r), mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

// Capsules for limbs — organic volumes instead of boxes.
function capsule(r, len, mat) {
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 3, 10), mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

// Elliptical tapered cylinder for the torso masses.
function taper(rTop, rBottom, h, mat, zScale = 0.74) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rTop, rBottom, h, 14), mat);
  m.scale.z = zScale;
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function sphere(r, mat) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 12, 10), mat);
  m.castShadow = true;
  return m;
}

// Procedural suit-fabric weave: fine warp/weft lines + noise. Shared by all
// suits as both roughnessMap (sheen variation) and bumpMap (thread relief).
let _weaveTex = null;
function weaveTexture() {
  if (_weaveTex) return _weaveTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const img = g.createImageData(64, 64);
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      const i = (y * 64 + x) * 4;
      const warp = (x % 4 < 2) ? 18 : 0;   // vertical threads
      const weft = (y % 4 < 2) ? 14 : 0;   // horizontal threads
      const noise = Math.floor(Math.random() * 36);
      const v = 165 + warp + weft + noise - 34;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  _weaveTex = new THREE.CanvasTexture(c);
  _weaveTex.wrapS = _weaveTex.wrapT = THREE.RepeatWrapping;
  _weaveTex.repeat.set(2, 2);
  return _weaveTex;
}

// Subtle pore/blotch noise for skin roughness.
let _skinTex = null;
function skinNoiseTexture() {
  if (_skinTex) return _skinTex;
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  const img = g.createImageData(32, 32);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 175 + Math.floor(Math.random() * 80);
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  _skinTex = new THREE.CanvasTexture(c);
  _skinTex.wrapS = _skinTex.wrapT = THREE.RepeatWrapping;
  return _skinTex;
}

// ── Procedural normal maps ──────────────────────────────────────────────────
// Tangent-space normal maps Sobel-derived from a height field, so detail
// catches directional light. Kept linear (no sRGB): data, not colour.
function normalFromHeight(size, heightFn, strength) {
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      h[y * size + x] = heightFn(x, y);
  const at = (x, y) => h[((y + size) % size) * size + ((x + size) % size)];
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Sobel gradient → tangent-space normal.
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      img.data[i]     = ((-dx / len) * 0.5 + 0.5) * 255;
      img.data[i + 1] = ((-dy / len) * 0.5 + 0.5) * 255;
      img.data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// Fabric weave normal: raised warp/weft threads (matches weaveTexture's pattern)
// so the cloth micro-relief tilts light along the thread grid.
let _weaveNormalTex = null;
function weaveNormalTexture() {
  if (_weaveNormalTex) return _weaveNormalTex;
  _weaveNormalTex = normalFromHeight(64, (x, y) => {
    const warp = (x % 4 < 2) ? 0.6 : 0.0;
    const weft = (y % 4 < 2) ? 0.5 : 0.0;
    const noise = Math.random() * 0.15;
    return warp + weft + noise;
  }, 2.2);
  _weaveNormalTex.repeat.set(2, 2);
  return _weaveNormalTex;
}

// Skin pore normal: fine high-frequency bumps at low strength — enough to
// scatter the sheen highlight without looking like orange peel.
let _skinNormalTex = null;
function skinNormalTexture() {
  if (_skinNormalTex) return _skinNormalTex;
  _skinNormalTex = normalFromHeight(64, () => Math.random(), 0.7);
  _skinNormalTex.repeat.set(3, 3);
  return _skinNormalTex;
}

// Tiny pixel US flag for the lapel pins (NearestFilter keeps the stripes crisp).
let _flagTex = null;
function flagTexture() {
  if (_flagTex) return _flagTex;
  const c = document.createElement('canvas');
  c.width = 24; c.height = 16;
  const g = c.getContext('2d');
  for (let i = 0; i < 7; i++) {
    g.fillStyle = i % 2 === 0 ? '#b22234' : '#f5f2ec';
    g.fillRect(0, Math.round(i * 16 / 7), 24, Math.ceil(16 / 7));
  }
  g.fillStyle = '#3c3b6e';
  g.fillRect(0, 0, 10, 9);
  g.fillStyle = '#f5f2ec';
  for (const [x, y] of [[2, 2], [6, 2], [4, 4], [2, 6], [6, 6]]) g.fillRect(x, y, 1, 1);
  _flagTex = new THREE.CanvasTexture(c);
  _flagTex.colorSpace = THREE.SRGBColorSpace;
  _flagTex.magFilter = THREE.NearestFilter;
  return _flagTex;
}

// ── Painted face detail ────────────────────────────────────────────────────
// A per-president canvas: base face tone, cheek blush, Trump's pale "goggle"
// tan lines, forehead/crow's-feet/nasolabial wrinkles, Nixon's five-o'clock
// shadow. Mapped onto a thin plate over the front of the skull; the 3D
// features (nose/brows/eyes/mouth) sit on top of it.
const _faceTexCache = new Map();
function faceDetailTexture(c) {
  if (_faceTexCache.has(c.id)) return _faceTexCache.get(c.id);
  const f = c.face || {};
  const S = 128;
  const W = (c.headW ?? 0.26) * 0.92;
  const H = (c.headH ?? 0.28) * 0.94;
  const y0 = 0.16 - H / 2;
  // Head-local coords → canvas pixels (y up → canvas y down).
  const px = (x) => (x / W + 0.5) * S;
  const py = (y) => (1 - (y - y0) / H) * S;

  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const base = c.faceTint ?? c.skin;
  g.fillStyle = cssHex(base);
  g.fillRect(0, 0, S, S);

  // Fine tonal grain so the plate doesn't read as a flat sticker.
  for (let i = 0; i < 260; i++) {
    g.fillStyle = shade(base, (Math.random() - 0.5) * 0.16);
    g.globalAlpha = 0.16;
    g.fillRect(Math.random() * S, Math.random() * S, 2, 2);
  }
  g.globalAlpha = 1;

  const eyeY = 0.195, eyeX = 0.062, mouthY = 0.085;

  // Trump's goggle tan: pale rings where the tanning bed didn't reach.
  if (f.tanLines) {
    g.fillStyle = shade(base, 0.32);
    g.globalAlpha = 0.85;
    for (const s of [-1, 1]) {
      g.beginPath();
      g.ellipse(px(s * eyeX), py(eyeY), S * 0.14, S * 0.1, 0, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
  }

  // Cheek blush (Clinton/Reagan ruddiness, a touch on Trump).
  if (f.blush) {
    for (const s of [-1, 1]) {
      const cx = px(s * 0.075), cy = py(0.13);
      const rg = g.createRadialGradient(cx, cy, 2, cx, cy, S * 0.13);
      rg.addColorStop(0, `rgba(196,84,72,${0.4 * f.blush})`);
      rg.addColorStop(1, 'rgba(196,84,72,0)');
      g.fillStyle = rg;
      g.fillRect(0, 0, S, S);
    }
  }

  // Age wrinkles: forehead creases, crow's feet, nasolabial folds.
  const wr = f.wrinkles ?? 0;
  if (wr > 0) {
    g.strokeStyle = shade(base, -0.32);
    g.lineWidth = 1.4;
    g.globalAlpha = 0.28 * wr;
    for (const fy of [0.255, 0.275]) {
      g.beginPath();
      g.moveTo(px(-0.075), py(fy));
      g.quadraticCurveTo(px(0), py(fy + 0.012), px(0.075), py(fy));
      g.stroke();
    }
    for (const s of [-1, 1]) {
      for (let i = 0; i < 3; i++) {
        g.beginPath();
        g.moveTo(px(s * (eyeX + 0.035)), py(eyeY + 0.01 - i * 0.012));
        g.lineTo(px(s * (eyeX + 0.058)), py(eyeY + 0.022 - i * 0.016));
        g.stroke();
      }
      // Nasolabial: nose wing down to the mouth corner.
      g.beginPath();
      g.moveTo(px(s * 0.028), py(0.155));
      g.quadraticCurveTo(px(s * 0.06), py(0.125), px(s * 0.055), py(mouthY + 0.008));
      g.stroke();
    }
    g.globalAlpha = 1;
  }

  // Nixon's five-o'clock shadow: speckled darkening over the jaw and upper lip.
  if (f.stubble) {
    g.fillStyle = shade(base, -0.42);
    for (let i = 0; i < 900; i++) {
      const x = Math.random() * S;
      const y = Math.random() * S;
      const ly = 1 - y / S;                     // 0 bottom → 1 top (v space)
      const yy = y0 + ly * H;                   // head-local y
      const jaw = yy < mouthY - 0.01;
      const lip = yy > mouthY + 0.012 && yy < 0.145 && Math.abs(x / S - 0.5) < 0.22;
      const sideburn = yy < eyeY && Math.abs(x / S - 0.5) > 0.4;
      if (!jaw && !lip && !sideburn) continue;
      g.globalAlpha = 0.16 + Math.random() * 0.18;
      g.fillRect(x, y, 1.4, 1.4);
    }
    g.globalAlpha = 1;
  }

  // Soft shading down the jaw sides so the flat plate reads as curvature.
  for (const s of [-1, 1]) {
    const cx = px(s * 0.115), cy = py(0.05);
    const rg = g.createRadialGradient(cx, cy, 2, cx, cy, S * 0.2);
    rg.addColorStop(0, 'rgba(40,20,12,0.14)');
    rg.addColorStop(1, 'rgba(40,20,12,0)');
    g.fillStyle = rg;
    g.fillRect(0, 0, S, S);
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  _faceTexCache.set(c.id, tex);
  return tex;
}

// ── Bespoke hair ───────────────────────────────────────────────────────────
// One silhouette per president — hair is the strongest identity read at
// gameplay distance, so each style is built specifically rather than shared.
// All coordinates are head-local; dims carries the per-president skull size.
function buildHair(c, hairMat, dims) {
  const g = new THREE.Group();
  const { w, d, topY, hw } = dims;
  const style = c.hairStyle;

  if (style === 'trumpSweep') {
    // The signature sweep: a tall crown, a big front lip overhanging the
    // forehead and swept sideways, side wings brushed back over the ears.
    const crown = box(w + 0.02, 0.085, d + 0.02, hairMat);
    crown.position.set(0, topY + 0.03, -0.005);
    const swoop = box(w + 0.015, 0.06, 0.16, hairMat);
    swoop.position.set(0.012, topY + 0.022, d / 2 - 0.012);
    swoop.rotation.set(-0.22, 0.12, -0.06);
    g.add(crown, swoop);
    for (const s of [-1, 1]) {
      const wing = box(0.05, 0.07, d * 0.8, hairMat);
      wing.position.set(s * (hw + 0.012), topY - 0.045, -0.012);
      wing.rotation.y = -s * 0.15;
      g.add(wing);
    }
    const back = box(w * 0.9, 0.075, 0.05, hairMat);
    back.position.set(0, topY - 0.03, -(d / 2) - 0.006);
    g.add(back);
  } else if (style === 'combover') {
    // Biden: thin white hair slicked straight back off a high hairline.
    const top = box(w * 0.94, 0.035, d * 0.82, hairMat);
    top.position.set(0, topY + 0.008, -0.03);
    const strip = box(0.1, 0.028, 0.07, hairMat);
    strip.position.set(0, topY + 0.004, d / 2 - 0.1);
    g.add(top, strip);
    for (const s of [-1, 1]) {
      const side = box(0.032, 0.08, d * 0.7, hairMat);
      side.position.set(s * (hw + 0.004), topY - 0.055, -0.015);
      g.add(side);
    }
    const back = box(w * 0.88, 0.06, 0.032, hairMat);
    back.position.set(0, topY - 0.03, -(d / 2) - 0.004);
    g.add(back);
  } else if (style === 'crop') {
    // Obama: tight crop hugging the skull; grey patches at the temples.
    const cap = box(w + 0.012, 0.045, d + 0.012, hairMat);
    cap.position.set(0, topY + 0.012, -0.004);
    const back = box(w * 0.95, 0.06, 0.035, hairMat);
    back.position.set(0, topY - 0.02, -(d / 2) - 0.004);
    g.add(cap, back);
    if (c.greyTemples) {
      const greyMat = new THREE.MeshStandardMaterial({
        color: 0x9a9a9a, roughness: 0.85, metalness: 0.0,
      });
      for (const s of [-1, 1]) {
        const temple = box(0.028, 0.05, 0.05, greyMat);
        temple.position.set(s * (hw + 0.006), topY - 0.045, 0.045);
        g.add(temple);
      }
    }
  } else if (style === 'sidePart') {
    // Bush/Carter: full head of hair with a visible side part — the main
    // mass sits right of the part line, a thinner flat panel to its left.
    const main = box(w * 0.72, 0.06, d, hairMat);
    main.position.set(0.038, topY + 0.02, -0.005);
    const flat = box(w * 0.34, 0.038, d * 0.94, hairMat);
    flat.position.set(-0.075, topY + 0.008, -0.005);
    g.add(main, flat);
    for (const s of [-1, 1]) {
      const side = box(0.04, 0.08, d * 0.78, hairMat);
      side.position.set(s * (hw + 0.006), topY - 0.05, -0.01);
      g.add(side);
    }
    const back = box(w * 0.92, 0.08, 0.04, hairMat);
    back.position.set(0, topY - 0.035, -(d / 2) - 0.005);
    g.add(back);
  } else if (style === 'silverSweep') {
    // Clinton: big soft silver volume swept up and back off the forehead.
    const puff = box(w + 0.03, 0.1, d + 0.02, hairMat);
    puff.position.set(0, topY + 0.045, -0.012);
    const wave = box(w * 0.9, 0.075, 0.09, hairMat);
    wave.position.set(0, topY + 0.038, d / 2 - 0.03);
    wave.rotation.x = -0.15;
    g.add(puff, wave);
    for (const s of [-1, 1]) {
      const side = box(0.045, 0.075, d * 0.8, hairMat);
      side.position.set(s * (hw + 0.015), topY - 0.03, -0.01);
      g.add(side);
    }
  } else if (style === 'pompadour') {
    // Reagan: tall glossy front wave rolling back into a slick crown.
    const wave = box(w * 0.96, 0.1, 0.11, hairMat);
    wave.position.set(0, topY + 0.045, d / 2 - 0.075);
    wave.rotation.x = -0.12;
    const crown = box(w * 0.98, 0.06, d * 0.7, hairMat);
    crown.position.set(0, topY + 0.02, -0.05);
    g.add(wave, crown);
    for (const s of [-1, 1]) {
      const side = box(0.04, 0.08, d * 0.75, hairMat);
      side.position.set(s * (hw + 0.008), topY - 0.04, -0.02);
      side.rotation.y = -s * 0.2;
      g.add(side);
    }
    const back = box(w * 0.9, 0.08, 0.04, hairMat);
    back.position.set(0, topY - 0.03, -(d / 2) - 0.005);
    g.add(back);
  } else if (style === 'comb') {
    // Bush Sr.: thin combed layer set well back — a high patrician forehead.
    const top = box(w * 0.9, 0.05, d * 0.75, hairMat);
    top.position.set(0, topY + 0.01, -0.045);
    g.add(top);
    for (const s of [-1, 1]) {
      const side = box(0.03, 0.07, d * 0.65, hairMat);
      side.position.set(s * (hw + 0.004), topY - 0.05, -0.02);
      g.add(side);
    }
  } else if (style === 'balding') {
    // Ford: bare crown; hair only above the ears and around the back.
    for (const s of [-1, 1]) {
      const side = box(0.05, 0.09, d * 0.77, hairMat);
      side.position.set(s * (hw + 0.005), topY - 0.06, -0.02);
      g.add(side);
    }
    const back = box(w + 0.02, 0.09, 0.05, hairMat);
    back.position.set(0, topY - 0.06, -(d / 2) - 0.005);
    g.add(back);
  } else if (style === 'widow') {
    // Nixon: full dark hair with the widow's-peak wedge down the brow.
    const top = box(w + 0.01, 0.07, d * 0.95, hairMat);
    top.position.set(0, topY + 0.022, -0.015);
    const peak = box(0.07, 0.04, 0.06, hairMat);
    peak.position.set(0, topY - 0.01, d / 2 - 0.008);
    peak.rotation.x = 0.35;
    g.add(top, peak);
    for (const s of [-1, 1]) {
      const side = box(0.04, 0.085, d * 0.8, hairMat);
      side.position.set(s * (hw + 0.005), topY - 0.05, -0.015);
      g.add(side);
    }
  } else if (style === 'brushBack') {
    // LBJ: thick brown hair brushed straight back off a high forehead, with
    // a slight upward roll at the front and brushed-down sides hugging the
    // temples. Reads as a working-statesman helmet of hair.
    const crown = box(w + 0.015, 0.07, d * 0.9, hairMat);
    crown.position.set(0, topY + 0.02, -0.025);
    const roll = box(w * 0.85, 0.035, 0.06, hairMat);
    roll.position.set(0, topY + 0.04, d / 2 - 0.04);
    roll.rotation.x = -0.45;
    g.add(crown, roll);
    for (const s of [-1, 1]) {
      const side = box(0.045, 0.085, d * 0.75, hairMat);
      side.position.set(s * (hw + 0.008), topY - 0.04, -0.015);
      side.rotation.z = -s * 0.08;
      g.add(side);
    }
    const back = box(w * 0.92, 0.075, 0.05, hairMat);
    back.position.set(0, topY - 0.04, -(d / 2) - 0.005);
    g.add(back);
  } else if (style === 'bouffant') {
    // JFK: tall thick hair lifted up and swept back from the forehead, with
    // a wide rolling front wave. Sides brushed down to hug the ears — the
    // unmistakable early-1960s Kennedy silhouette.
    const puff = box(w + 0.04, 0.115, d + 0.03, hairMat);
    puff.position.set(0, topY + 0.05, -0.02);
    const wave = box(w * 0.95, 0.085, 0.13, hairMat);
    wave.position.set(0, topY + 0.04, d / 2 - 0.05);
    wave.rotation.x = -0.2;
    g.add(puff, wave);
    for (const s of [-1, 1]) {
      const side = box(0.05, 0.095, d * 0.85, hairMat);
      side.position.set(s * (hw + 0.012), topY - 0.025, -0.012);
      side.rotation.z = -s * 0.05;
      g.add(side);
    }
    const back = box(w + 0.02, 0.1, 0.055, hairMat);
    back.position.set(0, topY - 0.03, -(d / 2) - 0.006);
    g.add(back);
  } else if (style === 'combBack') {
    // FDR: thin, distinguished silver hair combed straight back from a
    // moderate hairline. Short at the temples, slightly longer on top,
    // a small tidy wave at the forehead. The "New England aristocrat".
    const top = box(w * 0.95, 0.055, d * 0.85, hairMat);
    top.position.set(0, topY + 0.018, -0.035);
    top.rotation.x = -0.05;
    const brow = box(w * 0.9, 0.03, 0.05, hairMat);
    brow.position.set(0, topY + 0.005, d / 2 - 0.045);
    brow.rotation.x = -0.55;
    g.add(top, brow);
    for (const s of [-1, 1]) {
      const side = box(0.03, 0.07, d * 0.6, hairMat);
      side.position.set(s * (hw + 0.004), topY - 0.05, -0.02);
      g.add(side);
    }
  } else if (style === 'spiky') {
    // Messy tufts at varying angles — reads as "regular guy", not a statesman.
    const base = box(w + 0.03, 0.07, d + 0.03, hairMat);
    base.position.y = topY + 0.02;
    g.add(base);
    const tufts = [
      [-0.09, 0.065, 0.05, 0.3], [0.02, 0.075, -0.04, -0.25],
      [0.1, 0.06, 0.07, 0.4], [-0.02, 0.07, 0.1, -0.35], [0.06, 0.065, -0.1, 0.2],
    ];
    for (const [x, dy, z, rz] of tufts) {
      const tuft = box(0.07, 0.09, 0.07, hairMat);
      tuft.position.set(x, topY + dy, z);
      tuft.rotation.z = rz;
      tuft.rotation.x = rz * -0.6;
      g.add(tuft);
    }
  } else {
    const top = box(w + 0.02, 0.07, d + 0.02, hairMat);
    top.position.y = topY + 0.025;
    const back = box(w + 0.02, 0.1, 0.06, hairMat);
    back.position.set(0, topY - 0.02, -(d / 2));
    g.add(top, back);
  }
  return g;
}

// ── Facial features ────────────────────────────────────────────────────────
// Parameterized primitives on the front of the skull. Returns the mouth
// expression groups so the engine can swap neutral/hurt/grin at runtime.
function buildFace(c, head, mats, dims) {
  const f = c.face || {};
  const zF = dims.d / 2;
  const { faceMat, skinMat } = mats;

  // Painted detail plate (tan lines, blush, wrinkles, stubble).
  const plateMat = new THREE.MeshStandardMaterial({
    map: faceDetailTexture(c), roughness: 0.6, metalness: 0.0,
  });
  const plate = new THREE.Mesh(
    new THREE.PlaneGeometry(dims.w * 0.92, dims.h * 0.94), plateMat);
  plate.position.set(0, 0.16, zF + 0.004);
  head.add(plate);

  // Eyes: matte sclera half-embedded in the face, glossy dark iris/pupil
  // that catches the key light — the highlight is what makes them read alive.
  const eyes = f.eyes || {};
  const squint = eyes.squint ?? 0.15;
  const scleraMat = new THREE.MeshStandardMaterial({
    color: 0xf4f1ea, roughness: 0.45, metalness: 0.0,
  });
  const irisMat = new THREE.MeshStandardMaterial({
    color: mixHex(eyes.color ?? 0x3a2e22, 0x000000, 0.25),
    roughness: 0.12, metalness: 0.1,
  });
  for (const s of [-1, 1]) {
    const sclera = sphere(0.032, scleraMat);
    sclera.scale.set(1, 0.75 * (1 - squint * 0.5), 0.5);
    sclera.position.set(s * 0.062, 0.195, zF - 0.004);
    const pupil = sphere(0.0135, irisMat);
    pupil.scale.y = Math.max(0.4, 1 - squint * 0.7);
    pupil.position.set(s * 0.06, 0.195, zF + 0.009);
    head.add(sclera, pupil);
  }

  // Brows: the angle carries the personality — Nixon's stern inner-down
  // slabs vs. Bush's amused raise.
  const brow = f.brow || {};
  const browMat = new THREE.MeshStandardMaterial({
    color: brow.color ?? mixHex(c.hair, 0x000000, 0.35), roughness: 0.9,
  });
  const bThick = brow.thick ?? 1;
  for (const s of [-1, 1]) {
    const b = box(0.075 * (brow.w ?? 1), 0.017 * bThick, 0.02, browMat);
    b.position.set(s * 0.063, 0.243, zF);
    // angle < 0: inner ends drop toward the nose (stern). angle > 0: raised.
    b.rotation.z = s * (brow.angle ?? 0);
    head.add(b);
  }

  // Nose: the caricature anchor. A rotated group tips the bridge out of the
  // face; the tip sphere inherits the group transform.
  const nose = f.nose || {};
  const nSize = nose.size ?? 1;
  const noseG = new THREE.Group();
  noseG.position.set(0, 0.198, zF - 0.005);
  if (nose.type === 'button') {
    const tip = sphere(0.018 * nSize, faceMat);
    tip.position.set(0, -0.045, 0.018);
    noseG.add(tip);
  } else {
    const type = nose.type ?? 'straight';
    const wide = type === 'wide';
    const bridge = capsule((wide ? 0.02 : 0.016) * nSize, 0.06, faceMat);
    bridge.position.y = -0.033;
    noseG.add(bridge);
    let tip;
    if (type === 'ski') {
      // Nixon: the bridge juts out hard and the tip turns up.
      noseG.rotation.x = 0.65;
      tip = sphere(0.02 * nSize, faceMat);
      tip.scale.set(1, 0.9, 1.15);
      tip.position.set(0, -0.07, 0.012);
    } else if (type === 'bulb') {
      noseG.rotation.x = 0.42;
      tip = sphere(0.028 * nSize, faceMat);
      tip.position.set(0, -0.068, 0.005);
    } else if (wide) {
      noseG.rotation.x = 0.45;
      tip = sphere(0.021 * nSize, faceMat);
      tip.scale.set(1.5, 0.85, 1);
      tip.position.set(0, -0.068, 0.005);
    } else {
      noseG.rotation.x = 0.5;
      tip = sphere(0.019 * nSize, faceMat);
      tip.position.set(0, -0.068, 0.005);
    }
    noseG.add(tip);
  }
  head.add(noseG);

  // Mouth: three swappable expression groups. The engine toggles visibility
  // via setExpression — neutral at rest, hurt on hits/KO, grin on the win.
  const m = f.mouth || {};
  const mw = m.w ?? 1;
  const mouthY = 0.085;
  const mx = m.smirk ? 0.016 : 0;
  const lipMat = new THREE.MeshStandardMaterial({
    color: mixHex(c.faceTint ?? c.skin, 0x7a3a34, 0.65), roughness: 0.6,
  });
  const toothMat = new THREE.MeshStandardMaterial({
    color: 0xf2eee4, roughness: 0.35,
  });
  const innerMat = new THREE.MeshStandardMaterial({
    color: 0x431a17, roughness: 0.7,
  });

  const neutral = new THREE.Group();
  {
    const lip = box(0.11 * mw, 0.016, 0.014, lipMat);
    lip.position.set(mx, mouthY, zF);
    if (m.smirk) lip.rotation.z = 0.09;
    neutral.add(lip);
    const bend = (m.smile ?? 0) - (m.frown ?? 0);
    if (bend !== 0) {
      // Corner segments tilt up for a smile, down for a frown/purse.
      for (const s of [-1, 1]) {
        const corner = box(0.026, 0.013, 0.012, lipMat);
        corner.position.set(mx + s * 0.058 * mw, mouthY + 0.008 * bend, zF);
        corner.rotation.z = -s * 0.32 * bend;
        neutral.add(corner);
      }
    }
    if (m.teeth && (m.smile ?? 0) > 0.3) {
      // The Carter/Biden flash of teeth under the smile line.
      const teeth = box(0.08 * mw, 0.017, 0.011, toothMat);
      teeth.position.set(mx, mouthY - 0.013, zF - 0.001);
      neutral.add(teeth);
    }
  }

  const hurt = new THREE.Group();
  {
    const open = box(0.055, 0.05, 0.018, innerMat);
    open.position.set(0, mouthY - 0.006, zF - 0.002);
    const lipTop = box(0.08, 0.013, 0.013, lipMat);
    lipTop.position.set(0, mouthY + 0.022, zF);
    hurt.add(open, lipTop);
    hurt.visible = false;
  }

  const grin = new THREE.Group();
  {
    const teeth = box(0.105 * Math.max(mw, 1), 0.026, 0.014, toothMat);
    teeth.position.set(0, mouthY, zF);
    grin.add(teeth);
    for (const s of [-1, 1]) {
      const corner = box(0.026, 0.013, 0.012, lipMat);
      corner.position.set(s * 0.062 * Math.max(mw, 1), mouthY + 0.012, zF);
      corner.rotation.z = -s * 0.38;
      grin.add(corner);
    }
    grin.visible = false;
  }
  head.add(neutral, hurt, grin);

  // Chin/jaw mass — Ford's slab jaw, Nixon's heavy chin.
  const chinScale = f.chin ?? 1;
  if (chinScale > 0) {
    const chin = sphere(0.026 * chinScale, faceMat);
    chin.scale.set(1.35, 0.75, 0.8);
    chin.position.set(0, 0.028, zF - 0.008);
    head.add(chin);
  }
  // Nixon's jowls: cheek masses sagging beside the mouth, on a shared pivot
  // so the jiggle solver can quiver them on impacts.
  let jowlPivot = null;
  if (f.jowls) {
    jowlPivot = new THREE.Group();
    jowlPivot.position.set(0, 0.07, zF - 0.008);
    for (const s of [-1, 1]) {
      const jowl = sphere(0.03, faceMat);
      jowl.scale.set(1, 1.2, 0.75);
      jowl.position.set(s * 0.092, 0, 0);
      jowlPivot.add(jowl);
    }
    head.add(jowlPivot);
  }
  // Round cheek volumes (Clinton, Trump).
  if (f.cheeks) {
    for (const s of [-1, 1]) {
      const cheek = sphere(0.034, faceMat);
      cheek.scale.set(1, 0.9, 0.6);
      cheek.position.set(s * 0.078, 0.135, zF - 0.008);
      head.add(cheek);
    }
  }

  // Bush Sr.'s round wire glasses — open rings so the eyes show through.
  if (c.glasses === 'round') {
    const wireMat = new THREE.MeshStandardMaterial({
      color: 0xb9975b, roughness: 0.3, metalness: 0.8,
    });
    for (const s of [-1, 1]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.041, 0.006, 8, 20), wireMat);
      ring.position.set(s * 0.062, 0.195, zF + 0.008);
      head.add(ring);
      const arm = box(0.006, 0.006, 0.11, wireMat);
      arm.position.set(s * 0.115, 0.2, zF - 0.055);
      head.add(arm);
    }
    const bridge = box(0.032, 0.008, 0.008, wireMat);
    bridge.position.set(0, 0.205, zF + 0.008);
    head.add(bridge);
  }

  return { plateMat, mouths: { neutral, hurt, grin }, jowlPivot };
}

// Swap the visible mouth expression: 'neutral' | 'hurt' | 'grin'.
export function setExpression(rig, name) {
  const m = rig.refs && rig.refs.mouths;
  if (!m) return;
  const pick = m[name] ? name : 'neutral';
  for (const k of Object.keys(m)) m[k].visible = (k === pick);
}

/**
 * Builds one fighter rig. Returns { root, joints, materials, config, baseColors }.
 * @param {string} charId
 * @param {{physicalMaterials?: boolean}} [quality]
 *        physicalMaterials: false swaps the whole wardrobe from
 *        MeshPhysicalMaterial to MeshStandardMaterial. See `dress()` below.
 */
export function buildFighter(charId, quality = {}) {
  const c = CHARACTERS[charId];
  // Wardrobe material tier: sheen/clearcoat each add a BRDF lobe per fragment
  // per light, so lower tiers use MeshStandardMaterial. One construction path
  // either way; _applyDamageWear's later `clearcoat` writes are inert on a
  // standard material, but the constructor warns on unknown keys, so the
  // physical-only keys are dropped here.
  const physical = quality.physicalMaterials !== false;
  const dress = (params) => {
    if (physical) return new THREE.MeshPhysicalMaterial(params);
    const { sheen, sheenRoughness, sheenColor, clearcoat, clearcoatRoughness, ...standard } = params;
    return new THREE.MeshStandardMaterial(standard);
  };
  const b = c.buildScale;
  const casual = c.outfit === 'casual';
  // Caricature ratios layered on the base build.
  const belly = c.bellyScale ?? 1;
  const shoulderS = c.shoulderScale ?? 1;
  const dims = {
    w: c.headW ?? 0.26, h: c.headH ?? 0.28, d: c.headD ?? 0.26,
  };
  dims.hw = dims.w / 2;
  dims.topY = 0.16 + dims.h / 2;

  // For a casual outfit the "suit" material is the t-shirt (the engine's
  // sweat/tint systems talk to materials.suitMat, so the torso material must
  // keep that name regardless of wardrobe), and the legs get denim instead.
  // `sheen` gives fabric its grazing-angle glow; `clearcoat` gives polished
  // hair and dress shoes a second specular lobe.
  const suitMat = dress({
    color: casual ? c.shirtColor : c.suit,
    roughness: casual ? 0.9 : 0.95, metalness: casual ? 0.0 : 0.05,
    sheen: casual ? 0.3 : 0.55, sheenRoughness: 0.75,
    sheenColor: new THREE.Color(casual ? c.shirtColor : c.suit).lerp(new THREE.Color(0xffffff), 0.35),
    roughnessMap: weaveTexture(),
    normalMap: weaveNormalTexture(),
    normalScale: new THREE.Vector2(casual ? 0.35 : 0.7, casual ? 0.35 : 0.7),
  });
  const legMat = casual
    ? dress({
        color: c.jeans, roughness: 0.98, metalness: 0.0,
        sheen: 0.25, sheenRoughness: 0.9,
        sheenColor: new THREE.Color(c.jeans).lerp(new THREE.Color(0xffffff), 0.3),
        roughnessMap: weaveTexture(),
        normalMap: weaveNormalTexture(),
        normalScale: new THREE.Vector2(0.9, 0.9),
      })
    : suitMat;
  // Skin: a warm reddish sheen fakes subsurface scattering at grazing angles;
  // the pore normal breaks up the highlight.
  const skinMat = dress({
    color: c.skin, roughness: 0.55, metalness: 0.0,
    sheen: 0.32, sheenRoughness: 0.5, sheenColor: new THREE.Color(0xff7a55),
    roughnessMap: skinNoiseTexture(),
    normalMap: skinNormalTexture(),
    normalScale: new THREE.Vector2(0.35, 0.35),
    // Near-zero, not 0, so the clearcoat lobe is compiled in up front and
    // _applyDamageWear can ramp it with sweat without a recompile.
    clearcoat: 0.001, clearcoatRoughness: 0.28,
  });
  // Face-only skin: lets Trump's face run oranger than his hands.
  const faceMat = c.faceTint
    ? dress({
        color: c.faceTint ?? c.skin, roughness: 0.55, metalness: 0.0,
        sheen: 0.32, sheenRoughness: 0.5, sheenColor: new THREE.Color(0xff7a55),
        roughnessMap: skinNoiseTexture(),
        normalMap: skinNormalTexture(),
        normalScale: new THREE.Vector2(0.3, 0.3),
        clearcoat: 0.001, clearcoatRoughness: 0.28,
      })
    : skinMat;
  // Silk tie: strong anisotropic-looking sheen is what reads as silk.
  const tieMat = dress({
    color: c.tie ?? c.jeans ?? 0x444444, roughness: 0.5, metalness: 0.0,
    sheen: 0.8, sheenRoughness: 0.35,
    sheenColor: new THREE.Color(c.tie ?? c.jeans ?? 0x444444).lerp(new THREE.Color(0xffffff), 0.5),
    normalMap: weaveNormalTexture(),
    normalScale: new THREE.Vector2(0.35, 0.35),
  });
  const hairMat = dress({
    color: c.hair, roughness: c.hairShine ? 0.45 : 0.85, metalness: 0.0,
    clearcoat: c.hairShine ? 0.7 : 0.12, clearcoatRoughness: 0.35,
  });
  const shoeMat = dress({
    color: casual ? c.sneaker : 0x111111,
    roughness: casual ? 0.7 : 0.35, metalness: 0.05,
    clearcoat: casual ? 0.0 : 0.55, clearcoatRoughness: 0.25,
  });
  const shirtMat = new THREE.MeshStandardMaterial({
    color: 0xf5f5f0, roughness: 0.85, metalness: 0.0,
  });

  const root = new THREE.Group();

  // Secondary-motion pivots, registered with the jiggle solver at the end.
  let bellyPivot = null;
  const tieSegPivots = [];
  const flapPivots = [];

  const hips = new THREE.Group();
  hips.position.y = 1.0;
  root.add(hips);

  // Organic torso: tapered elliptical masses instead of boxes — waist
  // narrower than shoulders, pelvis flaring slightly to the hips. The belly
  // ratio widens the waist; the shoulder ratio widens the chest top.
  const pelvis = taper(0.175 * b * (1 + (belly - 1) * 0.6), 0.195 * b, 0.24, legMat, 0.78);
  hips.add(pelvis);

  const torso = new THREE.Group();
  torso.position.y = 0.1;
  hips.add(torso);

  const chest = taper(
    0.235 * b * (1 + (shoulderS - 1) * 0.6),
    0.165 * b * belly, 0.62, suitMat, 0.72);
  chest.position.y = 0.3;
  torso.add(chest);

  // Big-belly caricature: a forward bulge under the jacket (Trump, Clinton).
  // Wrapped in its own pivot so the jiggle solver can wobble it (scale
  // squash driven by vertical acceleration — jelly physics).
  if (belly > 1.1) {
    bellyPivot = new THREE.Group();
    bellyPivot.position.set(0, 0.13, 0.055 * b);
    const bulge = sphere(0.17 * b, suitMat);
    bulge.scale.set(1.05, 0.85, 0.7);
    bellyPivot.add(bulge);
    torso.add(bellyPivot);
  }

  // Suit shoulders: rounded caps where the arms meet the jacket.
  for (const s of [-1, 1]) {
    const cap = sphere(0.085 * b * shoulderS, suitMat);
    cap.scale.set(1.15, 0.85, 1.0);
    cap.position.set(s * 0.26 * b, 0.5, 0);
    torso.add(cap);
  }

  // Neck bridging the collar to the head.
  const neck = capsule(0.055, 0.08, skinMat);
  neck.position.y = 0.6;
  torso.add(neck);

  // Suit-only dressing: dress-shirt panel, jacket buttons, and the tie.
  // A casual fighter (BOB) wears a plain tee — none of these apply.
  let tiePivot = null;
  if (!casual) {
    const shirt = box(0.16 * b, 0.46, 0.02, shirtMat);
    shirt.position.set(0, 0.34, 0.152 * b);
    torso.add(shirt);
    if (c.cardigan) {
      // Carter's cardigan: angled V-neck edges over the shirt, a button
      // column instead of jacket buttons.
      for (const s of [-1, 1]) {
        const lapel = box(0.035, 0.3, 0.022, suitMat);
        lapel.position.set(s * 0.055 * b, 0.42, 0.155 * b);
        lapel.rotation.z = -s * 0.32;
        torso.add(lapel);
      }
      for (const by of [0.14, 0.06, -0.02]) {
        const btn = sphere(0.012, shoeMat);
        btn.position.set(0, by, 0.158 * b);
        torso.add(btn);
      }
    } else {
      // Jacket buttons.
      for (const by of [0.16, 0.06]) {
        const btn = sphere(0.014, shoeMat);
        btn.position.set(0, by, 0.155 * b);
        torso.add(btn);
      }
    }

    // Flag lapel pin — a tiny canvas-painted Stars and Stripes on the left
    // lapel, angled to hug the chest curve.
    if (c.lapelPin) {
      const pin = box(0.04, 0.026, 0.008, new THREE.MeshStandardMaterial({
        map: flagTexture(), roughness: 0.4, metalness: 0.3,
      }));
      pin.position.set(0.09 * b, 0.46, 0.152 * b);
      pin.rotation.y = 0.42;
      torso.add(pin);
    }

    // Tie: a knot plus three CHAINED spring pivots — each segment lags its
    // parent through the shared jiggle solver, so the tie whips, folds and
    // flows like cloth instead of swinging as one plank. Asymmetric pitch
    // clamps stop it swinging through the chest while letting it fly up
    // over the shoulder on hard knockback.
    const tieLen = 0.4 * c.tieLength;
    tiePivot = new THREE.Group();
    tiePivot.position.set(0, 0.52, 0.175 * b);
    if (c.tieLoose) tiePivot.position.y -= 0.035;
    const knot = box(0.055, 0.05, 0.03, tieMat);
    knot.position.y = -0.01;
    tiePivot.add(knot);
    const segLen = tieLen / 3;
    const segWidths = [0.06, 0.07, 0.082]; // widens toward the blade
    let tieParent = tiePivot;
    for (let i = 0; i < 3; i++) {
      const segPivot = new THREE.Group();
      segPivot.position.y = i === 0 ? -0.025 : -segLen;
      const segMesh = box(segWidths[i], segLen, 0.02, tieMat);
      segMesh.position.set(0, -segLen / 2, 0.004);
      if (i === 0 && c.tieLoose) segMesh.rotation.z = 0.09;
      segPivot.add(segMesh);
      tieParent.add(segPivot);
      tieSegPivots.push(segPivot);
      tieParent = segPivot;
    }
    if (c.tieLoose) {
      // Clinton's end-of-day loosened knot: collar button showing.
      const collarBtn = sphere(0.011, shirtMat);
      collarBtn.position.set(0, 0.545, 0.162 * b);
      torso.add(collarBtn);
    }
    torso.add(tiePivot);

    // Jacket tails: two rear hem flaps on spring pivots — they kick out
    // behind the fighter on dashes and knockback.
    for (const s of [-1, 1]) {
      const flapPivot = new THREE.Group();
      flapPivot.position.set(s * 0.09 * b, 0.02, -0.1 * b);
      const flap = box(0.09, 0.16, 0.02, suitMat);
      flap.position.y = -0.08;
      flapPivot.add(flap);
      torso.add(flapPivot);
      flapPivots.push(flapPivot);
    }
  } else {
    // Tee details: a ring collar and a small chest pocket print.
    const collar = taper(0.075, 0.085, 0.045, suitMat, 0.9);
    collar.position.y = 0.585;
    torso.add(collar);
    const pocket = box(0.06, 0.07, 0.015, new THREE.MeshStandardMaterial({
      color: 0xc9c4b8, roughness: 0.9,
    }));
    pocket.position.set(0.08 * b, 0.34, 0.15 * b);
    torso.add(pocket);
  }

  const head = new THREE.Group();
  head.position.y = 0.62;
  torso.add(head);
  // Whole-head caricature scale — the engine only writes to refs.skull.scale
  // (swelling), so the group scale is safe to own here.
  if (c.headScale && c.headScale !== 1) head.scale.setScalar(c.headScale);

  const skull = box(dims.w, dims.h, dims.d, faceMat);
  skull.position.y = 0.16;
  head.add(skull);
  // Hair on its own pivot so it can flop with a subtler jiggle than the tie.
  const hairPivot = new THREE.Group();
  hairPivot.position.y = 0.3;
  const hair = buildHair(c, hairMat, dims);
  hair.position.y = -0.3;
  hairPivot.add(hair);
  head.add(hairPivot);

  const earR = c.earR ?? 0.035;
  for (const side of [-1, 1]) {
    const ear = sphere(earR, skinMat);
    ear.position.set(side * (dims.hw + 0.01), 0.16, 0);
    head.add(ear);
  }

  // Facial features + painted detail plate (returns the expression groups).
  const face = buildFace(c, head, { faceMat, skinMat }, dims);

  // Cut decal above the brow — hidden until head damage passes the threshold
  // (the engine toggles refs.cut.visible).
  const cut = box(0.024, 0.06, 0.02, new THREE.MeshStandardMaterial({
    color: 0x7a1512, roughness: 0.35,
  }));
  cut.position.set(0.085, 0.225, dims.d / 2 - 0.005);
  cut.rotation.z = 0.45;
  cut.visible = false;
  head.add(cut);

  if (c.aviators) {
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x14161a, roughness: 0.1, metalness: 0.85,
    });
    for (const side of [-1, 1]) {
      const lens = box(0.09, 0.07, 0.02, glassMat);
      lens.position.set(side * 0.065, 0.19, dims.d / 2 + 0.012);
      head.add(lens);
    }
    const bridge = box(0.04, 0.015, 0.02, glassMat);
    bridge.position.set(0, 0.2, dims.d / 2 + 0.012);
    head.add(bridge);
  }

  const joints = { hips, torso, head };

  for (const side of ['L', 'R']) {
    const s = side === 'L' ? -1 : 1;

    // Arms: capsule sleeves with a shirt cuff and a mitt-shaped hand.
    const shoulder = new THREE.Group();
    shoulder.position.set(s * 0.28 * b, 0.5, 0);
    torso.add(shoulder);
    const upperArm = capsule(0.058 * b, 0.2, suitMat);
    upperArm.position.y = -0.16;
    shoulder.add(upperArm);

    const elbow = new THREE.Group();
    elbow.position.y = -0.34;
    shoulder.add(elbow);
    // Casual = short tee sleeves: the forearm is bare skin with no cuff.
    const forearm = capsule(0.05 * b, 0.18, casual ? skinMat : suitMat);
    forearm.position.y = -0.13;
    elbow.add(forearm);
    if (!casual) {
      const cuff = capsule(0.052 * b, 0.02, shirtMat);
      cuff.position.y = -0.235;
      elbow.add(cuff);
    }
    const fist = sphere(0.075, skinMat);
    fist.scale.set(0.95, 0.8, 1.2);
    fist.position.y = -0.3;
    elbow.add(fist);

    // Legs: capsule trousers over dress shoes with a heel.
    const hip = new THREE.Group();
    hip.position.set(s * 0.11, -0.1, 0);
    hips.add(hip);
    const thigh = capsule(0.078 * b, 0.26, legMat);
    thigh.position.y = -0.2;
    hip.add(thigh);

    const knee = new THREE.Group();
    knee.position.y = -0.42;
    hip.add(knee);
    const shin = capsule(0.06 * b, 0.26, legMat);
    shin.position.y = -0.2;
    knee.add(shin);
    const shoe = box(0.115, 0.075, 0.26, shoeMat);
    shoe.position.set(0, -0.45, 0.06);
    knee.add(shoe);
    if (casual) {
      // Sneaker sole: a dark rubber slab under the white upper.
      const sole = box(0.12, 0.03, 0.28, new THREE.MeshStandardMaterial({
        color: 0x2c2c2c, roughness: 0.9,
      }));
      sole.position.set(0, -0.492, 0.05);
      knee.add(sole);
    } else {
      const heel = box(0.1, 0.05, 0.08, shoeMat);
      heel.position.set(0, -0.462, -0.05);
      knee.add(heel);
    }

    joints['shoulder' + side] = shoulder;
    joints['elbow' + side] = elbow;
    joints['hip' + side] = hip;
    joints['knee' + side] = knee;
    // Strike anchors: the actual fist/shoe meshes, registered as joints so
    // the hit capsules track the visible polygons instead of approximating
    // them with forward-reach offsets from the elbow/knee.
    joints['fist' + side] = fist;
    joints['foot' + side] = shoe;
  }

  root.scale.setScalar(c.heightScale);

  // Secondary-motion springs. `gain` converts world acceleration into swing,
  // `stiffness`/`damping` shape the pendulum. kind 'rot' swings the pivot,
  // kind 'scale' squash-stretches it (belly wobble, jowl quiver). minRx/maxRx
  // clamp pitch asymmetrically so cloth can't swing through the body.
  const mkJiggle = (pivot, opts) => ({
    pivot, kind: 'rot', rx: 0, rz: 0, vrx: 0, vrz: 0,
    prev: null, vel: new THREE.Vector3(), ...opts,
  });
  const jiggles = [
    mkJiggle(hairPivot, { stiffness: 70, damping: 9, gain: 0.005, max: 0.28 }),
  ];
  // Chained tie segments: looser and wider-swinging toward the tip so the
  // chain whips. Pitch clamps: barely into the chest, freely up and away.
  tieSegPivots.forEach((pivot, i) => {
    jiggles.push(mkJiggle(pivot, {
      stiffness: 46 - i * 9, damping: 7 - i * 0.8, gain: 0.012 + i * 0.007,
      max: 0.6 + i * 0.18, minRx: -0.1 - i * 0.05, maxRx: 1.0 + i * 0.3,
    }));
  });
  // Jacket tails: swing backward only (the torso blocks the forward arc).
  for (const pivot of flapPivots) {
    jiggles.push(mkJiggle(pivot, {
      stiffness: 58, damping: 8, gain: 0.009, max: 0.6, minRx: -0.8, maxRx: 0.12,
    }));
  }
  // Body-mass wobble: Trump/Clinton bellies, Nixon jowls.
  if (bellyPivot) {
    jiggles.push(mkJiggle(bellyPivot, {
      kind: 'scale', stiffness: 90, damping: 8, gain: 0.0035, max: 0.16,
    }));
  }
  if (face.jowlPivot) {
    jiggles.push(mkJiggle(face.jowlPivot, {
      kind: 'scale', stiffness: 120, damping: 9, gain: 0.003, max: 0.2,
    }));
  }

  return {
    root,
    joints,
    jiggles,
    // Direct mesh handles for the damage-visuals system (swelling, cut) and
    // the expression system (mouths — see setExpression).
    refs: { skull, cut, hairPivot, mouths: face.mouths },
    materials: { suitMat, skinMat, faceMat, plateMat: face.plateMat, tieMat, hairMat },
    config: c,
    baseColors: {
      suit: new THREE.Color(casual ? c.shirtColor : c.suit),
      skin: new THREE.Color(c.skin),
      tie: new THREE.Color(c.tie ?? c.jeans ?? 0x444444),
    },
  };
}

// ── Secondary motion (tie/hair jiggle) ────────────────────────────────────
// Damped angular springs driven by the pivot's world-space acceleration:
// the appendage lags behind whatever the torso/head does — walking, punch
// twists, knockback — with no per-appendage special cases. Called from the
// engine's render loop at frame rate.
const _jw = new THREE.Vector3();
const _jv = new THREE.Vector3();
const _jaccel = new THREE.Vector3();
const _jq = new THREE.Quaternion();
export function updateJiggles(rig, dt) {
  if (!rig.jiggles) return;
  dt = Math.min(dt, 1 / 30);
  if (dt <= 1e-5) return;
  for (const j of rig.jiggles) {
    j.pivot.getWorldPosition(_jw);
    if (!j.prev) {
      j.prev = _jw.clone();
      continue;
    }
    _jv.copy(_jw).sub(j.prev).divideScalar(dt);
    _jaccel.copy(_jv).sub(j.vel).divideScalar(dt);
    j.vel.copy(_jv);
    j.prev.copy(_jw);

    // Clamp accel spikes (teleports) so the spring can't blow up.
    const m = _jaccel.length();
    if (m > 80) _jaccel.multiplyScalar(80 / m);

    // World accel → parent-local: the swing must be relative to the torso/head.
    j.pivot.parent.getWorldQuaternion(_jq);
    _jaccel.applyQuaternion(_jq.invert());

    if (j.kind === 'scale') {
      // Jelly wobble: vertical acceleration drives a squash-stretch spring.
      // Landing/knockback compresses the mass, the spring rebounds it.
      j.vrx += (-_jaccel.y * j.gain - j.rx * j.stiffness - j.vrx * j.damping) * dt;
      j.rx = Math.max(-j.max, Math.min(j.max, j.rx + j.vrx * dt));
      j.pivot.scale.set(1 + j.rx * 0.6, 1 - j.rx, 1 + j.rx * 0.6);
      continue;
    }

    // Lag: forward accel (+Z local) tips the appendage backward (+rot.x);
    // lateral accel (+X) tips it the other way (−rot.z).
    j.vrx += (_jaccel.z * j.gain - j.rx * j.stiffness - j.vrx * j.damping) * dt;
    j.vrz += (-_jaccel.x * j.gain - j.rz * j.stiffness - j.vrz * j.damping) * dt;
    j.rx = Math.max(j.minRx ?? -j.max, Math.min(j.maxRx ?? j.max, j.rx + j.vrx * dt));
    j.rz = Math.max(-j.max, Math.min(j.max, j.rz + j.vrz * dt));
    j.pivot.rotation.x = j.rx;
    j.pivot.rotation.z = j.rz;
  }
}
