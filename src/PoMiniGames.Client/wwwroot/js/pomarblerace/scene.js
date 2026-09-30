// scene.js — Three.js renderer/scene/lights + smooth orbit-follow camera, plus the
// post-processing pipeline: ACES tone mapping, dynamic shadows, GTAO, a transient rack focus,
// a colour grade, SMAA, a speed-reactive FOV, GPU sparks, pooled impact light pulses and a
// per-map lighting theme (setTheme).
//
// 2026-08-08 (user request) removed from this file: bloom (#2), the vignette (#6), chromatic
// aberration (#7), image-based lighting (#17) and the graded background (#20).
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import * as PostFx from '../postFx.js';

const BG = 0x0f172a;            // cyberpunk dark slate
// Broadcast-style chase cam: higher and further back for a cleaner, more
// professional framing that shows the leader plus the track ahead.
// High, pulled-back overview: a positive default pitch orbits the camera UP and
// behind the leader so it looks down into the channel over the tall walls,
// showing a complete view of the pack and the track ahead.
// Raised and pulled back with the road: at CHANNEL_WIDTH 64 the old 26/46 vantage framed
// about a third of the chute's width, so marbles kept fighting off-screen.
// The camera now locks to the PLAYER'S marble (see _pickShot), which is a marble you steer —
// so the framing is a chase cam, not a pack overview: closer and a touch lower than the old
// broadcast vantage, tilted enough to read the road ahead so you can steer toward boost pads
// and away from the fall-off edge.
//
// CHASE, FLATTENED: the previous 52/38 vantage sat almost on top of the marble (≈58° down),
// so the frame was floor-plus-berms and the road ahead was a thin sliver at the top — the ramp
// was unreadable. Pulling BACK rather than UP flattens the look angle to ≈40° and lets the
// chute recede into frame, which is what makes the ramp legible.
// RESCALED for the authored course (2026-08-10). The old 46/62 vantage was sized against the
// procedural chute: a 64-wide road with 44-tall berms, straight enough that a 62-unit lookback
// still saw down it. The authored course is a different size in both directions — the channel
// is 24-30 units across for most of its length (17 through Lane2) and the walls are 8.3 tall —
// and, more importantly, the start helix turns on a 56-unit radius. A camera 62 units back from
// a marble on that helix sits outside the spiral entirely and shoots through the track above it.
// Pulled in to roughly the same fraction of the channel width the old framing had. The berm
// clearance that pinned CAM_HEIGHT above ~50 no longer applies at all.
const CAM_HEIGHT = 20;          // base vantage height above the followed marble
const CAM_BACK = 28;            // behind the marble; the depth that lets the course recede and read
const CAM_LOOKAHEAD = 12;       // aims down-track so the road ahead owns the frame, not the floor underfoot
const CAM_LOOK_LIFT = 3;        // lifts the aim point; the marble settles into the lower third, road above it
const CAM_DEFAULT_PITCH = 0.12;  // positive → camera rides above and looks down into the chute
const CAM_LERP = 3.4;          // slightly smoother follow reads more cinematic
// Shot changes used to teleport the camera (a === 1). With the demo camera on the leader of a
// 101-marble pack that fired several times a second, which is the "jumping". The director's-cut
// intent is kept — a change still resolves fast — but it now runs as a hard ease over
// CAM_CUT_TIME instead of a single-frame warp, so a cut reads as a whip-pan and a lead swap
// between two adjacent marbles reads as nothing at all. See also the shot hysteresis in
// game.js _pickShot, which stops most cuts from being requested in the first place.
const CAM_CUT_LERP = 11;        // follow rate while a cut is resolving (vs CAM_LERP when settled)
const CAM_CUT_TIME = 0.5;       // seconds a cut stays on the accelerated rate
const FOV_BASE = 60;
// #4 speed-reactive FOV: the frame widens as the followed marble speeds up, so velocity is felt
// and not just measured. Mapped from marble speed; the start-line FOV punch rides on top.
const FOV_SPEED_ADD = 10;       // max degrees added at top speed
const FOV_SPEED_LO = 25;        // speed at which the widening starts
const FOV_SPEED_HI = 90;        // speed at which it saturates

