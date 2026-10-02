// sky.js — a sky you can look at, instead of a clear colour.
//
// Until now `scene.background` was a flat colour picked by lighting.js: correct at the
// horizon, wrong everywhere else. Looking up gave the same blue as looking out to sea,
// dusk was an orange wall, and night was a slightly darker wall with no stars in it. On a
// game where the god spends half the time flying, the sky is most of the frame.
//
// Two meshes, both parented to the camera position so they never run out:
//
//   DOME   an inverted sphere with a gradient from zenith to horizon, a sun disc with a
//          soft halo along the sun direction, a moon opposite it, and hash-based stars
//          that fade in with the night factor. Depth-tested off and drawn first, so it is
//          strictly behind everything and costs one full-screen-ish draw.
//   CLOUDS a high plane carrying two octaves of drifting value noise, coverage-thresholded
//          so it reads as separate clouds rather than haze, lit from the sun side and
//          darkened at night. Fades with distance so the plane never shows its edge.
//
// Everything is driven from the same `info` object lighting.update() returns, so the sky,
// the fog, the water and the shafts never disagree about the time of day.
//
// NIGHT SPECTACLE (GFX pass 2, idea 10). Two more terms in the dome, both additive, so a
// mild night stays mild — they bring light, they never take it away:
//
//   AURORA    curtains projected onto three stacked sheets above the island, rippled by
//             drifting noise and streaked with vertical rays; green at the foot, violet at
//             the crown. Its strength is decided by the renderer from the world's seed and
//             the date, so it is the ISLAND's aurora — two people watching the same world
//             on the same night see it together, and nothing the viewer does summons it.
//   METEORS   one potential streak per 2.6 s slot, hashed from the slot; the rate is the
//             renderer's (a shower night is again a property of the world and the date).
//             Each is a short great-circle segment with a fading tail.
import * as THREE from 'three';

const DOME_RADIUS = 560;
const CLOUD_Y = 96;
const CLOUD_SPAN = 1400;

const NOISE = `
float sHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float sNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(sHash(i), sHash(i + vec2(1.0, 0.0)), u.x),
             mix(sHash(i + vec2(0.0, 1.0)), sHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
`;

const DOME_VERT = `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  // The dome rides the camera: no translation, so it is a direction field, not a place.
  vec4 clip = projectionMatrix * mat4(mat3(viewMatrix)) * vec4(position, 1.0);
  gl_Position = clip.xyww;   // z = w: always at the far plane, never in front of anything
}
`;

