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

//====== SUPPORT ======
#version 300 es
// Pass 1 of each sub-step: field relaxation.
//  - Mohr-Coulomb support (sand), moisture exchange, fall-speed accumulation
//  - hydrostatic pressure relaxation + velocity damping (water)
//  - acoustic shockwave propagation (air)
//
// Cell packing (RGBA8), semantics depend on material:
//   R = material id * 60 (+ wetness 0..20 for sand)
//        0 air | 60..80 sand | 120 concrete | 180 water | 240 bedrock
//   G = water: horizontal velocity vx (128 = 0) | others: 0
//   B = air: shockwave intensity | water: vertical velocity vy (128 = 0)
//       sand: accumulated fall speed | others: 0
//   A = sand: support/cohesion | water: hydrostatic pressure (depth/255)
//       concrete & bedrock: 1.0 | air: 0
precision highp float;
precision highp int;

uniform sampler2D u_state;
uniform float u_seed;
out vec4 outColor;

const int W = 800;
const int H = 600;
const int AIR = 0, SAND = 1, CONCRETE = 2, WATER = 3, BEDROCK = 4;

const float H_DECAY = 0.0627;
const float D_DECAY = 0.022;
const float COHESION_THRESH = 0.25;
const float RECOHERE_RATE = 0.0015;
const float SHOCK_DISLODGE = 0.35;

const float P_STEP = 1.0 / 255.0;   // pressure gain per cell of depth
const float P_LAT_DECAY = 0.3 / 255.0; // viscous loss per lateral hop

vec4 get(ivec2 p) {
    if (p.y < 0) return vec4(240.0 / 255.0, 0.0, 0.0, 1.0); // below world: bedrock
    if (p.x < 0 || p.x >= W || p.y >= H) return vec4(0.0);  // sides/top: open air
    return texelFetch(u_state, p, 0);
}

int matOf(vec4 c) { return (int(floor(c.r * 255.0 + 0.5)) + 30) / 60; }
// Sand R byte: 60..80 = dry..damp, 81..84 = vitrified glass, 85 = a grain
// whose pore space holds one full cell of water (see the pore-water rules in
// MOVE). A saturated grain reads as fully damp everywhere else.
float wetOf(vec4 c) {
    if (matOf(c) != SAND) return 0.0;
    float rb = floor(c.r * 255.0 + 0.5);
    if (rb >= 85.0) return 20.0;
    float w = rb - 60.0;
    return (w <= 20.0) ? w : 0.0; // 81..84 = vitrified glass, not wet
}
float shockOf(vec4 c) { return matOf(c) == AIR ? c.b : 0.0; }

float supportOf(vec4 c) {
    int m = matOf(c);
    if (m == CONCRETE || m == BEDROCK) return 1.0;
    if (m == SAND) return c.a;
    return 0.0;
}

float hash(vec2 q) {
    return fract(sin(dot(q, vec2(127.1, 311.7))) * 43758.5453123);
}

