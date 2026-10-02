// materials.js — the surface detail every creature, tree, hut and prop shares.
//
// The art direction is flat-shaded low-poly Lambert, and that stays. What was missing is
// everything a flat facet cannot say on its own: a silhouette against the ground, a
// surface that is not one uniform tone from nose to tail, leaves that move. Rather than
// swapping materials (a PBR material would fight the look and cost more per pixel), one
// onBeforeCompile hook injects three terms into MeshLambertMaterial:
//
//   RIM     a Fresnel-weighted light on the silhouette, tinted by the sky. A rabbit on
//           grass is brown on green; the rim is what separates them at twenty metres.
//   MOTTLE  world-space value noise on the diffuse colour — fur, bark, stone grain — at
//           a scale the caller chooses. Sampled in world space so instanced meshes get
//           different patterns without an extra attribute.
//   SWAY    a vertex displacement that grows with local height, driven by a shared clock
//           and offset by world position so a forest does not move in lockstep. Only the
//           crowns and bushes ask for it.
//
// One clock. `materialClock.value` is set once per frame by the renderer and every hooked
// material reads it, so a new material never needs its own uniform plumbing.
import * as THREE from 'three';

export const materialClock = { value: 0 };
export const materialDetail = { value: 1 };   // 0 on the low tier: every injected term collapses
export const materialSeason = { value: 0 };   // 0 = Spring, 1 = Summer, 2 = Autumn, 3 = Winter
export const materialSnow = { value: 0 };     // 0..1 snow coverage factor
// Weather on surfaces (GFX pass 2, idea 3): the sim's own ground wetness (weather.js), and
// the sky colour a wet surface reflects. Set once per frame by the renderer, like the clock.
export const materialWet = { value: 0 };
export const materialSky = { value: new THREE.Color(0x8ec5ff) };
// The naturalist lenses: how far a creature's instance colour replaces its lit
// colour. 0 = an ordinary tinted Lambert; 1 = the flat lens colour, readable in the dark.
// Only materials hooked with `lens: true` (the creatures) listen to it.
export const materialLens = { value: 0 };

// Cloud shadows. The deck sky.js draws is a noise field anchored to the world,
// so the same field, sampled where the sun's ray through a surface point meets the deck,
// says whether that point is in shade. The renderer sets these four once per frame from the
// sky it has just updated; the terrain binds the same objects (terrainMesh.js).
export const materialCloud = {
  uCloudTime: { value: 0 },
  uCloudCover: { value: 0.45 },
  uCloudShade: { value: 0 },                       // 0 = none (night, low tier, closed deck)
  uCloudSun: { value: new THREE.Vector3(0, 1, 0) },
};
/**
 * GLSL for the shade test. `noise` is the name of a vec2 → float value-noise function the
 * shader already has (every hooked shader carries the same hash, so the field matches the
 * clouds overhead). 96.0 is sky.js CLOUD_Y; the scale and drift are its CLOUD_FRAG's.
 */
export const cloudShadowGlsl = (noise) => `
uniform float uCloudTime;
uniform float uCloudCover;
uniform float uCloudShade;
uniform vec3 uCloudSun;
float cloudLight(vec3 world) {
  if (uCloudShade <= 0.001) return 1.0;
  vec2 at = world.xz + uCloudSun.xz * ((96.0 - world.y) / max(uCloudSun.y, 0.25));
  vec2 p = at * 0.006 + vec2(uCloudTime * 0.0045, uCloudTime * 0.0018);
  float n = ${noise}(p) * 0.55 + ${noise}(p * 2.3 + 7.1) * 0.3 + ${noise}(p * 5.1 - 3.3) * 0.15;
  float edge = mix(0.72, 0.42, uCloudCover);
  return 1.0 - smoothstep(edge - 0.04, edge + 0.26, n) * uCloudShade;
}
`;

const NOISE = `
float mHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float mNoise(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(mHash(i), mHash(i + vec2(1.0, 0.0)), u.x),
             mix(mHash(i + vec2(0.0, 1.0)), mHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
`;

/**
 * Hook a Lambert material. Returns the same material for chaining.
 * @param {THREE.MeshLambertMaterial} material
 * @param {{ rim?: number, rimColor?: number, mottle?: number, mottleScale?: number, sway?: number, swayHeight?: number, lens?: boolean }} o
 *   rim: strength (0 = off) · mottle: amplitude 0..1 · mottleScale: world units per cycle ·
 *   sway: metres of displacement at the top · swayHeight: local height over which sway ramps ·
 *   lens: follow materialLens (the creatures' data-view colours)
 */
