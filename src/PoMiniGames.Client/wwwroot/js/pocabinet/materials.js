// pocabinet/materials.js
//
// Shared surface kit for PoCabinet's PBR pass: procedural textures (generated
// once per page, no image assets — the service-worker precache stays small) and
// small onBeforeCompile hooks layered onto MeshStandardMaterial:
//
//   asphalt()   — aggregate colour, a height-derived normal map and a roughness map
//   grass()     — two-tone blade-scale colour + normal map
//   noise()     — RGBA tileable fbm, four independent octave sets, for shaders
//   macro()     — world-space low-frequency tint so a repeated texture never tiles visibly
//   wind()      — vertex sway for foliage (instanced or not), driven by one clock
//   water()     — animated wave normals for pools
//
// `clock.value` is advanced once per frame by scene.js. Hooks chain: each
// material keeps a list and one onBeforeCompile runs them in order.

import * as THREE from 'three';

export const clock = { value: 0 };

// ── Tileable value-noise fbm ────────────────────────────────────────────────

function hash(x, y, seed) {
    let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** size×size fbm in [0,1], periodic so it tiles; `base` = cells across the lowest octave. */
function fbm(size, base, octaves, seed) {
    const out = new Float32Array(size * size);
    let amp = 0.5, total = 0;
    for (let o = 0; o < octaves; o++) {
        const cells = base << o;
        for (let y = 0; y < size; y++) {
            const fy = y / size * cells, y0 = Math.floor(fy), ty = fy - y0;
            const sy = ty * ty * (3 - 2 * ty);
            for (let x = 0; x < size; x++) {
                const fx = x / size * cells, x0 = Math.floor(fx), tx = fx - x0;
                const sx = tx * tx * (3 - 2 * tx);
                const a = hash(x0 % cells, y0 % cells, seed + o), b = hash((x0 + 1) % cells, y0 % cells, seed + o);
                const c = hash(x0 % cells, (y0 + 1) % cells, seed + o), d = hash((x0 + 1) % cells, (y0 + 1) % cells, seed + o);
                out[y * size + x] += amp * ((a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy);
            }
        }
        total += amp;
        amp *= 0.5;
    }
    for (let i = 0; i < out.length; i++) out[i] /= total;
    return out;
}

function dataTexture(data, size, srgb) {
    const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 8;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    return t;
}

/** Tangent-space normal map from a periodic height field. */
function normalMap(h, size, strength) {
    const out = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const l = h[y * size + (x - 1 + size) % size], r = h[y * size + (x + 1) % size];
            const u = h[((y - 1 + size) % size) * size + x], d = h[((y + 1) % size) * size + x];
            let nx = (l - r) * strength, ny = (u - d) * strength, nz = 1;
            const len = Math.hypot(nx, ny, nz);
            nx /= len; ny /= len; nz /= len;
            const i = (y * size + x) * 4;
            out[i] = (nx * 0.5 + 0.5) * 255;
            out[i + 1] = (ny * 0.5 + 0.5) * 255;
            out[i + 2] = (nz * 0.5 + 0.5) * 255;
            out[i + 3] = 255;
        }
    }
    return out;
}

let asphaltSet = null;
/** { map, normalMap, roughnessMap } — neutral grey, tinted by the material colour. */
export function asphalt() {
    if (asphaltSet) return asphaltSet;
    const S = 256;
    const low = fbm(S, 4, 4, 11), grit = fbm(S, 64, 2, 23);
    const col = new Uint8Array(S * S * 4), rough = new Uint8Array(S * S * 4), height = new Float32Array(S * S);
    for (let i = 0; i < S * S; i++) {
        const stone = hash(i % S, (i / S) | 0, 5);
        const speck = stone > 0.985 ? 0.2 : stone < 0.02 ? -0.14 : 0;
        const v = Math.min(1, Math.max(0, 0.8 + (low[i] - 0.5) * 0.22 + (grit[i] - 0.5) * 0.3 + speck));
        col[i * 4] = col[i * 4 + 1] = col[i * 4 + 2] = v * 255;
        col[i * 4 + 3] = 255;
        rough[i * 4 + 1] = (0.78 + (grit[i] - 0.5) * 0.25 - speck * 0.4) * 255;
        rough[i * 4 + 3] = 255;
        height[i] = grit[i] + speck * 1.5;
    }
    asphaltSet = {
        map: dataTexture(col, S, true),
        normalMap: dataTexture(normalMap(height, S, 5), S, false),
        roughnessMap: dataTexture(rough, S, false),
    };
    return asphaltSet;
}

let grassSet = null;
/** { map, normalMap } — near-white two-tone, tinted by the material colour. */
export function grass() {
    if (grassSet) return grassSet;
    const S = 256;
    const low = fbm(S, 4, 4, 41), blades = fbm(S, 48, 3, 57), clumps = fbm(S, 12, 2, 63);
    const col = new Uint8Array(S * S * 4), height = new Float32Array(S * S);
    for (let i = 0; i < S * S; i++) {
        const v = 0.78 + (blades[i] - 0.5) * 0.45 + (low[i] - 0.5) * 0.15;
        const warm = (clumps[i] - 0.5) * 0.35;
        col[i * 4] = Math.min(255, Math.max(0, (v + warm * 0.9) * 255));
        col[i * 4 + 1] = Math.min(255, Math.max(0, (v + warm * 0.25) * 255));
        col[i * 4 + 2] = Math.min(255, Math.max(0, (v - warm * 0.4) * 235));
        col[i * 4 + 3] = 255;
        height[i] = blades[i];
    }
    grassSet = { map: dataTexture(col, S, true), normalMap: dataTexture(normalMap(height, S, 4), S, false) };
    return grassSet;
}

