// arena.js — the fight ring, breakable props, low-poly crowd and lighting.
// Materials are MeshStandardMaterial so they read the key/rim lights and (optionally)
// the env map that the engine can attach at startup.
import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';

export const RING_HALF = 5.2; // playable clamp radius (ring is 12x12, keep a margin)

/**
 * No-op retained for API compatibility with game.js's teardown, which calls this
 * before its generic scene.traverse() walk.
 *
 * It used to release the planar-reflection floor's WebGLRenderTarget — a resource
 * a geometry/material traverse can never find, hence the dedicated hook. The
 * reflection floor is gone (2026-08-07), so there is nothing left to release, but
 * the export stays rather than being deleted along with its caller: the ordering
 * requirement it documents is the kind that gets silently reintroduced.
 */
export function disposeArenaReflector() { /* no reflector to dispose */ }

// Procedural ring-canvas texture: lavender-blue vinyl with scuff noise, a
// worn (lighter) center from footwork, and a faint center-ring logo.
let _canvasTex = null;
function ringCanvasTexture() {
  if (_canvasTex) return _canvasTex;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#3d4680';
  g.fillRect(0, 0, 256, 256);
  // Worn center: fighters shuffle here, the vinyl lightens.
  const wear = g.createRadialGradient(128, 128, 10, 128, 128, 120);
  wear.addColorStop(0, 'rgba(200,205,235,0.16)');
  wear.addColorStop(1, 'rgba(200,205,235,0)');
  g.fillStyle = wear;
  g.fillRect(0, 0, 256, 256);
  // Faint center-ring logo.
  g.strokeStyle = 'rgba(255,255,255,0.10)';
  g.lineWidth = 4;
  g.beginPath();
  g.arc(128, 128, 42, 0, Math.PI * 2);
  g.stroke();
  // Scuff noise.
  for (let i = 0; i < 2200; i++) {
    const v = Math.random();
    g.fillStyle = v > 0.5
      ? `rgba(255,255,255,${(v - 0.5) * 0.05})`
      : `rgba(0,0,20,${(0.5 - v) * 0.07})`;
    g.fillRect(Math.random() * 256, Math.random() * 256, 1 + Math.random() * 2, 1);
  }
  _canvasTex = new THREE.CanvasTexture(c);
  _canvasTex.colorSpace = THREE.SRGBColorSpace;
  return _canvasTex;
}

/**
 * @param {THREE.Scene} scene
 * @param {{rectAreaLights?: number}} [quality]
 *        rectAreaLights: how many of the two studio rig panels to build (0-2).
 *        Build-time only, and deliberately so — scene light counts are shader
 *        #defines, so adding or removing one recompiles every lit material in the
 *        scene at once. That stall is exactly what you must not introduce on a
 *        machine already dropping frames, so the count is fixed by the tier the
 *        game booted at rather than tracking live tier changes. See quality.js.
 */