void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec4 self = get(p);
    int m = matOf(self);

    vec4 up = get(p + ivec2(0, 1));
    vec4 dn = get(p + ivec2(0, -1));
    vec4 lf = get(p + ivec2(-1, 0));
    vec4 rt = get(p + ivec2(1, 0));
    int mu = matOf(up), md = matOf(dn), ml = matOf(lf), mr = matOf(rt);

    // ---------------------------------------------------------------- AIR --
    // Air G channel: 0 = clear; 1..120 = smoke/dust (massless, dissipates);
    // 136..255 = steam (carries water mass, cools and condenses back).
    if (m == AIR) {
        float nbrShock = max(max(shockOf(up), shockOf(dn)), max(shockOf(lf), shockOf(rt)));
        float shock = self.b * 0.985 - 0.002;
        shock = max(shock, nbrShock * 0.97 - 0.006);
        if (mu == AIR) shock = max(shock, shockOf(get(p + ivec2(0, 2))) * 0.94 - 0.010);
        if (md == AIR) shock = max(shock, shockOf(get(p + ivec2(0, -2))) * 0.94 - 0.010);
        if (ml == AIR) shock = max(shock, shockOf(get(p + ivec2(-2, 0))) * 0.94 - 0.010);
        if (mr == AIR) shock = max(shock, shockOf(get(p + ivec2(2, 0))) * 0.94 - 0.010);

        // Steam carries real water mass, so it is double-signed: G >= 136
        // AND the magic marker 222 in the (otherwise unused) air alpha.
        // Byte corruption on some drivers forged G >= 136 on plain air,
        // which then "condensed" into created water; forging two coherent
        // bytes is out of reach. A marked cell whose G was corrupted low
        // self-heals by condensing immediately, so no mass is ever lost.
        float g = self.g;
        bool steamMark = abs(self.a * 255.0 - 222.0) < 2.0;
        if (steamMark) {
            if (g < 136.0 / 255.0) { // corrupted steam: recover the water now
                outColor = vec4(180.0 / 255.0, 0.5, 0.5, 0.0);
                return;
            }
            g -= 1.0 / 255.0; // steam cools (quickly: every steam-second is
                              // exposure to byte corruption on some drivers)
            if (g < 136.0 / 255.0) {
                // ...and condenses back into a falling water cell.
                outColor = vec4(180.0 / 255.0, 0.5, 0.5, 0.0);
                return;
            }
            outColor = vec4(0.0, g, clamp(shock, 0.0, 1.0), 222.0 / 255.0);
            return;
        }
        if (g >= 136.0 / 255.0) g = 120.0 / 255.0; // unmarked steam = corruption -> smoke
        if (g > 0.0) g = max(g - 0.45 / 255.0, 0.0); // smoke/dust dissipates

        outColor = vec4(0.0, g, clamp(shock, 0.0, 1.0), 0.0);
        return;
    }

    // --------------------------------------------------------------- SAND --
    if (m == SAND) {
        float rnd = hash(vec2(p) * 0.173 + vec2(u_seed, u_seed * 1.31));
        float rbyte = floor(self.r * 255.0 + 0.5);
        // Two persistent grain fractions live below the byte quantisation
        // threshold. Coarse grains settle faster and resist entrainment;
        // fine grains travel farther in turbidity plumes.
        float grainFrac = fract(self.r * 255.0);
        // "No fraction yet" is a value on an integer, and on a half-float target
        // an integer byte lands a hair either side of it: 80/255 reads back as
        // 79.999, whose fract is 0.999. Left alone that was carried as the grain
        // fraction, pushed R to 81, and turned every damp grain that touched a
        // byte upload into vitrified glass (1,500 cells of lake bed in 8 s).
        if (grainFrac < 0.05 || grainFrac > 0.95) grainFrac = rnd < 0.62 ? 0.12 : 0.36;
        bool glass = rbyte >= 81.0 && rbyte <= 84.0; // vitrified blast lining
        bool sat = rbyte >= 85.0;                    // pores hold a cell of water

        // Blast wave dislodges but never destroys. Plunging water also
        // scours the bed loose (waterfall erosion).
        float nbrShock = max(max(shockOf(up), shockOf(dn)), max(shockOf(lf), shockOf(rt)));
        bool dislodged = nbrShock > SHOCK_DISLODGE;
        if (!glass && mu == WATER && up.b < 0.5 - 25.0 / 255.0 && rnd < 0.06) dislodged = true;

        // Moisture: soak from adjacent water, seep from damp neighbours,
        // slowly dry against open air. (Glass is impermeable.)
        float wet = glass ? 0.0 : wetOf(self);
        if (!glass && !sat) {
            float nbrWet = max(max(wetOf(up), wetOf(dn)), max(wetOf(lf), wetOf(rt)));
            wet = max(wet, nbrWet - 2.0);
            bool touchWater = (mu == WATER || md == WATER || ml == WATER || mr == WATER);
            if (touchWater) wet = min(wet + 2.0, 20.0);
            else if (rnd < 0.02 && (mu == AIR || ml == AIR || mr == AIR)) wet = max(wet - 1.0, 0.0);
        }

        // Fall-speed accumulator (inertia): builds while airborne and is
        // retained while riding a stack that is itself still falling, so
        // whole streams speed up together. Resets on real support.
        float fall = 0.0;
        if (md == AIR) fall = min(self.b + 8.0 / 255.0, 1.0);
        else if (md == SAND && dn.a < COHESION_THRESH && dn.b > 0.05)
            fall = min(self.b + 8.0 / 255.0, dn.b); // stack accelerates together,
                                                    // capped by the cell beneath

        // Mohr-Coulomb support with position-based geology strata:
        // gravel near the bedrock (weak, avalanche-prone), a clay band above
        // it (strong, holds tunnels), plain sand elsewhere. Damp sand arches
        // harder; fully saturated sand turns to weak slurry; glass is rigid.
        float a = self.a;
        if (dislodged) {
            a = 0.0;
        } else {
            float hDec = H_DECAY, dDec = D_DECAY;
            float band1 = 120.0 + 18.0 * sin(float(p.x) * 0.011 + 2.1);
            float band2 = 45.0 + 12.0 * sin(float(p.x) * 0.017);
            if (float(p.y) < band2) { hDec *= 1.6; dDec *= 1.8; }       // gravel
            else if (float(p.y) < band1) { hDec *= 0.55; dDec *= 0.5; } // clay
            if (wet > 8.0) { hDec *= 0.5; dDec *= 0.5; }
            float below = (md == CONCRETE || md == BEDROCK) ? 1.0 : (md == SAND ? dn.a : 0.0);
            float lat = max(supportOf(lf), supportOf(rt)) - hDec;
            float diag = max(supportOf(get(p + ivec2(-1, -1))), supportOf(get(p + ivec2(1, -1)))) - dDec;
            float target = clamp(max(below, max(lat, diag)), 0.0, 1.0);
            int waterNbrs = (mu == WATER ? 1 : 0) + (md == WATER ? 1 : 0) + (ml == WATER ? 1 : 0) + (mr == WATER ? 1 : 0);
            float saturation = clamp(wet / 20.0, 0.0, 1.0);
            float capillary = clamp(saturation * pow(1.0 - saturation, 4.0) * 12.207, 0.0, 1.0);
            target = min(1.0, target + capillary * 0.18);
            // Drucker-Prager-style yield envelope. Confinement raises shear
            // strength, saturation lowers the friction angle, and capillary
            // suction supplies the cohesion term for damp sand castles.
            float normalStress = clamp(below * 0.7 + diag * 0.3, 0.0, 1.0);
            float leftStress = clamp(supportOf(lf), 0.0, 1.0);
            float rightStress = clamp(supportOf(rt), 0.0, 1.0);
            float shearStress = abs(leftStress - rightStress) * 0.65 +
                                (md == AIR || md == WATER ? 0.32 : 0.0);
            float friction = mix(0.625, 0.510, saturation); // tan(32deg)..tan(27deg)
            // The envelope is tau <= c + sigma tan(phi), and c is not only
            // capillary: packed ground carries real cohesion, here its own
            // support value. With that term missing no dry cell with air under
            // it could ever pass (0.32 of shear against at most 0.18), so
            // every authored tunnel and pocket roof stoped up to the surface
            // within five seconds of load. Loose sand (a near 0) still has
            // none and slumps to repose; a cantilever tip still goes before a
            // bridged span does.
            float yieldLimit = capillary * 0.24 + normalStress * friction + self.a * 2.0;
            if (!glass && shearStress > yieldLimit) target = min(target, 0.18);
            // Terzaghi effective stress: pore pressure subtracts from the
            // grain skeleton's load-bearing stress before full liquefaction.
            float poreHead = 0.0;
            if (mu == WATER) poreHead = max(poreHead, up.a);
            if (ml == WATER) poreHead = max(poreHead, lf.a);
            if (mr == WATER) poreHead = max(poreHead, rt.a);
            // Wet weakening is for loose sediment (packed: self.a >= 0.5, see below).
            bool packed = self.a >= 0.5;
            if (!packed) target *= 1.0 - saturation * clamp(poreHead * 1.8, 0.0, 0.42);
            // Sand with standing water ON TOP of it is submerged, and
            // submerged sand has no capillary cohesion at all — the damp-sand
            // bridges that hold a bank up simply are not there once the pores
            // are full. That is what makes a river bed mobile. A cavern roof
            // has water BELOW it, not above, so it is untouched by this.
            // Loose sediment only: it can never set under water. Packed ground
            // keeps its packing, which is what every comment on permeability and
            // scour in MOVE assumes ("packed strata sit at 1.0, which keeps the
            // reservoir bed sealed"; "packed ground is immune"). Applied to
            // everything, this and the pore-pressure term above took a lake's
            // whole bed down to permeable, erodible slurry and the lake went
            // through it in seconds — hidden until now only because the
            // grain-fraction bug above was turning that same bed to glass.
            if (!packed && wet >= 16.0 && (waterNbrs >= 2 || mu == WATER)) target = min(target, 0.35);
            if (sat) target = min(target, 0.35);   // pore water makes it slurry —
            // and, being under 0.5, keeps it permeable so a wetting front can
            // carry on down through ground it has already soaked.
            if (glass) target = max(target, 0.8);                          // fused lining
            a = (target > a) ? min(a + RECOHERE_RATE, target) : target;
        }

        // Scorch/ember intensity (G) slowly cools back to plain sand.
        // Quantization-safe: a per-pass decrement of 0.0009 (~0.23 byte) is
        // rounded away on the RGBA8 write, freezing scorch forever, so cool
        // stochastically by whole quanta at the same expected rate.
        // Corruption guard: on some drivers the fall accumulator bleeds into
        // G in lockstep (G tracks B) on churning cells, and the phantom
        // scorch then flash-boils passing water. Genuine embers are stamped
        // G=230 while B rebuilds from zero, so G~=B marks the corruption —
        // zero it at birth before it can accumulate.
        float scorch = self.g;
        if (scorch > 0.0 && abs(scorch - self.b) < 9.0 / 255.0) scorch = 0.0;
        else if (scorch > 0.0 && fract(rnd * 23.11) < 0.23) scorch = max(scorch - 1.0 / 255.0, 0.0);

        outColor = vec4((glass ? rbyte : (sat ? 85.0 : 60.0 + wet) + grainFrac) / 255.0, scorch, fall, a);
        return;
    }

    // -------------------------------------------------------------- WATER --
    if (m == WATER) {
        // Quenching: water beside red-hot blast debris flashes to steam
        // (steam carries the water's mass and condenses back later).
        float nScorch = 0.0;
        if (mu == SAND) nScorch = max(nScorch, up.g);
        if (md == SAND) nScorch = max(nScorch, dn.g);
        if (ml == SAND) nScorch = max(nScorch, lf.g);
        if (mr == SAND) nScorch = max(nScorch, rt.g);
        float rq = hash(vec2(p) * 0.219 + vec2(u_seed * 1.13, u_seed));
        if (nScorch > 0.45 && rq < 0.06) {
            outColor = vec4(0.0, 205.0 / 255.0, 0.0, 222.0 / 255.0); // marked steam
            return;
        }

        // Hydrostatic pressure = depth below the connected free surface,
        // relaxed one cell per sub-step (down +1, lateral ~=, up -1).
        float a = 0.0;
        if (mu == WATER) a = max(a, up.a + P_STEP);
        if (ml == WATER) a = max(a, lf.a - P_LAT_DECAY);
        if (mr == WATER) a = max(a, rt.a - P_LAT_DECAY);
        if (md == WATER) a = max(a, dn.a - P_STEP);
        // Relaxation leak: the max-relaxation field has no anchor inside a
        // closed pool, so stale "ghost" pressure from pour/blast churn would
        // self-sustain forever and endlessly pump surface water upward
        // (poured pools climbed container walls as 45-degree ramps). The leak
        // must be STOCHASTIC in whole quanta: A is an 8-bit byte, so any
        // fractional decay (e.g. *0.996) is rounded away on write. A true
        // hydrostatic chain heals each pass from its source; ghost maxima
        // have no source and decay at ~leakProb px/pass.
        if (fract(rq * 17.77) < 0.06) a = max(a - P_STEP, 0.0);
        if (md == AIR) a = 0.0; // free-falling water carries no hydrostatic head
        a = clamp(a, 0.0, 1.0);

        // Velocity: falling water accelerates (real waterfall inertia, the
        // FALL pass grants extra cells once fast); otherwise viscous decay.
        // RGBA8 rounding eats any per-pass decay smaller than 0.5/255, which
        // froze mid-range velocity bytes forever (frozen upward vy kept the
        // impulse-rise rule firing and pumped settled pools into towers), so
        // the decay adds a stochastic ONE-QUANTUM drift toward rest. The
        // drift must never point away from rest: a symmetric dither random-
        // walks bytes across the impulse threshold instead of settling.
        // Shallow-water pressure force: water accelerates DOWN the
        // hydrostatic gradient, so a step in the free surface drives a real
        // current (dam-break surges, sloshing, seiches, bores running down a
        // tunnel) instead of the old purely diffusive random hop. Only WATER
        // neighbours may contribute: a wall's A byte is its cohesion (1.0 for
        // concrete/bedrock) and would forge an enormous phantom force.
        // The 2-byte deadband matters twice over: it keeps a settled pool at
        // exactly rest, and rest is what keeps it "calm" for the
        // communicating-vessels rule in MOVE.
        // The gradient is measured over a WIDE baseline. A pool spreading
        // toward level has a surface slope of a fraction of a cell per
        // column, and the resulting pressure difference between two ADJACENT
        // cells is a fraction of one byte: it rounds to nothing, the fluid
        // never accelerates, and all you get back is the diffusive hop you
        // started with. Sampling four cells out multiplies the signal by
        // eight, which lifts a realistic slope clear of both the 1/255 quantum
        // and the stochastic leak noise in the pressure field itself. The near
        // neighbour must be water too, so a wall still blocks the reading.
        vec4 l4 = get(p + ivec2(-4, 0));
        vec4 r4 = get(p + ivec2(4, 0));
        float pL = (ml == WATER) ? ((matOf(l4) == WATER) ? l4.a : lf.a) : a;
        float pR = (mr == WATER) ? ((matOf(r4) == WATER) ? r4.a : rt.a) : a;
        float dP = pL - pR;                     // > 0 pushes right
        // One quantum is the whole deadband. A 2-byte threshold sounds safer
        // but it sets a permanent angle of repose for water: any slope gentler
        // than a quarter cell per column can never be felt, so a wide basin
        // settles into a visible permanent ramp instead of a level surface.
        // Sub-quantum slopes still come out right in the aggregate, because
        // the difference rounds to 1 on exactly the fraction of cells that
        // matches the true slope, and the field's own leak noise is zero-mean.
        bool driven = abs(dP) * 255.0 >= 0.5;
        // The rest-drift is reduced while a cell is driven rather than
        // switched off: with no damping at all the only energy sink was the
        // brief instants when a pool passed through level, so it sloshed
        // essentially forever. A weak drift still lets a sustained head build
        // a current (0.35 byte of force per byte of head beats 0.12 of drift)
        // while draining the ringing out of a pool that has finished moving.
        float dq = (fract(rq * 9.71) < (driven ? 0.12 : 0.35)) ? 1.0 / 255.0 : 0.0;
        float vx = 0.5 + (self.g - 0.5) * 0.996;
        // 0.15 byte of velocity per byte of head. While a cell is genuinely
        // driven the stochastic rest-drift is suspended - otherwise the drift
        // (0.35 byte/pass) would cancel any head under ~2.5 bytes and the
        // fluid could never build a current at all.
        if (driven) vx += dP * 0.35;
        vx = vx > 0.5 ? max(0.5, vx - dq) : min(0.5, vx + dq);
        vx = clamp(vx, 0.5 - 100.0 / 255.0, 0.5 + 100.0 / 255.0);
        float vy;
        if (md == AIR) vy = max(self.b - 6.0 / 255.0, 0.15);
        else {
            vy = 0.5 + (self.b - 0.5) * 0.993;
            vy = vy > 0.5 ? max(0.5, vy - dq) : min(0.5, vy + dq);
        }

        // No-slip-ish boundary drag and two-way phase coupling. Flow next to
        // a sand bed loses momentum to the grains; the erosion pass spends
        // that transferred energy by mobilising them.
        float sandFaces = float(md == SAND) +
                          0.35 * float(ml == SAND || mr == SAND);
        float drag = min(0.16, sandFaces * 0.035);
        vx = mix(vx, 0.5, drag);
        vy = mix(vy, 0.5, drag * 0.65);

        outColor = vec4(180.0 / 255.0, vx, vy, a);
        return;
    }

    // -------------------------------------------------- CONCRETE / BEDROCK --
    outColor = vec4(self.r, 0.0, 0.0, 1.0);
}

