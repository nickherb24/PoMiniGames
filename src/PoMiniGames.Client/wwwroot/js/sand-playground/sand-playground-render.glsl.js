// AUTO-WRAPPED GLSL — do not fetch this as a raw .glsl asset.
//
// The SandPlayground page is routed at /sandplayground, so a relative shader fetch
// would resolve against the route rather than the app root,
// and 404. Shipping the shader source as an ES module also keeps it inside the
// module graph, so it is fingerprinted and cached with the engine instead of
// arriving as a second, uncacheable round-trip.
//
// Sections are delimited by `//====== NAME ======` and split by parseSections()
// in sand-playground-engine.js.
export const source = `
//====== VERTEX ======
#version 300 es
layout(location = 0) in vec2 a_pos;
out vec2 v_uv;
void main() {
    v_uv = a_pos * 0.5 + 0.5;
    gl_Position = vec4(a_pos, 0.0, 1.0);
}

//====== RENDER ======
#version 300 es
// Scene pass: material shading (wetness, strata, scorch, vitrified glass),
// water flow shimmer + refraction + caustics, micro-relief and ambient
// occlusion, column-depth ambience (dark caverns) and the propagated dynamic
// light field. Renders into the scene FBO; alpha carries the emissive mask
// that drives the bloom chain. Distortion/shake/tonemap live in COMPOSITE.
precision highp float;
precision highp int;

uniform sampler2D u_state;
uniform sampler2D u_light;    // half-res propagated light field
uniform sampler2D u_heights;  // 800x1: column surface height / 600
uniform sampler2D u_smoke;    // half-res advected field: R = smoke, G = vapour
uniform float u_time;
uniform vec4 u_sky;           // sun elevation -1..1, overcast 0..1, lightning 0..1, sun x 0..1
uniform int u_view;           // 0 = normal, 1 = support, 2 = water pressure, 3 = moisture
in vec2 v_uv;
out vec4 outColor;

const int W = 800;
const int H = 600;
const int AIR = 0, SAND = 1, CONCRETE = 2, WATER = 3, BEDROCK = 4;
const float COHESION_THRESH = 0.25;

vec4 get(ivec2 p) {
    if (p.y < 0) return vec4(240.0 / 255.0, 0.0, 0.0, 1.0);
    if (p.x < 0 || p.x >= W || p.y >= H) return vec4(0.0);
    return texelFetch(u_state, p, 0);
}

int matOf(vec4 c) { return (int(floor(c.r * 255.0 + 0.5)) + 30) / 60; }
bool solidM(int m) { return m == SAND || m == CONCRETE || m == BEDROCK; }
float wetOf(vec4 c) {
    if (matOf(c) != SAND) return 0.0;
    float rb = floor(c.r * 255.0 + 0.5);
    if (rb >= 85.0) return 20.0;
    float w = rb - 60.0;
    return (w <= 20.0) ? w : 0.0;
}
float shockOf(vec4 c) { return matOf(c) == AIR ? c.b : 0.0; }

float waterMask(ivec2 p) { return matOf(get(p)) == WATER ? 1.0 : 0.0; }
vec2 waterNormal(ivec2 p) {
    float gx = waterMask(p + ivec2(-2, 0)) + 2.0 * waterMask(p + ivec2(-1, 0))
             - waterMask(p + ivec2( 2, 0)) - 2.0 * waterMask(p + ivec2( 1, 0));
    float gy = waterMask(p + ivec2(0, -2)) + 2.0 * waterMask(p + ivec2(0, -1))
             - waterMask(p + ivec2(0,  2)) - 2.0 * waterMask(p + ivec2(0,  1));
    return normalize(vec2(gx, gy) + vec2(0.0, 0.001));
}

float hash(vec2 q) {
    return fract(sin(dot(q, vec2(127.1, 311.7))) * 43758.5453123);
}

// Sky colour at height t (0 = horizon, 1 = zenith) for the current sun.
vec3 skyColor(float t) {
    float day = smoothstep(-0.12, 0.25, u_sky.x);
    float dusk = 1.0 - smoothstep(0.0, 0.45, abs(u_sky.x));
    vec3 dayC = mix(vec3(0.76, 0.88, 0.94), vec3(0.25, 0.44, 0.72), clamp(pow(t, 1.6), 0.0, 1.0));
    vec3 nightC = mix(vec3(0.07, 0.09, 0.17), vec3(0.012, 0.016, 0.045), t);
    vec3 c = mix(nightC, dayC, day);
    c = mix(c, mix(vec3(1.0, 0.56, 0.28), vec3(0.42, 0.30, 0.46), t), dusk * 0.7 * (1.0 - t * 0.5));
    c = mix(c, vec3(dot(c, vec3(0.33))) * vec3(0.78, 0.82, 0.88), u_sky.y * 0.75);
    return c + vec3(0.75, 0.80, 1.0) * u_sky.z * 0.6;
}

// Blue -> cyan -> green -> yellow -> red.
vec3 ramp(float t) {
    t = clamp(t, 0.0, 1.0);
    return clamp(vec3(1.5 - abs(4.0 * t - 3.0), 1.5 - abs(4.0 * t - 2.0), 1.5 - abs(4.0 * t - 1.0)), 0.0, 1.0);
}

// X-ray views: the simulation's own fields, drawn instead of the materials.
vec3 xray(vec4 self, int m, ivec2 p) {
    float rb = floor(self.r * 255.0 + 0.5);
    bool glass = m == SAND && rb >= 81.0 && rb <= 84.0;
    if (m == CONCRETE || m == BEDROCK) return vec3(m == CONCRETE ? 0.62 : 0.34);
    if (m == AIR) return vec3(0.015, 0.02, 0.03);
    if (u_view == 1) {
        // Support: how much of the arch reserve is left. Red is about to go.
        if (m == WATER) return vec3(0.04, 0.09, 0.16);
        vec3 c = ramp(1.0 - self.a);
        if (self.a < COHESION_THRESH) c = mix(c, vec3(1.0), 0.5 + 0.5 * sin(u_time * 9.0 + float(p.x + p.y)));
        return c;
    }
    if (u_view == 2) {
        // Hydrostatic head, brightened by flow speed.
        if (m == SAND) return rb >= 85.0 ? vec3(0.10, 0.20, 0.34) : vec3(0.10, 0.09, 0.08);
        float sp = length(self.gb - vec2(0.5)) * 255.0 / 62.0;
        return ramp(self.a * 255.0 / 90.0) * (0.55 + 0.9 * clamp(sp, 0.0, 1.0));
    }
    // Moisture: dry tan -> damp blue, saturated cyan, glass green.
    if (m == WATER) return vec3(0.04, 0.16, 0.55);
    if (glass) return vec3(0.25, 0.90, 0.50);
    if (rb >= 85.0) return vec3(0.30, 0.92, 1.0);
    return mix(vec3(0.50, 0.38, 0.20), vec3(0.10, 0.42, 0.95), wetOf(self) / 20.0);
}

void main() {
    ivec2 p = ivec2(v_uv * vec2(float(W), float(H)));
    p = clamp(p, ivec2(0), ivec2(W - 1, H - 1));

    vec4 self = get(p);
    int m = matOf(self);
    float g = hash(vec2(p) * 0.7131); // static per-position grain seed

    if (u_view != 0) { outColor = vec4(xray(self, m, p), 0.0); return; }

    float day = smoothstep(-0.12, 0.25, u_sky.x);
    // What daylight is left to fall on the ground: a cool, dim night that a
    // blast or a bolt lights back up.
    vec3 dayTint = mix(vec3(0.44, 0.50, 0.74), vec3(1.0), day) * (1.0 - 0.28 * u_sky.y)
                 + vec3(0.6, 0.65, 0.8) * u_sky.z;

    vec4 up = get(p + ivec2(0, 1));
    vec4 dn = get(p + ivec2(0, -1));
    vec4 lf = get(p + ivec2(-1, 0));
    vec4 rt = get(p + ivec2(1, 0));
    int mu = matOf(up), md = matOf(dn), ml = matOf(lf), mr = matOf(rt);

    float speck = floor(g * 3.0) / 2.0; // 0, 0.5, 1.0

    // How deep this cell sits below its column's ground surface (0 = open).
    float colTop = texture(u_heights, vec2((float(p.x) + 0.5) / float(W), 0.5)).r * float(H);
    float depthBelow = max(0.0, colTop - float(p.y));

    vec3 col;
    float emis = 0.0; // emissive mask -> bloom

    if (m == AIR) {
        float t = float(p.y) / float(H - 1);
        t = floor(t * 24.0) / 23.0;
        col = skyColor(t);
        if (mod(float(p.x + p.y * 2), 4.0) < 1.0) col *= 0.985;
        if (depthBelow <= 1.0) {
            float clear = 1.0 - u_sky.y;
            // Stars come out as the sun goes down; cloud hides them.
            if (g > 0.9978) {
                float tw = 0.6 + 0.4 * sin(u_time * 2.3 + g * 400.0);
                col += vec3(0.85, 0.90, 1.0) * tw * (1.0 - day) * clear;
                emis += 0.25 * tw * (1.0 - day) * clear;
            }
            // Sun by day, moon by night, on opposite sides of the sky.
            vec2 sun = vec2(u_sky.w * float(W), 318.0 + u_sky.x * 250.0);
            vec2 moon = vec2((1.0 - u_sky.w) * float(W), 318.0 - u_sky.x * 250.0);
            float ds = distance(vec2(p), sun), dm = distance(vec2(p), moon);
            col += vec3(1.0, 0.86, 0.55) * exp(-ds / 46.0) * 0.45 * clear * step(0.0, u_sky.x);
            if (ds < 13.0 && u_sky.x > -0.05) { col = mix(col, vec3(1.0, 0.95, 0.78), clear); emis += 0.9 * clear; }
            if (dm < 10.0 && u_sky.x < 0.05) {
                float crater = hash(floor(vec2(p) / 3.0)) * 0.12;
                col = mix(col, vec3(0.86, 0.89, 0.95) - crater, clear);
                emis += 0.35 * clear;
            }
        }
        // Smoke/dust haze and white steam.
        float gg = self.g;
        if (gg >= 136.0 / 255.0) {
            float st = clamp((gg - 0.5) * 2.2, 0.0, 0.85);
            col = mix(col, vec3(0.93, 0.95, 0.97), st);
            emis += st * 0.12;
        } else if (gg > 0.01) {
            col = mix(col, vec3(0.36, 0.34, 0.32), clamp(gg * 2.0, 0.0, 0.7));
        }
        // Underground air reads as dark cavern space, not sky.
        if (depthBelow > 1.0) {
            float cave = 1.0 - exp(-depthBelow / 24.0);
            vec3 caveCol = vec3(0.072, 0.068, 0.084) * (0.8 + 0.5 * g);
            col = mix(col, caveCol, cave * 0.94);
        }
        // Sub-cell volume reconstruction: an air notch supported by water
        // below and beside it is the upper fraction of the free surface, not
        // a square hole. This visually preserves thin sheets and menisci while
        // the conservative occupancy grid remains one-material-per-cell.
        float partialWater = waterMask(p + ivec2(0, -1)) *
            (0.28 + 0.22 * max(waterMask(p + ivec2(-1, 0)), waterMask(p + ivec2(1, 0))));
        col = mix(col, vec3(0.30, 0.62, 0.82) * dayTint, partialWater);
    } else if (m == SAND) {
        float rb = floor(self.r * 255.0 + 0.5);
        float depth = clamp(1.0 - float(p.y) / 360.0, 0.0, 1.0);
        col = mix(vec3(0.78, 0.60, 0.33), vec3(0.47, 0.34, 0.19), depth * 0.55);
        // Geology strata: clay band and bedrock-adjacent gravel.
        float band1 = 120.0 + 18.0 * sin(float(p.x) * 0.011 + 2.1);
        float band2 = 45.0 + 12.0 * sin(float(p.x) * 0.017);
        if (float(p.y) < band2) col = mix(col, vec3(0.42, 0.40, 0.38), 0.45 + 0.2 * speck);
        else if (float(p.y) < band1) col = mix(col, vec3(0.55, 0.38, 0.28), 0.4);
        col *= 0.90 + 0.14 * speck;
        if (self.a < COHESION_THRESH) col *= 1.10;
        // Damp sand reads darker and slightly richer.
        float wet = wetOf(self) / 20.0;
        float shore = max(max(waterMask(p + ivec2(-1, 0)), waterMask(p + ivec2(1, 0))),
                          max(waterMask(p + ivec2(0, 1)), waterMask(p + ivec2(0, 2)) * 0.55));
        wet = max(wet, shore * 0.72);
        col = mix(col, col * vec3(0.62, 0.60, 0.66), wet);
        if (mu == AIR) col = mix(col, vec3(0.95, 0.83, 0.55) * (1.0 - 0.35 * wet), 0.55);
        if (mu == AIR && wet > 0.15) {
            float wetSpec = pow(max(0.0, sin(float(p.x) * 0.09 + u_time * 0.35)), 18.0);
            col += vec3(0.10, 0.13, 0.14) * wetSpec * wet;
        }
        // Submerged bed: dancing caustic light filtering through the water.
        if (mu == WATER) {
            float wdep = clamp(up.a * 255.0 / 34.0, 0.0, 1.0);
            float ph = float(p.x);
            float ca = sin(ph * 0.31 + u_time * 2.2)
                     + 0.6 * sin(ph * 0.113 - u_time * 1.45)
                     + 0.45 * sin(ph * 0.52 + u_time * 3.1);
            col += vec3(0.18, 0.34, 0.38) * max(0.0, ca - 1.15) * (1.0 - 0.85 * wdep);
            col = mix(col, col * vec3(0.72, 0.80, 0.92), 0.35);
        }
        // Scorched blast debris: blackbody radiation (cherry red -> molten gold -> incandescent white).
        float sc = self.g;
        if (sc > 0.02) {
            vec3 blackbody = mix(vec3(0.85, 0.22, 0.08), mix(vec3(1.0, 0.65, 0.16), vec3(1.0, 0.98, 0.88), smoothstep(0.45, 0.95, sc)), smoothstep(0.08, 0.55, sc));
            col = mix(col, blackbody, sc * 0.92);
            emis += sc * 1.15;
        }
        // Saturated ground: pore water darkens it and adds a wet sheen.
        if (rb >= 85.0) {
            col = mix(col, vec3(0.20, 0.24, 0.30), 0.45);
            if (mu == AIR) col = mix(col, vec3(0.42, 0.52, 0.60), 0.35);
        }
        // Vitrified blast lining: dark glassy sheen.
        if (rb >= 81.0 && rb <= 84.0) {
            col = mix(col, vec3(0.30, 0.48, 0.44), 0.7) * (0.9 + 0.25 * speck);
            emis += 0.06;
        }
    } else if (m == WATER) {
        float vx = (self.g * 255.0 - 128.0) / 62.0;
        float vyv = (self.b * 255.0 - 128.0) / 62.0;
        float speed = clamp(length(vec2(vx, vyv)), 0.0, 2.0);
        // Hydrostatic pressure = real depth below the connected surface.
        float depth = clamp(self.a * 255.0 / 45.0, 0.0, 1.0);
        vec2 normal = waterNormal(p);
        float surface = float(mu != WATER || ml != WATER || mr != WATER);
        // Beer-Lambert absorption in metres: red disappears first, leaving
        // deep water blue-green without painting an arbitrary depth ramp.
        float metres = self.a * 255.0 * 0.025;
        vec3 transmittance = exp(-vec3(0.42, 0.16, 0.075) * metres);
        vec3 shallow = vec3(0.18, 0.52, 0.72);
        vec3 deep = vec3(0.018, 0.075, 0.16);
        col = deep + shallow * transmittance;
        // Refraction follows the reconstructed surface normal and local flow.
        vec2 roff = normal * (1.2 + depth * 3.5) + vec2(vx, vyv) * 1.7;
        int rm = matOf(get(p + ivec2(roff)));
        if (rm == SAND) col = mix(col, vec3(0.40, 0.34, 0.24), 0.28);
        else if (rm == CONCRETE) col = mix(col, vec3(0.35, 0.38, 0.42), 0.25);
        // Interior caustic bands near the surface.
        if (depth < 0.55) {
            float ca = sin(float(p.x) * 0.21 + u_time * 1.8 + float(p.y) * 0.06)
                     + 0.7 * sin(float(p.x) * 0.083 - u_time * 1.15);
            col += vec3(0.08, 0.20, 0.24) * max(0.0, ca - 0.95) * (1.0 - depth / 0.55);
        }
        float curvature = abs(waterMask(p + ivec2(-1, 0)) + waterMask(p + ivec2(1, 0))
                            + waterMask(p + ivec2(0, -1)) + waterMask(p + ivec2(0, 1)) - 3.0);
        float foam = surface * smoothstep(0.35, 1.35, speed + curvature * 0.18);
        col = mix(col, vec3(0.72, 0.86, 0.94), foam * 0.72);
        // Bed contact under energetic flow entrains a visible turbidity veil.
        float bedContact = float(md == SAND || ml == SAND || mr == SAND);
        col = mix(col, vec3(0.34, 0.29, 0.20), bedContact * smoothstep(0.25, 1.1, speed) * 0.35);
        // Animated sparkle, advected with the flow.
        float sp = fract(g * 91.7 + u_time * (0.35 + speed * 0.5) + float(p.x) * 0.013 - vx * 1.7);
        if (sp > 0.96) { col = mix(col, vec3(0.62, 0.85, 0.98), 0.8); emis += 0.10; }
        // Free surface: bright rim with a moving glint (cheap Fresnel).
        if (mu == AIR) {
            float glint = 0.75 + 0.25 * sin(float(p.x) * 0.35 + u_time * 2.4 + g * 6.28);
            float fresnel = 0.02 + 0.98 * pow(1.0 - clamp(normal.y, 0.0, 1.0), 5.0);
            vec3 skyReflection = mix(skyColor(0.75), skyColor(0.05) + 0.1, glint) / max(dayTint, vec3(0.3));
            col = mix(col, skyReflection, clamp(fresnel + 0.18, 0.0, 0.82));
            emis += 0.12 * glint;
        } else if (ml == AIR || mr == AIR) {
            col = mix(col, vec3(0.55, 0.80, 0.95), 0.4);
        }
    } else if (m == CONCRETE) {
        col = vec3(0.60, 0.63, 0.67);
        col *= 0.92 + 0.10 * speck;
        if (mu != CONCRETE || md != CONCRETE || ml != CONCRETE || mr != CONCRETE)
            col *= 0.55;
        if ((p.x + p.y) % 7 == 0) col *= 0.88;
        if (mu == AIR) col += vec3(0.06);
    } else { // BEDROCK
        col = vec3(0.23, 0.24, 0.27);
        if ((p.x / 4 + p.y / 4) % 2 == 0) col *= 1.12;
        if (mu != BEDROCK) col = mix(col, vec3(0.42, 0.40, 0.36), 0.6);
    }

    // Micro-relief + ambient occlusion for granular solids.
    if (m == SAND || m == CONCRETE) {
        int nsolid = (solidM(mu) ? 1 : 0) + (solidM(md) ? 1 : 0)
                   + (solidM(ml) ? 1 : 0) + (solidM(mr) ? 1 : 0);
        col *= 1.08 - 0.05 * float(nsolid);          // enclosed cells read darker
        if (!solidM(ml) && solidM(mr)) col *= 1.05;  // key light from upper-left
        else if (!solidM(mr) && solidM(ml)) col *= 0.97;
    }

    // Depth ambience + propagated dynamic light.
    vec3 light = texture(u_light, v_uv).rgb;
    float llum = dot(light, vec3(0.35, 0.45, 0.2));
    if (m == AIR) {
        col += light * 0.55;
        emis += llum * 0.45;
    } else {
        float amb = 0.34 + 0.66 * exp(-depthBelow / 110.0);
        // Scorch glows by itself; daylight only falls on what it lights.
        col *= amb * mix(dayTint, vec3(1.0), clamp(emis, 0.0, 1.0));
        col += col * light * 1.7 + light * 0.16;
        emis += llum * 0.35;
    }

    // Lingering smoke and vapour, lit by whatever is burning inside it.
    vec2 sm = texture(u_smoke, v_uv).rg;
    vec3 smokeCol = mix(vec3(0.10, 0.10, 0.11), vec3(0.42, 0.40, 0.38), day) + light * 0.9;
    col = mix(col, smokeCol, clamp(sm.r * 1.25, 0.0, 0.82));
    col = mix(col, vec3(0.90, 0.93, 0.96) * max(dayTint, vec3(0.45)), clamp(sm.g * 0.8, 0.0, 0.55));

    // Acoustic blast flash rings.
    float s = shockOf(self);
    float ns = max(max(shockOf(up), shockOf(dn)), max(shockOf(lf), shockOf(rt)));
    if (s > 0.02) {
        col = mix(col, vec3(1.0, 0.62, 0.18), smoothstep(0.05, 0.35, s));
        col = mix(col, vec3(1.0, 0.93, 0.62), smoothstep(0.35, 0.62, s));
        col = mix(col, vec3(1.0), smoothstep(0.62, 0.9, s));
        emis += smoothstep(0.05, 0.6, s);
    } else if (ns > 0.15 && m != AIR) {
        col = mix(col, vec3(1.0, 0.72, 0.30), min(ns, 1.0) * 0.55);
        emis += min(ns, 1.0) * 0.35;
    }

    outColor = vec4(col, clamp(emis, 0.0, 1.0));
}

//====== LIGHT ======
#version 300 es
// Dynamic 2D light field (half res, ping-pong). Emission comes from blast
// shock cells and red-hot scorched sand, plus a handful of CPU point lights
// (lit fuses, fresh explosions, hot ejecta). Each step diffuses the previous
// field through the world with per-material attenuation, so explosions light
// up caverns and glow fades through overburden.
precision highp float;
precision highp int;

uniform sampler2D u_state;   // full-res sim state
uniform sampler2D u_prev;    // previous light field (target res)
uniform vec4 u_lights[8];    // x, y (sim px), radius, intensity
uniform int u_nlights;
in vec2 v_uv;
out vec4 outColor;

void main() {
    vec2 texel = vec2(1.0 / 400.0, 1.0 / 300.0);
    vec4 s = texture(u_state, v_uv);
    int m = (int(floor(s.r * 255.0 + 0.5)) + 30) / 60;

    vec3 E = vec3(0.0);
    if (m == 0) { // air: shock flash (steam excluded)
        if (s.g < 136.0 / 255.0) E += vec3(1.0, 0.55, 0.22) * smoothstep(0.03, 0.6, s.b) * 1.2;
    } else if (m == 1) { // sand: cooling embers
        E += vec3(1.0, 0.28, 0.08) * s.g * 0.9;
    }

    vec2 px = v_uv * vec2(800.0, 600.0);
    for (int i = 0; i < 8; i++) {
        if (i >= u_nlights) break;
        vec4 L = u_lights[i];
        float d = distance(px, L.xy);
        E += vec3(1.0, 0.72, 0.4) * L.w * exp(-d * d / (L.z * L.z));
    }

    vec3 c = texture(u_prev, v_uv).rgb;
    vec3 n = texture(u_prev, v_uv + vec2(texel.x, 0.0)).rgb
           + texture(u_prev, v_uv - vec2(texel.x, 0.0)).rgb
           + texture(u_prev, v_uv + vec2(0.0, texel.y)).rgb
           + texture(u_prev, v_uv - vec2(0.0, texel.y)).rgb;
    vec3 diff = c * 0.4 + n * 0.15;
    float occl = (m == 1 || m == 2 || m == 4) ? 0.80 : (m == 3 ? 0.93 : 0.975);
    outColor = vec4(clamp(max(E, diff * occl * 0.985), 0.0, 1.0), 1.0);
}

//====== BRIGHT ======
#version 300 es
// Bloom bright-pass: keyed on the scene's emissive mask (alpha) plus a
// conservative pure-luminance knee for the very brightest pixels.
precision highp float;
uniform sampler2D u_scene;
in vec2 v_uv;
out vec4 outColor;
void main() {
    vec4 s = texture(u_scene, v_uv);
    float l = dot(s.rgb, vec3(0.299, 0.587, 0.114));
    outColor = vec4(s.rgb * (s.a * 1.15 + smoothstep(0.93, 1.06, l) * 0.35), 1.0);
}

//====== BLUR ======
#version 300 es
// Separable 5-tap gaussian (bilinear-optimized offsets).
precision highp float;
uniform sampler2D u_scene;
uniform vec2 u_dir;
uniform vec2 u_texel;
in vec2 v_uv;
out vec4 outColor;
void main() {
    vec2 o = u_dir * u_texel;
    vec3 c = texture(u_scene, v_uv).rgb * 0.227027;
    c += (texture(u_scene, v_uv + o * 1.3846).rgb + texture(u_scene, v_uv - o * 1.3846).rgb) * 0.3162162;
    c += (texture(u_scene, v_uv + o * 3.2308).rgb + texture(u_scene, v_uv - o * 3.2308).rgb) * 0.0702703;
    outColor = vec4(c, 1.0);
}

//====== SMOKE ======
#version 300 es
// Smoke/vapour field (half res, ping-pong). The grid's own smoke cells clear
// in about a second; this is what is left hanging in the air afterwards. It
// rises, leans with the wind, billows, thins, and is blocked by solid ground.
// R = dark smoke, G = white vapour. Render-only: it carries no mass.
precision highp float;
precision highp int;

uniform sampler2D u_state;   // full-res sim state
uniform sampler2D u_prev;    // previous field
uniform vec4 u_src[8];       // x, y (sim px), radius, amount
uniform int u_nsrc;
uniform float u_wind;
uniform float u_time;
uniform float u_k;           // time scale (0 = paused)
uniform float u_seed;
in vec2 v_uv;
out vec4 outColor;

float hash(vec2 q) { return fract(sin(dot(q, vec2(127.1, 311.7))) * 43758.5453123); }
int matOf(vec4 c) { return (int(floor(c.r * 255.0 + 0.5)) + 30) / 60; }

void main() {
    vec2 texel = vec2(1.0 / 400.0, 1.0 / 300.0);
    vec4 s = texture(u_state, v_uv);
    int m = matOf(s);
    if (m != 0) { outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

    vec2 vel = vec2(u_wind * 0.55 + sin(v_uv.y * 38.0 + u_time * 0.9) * 0.28,
                    0.50 + cos(v_uv.x * 31.0 + u_time * 0.7) * 0.18) * u_k;
    vec2 from = v_uv - vel * texel;
    vec2 d = texture(u_prev, from).rg;
    vec2 n = (texture(u_prev, from + vec2(texel.x, 0.0)).rg + texture(u_prev, from - vec2(texel.x, 0.0)).rg
            + texture(u_prev, from + vec2(0.0, texel.y)).rg + texture(u_prev, from - vec2(0.0, texel.y)).rg) * 0.25;
    d = mix(d, n, 0.30 * min(u_k, 1.0));
    // Whole-quantum stochastic decay: a multiplicative fade under one byte
    // per pass is rounded away on an RGBA8 target and the haze never clears.
    float rq = hash(gl_FragCoord.xy * 0.37 + vec2(u_seed, u_seed * 1.7));
    if (rq < 0.42 * u_k) d.r = max(d.r - 1.0 / 255.0, 0.0);
    if (fract(rq * 7.3) < 0.75 * u_k) d.g = max(d.g - 1.0 / 255.0, 0.0);

    // Sources: the grid's smoke and steam cells, smouldering ground just
    // below, and the CPU emitters (blasts, the torch, lightning strikes).
    if (s.g >= 136.0 / 255.0) d.g = max(d.g, 0.55);
    else if (s.g > 0.02) d.r = max(d.r, s.g * 1.3);
    vec4 below = texture(u_state, v_uv - vec2(0.0, 2.0 / 600.0));
    if (matOf(below) == 1 && below.g > 0.25) d.r += 0.035 * below.g * u_k;
    vec2 px = v_uv * vec2(800.0, 600.0);
    for (int i = 0; i < 8; i++) {
        if (i >= u_nsrc) break;
        vec4 e = u_src[i];
        float q = distance(px, e.xy);
        d.r += e.w * exp(-q * q / (e.z * e.z)) * u_k;
    }
    outColor = vec4(clamp(d, 0.0, 1.0), 0.0, 1.0);
}

//====== COPY ======
#version 300 es
// Packs the (possibly half-float) state into an RGBA8 target so the CPU
// mirror is read back as bytes: no float readPixels, no per-frame JS convert.
precision highp float;
uniform sampler2D u_state;
out vec4 outColor;
void main() { outColor = texelFetch(u_state, ivec2(gl_FragCoord.xy), 0); }

//====== COMPOSITE ======
#version 300 es
// Final composite at the canvas's own resolution: sharp-bilinear upscale of
// the 800x600 scene, screen shake, expanding shock-ring refraction, bloom,
// blast flash, vignette, film grain, ACES tonemap, and the reset transition.
precision highp float;
uniform sampler2D u_scene;
uniform sampler2D u_bloom;
uniform sampler2D u_old;   // scene frozen at reset (the world being replaced)
uniform vec2 u_out;        // canvas backing size, px
uniform float u_melt;      // 0 none | (0,1] old world drains out | (1,2] new one pours in
uniform vec4 u_rings[4];   // x, y (sim px), radius, amplitude (px)
uniform int u_nrings;
uniform vec2 u_shake;      // sim px
uniform float u_flash;
uniform float u_time;
in vec2 v_uv;
out vec4 outColor;

float hash(vec2 q) { return fract(sin(dot(q, vec2(127.1, 311.7))) * 43758.5453123); }

vec3 aces(vec3 x) {
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

// Cell edges stay crisp at any scale but are antialiased over a fraction of
// an output pixel, which is what CSS image-rendering: pixelated cannot do at a
// non-integer scale (uneven cell widths that shimmer under screen shake).
vec2 sharp(vec2 uv, vec2 res) {
    vec2 scale = max(u_out / res * 0.6, vec2(1.0));
    vec2 tx = uv * res - 0.5;
    vec2 ti = floor(tx);
    vec2 f = clamp((tx - ti - 0.5) * scale + 0.5, 0.0, 1.0);
    return (ti + f + 0.5) / res;
}

void main() {
    vec2 res = vec2(800.0, 600.0);
    vec2 uv = v_uv + u_shake / res;
    vec2 px = uv * res;
    for (int i = 0; i < 4; i++) {
        if (i >= u_nrings) break;
        vec4 r = u_rings[i];
        vec2 d = px - r.xy;
        float dist = max(length(d), 0.6);
        float w = exp(-pow(dist - r.z, 2.0) / 260.0);
        uv += (d / dist) * (w * r.w) / res;
    }
    // Thermal Heat-Shimmer Refraction above hot/molten regions
    vec3 bloomSample = texture(u_bloom, uv).rgb;
    float heat = clamp(bloomSample.r * 1.6 - bloomSample.b * 0.4, 0.0, 1.0);
    if (heat > 0.04) {
        vec2 shimmer = vec2(
            sin(px.y * 0.14 + u_time * 7.5),
            cos(px.x * 0.12 + u_time * 6.0)
        ) * (heat * 0.0035);
        uv += shimmer;
    }

    // Reset transition, in ragged columns: the old world slides down out of
    // frame, then the new one drops in from above and lands.
    const vec3 VOID = vec3(0.02, 0.025, 0.04);
    float lag = hash(vec2(floor(v_uv.x * 160.0), 3.7)) * 0.4;
    vec3 col;
    if (u_melt > 0.0 && u_melt <= 1.0) {
        float k = clamp((u_melt - lag) / 0.6, 0.0, 1.0);
        vec2 ouv = vec2(uv.x, uv.y + k * k * 1.1);
        col = ouv.y < 1.0 ? texture(u_old, sharp(ouv, res)).rgb : VOID;
    } else {
        if (u_melt > 1.0) {
            float k = clamp((u_melt - 1.0 - lag) / 0.6, 0.0, 1.0);
            uv.y -= (1.0 - k * k) * 1.1;
        }
        col = uv.y >= 0.0 ? texture(u_scene, sharp(uv, res)).rgb + texture(u_bloom, uv).rgb * 0.85 : VOID;
    }
    col += vec3(1.0, 0.86, 0.62) * u_flash;
    vec2 vd = v_uv - 0.5;
    col *= 1.0 - dot(vd, vd) * 0.5;
    col += (hash(v_uv * 613.7 + fract(u_time * 0.7) * 17.0) - 0.5) * 0.02;
    outColor = vec4(aces(col * 1.05), 1.0);
}

//====== PUPDATE ======
#version 300 es
// Juice particles (sparks, dust, mist, bubbles, foam) integrated on the GPU
// by transform feedback. Each one reads the sim state where it stands, so it
// dies on solid ground, a bubble pops at the surface and a spark is quenched
// by water, exactly as the CPU version did for a tenth as many.
precision highp float;
precision highp int;
layout(location = 0) in vec4 a_pv;    // x, y, vx, vy (sim px, y up)
layout(location = 1) in vec4 a_meta;  // age, life, kind, size
uniform sampler2D u_state;
uniform float u_k;                    // time scale (0 = paused)
uniform float u_seed;
out vec4 o_pv;
out vec4 o_meta;

float hash(vec2 q) { return fract(sin(dot(q, vec2(127.1, 311.7))) * 43758.5453123); }
int matAt(vec2 q) {
    ivec2 c = ivec2(floor(q + 0.5));
    if (c.y < 0) return 4;
    if (c.x < 0 || c.x >= 800 || c.y >= 600) return 0;
    return (int(floor(texelFetch(u_state, c, 0).r * 255.0 + 0.5)) + 30) / 60;
}

void main() {
    vec2 p = a_pv.xy, v = a_pv.zw;
    float age = a_meta.x + u_k, life = a_meta.y, kind = a_meta.z;
    o_pv = a_pv; o_meta = a_meta;
    if (kind < 0.5 || u_k <= 0.0) return;
    if (age >= life) { o_meta.z = 0.0; return; }
    float jit = hash(vec2(float(gl_VertexID) * 0.731, u_seed)) - 0.5;
    if (kind < 1.5)      { v.y -= 0.13 * u_k; v *= pow(0.965, u_k); }                               // spark
    else if (kind < 2.5) { v.y -= 0.02 * u_k; v *= pow(0.94, u_k); }                                // dust
    else if (kind < 3.5) { v.y += 0.012 * u_k; v.x = v.x * pow(0.96, u_k) + jit * 0.06 * u_k; }     // mist
    else if (kind < 4.5) { v.y = min(v.y + 0.05 * u_k, 1.6); v.x = v.x * pow(0.9, u_k) + jit * 0.3 * u_k; } // bubble
    else                 { v.x *= pow(0.97, u_k); v.y *= pow(0.82, u_k); }                          // foam
    p += v * u_k;
    int m = matAt(p);
    bool dead = p.x < 1.0 || p.x >= 799.0 || p.y < 8.0;
    if (kind > 3.5 && kind < 4.5) dead = dead || m != 3;                        // surfaced
    else if (kind > 4.5) dead = dead || (m != 3 && matAt(p - vec2(0.0, 1.0)) != 3);
    else {
        dead = dead || m == 1 || m == 2 || m == 4;
        if (m == 3 && kind < 1.5) life = min(life, age + 5.0);                  // quenched
    }
    o_pv = vec4(p, v);
    o_meta = vec4(age, life, dead ? 0.0 : kind, a_meta.w);
}

//====== PNULL ======
#version 300 es
precision mediump float;
void main() { }

//====== PVERTEX ======
#version 300 es
// Additive point sprites straight from the particle state, positions in sim
// pixel coords (y-up), rendered 1:1 into the 800x600 scene FBO.
precision highp float;
layout(location = 0) in vec4 a_pv;
layout(location = 1) in vec4 a_meta;
out vec4 v_col;
void main() {
    float kind = a_meta.z;
    if (kind < 0.5) { v_col = vec4(0.0); gl_PointSize = 1.0; gl_Position = vec4(2.0, 2.0, 0.0, 1.0); return; }
    float k = clamp(1.0 - a_meta.x / a_meta.y, 0.0, 1.0);
    float size = a_meta.w;
    if (kind < 1.5) {
        float heat = k * k;
        v_col = vec4(1.0, 0.25 + 0.65 * heat, 0.06 + 0.5 * heat * heat, 0.85 * k);
        size *= 0.5 + k;
    } else if (kind < 2.5) v_col = vec4(0.45, 0.38, 0.28, 0.10 * k);
    else if (kind < 3.5) v_col = vec4(0.55, 0.72, 0.85, 0.09 * k);
    else if (kind < 4.5) v_col = vec4(0.5, 0.8, 0.95, 0.35);
    else { v_col = vec4(0.82, 0.90, 0.94, 0.24 * k); size *= 0.75 + 0.5 * k; }
    gl_PointSize = max(size, 1.5);
    gl_Position = vec4(a_pv.xy / vec2(400.0, 300.0) - 1.0, 0.0, 1.0);
}

//====== PFRAG ======
#version 300 es
precision mediump float;
in vec4 v_col;
out vec4 outColor;
void main() {
    vec2 d = gl_PointCoord - 0.5;
    float a = max(0.0, 1.0 - dot(d, d) * 4.0);
    a *= a;
    outColor = vec4(v_col.rgb * v_col.a * a, v_col.a * a * 0.9);
}
`;