export function buildArena(scene, quality = {}) {
  // 2026-07-26 browser audit #4: brighten the empty-hall background from
  // #0d0f1a to #1a2040. When the camera flies outside the ring edge and
  // points at empty space, the original near-black background read as "the
  // screen went black mid-match" to the user — even though the canvas was
  // rendering correctly. The new colour is still in the moody-arena
  // family but distinguishable from black on every monitor.
  scene.background = new THREE.Color(0x1a2040);
  // Exponential haze instead of the old far-plane linear fog: the fighters
  // (4-6 m from camera) stay clean while the crowd rows and hall edges melt
  // progressively into the dark — "smoky arena air". Slightly thinned (0.022
  // → 0.018) so the ring reads brighter after the env-map fill was removed.
  scene.fog = new THREE.FogExp2(0x1a2040, 0.018);

  // Outer floor.
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(120, 120),
    new THREE.MeshStandardMaterial({ color: 0x14172a, roughness: 0.95, metalness: 0.0 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.5;
  floor.receiveShadow = true;
  scene.add(floor);

  // The §GFX-2 planar-reflection floor was removed per user request (2026-08-07),
  // completing the reflection removal that had already taken out the IBL / env-map
  // pass (see game.js). The floor is now plainly opaque: it no longer goes
  // transparent to let a mirrored render show through from underneath, so nothing
  // else in the arena needs to compensate.

  const grid = new THREE.GridHelper(80, 40, 0x232848, 0x1a1e38);
  grid.position.y = -0.49;
  grid.material.opacity = 0.55;
  grid.material.transparent = true;
  scene.add(grid);

  // Ring platform.
  const ringMat = new THREE.MeshStandardMaterial({
    color: 0x2a3160, roughness: 0.85, metalness: 0.05,
  });
  const ring = new THREE.Mesh(new THREE.BoxGeometry(12, 0.5, 12), ringMat);
  ring.position.y = -0.25;
  ring.receiveShadow = true;
  scene.add(ring);

  // Ring canvas: procedurally textured matte vinyl — worn center, faint
  // ring logo, scuff noise. High roughness keeps the mat flat so it doesn't
  // mirror the house lights during the fight.
  const canvasMat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.95, metalness: 0.0,
    map: ringCanvasTexture(),
  });
  const top = new THREE.Mesh(new THREE.BoxGeometry(11.6, 0.04, 11.6), canvasMat);
  top.position.y = 0.02;
  top.receiveShadow = true;
  scene.add(top);

  // Corner posts — breakable. The engine listens for collisions against these.
  const postMat = new THREE.MeshStandardMaterial({
    color: 0x8a92c9, roughness: 0.7, metalness: 0.1,
  });
  const postGeo = new THREE.CylinderGeometry(0.08, 0.1, 1.5, 10);
  const posts = [];
  const half = 5.8;
  for (const x of [-half, half]) {
    for (const z of [-half, half]) {
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(x, 0.75, z);
      post.castShadow = true;
      post.receiveShadow = true;
      post.userData.breakable = true;
      post.userData.hp = 30;
      post.userData.maxHp = 30;
      post.userData.kind = 'post';
      post.userData.basePos = new THREE.Vector3(x, 0.75, z);
      scene.add(post);
      posts.push(post);

      // Foam topper for the post so it doesn't look like a bare pipe.
      const cap = new THREE.Mesh(
        new THREE.CylinderGeometry(0.12, 0.12, 0.1, 12),
        new THREE.MeshStandardMaterial({ color: 0xd0d4f0, roughness: 0.85 })
      );
      cap.position.set(x, 1.55, z);
      cap.castShadow = true;
      cap.userData.attachedTo = post;
      scene.add(cap);

      // Turnbuckle pads (idea #9): three cushioned pads wrapping each corner
      // post at the rope heights, in the corner's identity colour (red −X /
      // blue +X). Visual anchor for the corner HAZARD — the engine deals bonus
      // damage + a hard rebound when a fighter is knocked into a corner.
      const padColor = x < 0 ? 0xd23b30 : 0x3b6bff;
      const padMat = new THREE.MeshStandardMaterial({
        color: padColor, roughness: 0.55, metalness: 0.05,
        emissive: padColor, emissiveIntensity: 0.12,
      });
      const padGeo = new THREE.CylinderGeometry(0.17, 0.17, 0.26, 12);
      for (const py of [0.5, 0.9, 1.3]) {
        const pad = new THREE.Mesh(padGeo, padMat);
        pad.position.set(x, py, z);
        pad.castShadow = true;
        pad.userData.turnbuckle = true;
        scene.add(pad);
      }
    }
  }

  // Ropes: bendable bezier tubes with a spring-loaded midpoint. A fighter
  // pressed against the ring boundary bows the ropes on that side outward;
  // a hard rebound twangs them (see updateRopes / twangRope).
  const ropeMat = new THREE.MeshStandardMaterial({
    color: 0xd0d4f0, roughness: 0.85, metalness: 0.0,
  });
  const ropes = [];
  for (const y of [0.5, 0.9, 1.3]) {
    for (const axis of ['x', 'z']) {           // 'x' = runs along X (z = ±half)
      for (const sign of [-1, 1]) {
        const rope = {
          axis, sign, y, half,
          offset: 0, vel: 0, built: -1,
          mesh: new THREE.Mesh(undefined, ropeMat),
        };
        rope.mesh.geometry = ropeGeometry(rope);
        rope.built = 0;
        scene.add(rope.mesh);
        ropes.push(rope);
      }
    }
  }

  // Lights — slightly warmer key, bluer rim, plus a low ambient bounce so
  // PBR materials in shadow still read some colour. All handles are returned
  // so the engine can dim the house for the KO "lights down" cinematic.
  //
  // Intensity baseline bumped vs the previous pass: with the env-map fill
  // gone (no scene.environment, no IBL speculars) the rig has to carry the
  // scene's full ambient level on its own. The runtime values in
  // game.js::_updateLighting match these baselines — arena.js values are the
  // first-frame peak before the per-frame multiplier takes over.
  // Hemisphere is a flat, directionless fill: every unit of it raises the floor
  // of the image without ever creating a highlight. At 0.42 it was lifting the
  // whole frame into a mid-grey haze with no true blacks. Slightly raised
  // from the old 0.14 to 0.22 to compensate for the lost IBL fill, still well
  // below the old "haze" threshold so the contrast lever keeps working.
  const hemi = new THREE.HemisphereLight(0x9aa4ff, 0x1a1030, 0.22);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xfff1d0, 3.4);
  key.position.set(6, 12, 4);
  key.castShadow = true;
  // 2048 over the tight ±6.5 frustum. This was 4096 (idea #7, chasing a crisper
  // contact edge at the feet), which is a ~64 MB depth target re-rendering the
  // whole scene every frame — the second-largest fixed cost in the renderer after
  // the post chain. Over this frustum 2048 still lands ~157 texels per world metre
  // under the fighters, which is finer than PCFSoft's fixed kernel can resolve at
  // this camera distance, so the 4× memory and fill bought no visible edge.
  //
  // This is the BUILD-TIME default and equals the 'high' tier. quality.js retunes
  // it per tier immediately after buildArena — see BrawlGame._applyQuality.
  key.shadow.mapSize.set(2048, 2048);
  // Frustum hugs the ring (fight area is ±5.2, posts at ±5.8) — tighter
  // bounds roughly double the effective shadow resolution vs the old ±10.
  key.shadow.camera.left = -6.5;
  key.shadow.camera.right = 6.5;
  key.shadow.camera.top = 6.5;
  key.shadow.camera.bottom = -6.5;
  key.shadow.bias = -0.0005;
  // normalBias trades shadow acne for peter-panning: too high and contact
  // shadows detach from the feet, which is most of why the fighters read as
  // floating. 0.02 over this frustum is more than the geometry needs.
  key.shadow.normalBias = 0.008;
  // NOTE: shadow.radius is ignored by PCFSoftShadowMap (it only applies to
  // PCFShadowMap/VSM), so the old radius=4 here was dead config — the softness
  // you see is PCFSoft's fixed kernel scaled by texel size. Penumbra is
  // therefore controlled by mapSize vs frustum extent, not by this value.
  scene.add(key);

  const rim = new THREE.DirectionalLight(0x6070ff, 1.0);
  rim.position.set(-5, 6, -6);
  scene.add(rim);

  const fill = new THREE.PointLight(0xffe0a0, 0.6, 30, 1.4);
  fill.position.set(0, 6, 0);
  scene.add(fill);

  // Overhead ring spotlight — the classic bright-pool-over-the-ring look.
  // Casts its own shadow so the KO close-up gets a tight overhead shadow
  // under the fallen body; during the KO cinematic the engine brightens it
  // and retargets it onto the loser. Bumped from 1.1 → 1.6 to compensate for
  // the lost IBL speculars and to give the swinging rig a stronger read.
  const spot = new THREE.SpotLight(0xfff4e0, 1.6, 30, Math.PI / 4.5, 0.45, 1.2);
  spot.position.set(0, 11, 0);
  spot.target.position.set(0, 0, 0);
  spot.castShadow = true;
  // 1024, down from 2048. This map only ever reads during the KO push-in, but it
  // was rendering a second full shadow pass on every frame of every fight to stay
  // ready for it. 1024 holds up at that framing (the body fills the frame, so the
  // shadow is a few metres of world space, not the whole ring) at a quarter the cost.
  //
  // BUILD-TIME default = the 'high' tier; below high the spot stops casting
  // altogether. See quality.js.
  spot.shadow.mapSize.set(1024, 1024);
  spot.shadow.bias = -0.0005;
  spot.shadow.normalBias = 0.02;
  spot.shadow.radius = 6;
  scene.add(spot);
  scene.add(spot.target);

  // Studio rig panels: two RectAreaLights angled over the ring give the
  // broad soft speculars on the vinyl and gradient falloff on the fighters
  // that point/spot lights can't fake. No shadows (RectArea can't cast) —
  // the key/spot still own shadowing. Intensity bumped (2.6/1.8 → 3.4/2.6)
  // so the rig still reads "studio panels" without the IBL contribution.
  //
  // They are also the most expensive light type in the scene: each one adds a
  // linearly-transformed-cosine texture lookup to EVERY lit fragment of every
  // MeshPhysicalMaterial, and the fighters — the most-drawn objects in the frame —
  // are all physical. Hence the tier budget: two at 'high', one at 'medium', none
  // at 'low'. `rectA` is dropped before `rectB` so the surviving panel is the
  // cooler back-right one, which is what separates the fighters from the dark
  // backdrop; losing the warm front-left panel only flattens the key side, where
  // the directional key is already doing the work.
  const rectCount = quality.rectAreaLights ?? 2;
  let rectA = null;
  let rectB = null;
  if (rectCount > 0) {
    RectAreaLightUniformsLib.init();
    rectB = new THREE.RectAreaLight(0xdfe6ff, 2.6, 4.5, 3.2);
    rectB.position.set(3.6, 8.5, -3.6);
    rectB.lookAt(0, 0, 0);
    scene.add(rectB);
  }
  if (rectCount > 1) {
    rectA = new THREE.RectAreaLight(0xfff0d8, 3.4, 4.5, 3.2);
    rectA.position.set(-3.6, 8.5, 3.6);
    rectA.lookAt(0, 0, 0);
    scene.add(rectA);
  }

  // Corner identity lighting: red vs blue side, matching the HUD bars.
  // Fighters pick up a warm/cool gradient as they cross the ring. Bumped
  // (1.3 → 1.7) so the side tint still reads with the extra-direct rig.
  const cornerA = new THREE.PointLight(0xff3b30, 1.7, 8, 1.8);
  cornerA.position.set(-6.2, 1.4, 0);
  scene.add(cornerA);
  const cornerB = new THREE.PointLight(0x3b6bff, 1.7, 8, 1.8);
  cornerB.position.set(6.2, 1.4, 0);
  scene.add(cornerB);

  // Emissive apron trim: unlit strips along the canvas edges glow against
  // the dark arena (red side / blue side / dim violet ends).
  const trimRed = new THREE.MeshBasicMaterial({ color: 0xff5a4a });
  const trimBlue = new THREE.MeshBasicMaterial({ color: 0x4a7dff });
  const trimEnd = new THREE.MeshBasicMaterial({ color: 0x584a9c });
  const trimZ = new THREE.BoxGeometry(0.08, 0.05, 11.6);
  const trimX = new THREE.BoxGeometry(11.6, 0.05, 0.08);
  for (const [geo, mat, x, z] of [
    [trimZ, trimRed, -5.82, 0],
    [trimZ, trimBlue, 5.82, 0],
    [trimX, trimEnd, 0, -5.82],
    [trimX, trimEnd, 0, 5.82],
  ]) {
    const strip = new THREE.Mesh(geo, mat);
    strip.position.set(x, 0.06, z);
    scene.add(strip);
  }

  // Fake volumetrics: additive gradient cone under the spotlight + drifting
  // dust motes inside the beam.
  const atmo = buildAtmosphere(scene);

  // Backdrop architecture (idea #3): overhead truss rig, hanging banners and a
  // jumbotron fill the black void behind the crowd so the ring reads as an
  // event in a hall, not a lit island in a vacuum. All dim/emissive and far
  // from the camera — cheap, and the fog swallows their edges.
  const backdrop = buildBackdrop(scene);

  // Crowd: 4 rows of low-poly silhouettes around the ring.
  // They're tagged userData.crowd so we can bounce them on KOs (wave animation).
  const crowd = buildCrowd(scene);
  scene.add(crowd);

  // Camera-flash sprites sparkle in the crowd (a storm of them on KO).
  const flashes = buildCrowdFlashes(scene);
  // Phone screens held up in the stands for the last ten seconds and the result.
  const phones = buildPhoneLights(scene, crowd.userData.spots);

  return {
    posts, crowd, atmo, flashes, phones, ropes, backdrop,
    // The ring-mat material, so the engine can inject its knockdown ripple
    // (GFX/SOUND #10). Returned rather than looked up by traversal: `top` is
    // one of three boxes stacked at the ring and picking the right one from
    // outside would mean matching on dimensions.
    canvasMat,
    lights: { hemi, key, rim, fill, spot, cornerA, cornerB, rectA, rectB },
  };
}