//====== RELAX ======
#version 300 es
// Continuous water correction layered over the conservative cellular moves.
// Material occupancy still moves cell-for-cell, while velocity and pressure
// are half-float fields on capable GPUs.  A Jacobi-like relaxation removes
// checkerboard pressure, viscosity damps grid noise, and the pressure gradient
// supplies the missing sub-cell response before the Margolus transport pass.
precision highp float;
precision highp int;

uniform sampler2D u_state;
uniform float u_dt;
out vec4 outColor;

const int W = 800, H = 600;
const int WATER = 3;

vec4 get(ivec2 p) {
    p = clamp(p, ivec2(0), ivec2(W - 1, H - 1));
    return texelFetch(u_state, p, 0);
}
int matOf(vec4 c) { return (int(floor(c.r * 255.0 + 0.5)) + 30) / 60; }
vec2 vel(vec4 c) { return matOf(c) == WATER ? c.gb - vec2(0.5) : vec2(0.0); }
float head(vec4 c, float fallback) { return matOf(c) == WATER ? c.a : fallback; }

void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec4 s = get(p);
    if (matOf(s) != WATER) { outColor = s; return; }

    vec4 l = get(p + ivec2(-1, 0)), r = get(p + ivec2(1, 0));
    vec4 d = get(p + ivec2(0, -1)), u = get(p + ivec2(0, 1));
    float wl = float(matOf(l) == WATER), wr = float(matOf(r) == WATER);
    float wd = float(matOf(d) == WATER), wu = float(matOf(u) == WATER);
    float n = max(1.0, wl + wr + wd + wu);

    vec2 v = vel(s);
    vec2 avgV = (vel(l) + vel(r) + vel(d) + vel(u)) / n;
    v = mix(v, avgV, clamp(u_dt * 15.0, 0.0, 0.10));

    float pL = head(l, s.a), pR = head(r, s.a);
    float pD = head(d, s.a), pU = head(u, s.a);
    vec2 gradP = vec2(pR - pL, pU - pD);
    v -= gradP * clamp(u_dt * 24.0, 0.0, 0.16);

    // Vorticity confinement restores a little rolling motion lost to the
    // viscosity step, but only inside a body of water (never in a lone drop).
    float curl = (vel(r).y - vel(l).y) - (vel(u).x - vel(d).x);
    if (n > 2.5) v += vec2(-v.y, v.x) * curl * 0.018;

    float hydro = (pL * wl + pR * wr +
                   max(0.0, pD - 1.0 / 255.0) * wd +
                   min(1.0, pU + 1.0 / 255.0) * wu) / n;
    float divergence = ((vel(r).x - vel(l).x) + (vel(u).y - vel(d).y)) * 0.5;
    float relaxedHead = mix(s.a, hydro, clamp(u_dt * 18.0, 0.0, 0.12));
    relaxedHead = clamp(relaxedHead - divergence * 0.10, 0.0, 1.0);
    v = clamp(v, vec2(-100.0 / 255.0), vec2(100.0 / 255.0));
    outColor = vec4(s.r, v + vec2(0.5), relaxedHead);
}