const DOME_FRAG = `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform float uNight;
uniform float uDusk;
uniform float uTime;
uniform float uAurora;     // 0..1 tonight's aurora
uniform float uMeteors;    // 0..1 chance a meteor slot fires
uniform float uRainbow;    // 0..1 a bow after rain
varying vec3 vDir;
${NOISE}

vec3 aurora(vec3 d) {
  if (d.y < 0.03) return vec3(0.0);
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float sheet = 1.0 + fi * 0.35;
    vec2 q = d.xz / (d.y + 0.12) * sheet * 0.55;
    // The curtain line itself: a slow sinuous band across the sky.
    float wave = q.x * 1.3 + sNoise(q * 0.9 + vec2(uTime * 0.02, fi * 3.1)) * 2.6 + sin(q.y * 0.8 + uTime * 0.05) * 0.8;
    float band = exp(-pow(sin(wave) * 2.2, 2.0));
    // Vertical rays: noise stretched along the curtain, flickering slowly.
    float rays = 0.45 + 0.55 * sNoise(vec2(wave * 9.0, uTime * 0.35 + fi * 5.0));
    vec3 tint = mix(vec3(0.12, 1.0, 0.45), vec3(0.62, 0.25, 1.0), fi / 2.0);
    acc += tint * band * rays * (0.55 - fi * 0.12);
  }
  float lift = smoothstep(0.03, 0.25, d.y) * (1.0 - smoothstep(0.75, 1.0, d.y));
  return acc * lift;
}

vec3 meteor(vec3 d) {
  float slot = floor(uTime / 2.6);
  float h = sHash(vec2(slot, 17.0));
  if (h > uMeteors) return vec3(0.0);
  float p = fract(uTime / 2.6) / 0.32;          // lives for the first third of its slot
  if (p > 1.0) return vec3(0.0);
  float az = sHash(vec2(slot, 3.0)) * 6.2831;
  float el = 0.35 + sHash(vec2(slot, 5.0)) * 0.4;
  vec3 a = normalize(vec3(cos(az) * cos(el), sin(el), sin(az) * cos(el)));
  vec3 b = normalize(a + vec3(-sin(az), -0.55, cos(az)) * 0.35);
  vec3 head = normalize(mix(a, b, p));
  vec3 tail = normalize(mix(a, b, max(0.0, p - 0.35)));
  // Distance from d to the segment tail→head, on the chord.
  vec3 seg = head - tail;
  float t = clamp(dot(d - tail, seg) / max(dot(seg, seg), 1e-6), 0.0, 1.0);
  float dist = length(d - (tail + seg * t));
  float line = exp(-dist * dist * 2.2e5) * t * t;
  return vec3(0.85, 0.92, 1.0) * line * (1.0 - p * 0.6) * 2.4;
}

void main() {
  vec3 d = normalize(vDir);
  float up = clamp(d.y, -1.0, 1.0);

  // Gradient: the horizon band is wider at dusk, when the warm light sits low.
  float h = pow(1.0 - clamp(up, 0.0, 1.0), mix(2.6, 1.6, uDusk));
  vec3 col = mix(uZenith, uHorizon, h);
  // Below the horizon there is only sea; keep the horizon colour so the dome never shows
  // a seam where the water plane ends.
  col = mix(col, uHorizon * 0.92, smoothstep(0.0, -0.08, up));

  // Sun: a hard disc, a tight halo, and a wide warm glow that carries the dusk.
  float cosSun = dot(d, normalize(uSunDir));
  float disc = smoothstep(0.9993, 0.9997, cosSun);
  float halo = pow(max(cosSun, 0.0), 220.0) * 0.9;
  float glow = pow(max(cosSun, 0.0), 6.0) * (0.22 + uDusk * 0.5);
  col += uSunColor * (disc * 3.0 + halo + glow) * (1.0 - uNight * 0.85);

  // Moon: opposite the sun, small, cool, only at night.
  float cosMoon = dot(d, normalize(-uSunDir + vec3(0.0, 0.35, 0.0)));
  float moon = smoothstep(0.99955, 0.9998, cosMoon) + pow(max(cosMoon, 0.0), 400.0) * 0.35;
  col += vec3(0.86, 0.9, 1.0) * moon * uNight * 1.4;

  // Stars: a hash on a quantised direction, thresholded so only a few cells light, with a
  // slow twinkle. They live above the horizon and only once the sky is dark enough.
  vec2 cell = floor(d.xz / max(abs(d.y), 0.05) * 90.0);
  float s = sHash(cell);
  float star = step(0.986, s) * (0.6 + 0.4 * sin(uTime * (1.5 + s * 3.0) + s * 40.0));
  float aboveHorizon = smoothstep(0.02, 0.2, up);
  col += vec3(0.9, 0.95, 1.0) * star * aboveHorizon * smoothstep(0.35, 0.9, uNight) * 0.9;

  // Rainbow: the primary bow, 42 degrees out from the antisolar point, red on
  // the outside. Only above the horizon, so a high sun (bow centre far below it) shows none —
  // which is why real ones belong to mornings and late afternoons.
  if (uRainbow > 0.01 && up > 0.0) {
    float ang = acos(clamp(dot(d, -normalize(uSunDir)), -1.0, 1.0));
    float x = (ang - 0.733) / 0.03;
    float band = exp(-x * x * 0.45);
    float hue = clamp(0.5 - x * 0.27, 0.0, 1.0) * 0.76;
    vec3 spectrum = clamp(abs(mod(hue * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
    col += spectrum * band * uRainbow * 0.3 * smoothstep(0.0, 0.14, up) * (1.0 - smoothstep(0.45, 0.72, uNight));
  }

  float dark = smoothstep(0.3, 0.85, uNight);
  if (uAurora > 0.01 && dark > 0.0) col += aurora(d) * uAurora * dark * 0.9;
  if (uMeteors > 0.001 && dark > 0.0) col += meteor(d) * dark;

  gl_FragColor = vec4(col, 1.0);
}
`;