let noiseTex = null;
/** RGBA tileable fbm (four independent channels) for shader lookups. */
export function noise() {
    if (noiseTex) return noiseTex;
    const S = 128;
    const ch = [fbm(S, 4, 4, 71), fbm(S, 8, 3, 83), fbm(S, 2, 4, 97), fbm(S, 16, 2, 101)];
    const data = new Uint8Array(S * S * 4);
    for (let i = 0; i < S * S; i++) for (let c = 0; c < 4; c++) data[i * 4 + c] = ch[c][i] * 255;
    noiseTex = dataTexture(data, S, false);
    return noiseTex;
}

// ── Hooks ────────────────────────────────────────────────────────────────────

function addHook(material, key, fn) {
    if (!material.userData.hooks) {
        material.userData.hooks = [];
        material.onBeforeCompile = (shader) => { for (const h of material.userData.hooks) h.fn(shader); };
        material.customProgramCacheKey = () => material.userData.hooks.map(h => h.key).join('|');
    }
    material.userData.hooks.push({ key, fn });
    material.needsUpdate = true;
    return material;
}

const WORLD_VARYING_V = `
varying vec3 vPcWorld;
`;

function ensureWorldVarying(shader) {
    if (shader.vertexShader.includes('vPcWorld')) return;
    shader.vertexShader = WORLD_VARYING_V + shader.vertexShader.replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
    {
        vec4 pcw = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
            pcw = instanceMatrix * pcw;
        #endif
        vPcWorld = (modelMatrix * pcw).xyz;
    }`);
    shader.fragmentShader = WORLD_VARYING_V + shader.fragmentShader;
}

/**
 * World-space low-frequency variation of the albedo: `amount` ± around 1 at
 * `scale` world units per noise tile. Kills visible tiling on big surfaces.
 */
export function macro(material, scale = 60, amount = 0.25) {
    return addHook(material, `macro${scale}:${amount}`, (shader) => {
        ensureWorldVarying(shader);
        shader.uniforms.uPcNoise = { value: noise() };
        shader.fragmentShader = 'uniform sampler2D uPcNoise;\n' + shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
        {
            vec4 n1 = texture2D(uPcNoise, vPcWorld.xz / ${scale.toFixed(1)});
            vec4 n2 = texture2D(uPcNoise, vPcWorld.xz / ${(scale * 0.23).toFixed(2)});
            float m = (n1.r - 0.5) * 1.4 + (n2.g - 0.5) * 0.6;
            diffuseColor.rgb *= 1.0 + m * ${amount.toFixed(3)};
            diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.08, 1.0, 0.86), clamp(n1.b - 0.45, 0.0, 1.0) * ${amount.toFixed(3)} * 2.0);
        }`);
    });
}

/**
 * Foliage sway. Geometry is authored with its root at the local origin and the
 * free end along +`axis` ('y' for trees, 'x' for palm fronds); the bend grows
 * with distance² (× `reach`). Instances sway out of phase by position.
 */
export function wind(material, amount = 0.12, axis = 'y', reach = 1) {
    return addHook(material, `wind${amount}${axis}${reach}`, (shader) => {
        shader.uniforms.uPcTime = clock;
        shader.vertexShader = 'uniform float uPcTime;\n' + shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        {
            vec3 root = vec3(0.0);
            #ifdef USE_INSTANCING
                root = instanceMatrix[3].xyz;
            #endif
            float h = max(position.${axis}, 0.0) * ${reach.toFixed(3)};
            float ph = dot(root.xz, vec2(0.37, 0.23));
            float gust = 0.7 + 0.3 * sin(uPcTime * 0.31 + root.x * 0.02);
            float sx = sin(uPcTime * 1.3 + ph) * 0.6 + sin(uPcTime * 2.9 + ph * 1.7) * 0.2;
            float sz = cos(uPcTime * 1.05 + ph * 0.8) * 0.4;
            transformed.x += sx * ${amount.toFixed(3)} * h * h * gust;
            transformed.z += sz * ${amount.toFixed(3)} * h * h * gust;
            transformed.y += (sx + sz) * ${(amount * 0.4).toFixed(3)} * h * h * gust;
        }`);
    });
}

/** Rippling water: animated normal perturbation on a flat, glossy surface. */
export function water(material, strength = 0.18) {
    return addHook(material, `water${strength}`, (shader) => {
        ensureWorldVarying(shader);
        shader.uniforms.uPcTime = clock;
        shader.uniforms.uPcNoise = { value: noise() };
        shader.fragmentShader = 'uniform float uPcTime;\nuniform sampler2D uPcNoise;\n' + shader.fragmentShader.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
            vec2 p = vPcWorld.xz;
            vec2 a = texture2D(uPcNoise, p * 0.11 + vec2(uPcTime * 0.021, uPcTime * 0.013)).rg - 0.5;
            vec2 b = texture2D(uPcNoise, p * 0.23 - vec2(uPcTime * 0.017, -uPcTime * 0.024)).ba - 0.5;
            vec2 g = (a + b) * ${strength.toFixed(3)} * 2.0;
            normal = normalize(normal + (viewMatrix * vec4(g.x, 0.0, g.y, 0.0)).xyz);
        }`);
    });
}

/** MeshStandardMaterial shorthand. */