//====== MOVE ======
#version 300 es
// Pass 2 of each sub-step: Margolus block cellular automaton movement.
// Adds: pressure-driven upwelling (communicating vessels), velocity-biased
// lateral water flow, and moisture-steepened sand repose.
precision highp float;
precision highp int;

uniform sampler2D u_state;
uniform int u_parity;
uniform float u_seed;
uniform float u_wind; // -1..1 slow ambient drift for smoke/steam
uniform int u_disable; // diagnostic rule toggles: 1=up-flow, 2=water-lateral
out vec4 outColor;

const int W = 800;
const int H = 600;
const int AIR = 0, SAND = 1, CONCRETE = 2, WATER = 3, BEDROCK = 4;
const float COHESION_THRESH = 0.25;
const float P_UP = 4.0 / 255.0;   // pressure head needed to push upward
const float FAST_B = 40.0 / 255.0;    // sand fall-speed byte that counts as fast
const float SINK_P = 0.16;            // per-substep chance a grain settles a cell in water
const float CREEP_P = 0.30;           // surface creep rate (sets the angle of repose)
const float PORE_P = 0.25;            // pore water soaking in / working downward
const float SEEP_P = 0.10;            // saturated ground weeping into an opening
const float PERC_P = 0.012;           // bed exchange floor rate
const float EROSION_V = 14.0 / 255.0; // flow speed at which the bed starts to lift
// (bank flattening is handled by the water diagonal-slide rule; a lower
// threshold here lets transient chop pressure pump surfaces into a tilt)

vec4 get(ivec2 p) {
    if (p.y < 0) return vec4(240.0 / 255.0, 0.0, 0.0, 1.0);
    // Sides are sealed for MOVEMENT: a swap into a virtual off-grid cell has
    // no pixel to land in and would silently destroy matter. Lateral
    // drainage is instead performed (and counted) on the CPU each frame.
    if (p.x < 0 || p.x >= W) return vec4(240.0 / 255.0, 0.0, 0.0, 1.0);
    if (p.y >= H) return vec4(0.0);
    return texelFetch(u_state, p, 0);
}