// Colour-grade post pass (#3). Runs in linear HDR before OutputPass.
//
// 2026-08-08 (user request): this pass used to also do a vignette (#6) and a
// chromatic aberration (#7). Both are gone, along with the radial blur (#2)
// removed earlier, so what remains is purely the colour grade (#3) — a straight
// 1:1 texture read with saturation/contrast/tint applied. No multi-tap sampling
// of any kind, which is why the split-sample helper and the blur branch are gone
// rather than merely switched off.
const PostShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTint: { value: new THREE.Vector3(1, 1, 1) },   // #3 — grade
    uContrast: { value: 1.0 },
    uSaturation: { value: 1.0 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform vec3 uTint; uniform float uContrast; uniform float uSaturation;
    varying vec2 vUv;

    void main() {
      vec3 col = texture2D(tDiffuse, vUv).rgb;

      // Grade (#3): saturation, then contrast about mid-grey, then tint. Clamped at zero —
      // this runs in linear HDR, where a contrast push can otherwise drive channels negative
      // and OutputPass turns those into black speckle.
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(luma), col, uSaturation);
      col = (col - 0.5) * uContrast + 0.5;
      col = max(col * uTint, 0.0);

      gl_FragColor = vec4(col, 1.0);
    }`,
};

// #3 grade presets. Eased toward, never snapped — see the grade easing in followTarget.
// The per-preset `vignette` field went with the vignette itself (2026-08-08).
const GRADES = {
  // Pre-race on the grid: cool, desaturated, flat. Clinical — nothing has happened yet.
  pick: { tint: [0.88, 0.94, 1.10], contrast: 0.94, saturation: 0.78 },
  // The baseline look the game shipped with.
  racing: { tint: [1.00, 1.00, 1.00], contrast: 1.00, saturation: 1.00 },
  // Final stretch: warm, contrasty, tighter vignette. Matches the HUD's own 0.86 threshold.
  final: { tint: [1.12, 1.02, 0.90], contrast: 1.12, saturation: 1.14 },
  // Won: brief lift in saturation and exposure.
  win: { tint: [1.16, 1.10, 0.98], contrast: 1.08, saturation: 1.30 },
  // Lost or eliminated: drain the colour out.
  loss: { tint: [0.92, 0.92, 0.96], contrast: 0.96, saturation: 0.35 },
};

export function createScene(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false });
  renderer.setPixelRatio(window.PoCanvasDpr.ceiling());   // audit #8: shared policy, js/canvasDpr.js
  renderer.setClearColor(BG, 1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;   // #2 — filmic highlight rolloff
  renderer.toneMappingExposure = 1.15;
  renderer.shadowMap.enabled = true;                     // #3 — dynamic shadows
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // The glass marbles (marbles.js, heavy tier) render the scene once more for refraction; they
  // are small on screen, so half resolution is indistinguishable and halves that pass.
  renderer.transmissionResolutionScale = 0.5;
  // FLICKER FIX (1/4) — anisotropy. Every procedural texture in track.js pinned itself to 4,
  // and the kerb stripes (hard red/white, seen at grazing angles by a chase cam) aliased into
  // crawling moiré at that level. Textures inherit this default, so raising it here raises it
  // for the whole track — createScene runs before buildTrack, and track.js's texture
  // singletons are built lazily on first use, so the ordering holds.
  THREE.Texture.DEFAULT_ANISOTROPY = renderer.capabilities.getMaxAnisotropy();
  container.style.position = 'relative';
  container.style.overflow = 'hidden';
  container.appendChild(renderer.domElement);
  renderer.domElement.style.display = 'block';

  const scene = new THREE.Scene();
  // Graded background (#20) removed 2026-08-08 (user request). It was a 4x256 canvas
  // gradient ramping #070b18 -> #0f172a -> #16203c up the sky. A flat BG matches the fog
  // colour exactly, so the horizon no longer shows a seam where fog meets sky.
  scene.background = new THREE.Color(BG);
  // Fog tracks the camera distance: the haze must start comfortably PAST the followed marble or
  // it greys out the exact stretch of course the framing exists to show. Pulled in with
  // CAM_BACK 62→28 for the authored course — at 170/560 the fog now sat so far beyond the
  // subject that it never resolved anything, which on a course that spirals back over itself
  // costs real depth cues.
  scene.fog = new THREE.Fog(BG, 78, 260);

  // Image-based lighting (#17) removed 2026-08-08 (user request). A RoomEnvironment PMREM
  // used to sit on scene.environment purely so the glossy marbles and floor had something to
  // reflect. The ambient + hemisphere + key rig below carries the lighting on its own; the
  // marble and road materials had their metalness dropped to 0 to suit (a metal with nothing
  // to reflect renders black, which is what removing the env map alone would have caused).

  // FLICKER FIX (2/4) — depth precision. near 0.1 / far 2000 is a 20000:1 range, which leaves
  // almost no usable depth resolution out where the track is; the rumble/boost/kicker bands sit
  // a mere 0.05–0.06 above the floor ribbon and were z-fighting it, which is the flicker that
  // crawls across the road surface. Nothing is ever within 1 unit of this camera (it rides
  // ≥15 units off the marble at any orbit angle) and fog reaches BG by 560, so 1/1000 clips
  // nothing visible and buys ~20× the depth resolution.
  const camera = new THREE.PerspectiveCamera(FOV_BASE, 1, 1, 1000);
  camera.position.set(0, CAM_HEIGHT, -CAM_BACK);

  // Lighting — soft ambient + a shadow-casting key light; neon comes from emissive materials.
  //
  // 2026-08-08: these were rebalanced UPWARD when the image-based lighting (#17) came out.
  // RoomEnvironment was not a subtle reflection layer — it was carrying most of the scene's
  // actual illumination, and deleting it alone dropped the rendered frame from a mean
  // luminance of ~138 to ~27 (measured over the demo track), i.e. a barely-visible picture.
  // The ambient is also re-tinted from a dim blue (0x33405c) toward a neutral slate: the blue
  // was there to sit under a warm env map that no longer exists, and on its own it drained the
  // road's colour. Values chosen by measuring the composited frame back to the original range.
  // Near-neutral on purpose. These were blue (0x8899b8 ambient, 0x88aaff sky) to match the
  // cyberpunk palette, but a blue fill lands on the largest surface in the scene and made the
  // asphalt read as blue-grey — measured at a +37 blue bias over the road, which is what the
  // grey road texture was fighting. A faint cool sky tint is kept so the scene is not sterile.
  const ambient = new THREE.AmbientLight(0xb6b8bd, 3.6);
  scene.add(ambient);
  const hemi = new THREE.HemisphereLight(0xc2ccdd, 0x3a3c42, 2.2);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffffff, 3.0);
  key.position.set(40, 80, -30);
  key.castShadow = true;
  // FLICKER FIX (3/4) — shadow crawl. The shadow camera is dragged along by the followed
  // marble every frame (see followTarget), so its texel grid slid continuously over the
  // geometry and every shadow edge boiled. 2048 over the 150-wide frustum halves the texel,
  // and followTarget quantises the light position to SHADOW_TEXEL so the grid steps instead
  // of sliding.
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 220;
  // 2026-08-08 realism pass #10: frustum tightened 150 -> 96 wide.
  //
  // The road is CHANNEL_WIDTH 64. At ±75 more than half the shadow map was being spent on
  // empty space either side of the chute, so a marble's contact shadow — a ~2-unit feature —
  // had barely 27 texels to live in and resolved as a smudge rather than a contact. ±48 still
  // clears the 64-wide road plus the berms either side (they are ~14 further out and only need
  // to receive, which the road itself covers), and it more than halves the texel size: 0.073
  // world units versus 0.073*1.56. That is the difference between a marble looking like it is
  // ON the road and looking like it is over a dark patch.
  //
  // The frustum tracks the followed marble (see followTarget), so a narrower one is not a
  // coverage risk — it is always centred on the action.
  // Narrowed with the camera (48→30): the frustum only has to cover what the shot frames, and a
  // tighter one halves the texel size again on a course whose channel is less than half the
  // width of the chute this was sized for.
  const SHADOW_HALF = 30;
  key.shadow.camera.left = -SHADOW_HALF; key.shadow.camera.right = SHADOW_HALF;
  key.shadow.camera.top = SHADOW_HALF; key.shadow.camera.bottom = -SHADOW_HALF;
  key.shadow.bias = -0.0008;
  // A tighter frustum means a smaller texel, which means acne appears at a bias that used to be
  // fine. normalBias offsets along the surface normal and is the right control for curved
  // receivers (every marble in the pack is one).
  key.shadow.normalBias = 0.02;
  // frustum width ÷ map size — the world size of one shadow texel; followTarget snaps the
  // light to this grid so the map doesn't crawl as the camera follows.
  const SHADOW_TEXEL = (SHADOW_HALF * 2) / 2048;
  scene.add(key);
  scene.add(key.target);

  // ── Marble-only environment (2026-08-08 realism pass #3) ──────────────
  // Glass spheres are defined by their highlight. With scene.environment gone (#17) the marbles
  // had no specular response at all and rendered as matte putty — the one material in the scene
  // that most needs reflection was the one hurt most by removing it.
  //
  // This is deliberately NOT scene.environment. It is handed to marbles.js and set as `envMap`
  // on the marble materials alone, so the road, berms and hazards stay matte exactly as asked;
  // only the 101 spheres get something to catch. The source is a tiny 2-stop vertical gradient
  // (cool sky over dark ground), not a room capture, so nothing recognisable is mirrored — it
  // reads as a lit environment rather than as a reflection of a place.
  //
  // PMREM-prefiltered because MeshStandardMaterial needs roughness-aware mips; feeding a raw
  // texture as envMap gives a hard mirror at every roughness.
  const marbleEnv = (() => {
    const c = document.createElement('canvas');
    c.width = 16; c.height = 64;
    const g = c.getContext('2d');
    const grd = g.createLinearGradient(0, 0, 0, 64);
    grd.addColorStop(0.00, '#dfe8f5');   // sky
    grd.addColorStop(0.48, '#8f9db4');
    grd.addColorStop(0.52, '#3c4048');   // horizon break — this is what makes a highlight read
    grd.addColorStop(1.00, '#191b1f');   // ground
    g.fillStyle = grd; g.fillRect(0, 0, 16, 64);
    const src = new THREE.CanvasTexture(c);
    src.mapping = THREE.EquirectangularReflectionMapping;
    src.colorSpace = THREE.SRGBColorSpace;
    const pm = new THREE.PMREMGenerator(renderer);
    const rt = pm.fromEquirectangular(src);
    pm.dispose();
    src.dispose();
    return rt;   // caller disposes rt.texture via dispose() below
  })();

  // ── Post-processing composer ──────────────────────────────────────────
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(renderer.getPixelRatio());
  composer.addPass(new RenderPass(scene, camera));

  // GTAO (§GFX-2). The chute is a big diffuse trough lit by one key light and an
  // environment map, so before this the marbles read as *hovering over* the road
  // rather than rolling on it — there was no contact darkening anywhere. Ground
  // truth ambient occlusion is what puts them back in contact with the floor.
  //
  // High tier only, and OFF rather than degraded below it: GTAO costs a depth +
  // normal prepass, which is the wrong thing to be paying for on a machine that
  // is already dropping frames. The scene still reads correctly without it.
  let gtao = null;
  if (PostFx.allowHeavy()) {
    gtao = new GTAOPass(scene, camera, 1, 1);
    gtao.output = GTAOPass.OUTPUT.Default;
    // Radius in world units. The track is ~64 wide and marbles are radius 1, so
    // a small radius is right — a large one would darken whole berms instead of
    // the crease where a marble meets the road.
    gtao.updateGtaoMaterial({ radius: 2.2, distanceExponent: 1.0, thickness: 1.0, scale: 1.1 });
    composer.addPass(gtao);
    // The pass hides Points and Lines from its depth/normal prepass but not Meshes, so an additive
    // Mesh (the ribbon trails) was written as solid depth and drew a black AO smear. Objects marked
    // userData.noAO are hidden too; restoreVisibility() restores them from the cache the original
    // overrideVisibility() just filled.
    const hideFromAo = gtao.overrideVisibility.bind(gtao);
    gtao.overrideVisibility = () => {
      hideFromAo();
      scene.traverse((o) => { if (o.userData.noAO) o.visible = false; });
    };
  }

  // Bloom (#2) removed 2026-08-08 (user request).

  // Rack focus (§GFX-2). Disabled during the race; the photo finish turns it on
  // for a beat. See postFx.js for why a transient DoF pass is affordable and a
  // permanent one is not.
  const rackFocus = PostFx.createRackFocus(scene, camera, 1, 1);
  composer.addPass(rackFocus.pass);
  // ShaderPass CLONES the uniforms off the descriptor, so drive `post.uniforms` — writing to
  // PostShader.uniforms would touch the module-level template and leak between scenes.
  const post = new ShaderPass(PostShader);                // #3 colour grade (all this pass still does)
  composer.addPass(post);
  const smaa = new SMAAPass(1, 1);                        // #10 — anti-aliasing
  composer.addPass(smaa);
  composer.addPass(new OutputPass());                     // tone-map + sRGB to screen

  // ── Per-map theme (GFX 2026-09-30) ────────────────────────────────────
  // Each map in maps.js may carry a `theme`: background (which is also the fog colour, so the
  // horizon never shows the seam the graded background once did), fog range, the three lights and
  // exposure. A map without one keeps the rig above. The light COUNT never changes, so switching
  // theme never recompiles a shader.
  function setTheme(t) {
    if (!t) return;
    renderer.setClearColor(t.bg, 1);
    scene.background.setHex(t.bg);
    scene.fog.color.setHex(t.bg);
    scene.fog.near = t.fogNear;
    scene.fog.far = t.fogFar;
    ambient.color.setHex(t.ambient[0]); ambient.intensity = t.ambient[1];
    hemi.color.setHex(t.hemi[0]); hemi.groundColor.setHex(t.hemi[1]); hemi.intensity = t.hemi[2];
    key.color.setHex(t.key[0]); key.intensity = t.key[1];
    renderer.toneMappingExposure = t.exposure;
  }

  // ── Impact light pulses (GFX #5) ──────────────────────────────────────
  // A hard hit or a kicker discharge lights the track around it for a beat. Three point lights
  // live in the scene from the start at zero intensity and are only re-aimed and brightened:
  // adding and removing lights would change the light count and recompile every lit material.
  const PULSES = 3;
  const pulses = Array.from({ length: PULSES }, () => {
    const l = new THREE.PointLight(0xffffff, 0, 26, 2);
    scene.add(l);
    return { light: l, life: 0, peak: 0 };
  });
  let pulseHead = 0;
  function pulseLight(pos, colorHex, strength = 1) {
    const p = pulses[pulseHead];
    pulseHead = (pulseHead + 1) % PULSES;
    p.light.position.set(pos.x, pos.y + 2.5, pos.z);
    p.light.color.set(colorHex);
    p.peak = 150 * strength;   // candela; ≈ 3× the key light on the floor right under it
    p.life = 1;
  }
  function updatePulses(dt) {
    for (const p of pulses) {
      if (p.life <= 0) continue;
      p.life = Math.max(0, p.life - dt / 0.35);
      p.light.intensity = p.peak * p.life * p.life;
    }
  }

  // ── GPU spark pool (#7 — collision sparks) ────────────────────────────
  // 320, up from 160: the finish burst (game.js) throws 120 at once for your own top-10 crossing.
  const SPARKS = 320;
  const sparkPos = new Float32Array(SPARKS * 3);
  const sparkCol = new Float32Array(SPARKS * 3);
  const sparkVel = new Float32Array(SPARKS * 3);
  const sparkLife = new Float32Array(SPARKS);
  const sparkBase = new Float32Array(SPARKS * 3);
  const sparkGeo = new THREE.BufferGeometry();
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(sparkPos, 3));
  sparkGeo.setAttribute('color', new THREE.BufferAttribute(sparkCol, 3));
  const sparkMat = new THREE.PointsMaterial({
    size: 0.7, vertexColors: true, transparent: true,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const sparkPoints = new THREE.Points(sparkGeo, sparkMat);
  sparkPoints.frustumCulled = false;
  for (let i = 0; i < SPARKS; i++) { sparkPos[i * 3 + 1] = -9999; }
  scene.add(sparkPoints);
  let sparkHead = 0;
  const _col = new THREE.Color();

  function burstSparks(pos, colorHex, count = 9, strength = 1) {
    _col.set(colorHex ?? 0xffd9a0);
    for (let k = 0; k < count; k++) {
      const i = sparkHead; sparkHead = (sparkHead + 1) % SPARKS;
      sparkPos[i * 3] = pos.x; sparkPos[i * 3 + 1] = pos.y; sparkPos[i * 3 + 2] = pos.z;
      sparkVel[i * 3] = (Math.random() - 0.5) * 10 * strength;
      sparkVel[i * 3 + 1] = (Math.random() * 0.7 + 0.3) * 9 * strength;
      sparkVel[i * 3 + 2] = (Math.random() - 0.5) * 10 * strength;
      sparkLife[i] = 1;
      sparkBase[i * 3] = _col.r; sparkBase[i * 3 + 1] = _col.g; sparkBase[i * 3 + 2] = _col.b;
    }
  }

  // Multicolored confetti burst — reuses the spark pool but with random bright
  // colors and a strong upward pop. Fired when a marble crosses the finish line.
  const CONFETTI_COLORS = [0x22d3ee, 0xe879f9, 0xa3e635, 0xfb923c, 0xf87171, 0x60a5fa, 0xfde047, 0xf472b6, 0xffffff];
  function burstConfetti(pos, count = 24) {
    for (let k = 0; k < count; k++) {
      const i = sparkHead; sparkHead = (sparkHead + 1) % SPARKS;
      sparkPos[i * 3] = pos.x; sparkPos[i * 3 + 1] = pos.y + 1.2; sparkPos[i * 3 + 2] = pos.z;
      sparkVel[i * 3] = (Math.random() - 0.5) * 16;
      sparkVel[i * 3 + 1] = Math.random() * 12 + 7;
      sparkVel[i * 3 + 2] = (Math.random() - 0.5) * 16;
      sparkLife[i] = 1.3;
      _col.set(CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0]);
      sparkBase[i * 3] = _col.r; sparkBase[i * 3 + 1] = _col.g; sparkBase[i * 3 + 2] = _col.b;
    }
  }

  function updateSparks(dt) {
    let any = false;
    for (let i = 0; i < SPARKS; i++) {
      if (sparkLife[i] <= 0) continue;
      any = true;
      sparkLife[i] -= dt / 0.45;
      const l = Math.max(0, sparkLife[i]);
      sparkVel[i * 3 + 1] -= 26 * dt;
      sparkPos[i * 3] += sparkVel[i * 3] * dt;
      sparkPos[i * 3 + 1] += sparkVel[i * 3 + 1] * dt;
      sparkPos[i * 3 + 2] += sparkVel[i * 3 + 2] * dt;
      sparkCol[i * 3] = sparkBase[i * 3] * l;
      sparkCol[i * 3 + 1] = sparkBase[i * 3 + 1] * l;
      sparkCol[i * 3 + 2] = sparkBase[i * 3 + 2] * l;
      if (sparkLife[i] <= 0) { sparkPos[i * 3 + 1] = -9999; sparkCol[i * 3] = sparkCol[i * 3 + 1] = sparkCol[i * 3 + 2] = 0; }
    }
    if (any) { sparkGeo.attributes.position.needsUpdate = true; sparkGeo.attributes.color.needsUpdate = true; }
  }

  // ── Audio spatialization helper (#9) ──────────────────────────────────
  // Turns a world position into a stereo pan and a distance gain relative to the LIVE camera,
  // so audio.js never needs to know about the camera or three.js at all. Pan comes from the
  // projected NDC x, which is exactly "where on screen did this happen" — the thing a player
  // is actually looking at when the sound arrives.
  const _cue = new THREE.Vector3();
  const AUDIO_NEAR = 30;        // full volume within this distance
  const AUDIO_FAR = 420;        // floor volume at/after this distance
  const AUDIO_FLOOR = 0.18;     // distant events recede but never vanish
  function audioCue(pos) {
    _cue.set(pos.x, pos.y, pos.z);
    const dist = _cue.distanceTo(camera.position);
    _cue.project(camera);
    // NDC x is unbounded behind the camera; clamp so an off-screen event pans hard rather than
    // producing a nonsense pan value.
    const pan = Math.max(-1, Math.min(1, _cue.x));
    const t = Math.max(0, Math.min(1, (dist - AUDIO_NEAR) / (AUDIO_FAR - AUDIO_NEAR)));
    return { pan, gain: 1 - (1 - AUDIO_FLOOR) * t };
  }

  const camTarget = new THREE.Vector3();
  let haveTarget = false;
  let cutT = 0;                 // seconds left on the accelerated post-cut ease
  let fovPunch = 0;
  function punchFov() { fovPunch = -9; }

  // ── #3 grade state ────────────────────────────────────────────────────
  // Live values are eased toward the targets every frame so a grade change is always a
  // transition and never a cut.
  //
  // The radial blur (#2), vignette (#6) and chromatic aberration (#7) that used to be driven
  // from here are all removed; the grade is the only thing this pass still does.
  let gradeTo = GRADES.racing;
  const gradeNow = {
    tint: new THREE.Vector3(1, 1, 1), contrast: 1, saturation: 1,
  };

  // Name one of GRADES ('pick' | 'racing' | 'final' | 'win' | 'loss'). Unknown names are
  // ignored rather than throwing — the grade is decoration, and a typo here must never take
  // the render loop down mid-race.
  function setGrade(name) {
    const g = GRADES[name];
    if (g) gradeTo = g;
  }

  function updatePost(dt) {
    const k = 1 - Math.exp(-3.2 * dt);      // grade easing; slower than the FOV so it reads as a mood shift
    gradeNow.tint.x += (gradeTo.tint[0] - gradeNow.tint.x) * k;
    gradeNow.tint.y += (gradeTo.tint[1] - gradeNow.tint.y) * k;
    gradeNow.tint.z += (gradeTo.tint[2] - gradeNow.tint.z) * k;
    gradeNow.contrast += (gradeTo.contrast - gradeNow.contrast) * k;
    gradeNow.saturation += (gradeTo.saturation - gradeNow.saturation) * k;

    const u = post.uniforms;
    u.uTint.value.copy(gradeNow.tint);
    u.uContrast.value = gradeNow.contrast;
    u.uSaturation.value = gradeNow.saturation;
  }

  // ── Left-drag mouse orbit around the followed target ──────────────────
  let orbitYaw = 0;
  let orbitPitch = CAM_DEFAULT_PITCH; // start tilted down so the marble sits centered, not at the top
  let dragging = false;
  let lastX = 0, lastY = 0;
  const YAW_SPEED = 0.008, PITCH_SPEED = 0.006;
  const PITCH_MIN = -0.55, PITCH_MAX = 1.15;

  const canvas = renderer.domElement;
  canvas.style.cursor = 'grab';
  canvas.style.touchAction = 'none';

  const onPointerDown = (e) => {
    if (e.button !== 0) return;           // left button only
    dragging = true;
    lastX = e.clientX; lastY = e.clientY;
    canvas.style.cursor = 'grabbing';
    try { canvas.setPointerCapture(e.pointerId); } catch { }
  };
  const onPointerMove = (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    orbitYaw -= dx * YAW_SPEED;
    orbitPitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, orbitPitch + dy * PITCH_SPEED));
  };
  const onPointerUp = () => {
    dragging = false;
    canvas.style.cursor = 'grab';
  };
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);

  function resize() {
    // 2026-09-11 fix: clamp the measured host to the viewport. If the host
    // chain ever resolves content-driven (flex-basis:auto shell), sizing the
    // buffer to the host makes the canvas attribute itself the host's content
    // and the ResizeObserver doubles it every pass until the browser clamps
    // at 2^26 — the page ends up 33M px tall. No legitimate render needs more
    // than the viewport; three.js applies devicePixelRatio on top of this.
    const capW = Math.max(320, Math.round(window.innerWidth * 1.5));
    const capH = Math.max(320, Math.round(window.innerHeight * 1.5));
    const w = Math.min(container.clientWidth || 800, capW);
    const h = Math.min(container.clientHeight || 540, capH);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    composer.setSize(w, h);
    smaa.setSize(w, h);
    // Both of these own internal render targets sized independently of the
    // composer's; missing either leaves it sampling a stale buffer at the old
    // aspect, which shows up as the AO or the bokeh being stretched.
    if (gtao) gtao.setSize(w, h);
    rackFocus.setSize(w, h);
  }
  resize();
  window.addEventListener('resize', resize);
  // The window resize event only fires for viewport changes — it misses the
  // container growing/shrinking in place, which is exactly what happens when the
  // Blazor layout settles after init (fonts, intro card unmounting, the shell's
  // flex height). That race once left the canvas sized for a stale first
  // measurement. ResizeObserver covers both sources; the guard is for ancient
  // browsers where the window listener alone still works.
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(resize).observe(container);
  }

  // Smoothly move the camera to orbit-and-follow `pos`. With no drag this is the default
  // above-and-behind view; left-drag adds a yaw/pitch offset that rotates around the target.
  // `forward` (optional) is the track's full 3D heading at the followed marble. It places the
  // camera (behind along the track rather than behind in world -Z, and lifted by the climb of
  // the ground behind) as well as aiming it down-track along travel, so the road ahead reads
  // around curves and down the ramp. `speed` (optional) drives the speed-reactive FOV.
  function followTarget(pos, dt, snap, forward, speed) {
    // Track-relative framing. The offset used to be a fixed world -Z, which is wrong twice over
    // on this track: the chute TURNS (so "behind in -Z" can put the camera in FRONT of the
    // marble through a hairpin), and it DESCENDS at up to ~0.42 (so a fixed world-Y lift leaves
    // the eye below the 44-unit berms of the stretch behind, which then wall the shot in — the
    // pulled-back CAM_BACK made that unmissable). Offsetting along the track's own heading and
    // adding the climb of the ground behind keeps the eye CAM_HEIGHT above the *track surface*
    // it has to see over, on the flat and on the ramp alike.
    let fx = 0, fy = 0, fz = 1;                  // unit heading of travel; +Z when not supplied
    if (forward) {
      const L = Math.hypot(forward.x, forward.y, forward.z) || 1;
      fx = forward.x / L; fy = forward.y / L; fz = forward.z / L;
    }
    const fxz = Math.hypot(fx, fz) || 1;
    const horiz = CAM_BACK * Math.cos(orbitPitch);
    const vert = CAM_HEIGHT + CAM_BACK * Math.sin(orbitPitch);
    const climb = -(fy / fxz) * horiz;           // fy < 0 descending → the ground behind is higher
    // Backward heading rotated by the orbit yaw; yaw 0 → directly behind, matching the old
    // (sin, -cos) world offset when `forward` is +Z.
    const bx = -fx / fxz, bz = -fz / fxz;
    const cy = Math.cos(orbitYaw), sy = Math.sin(orbitYaw);
    const desired = new THREE.Vector3(
      pos.x + (bx * cy - bz * sy) * horiz,
      pos.y + vert + climb,
      pos.z + (bx * sy + bz * cy) * horiz);
    // `snap` no longer teleports. It arms CAM_CUT_TIME of accelerated easing, so a director's
    // cut still resolves in a few frames but travels rather than warping. The one true warp
    // left is placement: the first call, and the dt === 0 calls _buildTrack makes to frame the
    // start gate, where easing would move the camera nowhere at all.
    if (snap) cutT = CAM_CUT_TIME;
    const instant = !haveTarget || dt <= 0;
    const a = instant ? 1 : 1 - Math.exp(-(cutT > 0 ? CAM_CUT_LERP : CAM_LERP) * dt);
    cutT = Math.max(0, cutT - dt);
    camera.position.lerp(desired, a);

    // Look-ahead along the direction of travel (falls back to straight down-track). Only when
    // roughly behind the target, so it stays centred when orbited round. Lift the look-at point
    // so the marble (radius ≈ 1) sits ~mid-screen instead of clipped against the bottom edge.
    // The aim point rides the full 3D heading, so on the ramp it tracks the road DOWN instead of
    // floating above it — aiming a flat CAM_LOOKAHEAD ahead in XZ only pointed the camera at
    // empty air over a descent, which is half of why the ramp never read.
    const laFactor = Math.max(0, Math.cos(orbitYaw)) * CAM_LOOKAHEAD;
    const look = new THREE.Vector3(
      pos.x + fx * laFactor,
      pos.y + fy * laFactor + CAM_LOOK_LIFT,
      pos.z + fz * laFactor);
    if (!haveTarget) { camTarget.copy(look); haveTarget = true; }
    camTarget.lerp(look, a);
    camera.lookAt(camTarget);

    // Keep the shadow-casting key light (and its frustum) over the action for crisp shadows.
    // Quantised to the shadow texel grid (see SHADOW_TEXEL): following the marble's exact
    // position slid the shadow map by a fraction of a texel every frame, which boils every
    // shadow edge in the scene. Stepping in whole texels keeps the map stationary between
    // steps, so edges stay put.
    const qx = Math.round(pos.x / SHADOW_TEXEL) * SHADOW_TEXEL;
    const qy = Math.round(pos.y / SHADOW_TEXEL) * SHADOW_TEXEL;
    const qz = Math.round(pos.z / SHADOW_TEXEL) * SHADOW_TEXEL;
    key.position.set(qx + 28, qy + 70, qz - 18);
    key.target.position.set(qx, qy, qz + 6);
    key.target.updateMatrixWorld();

    // FOV: base + speed-reactive widening (#4) + start-line punch (#10), all eased toward.
    const spd = speed || 0;
    const speedT = Math.max(0, Math.min(1, (spd - FOV_SPEED_LO) / (FOV_SPEED_HI - FOV_SPEED_LO)));
    const targetFov = FOV_BASE + speedT * FOV_SPEED_ADD + fovPunch;
    camera.fov += (targetFov - camera.fov) * (1 - Math.exp(-5 * dt));
    camera.updateProjectionMatrix();
    fovPunch = Math.abs(fovPunch) > 0.05 ? fovPunch * Math.exp(-6 * dt) : 0;

    // §GFX-8 — camera shake, applied LAST so it offsets the final framing. Put
    // before lookAt it would be cancelled out, because lookAt recomputes the
    // orientation from the (already shaken) position and the shake would only
    // translate the eye without moving the image.
    PostFx.applyCameraShake(camera, performance.now() / 1000, 1.4);

    updateSparks(dt);
    updatePulses(dt);
    updatePost(dt);             // #3 colour grade
    rackFocus.update(dt);       // §GFX-2 — no-op unless a photo finish is running
  }

  return {
    scene,
    camera,
    renderer,
    // Handed to createMarbles so ONLY the marble materials get a specular environment (#3).
    marbleEnv: marbleEnv.texture,
    add(obj) { scene.add(obj); },
    remove(obj) { scene.remove(obj); },
    // True where the device can afford the heavy passes (GTAO, glass transmission).
    heavy: !!gtao,
    followTarget,
    burstSparks,
    burstConfetti,
    pulseLight,       // GFX #5
    setTheme,
    audioCue,         // #9
    setGrade,         // #3
    punchFov,
    /**
     * §GFX-2 — rack the focus for the photo finish. `distance` is how far the
     * winning marble is from the camera; the chase cam holds it at roughly
     * CAM_BACK, so that is the default and callers only need to pass a value if
     * they are framing something else.
     */
    photoFinish(distance) {
      rackFocus.trigger(distance == null ? CAM_BACK : distance, 1.1, 1);
    },
    render() { composer.render(); },
    resize,
    dispose() {
      window.removeEventListener('resize', resize);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      sparkGeo.dispose();
      sparkMat.dispose();
      marbleEnv.dispose();   // PMREM render target + its texture
      rackFocus.dispose();
      gtao?.dispose?.();
      composer.dispose();
      renderer.dispose();
      // …and hand the context back. dispose() only frees what three.js
      // allocated inside it; the context survives on the detached canvas until
      // GC runs, so hopping between the 3D games leaks one slot per visit out of
      // the browser's ~16 (see pobrawl/game.js dispose()).
      try { renderer.forceContextLoss?.(); } catch { /* context already gone */ }
      if (renderer.domElement && renderer.domElement.parentNode) {
        renderer.domElement.parentNode.removeChild(renderer.domElement);
      }
    },
  };
}