// ── Backdrop architecture (idea #3) ─────────────────────────────────────────
// Everything here lives well outside the crowd ring and mostly above the
// fighters, so it never crowds the fight but gives the frame depth and a
// "big event" read: a square lighting truss overhead with rig-light blocks,
// four hanging banners, and a pair of emissive jumbotron screens. The
// jumbotron material is returned so the engine could pulse it, but it's fine
// left static.
function buildBackdrop(scene) {
  const group = new THREE.Group();
  group.userData.kind = 'backdrop';

  // Dark structural metal for trusses/frames — reads as silhouette against
  // the fog, catching only a little of the rig lights.
  const steel = new THREE.MeshStandardMaterial({
    color: 0x12141f, roughness: 0.7, metalness: 0.6,
  });

  // Overhead lighting truss: a square ring of box beams up in the rafters,
  // with cross-braces. Sits above the spotlight so its shadow never matters.
  const trussY = 9.4;
  const trussHalf = 7.5;
  const beamLong = new THREE.BoxGeometry(trussHalf * 2, 0.22, 0.22);
  const beamSideGeo = new THREE.BoxGeometry(0.22, 0.22, trussHalf * 2);
  for (const z of [-trussHalf, trussHalf]) {
    const beam = new THREE.Mesh(beamLong, steel);
    beam.position.set(0, trussY, z);
    group.add(beam);
  }
  for (const x of [-trussHalf, trussHalf]) {
    const beam = new THREE.Mesh(beamSideGeo, steel);
    beam.position.set(x, trussY, 0);
    group.add(beam);
  }
  // A few cross-braces so the truss reads as a lattice, not a bare square.
  const braceGeo = new THREE.BoxGeometry(trussHalf * 2, 0.1, 0.1);
  for (const z of [-3.5, 0, 3.5]) {
    const brace = new THREE.Mesh(braceGeo, steel);
    brace.position.set(0, trussY - 0.15, z);
    group.add(brace);
  }

  // Rig-light blocks clamped to the truss — small emissive lenses pointing
  // down at the ring. Purely decorative (the real lights are in buildArena).
  const lensGeo = new THREE.BoxGeometry(0.3, 0.18, 0.3);
  const lensColors = [0xfff2d0, 0xbcd0ff, 0xfff2d0, 0xffd0d0];
  let li = 0;
  for (const x of [-5, -1.7, 1.7, 5]) {
    for (const z of [-trussHalf, trussHalf]) {
      const lens = new THREE.Mesh(lensGeo, new THREE.MeshStandardMaterial({
        color: 0x0a0a0a, emissive: lensColors[li % lensColors.length],
        emissiveIntensity: 1.4, roughness: 0.4,
      }));
      lens.position.set(x, trussY - 0.28, z);
      // Tagged so the engine can find them without matching on geometry or
      // material shape (GFX/SOUND #10 — audio-reactive rig LEDs). Each lens
      // owns its own material, which is what lets them pulse independently.
      lens.userData.rigLens = true;
      lens.userData.baseEmissive = 1.4;
      group.add(lens);
      li++;
    }
  }

  // Hanging banners: tall vertical panels dropping from the truss on all four
  // sides, alternating red/blue to echo the corner identity. Unlit-ish
  // standard material so they sit back in the gloom.
  // Segmented so the cloth can ripple (idea #10): each banner gets its own
  // clone of this geometry and a stored rest pose that updateBanners waves.
  const bannerGeo = new THREE.PlaneGeometry(2.2, 4.0, 4, 12);
  const bannerRed = new THREE.MeshStandardMaterial({
    color: 0x6a1f22, roughness: 0.9, side: THREE.DoubleSide,
    emissive: 0x2a0a0c, emissiveIntensity: 0.4,
  });
  const bannerBlue = new THREE.MeshStandardMaterial({
    color: 0x1f2f6a, roughness: 0.9, side: THREE.DoubleSide,
    emissive: 0x0a1030, emissiveIntensity: 0.4,
  });
  const bannerSpots = [
    { x: -trussHalf + 0.3, z: 0, ry: Math.PI / 2, mat: bannerRed },
    { x: trussHalf - 0.3, z: 0, ry: Math.PI / 2, mat: bannerBlue },
    { x: 0, z: -trussHalf + 0.3, ry: 0, mat: bannerBlue },
    { x: 0, z: trussHalf - 0.3, ry: 0, mat: bannerRed },
  ];
  let bannerPhase = 0;
  for (const b of bannerSpots) {
    const geo = bannerGeo.clone();
    const banner = new THREE.Mesh(geo, b.mat);
    banner.position.set(b.x, trussY - 2.3, b.z);
    banner.rotation.y = b.ry;
    banner.userData.banner = true;
    banner.userData.phase = (bannerPhase += 1.7);
    // Rest pose for the ripple solve (local-space vertex positions).
    banner.userData.base = geo.attributes.position.array.slice();
    group.add(banner);
  }

  // Jumbotron: two big emissive screens on the far ends (behind the crowd on
  // the ±Z sides, high up). A dim procedural "static" texture reads as a live
  // feed from a distance without needing to render one.
  const screenTex = jumbotronTexture();
  const screenMat = new THREE.MeshBasicMaterial({ map: screenTex, fog: true });
  const frameGeo = new THREE.BoxGeometry(6.4, 3.4, 0.3);
  const screenGeo = new THREE.PlaneGeometry(6.0, 3.0);
  for (const sign of [-1, 1]) {
    const frame = new THREE.Mesh(frameGeo, steel);
    frame.position.set(0, 6.4, sign * 14);
    group.add(frame);
    // Screen sits 0.16 toward the ring from its frame so the frame never
    // occludes it, and faces inward (the −z screen faces +z, and vice-versa).
    const screen = new THREE.Mesh(screenGeo, screenMat);
    screen.position.set(0, 6.4, sign * 13.84);
    screen.rotation.y = sign > 0 ? Math.PI : 0;
    group.add(screen);
  }

  group.userData.screenMat = screenMat;
  scene.add(group);
  return group;
}