int matOf(vec4 c) { return (int(floor(c.r * 255.0 + 0.5)) + 30) / 60; }
float wetOf(vec4 c) {
    if (matOf(c) != SAND) return 0.0;
    float rb = floor(c.r * 255.0 + 0.5);
    if (rb >= 85.0) return 20.0;
    float w = rb - 60.0;
    return (w <= 20.0) ? w : 0.0;
}

bool isAir(vec4 c) { return matOf(c) == AIR; }
bool isGasAir(vec4 c) { return matOf(c) == AIR && c.g > 2.0 / 255.0; }
bool isClearAir(vec4 c) { return matOf(c) == AIR && c.g <= 2.0 / 255.0; }
// Capillary suction curve, replacing a hard step at wetOf 8. Cohesion is
// negligible in bone-dry sand, peaks where menisci bridge the grains at about
// a fifth saturation (this is the sandcastle), and collapses again once the
// pores fill and the pore pressure goes positive. The step made the same grain
// topple freely at wetOf 8 and cling at 9, and — backwards — made
// pore-saturated sand LESS mobile than damp sand when a drowned slurry should
// slump more readily, not less. s(1-s)^4 peaks at s = 0.2 and is zero at both
// ends, so dry and saturated keep their free-flowing behaviour instead of
// being dragged toward the damp minimum the way a bell curve would drag them.
float toppleP(vec4 c) {
    float s = clamp(wetOf(c) / 20.0, 0.0, 1.0);
    float bridge = clamp(s * pow(1.0 - s, 4.0) * 12.207, 0.0, 1.0);
    return mix(1.0, 0.22, bridge);
}

bool isGranular(vec4 c) { return matOf(c) == SAND && c.a < COHESION_THRESH; }
// Permeable to percolating water: loose sand, and the saturated slurry that
// loose sand becomes once it is waterlogged (support caps at 0.35 there, just
// above the granular threshold, so a wetted heap would otherwise seal itself
// against its own drainage after about a second). Packed ground stays
// impermeable at 1.0, which is what keeps the authored caverns and the
// reservoir bed sealed.
float rbOf(vec4 c) { return floor(c.r * 255.0 + 0.5); }
// A grain whose pore space is full. It carries one cell of water with it, so
// recount() on the CPU counts it as water and every transition below is one
// cell in, one cell out.
bool isSat(vec4 c) { return matOf(c) == SAND && rbOf(c) >= 85.0; }
float grainScale(vec4 c) { return fract(c.r * 255.0) < 0.24 ? 0.72 : 1.35; }
// Able to take water in: loose or already-slurried ground, never vitrified
// lining and never a grain that is already full. Packed strata sit at 1.0,
// which is what keeps the cavern roofs and the reservoir bed sealed.
bool isPermeable(vec4 c) { return matOf(c) == SAND && c.a < 0.5 && rbOf(c) <= 80.0; }
bool isMobile(vec4 c) { int m = matOf(c); return (m == SAND && c.a < COHESION_THRESH) || m == WATER; }

// Sand falls through air in a single sub-step but only creeps down through
// water: real quartz settles orders of magnitude slower once submerged.
// Taking the caller's random rather than drawing a fresh one keeps the answer
// stable across the several places one cell is tested within a pass.
bool canSink(vec4 top, vec4 bot, float rnd) {
    int mb = matOf(bot);
    if (mb == AIR) return true;
    if (mb == WATER && matOf(top) == SAND) return rnd < SINK_P * grainScale(top);
    return false;
}

float hash(vec2 q) {
    return fract(sin(dot(q, vec2(127.1, 311.7))) * 43758.5453123);
}

int fdiv2(int v) { return (v >= 0) ? v / 2 : -((-v + 1) / 2); }