const CLOUD_VERT = `
varying vec3 vWorld;
void main() {
  vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}
`;

const CLOUD_FRAG = `
uniform vec3 uLit;        // sun-facing colour
uniform vec3 uShade;      // underside colour
uniform vec3 uSunDir;
uniform float uTime;
uniform float uCover;     // 0..1 coverage
uniform float uNight;
varying vec3 vWorld;
${NOISE}

void main() {
  vec2 p = vWorld.xz * 0.006 + vec2(uTime * 0.0045, uTime * 0.0018);
  float n = sNoise(p) * 0.55 + sNoise(p * 2.3 + 7.1) * 0.3 + sNoise(p * 5.1 - 3.3) * 0.15;
  float edge = mix(0.72, 0.42, uCover);
  float body = smoothstep(edge, edge + 0.22, n);
  if (body <= 0.003) discard;

  // Lighting: the sun side of a cloud is where the noise slopes toward the sun. A gradient
  // of the same noise is a cheap normal, and it is enough to give the tops a lit rim.
  float e = 0.02;
  vec2 g = vec2(sNoise(p + vec2(e, 0.0)) - sNoise(p - vec2(e, 0.0)), sNoise(p + vec2(0.0, e)) - sNoise(p - vec2(0.0, e)));
  float lit = clamp(0.5 + dot(normalize(g + 1e-5), normalize(uSunDir.xz + 1e-5)) * 0.6, 0.0, 1.0);
  vec3 col = mix(uShade, uLit, lit) * (1.0 - uNight * 0.75);

  float dist = length(cameraPosition.xz - vWorld.xz);
  float far = 1.0 - smoothstep(380.0, 640.0, dist);
  gl_FragColor = vec4(col, body * 0.86 * far);
}
`;