// Procedural jumbotron screen: a dim bluish glow with scanline banding and a
// blocky "crowd cam" smear — legible as a big screen only from across the hall.
let _jumboTex = null;
function jumbotronTexture() {
  if (_jumboTex) return _jumboTex;
  const c = document.createElement('canvas');
  c.width = 128; c.height = 64;
  const g = c.getContext('2d');
  g.fillStyle = '#0a1428';
  g.fillRect(0, 0, 128, 64);
  // Blocky colour smears — a fuzzy, unreadable live feed.
  for (let i = 0; i < 60; i++) {
    const hue = 200 + Math.random() * 60;
    g.fillStyle = `hsla(${hue}, 40%, ${30 + Math.random() * 30}%, 0.5)`;
    g.fillRect(Math.random() * 128, Math.random() * 64, 4 + Math.random() * 10, 3 + Math.random() * 8);
  }
  // Scanlines.
  g.fillStyle = 'rgba(0,0,0,0.35)';
  for (let y = 0; y < 64; y += 2) g.fillRect(0, y, 128, 1);
  _jumboTex = new THREE.CanvasTexture(c);
  _jumboTex.colorSpace = THREE.SRGBColorSpace;
  return _jumboTex;
}

// ── Rope physics ──────────────────────────────────────────────────────────
// Each rope is a quadratic-bezier tube whose midpoint control rides a
// damped spring. Pressing bows it outward (and slightly down); releasing
// twangs it back with an underdamped snap.
const _ropeA = new THREE.Vector3();
const _ropeM = new THREE.Vector3();
const _ropeB = new THREE.Vector3();
function ropeGeometry(rope) {
  const { axis, sign, y, half, offset } = rope;
  if (axis === 'x') {
    _ropeA.set(-half, y, sign * half);
    _ropeB.set(half, y, sign * half);
    _ropeM.set(0, y - Math.abs(offset) * 0.18, sign * (half + offset * 1.6));
  } else {
    _ropeA.set(sign * half, y, -half);
    _ropeB.set(sign * half, y, half);
    _ropeM.set(sign * (half + offset * 1.6), y - Math.abs(offset) * 0.18, 0);
  }
  return new THREE.TubeGeometry(
    new THREE.QuadraticBezierCurve3(_ropeA.clone(), _ropeM.clone(), _ropeB.clone()),
    12, 0.022, 6);
}