void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    ivec2 base = ivec2(fdiv2(p.x - u_parity) * 2 + u_parity,
                       fdiv2(p.y - u_parity) * 2 + u_parity);

    vec4 c00 = get(base);                 // bottom-left
    vec4 c10 = get(base + ivec2(1, 0));   // bottom-right
    vec4 c01 = get(base + ivec2(0, 1));   // top-left
    vec4 c11 = get(base + ivec2(1, 1));   // top-right

    float r = hash(vec2(base) * 0.1731 + vec2(u_seed * 0.719, u_seed));
    float r2 = fract(r * 13.77);
    float rs0 = fract(r * 5.137);    // settling, left column
    float rs1 = fract(r * 21.31);    // settling, right column
    float rc = fract(r * 3.771);     // surface creep
    float re = fract(r * 8.219);     // bed exchange (percolation / scour)
    vec4 t;

    // 1) Gravity within each column. A grain entering WATER settles slowly,
    //    which is what turns a slug of blast ejecta into a billowing
    //    turbidity plume that keeps drifting with the current as it sinks.
    if (isMobile(c01) && canSink(c01, c00, rs0)) { t = c01; c01 = c00; c00 = t; }
    if (isMobile(c11) && canSink(c11, c10, rs1)) { t = c11; c11 = c10; c10 = t; }

    // 2) Pressure/impulse-driven upwelling: water below air rises when its
    //    connected column is taller (communicating vessels) or a blast gave
    //    it upward velocity.
    // (Guarded so water can never swap into the virtual row above the world,
    // which has no pixel to land in and would silently destroy it.)
    if ((u_disable & 1) == 0 && base.y + 1 < H) {
        // The pressure-driven rise requires CALM water: churn convects deep
        // parcels (still carrying their pressure byte) to the surface, and
        // letting them pump creates a self-feeding chop->pump->chop loop
        // that climbed container walls. A genuine artesian column is calm
        // and keeps rising; blast jets use the separate impulse condition.
        // Churn is a VERTICAL signature, so vy stays strict; vx is tolerant
        // because water climbing the short leg of a U-tube now necessarily
        // arrives along the bottom carrying real horizontal momentum.
        bool calm00 = abs(c00.g - 0.5) < 20.0 / 255.0 && abs(c00.b - 0.5) < 6.0 / 255.0;
        bool calm10 = abs(c10.g - 0.5) < 20.0 / 255.0 && abs(c10.b - 0.5) < 6.0 / 255.0;
        // Impulse rises additionally require SHOCKED air above (air B carries
        // the blast shockwave): upward-impulse jets are a blast phenomenon,
        // so quiet pools can never impulse-pump themselves.
        if (isAir(c01) && matOf(c00) == WATER && ((c00.a > P_UP && calm00) || (c00.b > 0.5 + 8.0 / 128.0 && c01.b > 0.08))) { t = c01; c01 = c00; c00 = t; c01.a = 0.0; }
        if (isAir(c11) && matOf(c10) == WATER && ((c10.a > P_UP && calm10) || (c10.b > 0.5 + 8.0 / 128.0 && c11.b > 0.08))) { t = c11; c11 = c10; c10 = t; c11.a = 0.0; }
    }

    // 2b) Gas buoyancy: smoke and steam rise through clear air, and drift
    //     laterally with the ambient wind. (Guarded against the virtual row
    //     above the world — swapping into it would destroy the gas, and
    //     steam carries real water mass.)
    if (base.y + 1 < H) {
        if (isClearAir(c01) && isGasAir(c00) && r < 0.85) { t = c01; c01 = c00; c00 = t; }
        if (isClearAir(c11) && isGasAir(c10) && r2 < 0.85) { t = c11; c11 = c10; c10 = t; }
    }
    float rg = fract(r * 7.31);
    if (isGasAir(c00) && isClearAir(c10) && rg < 0.22 + u_wind * 0.18) { t = c00; c00 = c10; c10 = t; }
    else if (isGasAir(c10) && isClearAir(c00) && rg < 0.22 - u_wind * 0.18) { t = c00; c00 = c10; c10 = t; }

    // 3) Diagonal toppling of granular sand (damp sand rests steeper).
    //    Submerged grains topple as well - without this a pile that landed
    //    under water could never spread and stood as a vertical spire - but
    //    only as often as they sink, so underwater slopes relax in slow
    //    motion and sediment fans build out grain by grain.
    bool wtop0 = fract(rc * 11.3) < SINK_P;
    bool wtop1 = fract(rc * 29.7) < SINK_P;
    bool tgt10 = isAir(c10) || (matOf(c10) == WATER && wtop0);
    bool tgt00 = isAir(c00) || (matOf(c00) == WATER && wtop1);
    bool topple01 = isGranular(c01) && !canSink(c01, c00, rs0) && tgt10 && r2 < toppleP(c01);
    bool topple11 = isGranular(c11) && !canSink(c11, c10, rs1) && tgt00 && r2 < toppleP(c11);
    if (topple01 && topple11) { if (r < 0.5) topple11 = false; else topple01 = false; }
    if (topple01) { t = c01; c01 = c10; c10 = t; }
    else if (topple11) { t = c11; c11 = c00; c00 = t; }

    // 3a) Surface creep. A Margolus diagonal topple can only ever relax a
    //     slope to 45 degrees, but real dry sand stands at about 32, so a
    //     loose surface grain also steps sideways whenever the ground falls
    //     away faster than that. Probe geometry: on a uniform slope of s
    //     cells per column the cell at (+k, -j) is air exactly when
    //     s >= (j + 0.5) / k, so the (+4, -2) probe fires at s >= 0.625
    //     (32.0 degrees) while (+2, 0) merely keeps the path itself open.
    //     A grain that has just landed at speed spends that speed on the
    //     step, so a falling stream throws out a run-out apron instead of
    //     stopping dead where it hits.
    float pc0 = CREEP_P + (c00.b > FAST_B ? 0.45 : 0.0);
    float pc1 = CREEP_P + (c10.b > FAST_B ? 0.45 : 0.0);
    if (isGranular(c00) && isAir(c10) && rc < pc0
        && isAir(get(base + ivec2(2, 0))) && isAir(get(base + ivec2(4, -2)))) {
        t = c00; c00 = c10; c10 = t;
    } else if (isGranular(c10) && isAir(c00) && rc > 1.0 - pc1
        && isAir(get(base + ivec2(-1, 0))) && isAir(get(base + ivec2(-3, -2)))) {
        t = c00; c00 = c10; c10 = t;
    }

    // 3b) Mud slither: waterlogged loose sand creeps sideways like a slurry.
    float rm = fract(r * 3.317);
    if (isGranular(c00) && wetOf(c00) >= 14.0 && isAir(c10) && rm < 0.10) { t = c00; c00 = c10; c10 = t; }
    else if (isGranular(c10) && wetOf(c10) >= 14.0 && isAir(c00) && rm < 0.10) { t = c00; c00 = c10; c10 = t; }

    // 3d) Bed exchange: a water cell and the loose grain beneath it trade
    //     places. Run slowly it is percolation - spills sink into a loose
    //     heap, a water table builds at its base and seeps out along the toe.
    //     Run fast it is entrainment: the current lifts the bed into
    //     suspension, the grain drifts downstream while it settles back out
    //     (rule 1), and so channels scour, banks undercut, and bars build
    //     exactly where the flow slackens. Packed cohesive ground is
    //     impermeable, so authored caverns and the reservoir bed stay sealed.
    float wsp0 = abs(c01.g - 0.5);
    float wsp1 = abs(c11.g - 0.5);
    // Cohesion RESISTS scour rather than switching it on and off: loose bed
    // material goes at the full rate, a half-set bank goes slowly, and packed
    // ground (support 1.0) is immune, so authored terrain cannot be washed
    // away while a real current still cuts its channel. Saturated grains are
    // erodible too — this is a swap, so their pore water rides along with
    // them and the totals stay exact.
    float coh0 = clamp(1.0 - c00.a * 1.25, 0.0, 1.0);
    float coh1 = clamp(1.0 - c10.a * 1.25, 0.0, 1.0);
    // Purely flow-driven: still water must not stir the bed at all, or a
    // quiet lake would slowly go turbid and creep its own bed upward.
    // Infiltration is the pore-water system(3e) job, not this one.
    // Shields-style mobility: quadratic flow forcing, opposed by packing,
    // capillary bridges and grain weight. Coarse grains armour the bed.
    float sat0 = clamp(wetOf(c00) / 20.0, 0.0, 1.0);
    float sat1 = clamp(wetOf(c10) / 20.0, 0.0, 1.0);
    float cap0 = sat0 * pow(1.0 - sat0, 4.0) * 12.207;
    float cap1 = sat1 * pow(1.0 - sat1, 4.0) * 12.207;
    float pe0 = max(0.0, wsp0 * wsp0 - EROSION_V * EROSION_V) * 14.0 * coh0 /
                (grainScale(c00) + cap0 * 0.8 + c00.a * 0.7);
    float pe1 = max(0.0, wsp1 * wsp1 - EROSION_V * EROSION_V) * 14.0 * coh1 /
                (grainScale(c10) + cap1 * 0.8 + c10.a * 0.7);
    if (matOf(c01) == WATER && matOf(c00) == SAND && re < pe0) { t = c01; c01 = c00; c00 = t; }
    else if (matOf(c11) == WATER && matOf(c10) == SAND && fract(re * 7.19) < pe1) { t = c11; c11 = c10; c10 = t; }

    // 3e) Pore water. Infiltration CANNOT be modelled by swapping a water
    //     cell with the grain below it: this automaton already makes grains
    //     denser than water, so a swapped cell is buoyed straight back up and
    //     the water can never get below the surface. Real water instead fills
    //     the PORE SPACE between grains, so a grain carries a saturation flag
    //     (R byte 85) worth exactly one cell of water, and the water travels
    //     as a state transfer between grains rather than as a swap of them.
    //     Every branch here is one cell of water in and one out, so totals
    //     stay exact. Surface water (air above) cannot soak in: it has to
    //     pool on top of the heap first. Only BURIED water — sand above the
    //     water cell, so it is already inside the heap — migrates down
    //     through the pore space. Result: a spill forms a puddle on top of
    //     a loose heap; once the heap buries water (e.g. a fresh pour
    //     collapsed over it, or the bed rose around it), the trapped water
    //     soaks down, a water table builds at the base, and it weeps out
    //     again at the toe.
    float rp = fract(re * 3.913);
    // "Buried" means a sand cell directly above the water cell. c01 sits at
    // (base.x, base.y + 1), so the cell above it is at base + (0, 2). c11
    // sits at (base.x + 1, base.y + 1), so its roof is at base + (1, 2).
    bool buried01 = matOf(get(base + ivec2(0, 2))) == SAND;
    bool buried11 = matOf(get(base + ivec2(1, 2))) == SAND;
    if (matOf(c01) == WATER && isPermeable(c00) && rp < PORE_P && buried01) {
        c00.r = 85.0 / 255.0; c01 = vec4(0.0);          // soaks in (buried only)
    } else if (matOf(c11) == WATER && isPermeable(c10) && rp < PORE_P && buried11) {
        c10.r = 85.0 / 255.0; c11 = vec4(0.0);
    } else if (isSat(c01) && isPermeable(c00) && rp < PORE_P) {
        c00.r = 85.0 / 255.0; c01.r = 80.0 / 255.0;     // works its way down
    } else if (isSat(c11) && isPermeable(c10) && rp < PORE_P) {
        c10.r = 85.0 / 255.0; c11.r = 80.0 / 255.0;
    } else if (isSat(c01) && isClearAir(c00) && rp < SEEP_P) {
        c00 = vec4(180.0 / 255.0, 0.5, 0.5, 0.0); c01.r = 80.0 / 255.0; // seeps out
    } else if (isSat(c11) && isClearAir(c10) && rp < SEEP_P) {
        c10 = vec4(180.0 / 255.0, 0.5, 0.5, 0.0); c11.r = 80.0 / 255.0;
    } else if (isSat(c00) && isClearAir(c10) && rp < SEEP_P) {
        c10 = vec4(180.0 / 255.0, 0.5, 0.5, 0.0); c00.r = 80.0 / 255.0; // spring at the toe
    } else if (isSat(c10) && isClearAir(c00) && rp < SEEP_P) {
        c00 = vec4(180.0 / 255.0, 0.5, 0.5, 0.0); c10.r = 80.0 / 255.0;
    }

    // 3c) Water always slides downhill: the diagonal drop sand gets from
    //     toppling, but unconditional — water has no angle of repose. Without
    //     this, a sheet of water draped on a sand slope could only creep off
    //     via parity-gated lateral hops and stood at ~35 degrees for minutes.
    bool wslide01 = matOf(c01) == WATER && !canSink(c01, c00, 0.0) && isAir(c10);
    bool wslide11 = matOf(c11) == WATER && !canSink(c11, c10, 0.0) && isAir(c00);
    if (wslide01 && wslide11) { if (r < 0.5) wslide11 = false; else wslide01 = false; }
    if (wslide01) { t = c01; c01 = c10; c10 = t; }
    else if (wslide11) { t = c11; c11 = c00; c00 = t; }

    // 4) Lateral water flow, biased by stored velocity and by pressure
    //    (pressurized water jets into any opening). The probability is also
    //    steered by what lies beneath the target opening: spreading onto an
    //    adjacent water column (levelling) or over an edge (pour-off) is
    //    near-certain, spreading onto dry floor is moderate — so free
    //    surfaces relax flat like a real fluid instead of random-walking.
    if ((u_disable & 2) != 0) { /* water-lateral disabled for diagnosis */ }
    else if (matOf(c00) == WATER && isAir(c10)) {
        int mbr = matOf(get(base + ivec2(1, -1)));
        float bias = (mbr == WATER) ? 0.42 : ((mbr == AIR) ? 0.5 : 0.1);
        float pr = clamp(0.45 + bias + (c00.g - 0.5) * 3.0 + c00.a * 20.0, 0.05, 0.97);
        // Surface tension: a droplet with no water neighbour at all holds
        // together instead of smearing itself into a one-pixel film, so spray
        // beads on dry ground and runs off in drops. Every cell inside a real
        // pool has neighbours, so this never touches levelling.
        if (matOf(c01) != WATER && matOf(get(base + ivec2(0, -1))) != WATER
            && matOf(get(base + ivec2(-1, 0))) != WATER) pr *= 0.12;
        if (r2 < pr) { t = c00; c00 = c10; c10 = t; }
    } else if (matOf(c10) == WATER && isAir(c00)) {
        int mbl = matOf(get(base + ivec2(0, -1)));
        float bias = (mbl == WATER) ? 0.42 : ((mbl == AIR) ? 0.5 : 0.1);
        float pl = clamp(0.45 + bias - (c10.g - 0.5) * 3.0 + c10.a * 20.0, 0.05, 0.97);
        if (matOf(c11) != WATER && matOf(get(base + ivec2(1, -1))) != WATER
            && matOf(get(base + ivec2(2, 0))) != WATER) pl *= 0.12;
        if (r2 < pl) { t = c00; c00 = c10; c10 = t; }
    }

    if ((u_disable & 2) != 0) { /* surface-lateral disabled for diagnosis */ }
    else if (matOf(c01) == WATER && isAir(c11) && !isAir(c00) && !isAir(c10)) {
        float pr = clamp(0.5 + (c01.g - 0.5) * 3.0, 0.05, 0.95);
        if (matOf(get(base + ivec2(0, 2))) != WATER && matOf(c00) != WATER
            && matOf(get(base + ivec2(-1, 1))) != WATER) pr *= 0.12;
        if (r > 1.0 - pr) { t = c01; c01 = c11; c11 = t; }
    } else if (matOf(c11) == WATER && isAir(c01) && !isAir(c00) && !isAir(c10)) {
        float pl = clamp(0.5 - (c11.g - 0.5) * 3.0, 0.05, 0.95);
        if (matOf(get(base + ivec2(1, 2))) != WATER && matOf(c10) != WATER
            && matOf(get(base + ivec2(2, 1))) != WATER) pl *= 0.12;
        if (r > 1.0 - pl) { t = c01; c01 = c11; c11 = t; }
    }

    // Emit this pixel's slot. (Lateral edge drainage is CPU-side, audited.)
    ivec2 local = p - base;
    outColor = (local.y == 0) ? (local.x == 0 ? c00 : c10) : (local.x == 0 ? c01 : c11);
}