export function enhanceLambert(material, { rim = 0.35, rimColor = 0xbfd4ff, mottle = 0.18, mottleScale = 1.6, sway = 0, swayHeight = 3, lens = false } = {}) {
  const rimCol = new THREE.Color(rimColor);
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, materialCloud);
    shader.uniforms.uLensGlow = lens ? materialLens : { value: 0 };
    shader.uniforms.uMatTime = materialClock;
    shader.uniforms.uMatDetail = materialDetail;
    shader.uniforms.uSeason = materialSeason;
    shader.uniforms.uSnow = materialSnow;
    shader.uniforms.uWet = materialWet;
    shader.uniforms.uSkyTint = materialSky;
    shader.uniforms.uRim = { value: rim };
    shader.uniforms.uRimColor = { value: rimCol };
    shader.uniforms.uMottle = { value: mottle };
    shader.uniforms.uMottleScale = { value: 1 / Math.max(0.05, mottleScale) };
    shader.uniforms.uSway = { value: sway };
    shader.uniforms.uSwayHeight = { value: Math.max(0.1, swayHeight) };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `
        #include <common>
        uniform float uMatTime;
        uniform float uSway;
        uniform float uSwayHeight;
        varying vec3 vMatWorld;
      `)
      // Sway before projection, in object space, so the instance matrix still applies.
      // The phase comes from the instance's world offset (its matrix translation) so
      // neighbouring trees never move together.
      .replace('#include <begin_vertex>', `
        #include <begin_vertex>
        if (uSway > 0.0) {
          #ifdef USE_INSTANCING
            vec2 anchor = instanceMatrix[3].xz;
          #else
            vec2 anchor = vec2(0.0);
          #endif
          float lift = clamp((transformed.y + uSwayHeight * 0.5) / uSwayHeight, 0.0, 1.0);
          float phase = uMatTime * 1.35 + anchor.x * 0.31 + anchor.y * 0.27;
          transformed.x += sin(phase) * uSway * lift * lift;
          transformed.z += cos(phase * 0.83 + 1.7) * uSway * 0.6 * lift * lift;
        }
      `)
      .replace('#include <project_vertex>', `
        #include <project_vertex>
        #ifdef USE_INSTANCING
          vMatWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        #else
          vMatWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
        #endif
      `);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `
        #include <common>
        uniform float uMatDetail;
        uniform float uRim;
        uniform vec3 uRimColor;
        uniform float uMottle;
        uniform float uMottleScale;
        uniform float uSeason;
        uniform float uSnow;
        uniform float uWet;
        uniform vec3 uSkyTint;
        uniform float uLensGlow;
        varying vec3 vMatWorld;
        ${NOISE}
        ${cloudShadowGlsl('mNoise')}
      `)
      .replace('#include <color_fragment>', `
        #include <color_fragment>
        if (uMatDetail > 0.5) diffuseColor.rgb *= cloudLight(vMatWorld);
        if (uMatDetail > 0.5 && uMottle > 0.0) {
          // Two octaves in world space; the vertical term keeps the pattern from streaking
          // down a trunk or a leg.
          vec3 w = vMatWorld * uMottleScale;
          float m = mNoise(w.xz + w.y * 0.7) * 0.6 + mNoise(w.xz * 2.9 - w.y * 1.3) * 0.4;
          diffuseColor.rgb *= 1.0 - uMottle * 0.5 + m * uMottle;
        }
      `)
      // Seasonal effects need the surface normal, and three only declares `normal` in
      // normal_fragment_begin — AFTER color_fragment. Injecting `normal.y` there made the
      // whole instanced Lambert program fail to compile ('normal' : undeclared identifier),
      // so every hooked creature/prop mesh drew as a garbage blob and flooded the console
      // with useProgram warnings (visible in renderer.info.programs).
      // normal is view-space; inverseTransformDirection (from <common>) gives world up.
      .replace('#include <normal_fragment_begin>', `
        #include <normal_fragment_begin>
        // Wet bark, wet fur, wet thatch: darker and a touch more saturated.
        diffuseColor.rgb *= 1.0 - uWet * 0.2;
        if (uSnow > 0.05) {
          float upNorm = clamp(inverseTransformDirection(normal, viewMatrix).y, 0.0, 1.0);
          float snowFactor = smoothstep(0.2, 0.75, upNorm) * uSnow;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92, 0.95, 0.98), snowFactor * 0.85);
        } else if (uSeason > 1.5 && uSeason < 2.5) {
          // Warm amber shift in Autumn
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(diffuseColor.r * 1.25, diffuseColor.g * 0.8, diffuseColor.b * 0.45), 0.35);
        }
      `)
      // Rim after the lighting sum: an additive, view-dependent term on the silhouette.
      .replace('#include <opaque_fragment>', `
        if (uMatDetail > 0.5 && uRim > 0.0) {
          vec3 viewDir = normalize(vViewPosition);
          float rimF = pow(1.0 - clamp(dot(normal, viewDir), 0.0, 1.0), 3.2);
          outgoingLight += uRimColor * rimF * uRim * (0.35 + 0.65 * diffuseColor.g);
          // A wet surface mirrors the sky along its silhouette — the sheen that tells the
          // eye it has been raining before it sees a single drop.
          outgoingLight += uSkyTint * rimF * uWet * 0.35;
        }
        // A lens draws the creature in its data colour (the instance colour, which three
        // exposes as vColor whenever an instanced mesh carries one), lit or not.
        #ifdef USE_COLOR
          if (uLensGlow > 0.001) outgoingLight = mix(outgoingLight, vColor.rgb, uLensGlow);
        #endif
        #include <opaque_fragment>
      `);
  };
  // A hooked material must not share a program with an unhooked one of the same type.
  material.customProgramCacheKey = () => `poeco-enh-${rim}-${mottle}-${mottleScale}-${sway}-${swayHeight}-${lens ? 1 : 0}`;
  return material;
}