// Per-frame rope solve. `fighters` is the engine's fighter list; a body
// leaning past the clamp margin presses the ropes on that side.
export function updateRopes(arena, dt, fighters, t = 0) {
  if (!arena.ropes) return;
  const pressStart = RING_HALF - 0.55; // bodies this far out start pressing
  for (const rope of arena.ropes) {
    // Idle sway (idea #10): a gentle continuous breathing so the ropes never
    // sit dead-still. Tiny amplitude — the press response below dominates.
    let target = 0.012 * Math.sin(t * 1.25 + rope.y * 3.1 + (rope.axis === 'x' ? 0 : 1.6));
    if (fighters) {
      for (const f of fighters) {
        const p = f.rig.root.position;
        const along = rope.axis === 'x' ? p.x : p.z;
        const out = (rope.axis === 'x' ? p.z : p.x) * rope.sign;
        if (Math.abs(along) > rope.half - 0.4) continue; // near the posts, not the span
        const press = out - pressStart;
        if (press > 0) {
          // The middle rope (torso height) takes the most load.
          const w = rope.y === 0.9 ? 1.1 : 0.6;
          target = Math.max(target, Math.min(0.55, press * w));
        }
      }
    }
    // Underdamped spring toward the press target — released ropes twang.
    rope.vel += ((target - rope.offset) * 55 - rope.vel * 7) * dt;
    rope.offset += rope.vel * dt;
    if (Math.abs(rope.offset - rope.built) > 0.004) {
      rope.mesh.geometry.dispose();
      rope.mesh.geometry = ropeGeometry(rope);
      rope.built = rope.offset;
    }
  }
}