//====== FALL ======
#version 300 es
// Pass 3 of each sub-step: inertial fast-fall. Sand with a built-up fall
// speed drops up to TWO extra cells per sub-step. The jump distance must be
// even: a 2-cell jump preserves the grain's Margolus parity phase, so the
// MOVE pass keeps contributing its own cell as well (a 1-cell extra move
// would phase-lock the grain into the block's bottom row and replace —
// not add to — the Margolus fall). Gather rule, race-free by construction.
precision highp float;
precision highp int;

uniform sampler2D u_state;
out vec4 outColor;

const int W = 800;
const int H = 600;
const int AIR = 0, SAND = 1;
const float COHESION_THRESH = 0.25;
const float FAST = 40.0 / 255.0;

vec4 get(ivec2 p) {
    if (p.y < 0) return vec4(240.0 / 255.0, 0.0, 0.0, 1.0);
    if (p.x < 0 || p.x >= W || p.y >= H) return vec4(0.0);
    return texelFetch(u_state, p, 0);
}

int matOf(vec4 c) { return (int(floor(c.r * 255.0 + 0.5)) + 30) / 60; }
bool isAir(vec4 c) { return matOf(c) == AIR; }
// Fast fallers: loose sand with built-up speed, and accelerating water
// (waterfall inertia; water vy byte < 0.5 - 40/255 means fast-down).
bool fastCell(vec4 c) {
    int m = matOf(c);
    if (m == SAND) return c.a < COHESION_THRESH && c.b > FAST;
    if (m == 3) return c.b < 0.5 - 40.0 / 255.0;
    return false;
}

