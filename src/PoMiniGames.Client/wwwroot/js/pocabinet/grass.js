// pocabinet/grass.js
//
// Camera-riding grass: a fixed field of blades (one BufferGeometry, positions
// baked in a TILE-sized square) that the vertex shader wraps around the camera,
// so the lawn is infinite and costs one draw call. Built on MeshStandardMaterial
// via onBeforeCompile, so blades take the same sun, IBL, shadows and fog as the
// ground they grow from; normals point up so the two blend.
//
// A top-down mask (the road plus kerb band, rasterised once per track from the
// centerline) keeps blades off the tarmac; a noise lookup makes it patchy; blades
// shrink out toward the tile edge so the wrap never shows.

import * as THREE from 'three';
import { clock, noise } from './materials.js';
import { KERB_OUTER } from './kerbs.js';

const WS = 10;
const TILE = 44;

function roadMask(track, margin, keepOut) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < track.count; i++) {
        minX = Math.min(minX, track.x[i]); maxX = Math.max(maxX, track.x[i]);
        minY = Math.min(minY, track.y[i]); maxY = Math.max(maxY, track.y[i]);
    }
    const pad = track.halfWidth + margin + 40;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    const S = 1024;
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, S, S);
    const sx = S / (maxX - minX), sy = S / (maxY - minY);
    g.strokeStyle = '#fff';
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.lineWidth = (track.halfWidth + margin) * 2 * Math.max(sx, sy);
    g.beginPath();
    for (let i = 0; i <= track.count; i++) {
        const k = i % track.count;
        const px = (track.x[k] - minX) * sx, py = (track.y[k] - minY) * sy;
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    // A road with height (the Playground run) is up on the model, not on the lawn.
    if (!track.z) g.stroke();
    // No blades where a scene model already covers the ground (the Playground's pad).
    if (keepOut) {
        g.fillStyle = '#fff';
        g.beginPath();
        for (let i = 0; i < keepOut.length; i += 2) g.lineTo((keepOut[i] - minX) * sx, (keepOut[i + 1] - minY) * sy);
        g.fill();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.flipY = false;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    return { tex, rect: new THREE.Vector4(minX / WS, minY / WS, (maxX - minX) / WS, (maxY - minY) / WS) };
}

function bladeGeometry(count) {
    const pos = new Float32Array(count * 5 * 3);
    const nrm = new Float32Array(count * 5 * 3);
    const off = new Float32Array(count * 5 * 2);
    const rnd = new Float32Array(count * 5 * 4);
    const idx = new Uint32Array(count * 9);
    const shape = [[-1, 0], [1, 0], [-0.6, 0.5], [0.6, 0.5], [0, 1]];
    let s = 1234567;
    const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    for (let b = 0; b < count; b++) {
        const ox = r() * TILE, oz = r() * TILE;
        const rr = [r(), r(), r(), r()];
        for (let v = 0; v < 5; v++) {
            const i = b * 5 + v;
            pos[i * 3] = shape[v][0]; pos[i * 3 + 1] = shape[v][1]; pos[i * 3 + 2] = 0;
            nrm[i * 3 + 1] = 1;
            off[i * 2] = ox; off[i * 2 + 1] = oz;
            rnd[i * 4] = rr[0]; rnd[i * 4 + 1] = rr[1]; rnd[i * 4 + 2] = rr[2]; rnd[i * 4 + 3] = rr[3];
        }
        const v0 = b * 5;
        idx.set([v0, v0 + 1, v0 + 2, v0 + 1, v0 + 3, v0 + 2, v0 + 2, v0 + 3, v0 + 4], b * 9);
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geom.setAttribute('aOffset', new THREE.BufferAttribute(off, 2));
    geom.setAttribute('aRand', new THREE.BufferAttribute(rnd, 4));
    geom.setIndex(new THREE.BufferAttribute(idx, 1));
    return geom;
}

export class Grass {
    /**
     * @param track  runtime track
     * @param color  base colour (the ground's)
     * @param count  blades in the tile (quality tier)
     * @param keepOut optional sim ring [x0, y0, …] kept bare, like the road
     */
    constructor(track, color, count, keepOut) {
        const mask = roadMask(track, KERB_OUTER + 6, keepOut);
        this.mask = mask.tex;
        this.center = new THREE.Vector3();
        this.material = new THREE.MeshStandardMaterial({
            color: new THREE.Color(color).multiplyScalar(1.15), roughness: 0.85, metalness: 0, side: THREE.DoubleSide,
        });
        const uniforms = {
            uCenter: { value: this.center },
            uMask: { value: mask.tex },
            uMaskRect: { value: mask.rect },
            uPcNoise: { value: noise() },
            uPcTime: clock,
        };
        this.material.onBeforeCompile = (shader) => {
            Object.assign(shader.uniforms, uniforms);
            shader.vertexShader = `
uniform vec3 uCenter;
uniform sampler2D uMask;
uniform vec4 uMaskRect;
uniform sampler2D uPcNoise;
uniform float uPcTime;
attribute vec2 aOffset;
attribute vec4 aRand;
varying float vBlade;
` + shader.vertexShader
                .replace('#include <beginnormal_vertex>', `
    float yaw = aRand.z * 6.2831853;
    vec2 bdir = vec2(cos(yaw), sin(yaw));
    vec3 objectNormal = normalize(vec3(bdir.y * 0.35, 1.0, -bdir.x * 0.35));
    #ifdef USE_TANGENT
        vec3 objectTangent = vec3(1.0, 0.0, 0.0);
    #endif`)
                .replace('#include <begin_vertex>', `
    const float T = ${TILE.toFixed(1)};
    vec2 rel = mod(aOffset - uCenter.xz + T * 0.5, T) - T * 0.5;
    vec2 root = uCenter.xz + rel;
    float fade = 1.0 - smoothstep(T * 0.3, T * 0.48, length(rel));
    float road = texture2D(uMask, (root - uMaskRect.xy) / uMaskRect.zw).r;
    float patchy = texture2D(uPcNoise, root * 0.015).r + aRand.y * 0.35;
    float h = (0.28 + aRand.x * 0.55) * fade * (1.0 - smoothstep(0.1, 0.6, road)) * smoothstep(0.42, 0.62, patchy);
    float t = position.y;
    float gust = texture2D(uPcNoise, root * 0.02 + vec2(uPcTime * 0.05, uPcTime * 0.03)).g;
    float sway = sin(uPcTime * 1.9 + root.x * 0.45 + root.y * 0.3) * 0.25 + (gust - 0.5) * 0.9;
    vec3 transformed = vec3(root.x, 0.0, root.y);
    transformed.xz += bdir * position.x * 0.045 * (1.0 - t * 0.85);
    transformed.xz += (vec2(0.8, 0.45) * sway + vec2(-bdir.y, bdir.x) * (aRand.w - 0.5) * 0.6) * t * t * h * 0.55;
    transformed.y = t * h;
    // A culled blade (road, patch gap, tile edge) collapses to one point underground:
    // left at full width it lies flat as a sliver that shades into HDR fireflies.
    if (h < 0.03) transformed = vec3(root.x, -1.0, root.y);
    vBlade = t;`);
            shader.fragmentShader = 'varying float vBlade;\n' + shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
    diffuseColor.rgb *= mix(0.35, 1.25, vBlade);
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.15, 1.1, 0.7), vBlade * vBlade * 0.5);`);
        };
        this.material.customProgramCacheKey = () => 'pocabinet-grass';
        this.mesh = new THREE.Mesh(bladeGeometry(count), this.material);
        this.mesh.name = 'pocabinet-grass';
        this.mesh.frustumCulled = false;
        this.mesh.receiveShadow = true;
    }

    /** Follow the camera (the wrap happens in the shader). */
    update(camera) {
        this.center.copy(camera.position);
    }

    dispose() {
        this.mesh.geometry.dispose();
        this.material.dispose();
        this.mask.dispose();
    }
}