// Impulse a side's ropes (rebound off the boundary): axis 'x'|'z' is the
// world axis the fighter was clamped on, sign which side.
export function twangRope(arena, clampAxis, sign, power = 1) {
  if (!arena.ropes) return;
  for (const rope of arena.ropes) {
    // A clamp on world X hits the ropes that run along Z at x = sign*half.
    const runsAlong = clampAxis === 'x' ? 'z' : 'x';
    if (rope.axis === runsAlong && rope.sign === sign) {
      rope.vel += 2.6 * power;
    }
  }
}

// ── Banner cloth ripple (idea #10) ─────────────────────────────────────────
// A cheap "soft-body" pass over the hanging banners: each vertex is pushed
// out-of-plane by a traveling wave whose amplitude grows toward the free
// bottom edge (the top hem is pinned to the truss). No solver, no constraints
// — a driven wave reads as a banner breathing in the hall's air currents.
export function updateBanners(backdrop, t) {
  if (!backdrop) return;
  backdrop.traverse((o) => {
    if (!o.userData || !o.userData.banner || !o.geometry) return;
    const pos = o.geometry.attributes.position;
    const base = o.userData.base;
    const ph = o.userData.phase || 0;
    for (let i = 0; i < pos.count; i++) {
      const bx = base[i * 3], by = base[i * 3 + 1];
      // by spans [-2, 2] (height 4); +2 is the pinned top, -2 the free bottom.
      const droop = (2.0 - by) / 4.0;            // 0 at top → 1 at bottom
      const amp = 0.22 * droop * droop;
      const z = amp * Math.sin(t * 1.7 + bx * 1.6 + by * 0.7 + ph);
      pos.array[i * 3 + 2] = base[i * 3 + 2] + z;
      // A little lateral drift near the bottom so it doesn't wave like a flag
      // on a rigid pole.
      pos.array[i * 3] = bx + amp * 0.4 * Math.sin(t * 1.1 + by * 0.9 + ph);
    }
    pos.needsUpdate = true;
    // Normals are intentionally NOT recomputed each frame — these are dim
    // backdrop banners, and per-frame computeVertexNormals was a needless
    // main-thread cost (it contributed to countdown-time frame hitches). The
    // silhouette ripple reads fine with static normals.
  });
}

// ── Atmosphere: light shaft + dust ────────────────────────────────────────
// The cone is a cheap "volumetric" — an open cylinder with a vertical
// alpha-gradient, additive-blended so it reads as light in smoky air.
function buildAtmosphere(scene) {
  const c = document.createElement('canvas');
  c.width = 1; c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 64);
  grad.addColorStop(0, 'rgba(255,244,224,0.55)');
  grad.addColorStop(1, 'rgba(255,244,224,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 1, 64);
  const tex = new THREE.CanvasTexture(c);

  const cone = new THREE.Mesh(
    new THREE.CylinderGeometry(0.35, 4.2, 10, 24, 1, true),
    new THREE.MeshBasicMaterial({
      map: tex, transparent: true, opacity: 0.09,
      blending: THREE.AdditiveBlending, depthWrite: false,
      side: THREE.DoubleSide, fog: false,
    })
  );
  cone.position.y = 5.6;
  cone.renderOrder = 2;
  scene.add(cone);

  // (Floating dust motes removed per user request — the shaft alone carries
  // the volumetric read.)
  return { cone };
}

// Pool of billboard sprites reused as crowd camera flashes. Kept in their
// own group (same coordinate space — the crowd group has no transform) so
// animateCrowd's child loop never touches them.
function buildCrowdFlashes(scene) {
  const group = new THREE.Group();
  const pool = [];
  // Soft round glow. Without a map a sprite is a hard square — invisible at the
  // crowd's 0.14 m, obvious at the press row's 0.4 m (pressBurst).
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.8)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 32);
  const glow = new THREE.CanvasTexture(c);
  for (let i = 0; i < 20; i++) {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glow, color: 0xffffff, transparent: true, opacity: 0,
      depthWrite: false, fog: false,
    }));
    s.scale.setScalar(0.14);
    s.visible = false;
    group.add(s);
    pool.push({ sprite: s, life: 0 });
  }
  scene.add(group);
  return pool;
}