export function createSky(scene, { tier = 'high' } = {}) {
  const domeMat = new THREE.ShaderMaterial({
    uniforms: {
      uZenith: { value: new THREE.Color(0x3b7dd8) },
      uHorizon: { value: new THREE.Color(0x8ec5ff) },
      uSunColor: { value: new THREE.Color(0xfff2df) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uNight: { value: 0 },
      uDusk: { value: 0 },
      uTime: { value: 0 },
      uAurora: { value: 0 },
      uMeteors: { value: 0 },
      uRainbow: { value: 0 },
    },
    vertexShader: DOME_VERT,
    fragmentShader: DOME_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(DOME_RADIUS, 32, 18), domeMat);
  dome.renderOrder = -10;
  dome.frustumCulled = false;
  dome.name = 'sky';
  scene.add(dome);

  let clouds = null;
  if (tier !== 'low') {
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uLit: { value: new THREE.Color(0xffffff) },
        uShade: { value: new THREE.Color(0x9fb3c8) },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uTime: { value: 0 },
        uCover: { value: 0.45 },
        uNight: { value: 0 },
      },
      vertexShader: CLOUD_VERT,
      fragmentShader: CLOUD_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    const geo = new THREE.PlaneGeometry(CLOUD_SPAN, CLOUD_SPAN, 1, 1);
    geo.rotateX(-Math.PI / 2);
    const plane = new THREE.Mesh(geo, mat);
    plane.position.y = CLOUD_Y;
    plane.renderOrder = -5;
    plane.frustumCulled = false;
    plane.name = 'clouds';
    scene.add(plane);
    clouds = { plane, mat };
  }

  const zenith = new THREE.Color();
  const WHITE = new THREE.Color(0xffffff);
  const SLATE = new THREE.Color(0x6b7a8c);
  const STORM = new THREE.Color(0x4a5360);
  // Weather: 0 = the usual scattered clouds, 1 = a closed storm deck. Eased per frame so
  // a spell rolls in rather than switching the sky.
  let overcast = 0;
  let overcastTarget = 0;
  const spectacle = { aurora: 0, meteors: 0 };
  let rainbow = 0;
  const DAY_ZENITH = new THREE.Color(0x2f6fd0);
  const NIGHT_ZENITH = new THREE.Color(0x0b1326);
  const DUSK_ZENITH = new THREE.Color(0x4a3a7a);

  return {
    dome,
    get clouds() { return clouds?.plane ?? null; },
    /**
     * @param {{ sky: THREE.Color, sunColour: THREE.Color, sunDir: THREE.Vector3, night: number, day: number, dusk: number }} sky
     *   the object lighting.update() returns
     * @param {{x:number, z:number}} player
     * @param {number} time seconds
     */
    /** 0..1 cloud deck from the weather (renderer.js). */
    setOvercast(v) { overcastTarget = Math.max(0, Math.min(1, v)); },
    /** Tonight's spectacle (renderer.js decides it from the world): 0..1 each. Eased. */
    setSpectacle(auroraLevel, meteorRate) {
      spectacle.aurora = Math.max(0, Math.min(1, auroraLevel));
      spectacle.meteors = Math.max(0, Math.min(1, meteorRate));
    },
    get overcast() { return overcast; },
    /** Cloud coverage as the cloud shader has it (the cloud shadows sample the same field). */
    get cover() { return 0.45 + overcast * 0.45; },
    /** 0..1 rainbow strength (renderer.js: rain easing off over wet ground, in daylight). */
    setRainbow(v) { rainbow = Math.max(0, Math.min(1, v)); },
    get rainbow() { return domeMat.uniforms.uRainbow.value; },
    update(sky, player, time) {
      const u = domeMat.uniforms;
      overcast += (overcastTarget - overcast) * 0.02;
      zenith.copy(NIGHT_ZENITH).lerp(DAY_ZENITH, sky.day).lerp(DUSK_ZENITH, sky.dusk * 0.6).lerp(STORM, overcast * 0.6);
      u.uZenith.value.copy(zenith);
      u.uHorizon.value.copy(sky.sky);
      u.uSunColor.value.copy(sky.sunColour);
      u.uSunDir.value.copy(sky.sunDir);
      u.uNight.value = sky.night;
      u.uDusk.value = sky.dusk;
      u.uTime.value = time;
      // A closed cloud deck hides both; the aurora also fades in over a minute or so rather
      // than switching on at dusk.
      const clear = 1 - overcast;
      u.uAurora.value += (spectacle.aurora * clear - u.uAurora.value) * 0.004;
      u.uMeteors.value = spectacle.meteors * clear;
      u.uRainbow.value += (rainbow - u.uRainbow.value) * 0.02;
      if (clouds) {
        const c = clouds.mat.uniforms;
        c.uSunDir.value.copy(sky.sunDir);
        c.uTime.value = time;
        c.uNight.value = sky.night;
        // The lit side takes the sun's colour, so dusk clouds go pink without a special case.
        c.uLit.value.copy(sky.sunColour).lerp(WHITE, 0.35).lerp(SLATE, overcast * 0.55);
        c.uShade.value.copy(sky.sky).lerp(SLATE, 0.45).lerp(STORM, overcast * 0.6);
        c.uCover.value = 0.45 + overcast * 0.45;
        clouds.plane.position.set(player.x, CLOUD_Y, player.z);
      }
    },
    dispose() {
      scene.remove(dome); dome.geometry.dispose(); domeMat.dispose();
      if (clouds) { scene.remove(clouds.plane); clouds.plane.geometry.dispose(); clouds.mat.dispose(); }
    },
  };
}
