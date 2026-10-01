// pocabinet/sky.js
//
// Sky dome for PoCabinet: a camera-following inverted sphere with a gradient, sun
// and drifting fbm clouds (greyed and thickened in rain). Daytime only since
// 2026-09-29 — the stars, city glow and Press Briefing searchlights went with the
// night mode. Replaces the flat scene.background colour.
//
// The horizon colour is read from scene.fog every frame, so whatever the fog
// becomes (environment.js greys it in rain) the ground fades into the sky
// with no seam. Written at the far plane (z = w) and drawn first.

import * as THREE from 'three';

// Per-track look. Directions are world space (y up). The DirectionalLight in
// scene.js follows `sun`, clamped high enough to keep the road lit.
// All are daytime (2026-09-29): Capitol was a low-sun dusk and Press Briefing
// a starless night with searchlights, and both made the race hard to read.
const PRESETS = {
    capitol: {
        zenith: '#3a78c8', sun: [-0.45, 0.66, -0.6], sunColor: '#fff1d6', sunSize: 1.2,
        clouds: 0.3, cloudColor: '#ffffff',
    },
    maralago: {
        zenith: '#2f6fbf', sun: [0.35, 0.72, 0.45], sunColor: '#fff2d0', sunSize: 1.4,
        clouds: 0.26, cloudColor: '#ffffff',
    },
    pressbriefing: {
        zenith: '#4a86cf', sun: [0.3, 0.7, 0.55], sunColor: '#fff4dc', sunSize: 1.2,
        clouds: 0.32, cloudColor: '#ffffff',
    },
    playground: {
        zenith: '#3f86d6', sun: [-0.4, 0.74, 0.5], sunColor: '#fff3d8', sunSize: 1.3,
        clouds: 0.34, cloudColor: '#ffffff',
    },
};

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
    vDir = position;
    vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    gl_Position = p.xyww;
}`;

const FRAG = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunSize;
uniform float uCloud;
uniform vec3 uCloudColor;
uniform float uTime;
uniform float uRain;
varying vec3 vDir;

#define PI 3.14159265

float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x),
               mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
    return s;
}

void main() {
    vec3 d = normalize(vDir);
    float h = d.y;
    float up = pow(smoothstep(-0.02, 0.65, h), 0.65);
    // Rain greys the zenith toward its own luminance.
    vec3 zen = mix(uZenith, vec3(dot(uZenith, vec3(0.33))) * 1.4, uRain * 0.6);
    vec3 col = mix(uHorizon, zen, up);

    // Sun: disc + halo + a warm band along the horizon under it.
    float day = 1.0 - uRain * 0.85;
    float s = max(dot(d, normalize(uSunDir)), 0.0);
    col += uSunColor * (pow(s, 1400.0 / max(uSunSize, 0.01)) * 5.0 + pow(s, 14.0) * 0.3) * day * step(0.01, uSunSize);
    col += uSunColor * pow(s, 3.0) * 0.18 * (1.0 - up) * day;

    // Clouds: fbm on a plane overhead.
    if (h > 0.0) {
        vec2 cp = d.xz / (h + 0.12) * 0.9 + uTime * vec2(0.011, 0.004);
        float n = fbm(cp * 1.6);
        float cover = clamp(uCloud + uRain * 0.55, 0.0, 0.95);
        float c = smoothstep(1.0 - cover, 1.0 - cover + 0.32, n) * smoothstep(0.0, 0.22, h);
        vec3 lit = mix(uCloudColor * 0.55, uCloudColor * 1.1, smoothstep(0.3, 1.0, n));
        lit += uSunColor * pow(s, 6.0) * 0.4 * day;
        lit = mix(lit, vec3(0.28, 0.3, 0.33), uRain * 0.7);
        col = mix(col, lit, c * 0.88);
    }

    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
}`;

export class Sky {
    constructor(trackId) {
        const p = PRESETS[trackId] || PRESETS.capitol;
        this.preset = p;
        this.baseZenith = new THREE.Color(p.zenith);
        this.material = new THREE.ShaderMaterial({
            vertexShader: VERT,
            fragmentShader: FRAG,
            side: THREE.BackSide,
            depthWrite: false,
            fog: false,
            uniforms: {
                uZenith: { value: this.baseZenith.clone() },
                uHorizon: { value: new THREE.Color('#14233f') },
                uSunDir: { value: new THREE.Vector3(...p.sun).normalize() },
                uSunColor: { value: new THREE.Color(p.sunColor) },
                uSunSize: { value: p.sunSize },
                uCloud: { value: p.clouds },
                uCloudColor: { value: new THREE.Color(p.cloudColor) },
                uTime: { value: 0 },
                uRain: { value: 0 },
            },
        });
        this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1500, 32, 16), this.material);
        this.mesh.name = 'pocabinet-sky';
        this.mesh.frustumCulled = false;
        this.mesh.renderOrder = -1000;
    }

    /** World-space direction the DirectionalLight should shine from. */
    lightDirection() {
        const d = new THREE.Vector3(...this.preset.sun).normalize();
        d.y = Math.max(d.y, 0.6);
        return d.normalize();
    }

    setRain(rain) {
        this.material.uniforms.uRain.value = rain ? 1 : 0;
    }

    update(camera, fog, timeSeconds) {
        this.mesh.position.copy(camera.position);
        if (camera.parent && camera.parent.isObject3D && camera.parent.type !== 'Scene') {
            camera.getWorldPosition(this.mesh.position);
        }
        if (fog) this.material.uniforms.uHorizon.value.copy(fog.color);
        this.material.uniforms.uTime.value = timeSeconds % 10000;
    }

    dispose() {
        this.mesh.geometry.dispose();
        this.material.dispose();
    }
}