// Phone lights (2026-09-29): small cool-white sprites a little above random
// heads. One pool, faded as a group by the `phones` level updateAtmosphere gets;
// each sways on its own phase so the stands look held, not pinned.
function buildPhoneLights(scene, spots) {
  const group = new THREE.Group();
  const pool = [];
  const mat = new THREE.SpriteMaterial({
    color: 0xdfe8ff, transparent: true, opacity: 0, depthWrite: false, fog: false,
  });
  for (let i = 0; i < 36 && spots.length; i++) {
    const m = spots[(Math.random() * spots.length) | 0];
    const s = new THREE.Sprite(mat);
    s.scale.set(0.06, 0.1, 1);
    s.userData.base = new THREE.Vector3(m.x, m.y + 0.32 + Math.random() * 0.12, m.z);
    s.userData.phase = Math.random() * Math.PI * 2;
    s.position.copy(s.userData.base);
    group.add(s);
    pool.push(s);
  }
  group.visible = false;
  scene.add(group);
  return { group, pool, mat };
}

// Press row (2026-09-29): a burst of bigger, HDR-bright flashes at ringside —
// heavy hits, supers and the KO. Borrows the crowd-flash pool; `delay` staggers
// the pops so a burst reads as several photographers, not one strobe.
const PRESS_R = 6.6;
export function pressBurst(arena, n) {
  const flashes = arena?.flashes;
  if (!flashes) return;
  for (let i = 0; i < n; i++) {
    const free = flashes.find((f) => f.life <= 0 && !(f.delay > 0));
    if (!free) return;
    const a = Math.random() * Math.PI * 2;
    const r = PRESS_R + Math.random() * 0.5;
    free.sprite.position.set(Math.sin(a) * r, 0.9 + Math.random() * 0.7, Math.cos(a) * r);
    free.sprite.scale.setScalar(0.34 + Math.random() * 0.12);
    // > 1 is deliberate: the composer is HDR, so the bloom pass flares these.
    free.sprite.material.color.setScalar(2.4);
    free.dur = free.life = 0.12;
    free.delay = i === 0 ? 0.0001 : Math.random() * 0.35;
    free.sprite.visible = false;
  }
}

// Per-frame atmosphere update: dust drifts down the beam and wraps; crowd
// flashes fire occasionally at rest and in a storm while `excited` > 0; phone
// lights fade with `phones` (0..1).
export function updateAtmosphere(arena, dt, t, excited, phones = 0) {
  const { flashes, crowd } = arena;
  if (flashes && crowd) {
    const rate = 1.2 + excited * 22; // expected flashes per second
    if (Math.random() < rate * dt) {
      const free = flashes.find((f) => f.life <= 0 && !(f.delay > 0));
      const spots = crowd.userData.spots;
      if (free && spots && spots.length) {
        const m = spots[(Math.random() * spots.length) | 0];
        free.sprite.position.set(
          m.x + (Math.random() - 0.5) * 0.3,
          m.y + 0.15 + Math.random() * 0.25,
          m.z + (Math.random() - 0.5) * 0.3
        );
        free.sprite.scale.setScalar(0.14);
        free.sprite.material.color.setScalar(1);
        free.dur = free.life = 0.09;
        free.sprite.visible = true;
      }
    }
    for (const f of flashes) {
      if (f.delay > 0) {
        f.delay -= dt;
        if (f.delay > 0) continue;
        f.sprite.visible = true;
      }
      if (f.life > 0) {
        f.life -= dt;
        f.sprite.material.opacity = Math.max(0, f.life / (f.dur || 0.09));
        if (f.life <= 0) f.sprite.visible = false;
      }
    }
  }
  const ph = arena.phones;
  if (ph) {
    ph.group.visible = phones > 0.01;
    if (ph.group.visible) {
      ph.mat.opacity = Math.min(1, phones) * 0.9;
      for (const s of ph.pool) {
        const b = s.userData.base, q = s.userData.phase + t * 0.9;
        s.position.set(b.x + Math.sin(q) * 0.06, b.y + Math.sin(q * 1.3) * 0.03, b.z);
      }
    }
  }
}