void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec4 self = get(p);
    vec4 up1 = get(p + ivec2(0, 1));
    vec4 up2 = get(p + ivec2(0, 2));
    vec4 dn1 = get(p + ivec2(0, -1));
    vec4 dn2 = get(p + ivec2(0, -2));

    if (isAir(self)) {
        // Receive a 1-step lander (its road ends at me: my below is blocked).
        if (fastCell(up1) && !isAir(dn1)) { outColor = up1; return; }
        // Receive a 2-step jumper passing through the cell above me.
        if (fastCell(up2) && isAir(up1)) { outColor = up2; return; }
        // A jumper passing THROUGH me leaves me unchanged (up1 fast, my
        // below open) — falls through to outputting self below.
    } else if (fastCell(self) && isAir(dn1)) {
        // Vacate: the air I land in (or jump past to) takes my place.
        outColor = isAir(dn2) ? dn2 : dn1;
        return;
    }
    outColor = self;
}

//====== SURGE ======
#version 300 es
// Pass 4 of each sub-step: horizontal inertial surge. Water carrying real
// momentum - from the shallow-water pressure force in SUPPORT, or from a
// blast impulse - travels TWO extra cells along its direction of travel, so a
// front can out-run the one-cell-per-sub-step Margolus hop. That is the
// difference between a fluid that merely diffuses toward level and one that
// has waves: dam breaks race out, surges overshoot and slosh back, and jets
// shoot across a cavern before they fall.
// The jump must be EVEN for exactly the reason the FALL pass jumps two: an
// odd extra move phase-locks against the Margolus block parity and REPLACES
// the automaton's own hop instead of adding to it.
// Race-free by construction: only movers travelling along u_surgeDir are
// considered in any one pass (the direction alternates every sub-step), so
// every air cell has at most one possible donor - the same gather argument
// that makes the FALL pass safe.
precision highp float;
precision highp int;

uniform sampler2D u_state;
uniform int u_surgeDir;              // +1 = rightward movers, -1 = leftward
out vec4 outColor;

const int W = 800;
const int H = 600;
const int AIR = 0, WATER = 3;
const float SURGE_T = 16.0 / 255.0;  // vx byte offset that counts as fast

vec4 get(ivec2 p) {
    if (p.y < 0) return vec4(240.0 / 255.0, 0.0, 0.0, 1.0);
    // Sides are sealed for MOVEMENT: a swap into a virtual off-grid cell has
    // no pixel to land in and would silently destroy matter. Lateral drainage
    // is performed (and counted) on the CPU each frame.
    if (p.x < 0 || p.x >= W) return vec4(240.0 / 255.0, 0.0, 0.0, 1.0);
    if (p.y >= H) return vec4(0.0);
    return texelFetch(u_state, p, 0);
}

int matOf(vec4 c) { return (int(floor(c.r * 255.0 + 0.5)) + 30) / 60; }
bool isAir(vec4 c) { return matOf(c) == AIR; }

void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    ivec2 d = ivec2(u_surgeDir, 0);
    float dir = float(u_surgeDir);
    vec4 self = get(p);

    vec4 b1 = get(p - d), b2 = get(p - 2 * d);   // behind me
    vec4 f1 = get(p + d), f2 = get(p + 2 * d);   // ahead of me

    bool fb1 = matOf(b1) == WATER && (b1.g - 0.5) * dir > SURGE_T;
    bool fb2 = matOf(b2) == WATER && (b2.g - 0.5) * dir > SURGE_T;
    bool fs  = matOf(self) == WATER && (self.g - 0.5) * dir > SURGE_T;

    if (isAir(self)) {
        if (fb1 && !isAir(f1)) { outColor = b1; return; }  // 1-step lander: its road ends at me
        if (fb2 && isAir(b1))  { outColor = b2; return; }  // 2-step jumper, passing through b1
        // A jumper passing THROUGH me leaves me unchanged.
    } else if (fs && isAir(f1)) {
        // Vacate: the air I move into (or jump past to) takes my place, so
        // whatever smoke or steam that air was carrying is preserved.
        outColor = isAir(f2) ? f2 : f1;
        return;
    }
    outColor = self;
}
`;
