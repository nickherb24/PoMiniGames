// pocabinet/reflections.js
//
// Wet-road light reflections. The wet asphalt in environment.js only
// mirrors the sky (its env map is a sky capture), so a lamp or a tail light never
// showed in it. This draws what a camera actually sees on wet tarmac: each light
// smeared into a long streak running from under it toward the viewer, broken into
// shimmering bands by the rain.
//
// One instanced quad per light, aimed in the vertex shader (no per-frame matrix
// work): every car's tail lights, brighter under braking (the game is always day,
// so there are no lamp or headlight sources).
// Additive over the road, depth-tested so cars occlude it. Render-only: it reads the
// poses race.js already drew.

import * as THREE from 'three';

const MAX = 32;
const TAIL = new THREE.Color('#ff2a18');
const TAILS = [new THREE.Vector3(-1.9, 0.56, 0.56), new THREE.Vector3(-1.9, 0.56, -0.56)];

const VERT = /* glsl */ `
attribute vec4 aLight;     // world x, world z, light height, intensity
attribute vec3 aColor;
uniform vec3 uCam;
varying vec2 vQ;
varying vec3 vColor;
varying float vI;
void main() {
    vec2 foot = aLight.xy;
    vec2 toCam = uCam.xz - foot;
    float dist = length(toCam);
    vec2 dir = toCam / max(dist, 1e-3);
    vec2 side = vec2(-dir.y, dir.x);
    // The mirror image sits under the light; roughness smears it toward the eye,
    // longer for a higher light and a longer view across the wet.
    float len = clamp(aLight.z * 2.4 + dist * 0.14, 1.0, max(1.0, min(dist * 0.85, 28.0)));
    float width = 0.16 + aLight.z * 0.05;
    vec2 p = foot + side * position.x * width + dir * position.y * len;
    vQ = position.xy;
    vColor = aColor;
    vI = aLight.w * smoothstep(120.0, 55.0, dist);
    gl_Position = projectionMatrix * viewMatrix * vec4(p.x, 0.06, p.y, 1.0);
}`;

const FRAG = /* glsl */ `
uniform float uTime;
varying vec2 vQ;
varying vec3 vColor;
varying float vI;
void main() {
    float across = exp(-vQ.x * vQ.x * 3.2);
    float along = smoothstep(0.0, 0.06, vQ.y) * (1.0 - vQ.y) * (1.0 - vQ.y);
    float band = 0.6 + 0.4 * sin(vQ.y * 42.0 - uTime * 5.0 + vQ.x * 2.5 + vColor.r * 9.0);
    float a = across * along * band * vI;
    if (a < 0.003) discard;
    gl_FragColor = vec4(vColor * a, 1.0);
    #include <colorspace_fragment>
}`;

export class WetReflections {
    /** @param sceneHandle scene.js SceneHandle */
    constructor(sceneHandle) {
        this.sh = sceneHandle;
        const quad = new THREE.InstancedBufferGeometry();
        quad.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, -1, 1, 0, 1, 1, 0], 3));
        quad.setIndex([0, 1, 2, 1, 3, 2]);
        this.light = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4).setUsage(THREE.DynamicDrawUsage);
        this.color = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3).setUsage(THREE.DynamicDrawUsage);
        quad.setAttribute('aLight', this.light);
        quad.setAttribute('aColor', this.color);
        quad.instanceCount = 0;
        this.geom = quad;
        this.material = new THREE.ShaderMaterial({
            vertexShader: VERT,
            fragmentShader: FRAG,
            uniforms: { uCam: { value: new THREE.Vector3() }, uTime: { value: 0 } },
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
        });
        this.mesh = new THREE.Mesh(quad, this.material);
        this.mesh.frustumCulled = false;
        this.mesh.renderOrder = 3;
        sceneHandle.scene.add(this.mesh);
        this._v = new THREE.Vector3();
        this.disposed = false;
    }

    /**
     * @param timeSeconds  animation clock
     * @param cars         cars.js handles (group transform, braking flag)
     */
    update(timeSeconds, cars) {
        if (this.disposed) return;
        const L = this.light.array, C = this.color.array;
        let n = 0;
        const put = (x, z, h, intensity, c) => {
            if (n >= MAX || intensity <= 0.01) return;
            L[n * 4] = x; L[n * 4 + 1] = z; L[n * 4 + 2] = h; L[n * 4 + 3] = intensity;
            C[n * 3] = c.r; C[n * 3 + 1] = c.g; C[n * 3 + 2] = c.b;
            n++;
        };
        for (const car of cars) {
            if (!car || car.disposed || !car.group.visible) continue;
            car.group.updateMatrixWorld();
            const tail = car.braking ? 0.85 : 0.35;
            for (const p of TAILS) {
                const w = this._v.copy(p).applyMatrix4(car.group.matrixWorld);
                put(w.x, w.z, 0.56, tail, TAIL);
            }
        }
        this.geom.instanceCount = n;
        this.light.needsUpdate = true;
        this.color.needsUpdate = true;
        this.material.uniforms.uCam.value.copy(this.sh.camera.position);
        this.material.uniforms.uTime.value = timeSeconds % 1000;
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.mesh.parent?.remove(this.mesh);
        this.geom.dispose();
        this.material.dispose();
    }
}