// GPU-instanced crowd: all torsos in one InstancedMesh, all heads in another
// (2 draw calls total, was ~290 as individual meshes). The idle sway and the
// excited bounce moved into the vertex shader — a per-instance phase
// attribute plus shared uTime/uExcited uniforms displace each spectator.
// Instances only rotate about Y, so an object-space +Y offset in
// begin_vertex IS a world-space bounce.
function crowdBounceMaterial(uniforms) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uExcited = uniforms.uExcited;
    shader.vertexShader = `
      uniform float uTime;
      uniform float uExcited;
      attribute float aPhase;
    ` + shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      float crowdPhase = aPhase + uTime * 1.4;
      transformed.y += sin(crowdPhase) * 0.025
        + sin(crowdPhase * 1.8) * 0.18 * uExcited;`);
  };
  return mat;
}

function buildCrowd(scene) {
  const group = new THREE.Group();
  group.userData.kind = 'crowd';

  const skins = [0xb88a6a, 0x6b4a32, 0xd8a67f, 0x8a5d3f];
  const shirts = [0x4a4a4a, 0x252540, 0x5a2f2f, 0x2f4a3a, 0x3a3a5c, 0x6b5a2f];

  const ring = 7.6;
  const rows = [
    { r: ring, count: 24 },
    { r: ring + 1.6, count: 32 },
    { r: ring + 3.4, count: 40 },
    { r: ring + 5.5, count: 48 },
  ];
  const total = rows.reduce((n, r) => n + r.count, 0);

  const uniforms = { uTime: { value: 0 }, uExcited: { value: 0 } };
  const torsoMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.42, 0.9, 0.28), crowdBounceMaterial(uniforms), total);
  const headMesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.24, 0.26, 0.24), crowdBounceMaterial(uniforms), total);
  torsoMesh.castShadow = false;
  headMesh.castShadow = false;

  const phases = new Float32Array(total);
  const spots = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const color = new THREE.Color();

  let id = 0;
  for (const row of rows) {
    for (let i = 0; i < row.count; i++) {
      const a = (i / row.count) * Math.PI * 2 + (Math.random() - 0.5) * 0.05;
      const x = Math.sin(a) * row.r + (Math.random() - 0.5) * 0.4;
      const z = Math.cos(a) * row.r + (Math.random() - 0.5) * 0.4;
      const y = -0.45;
      const heightJitter = 0.92 + Math.random() * 0.18;
      const yaw = Math.atan2(-x, -z) + (Math.random() - 0.5) * 0.6;
      q.setFromAxisAngle(up, yaw);

      // Torso: height jitter via Y scale (its box is 0.9 tall around origin).
      s.set(1, heightJitter, 1);
      p.set(x, y + 0.45 * heightJitter, z);
      m.compose(p, q, s);
      torsoMesh.setMatrixAt(id, m);
      torsoMesh.setColorAt(id, color.setHex(shirts[(Math.random() * shirts.length) | 0]));

      s.set(1, 1, 1);
      p.set(x, y + 1.05 * heightJitter, z);
      m.compose(p, q, s);
      headMesh.setMatrixAt(id, m);
      headMesh.setColorAt(id, color.setHex(skins[(Math.random() * skins.length) | 0]));

      phases[id] = Math.random() * Math.PI * 2;
      spots.push({ x, y: y + 1.05 * heightJitter, z });
      id++;
    }
  }
  const phaseAttr = new THREE.InstancedBufferAttribute(phases, 1);
  torsoMesh.geometry.setAttribute('aPhase', phaseAttr);
  headMesh.geometry.setAttribute('aPhase', phaseAttr);
  torsoMesh.instanceMatrix.needsUpdate = true;
  headMesh.instanceMatrix.needsUpdate = true;
  if (torsoMesh.instanceColor) torsoMesh.instanceColor.needsUpdate = true;
  if (headMesh.instanceColor) headMesh.instanceColor.needsUpdate = true;

  group.add(torsoMesh, headMesh);
  group.userData.uniforms = uniforms;
  // Head positions for the camera-flash sprites (updateAtmosphere).
  group.userData.spots = spots;
  return group;
}

// Animate the crowd: the sway/bounce runs in the vertex shader now — this
// just feeds the clock and excitement uniforms. Called from the engine's
// _updateCrowd at render rate.
export function animateCrowd(crowd, dt, t, excited) {
  if (!crowd || !crowd.userData.uniforms) return;
  crowd.userData.uniforms.uTime.value = t;
  crowd.userData.uniforms.uExcited.value = excited;
}

// Knock chunks off a post on collision. Returns the debris meshes for the engine
// to integrate into its particle update list.
const _debrisGeo = new THREE.BoxGeometry(0.18, 0.06, 0.18);
const _debrisMat = new THREE.MeshStandardMaterial({ color: 0x8a92c9, roughness: 0.6 });
export function damagePost(post, dmg, scene) {
  if (!post || !post.userData.breakable) return [];
  post.userData.hp -= dmg;
  const debris = [];
  if (post.userData.hp <= 0 && post.userData.hp > -1000) {
    post.userData.hp = -1000; // sentinel to avoid re-spawning
    // Spawn 3-5 wood chunks that fly outward and fall.
    const chunks = 4 + Math.floor(Math.random() * 2);
    for (let i = 0; i < chunks; i++) {
      const chunk = new THREE.Mesh(_debrisGeo, _debrisMat.clone());
      chunk.position.copy(post.userData.basePos);
      chunk.userData.kind = 'debris';
      chunk.userData.vel = new THREE.Vector3(
        (Math.random() - 0.5) * 4,
        Math.random() * 4 + 2,
        (Math.random() - 0.5) * 4
      );
      chunk.userData.angVel = new THREE.Vector3(
        (Math.random() - 0.5) * 8,
        (Math.random() - 0.5) * 8,
        (Math.random() - 0.5) * 8
      );
      chunk.userData.life = 1.5;
      scene.add(chunk);
      debris.push(chunk);
    }
    // Hide the post so it doesn't visually remain.
    post.visible = false;
    // Remove attached cap.
    post.parent && post.parent.traverse?.((o) => {
      if (o.userData && o.userData.attachedTo === post) o.visible = false;
    });
  }
  return debris;
}