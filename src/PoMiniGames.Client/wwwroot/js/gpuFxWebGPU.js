// gpuFxWebGPU.js — the title swarm on the game intro card (WebGPU compute, §GFX-12).
//
// A few thousand particles start scattered across the whole viewport, fall into the letters
// of the game's title on the intro card, dissolve into the real heading, and burst back out
// of it when the card closes. Position and velocity live on the GPU and are integrated by a WGSL compute
// pass; the CPU writes the buffer once (start positions and each particle's home pixel) and
// after that only a 64-byte uniform per frame.
//
// WHAT THIS FILE USED TO BE
// A "WebGPU backend" for gpuFx.js's confetti, behind `active()`. Nothing ever loaded the
// file, so `active()` was always undefined and the delegation in gpuFx.celebrate was dead;
// when it finally ran here its uniform buffer was 48 bytes against a 64-byte WGSL struct
// (bind group creation fails validation) and every spawn overwrote slot 0. The confetti
// stays on WebGL2, which works everywhere; this module does the one thing a closed-form
// vertex shader cannot, which is steer every particle toward its own target.
//
// FALLBACK CONTRACT: no navigator.gpu, no adapter, low tier, reduced motion, a title with no
// text, or any error at any point → nothing is drawn and the card looks exactly as it does
// without this file. Nothing here throws to its caller.
//
// Exposed as window.PoGpuWebGPU = { assemble(root), scatter(), active() }.
(function () {
    'use strict';

    const MAX_PARTICLES = 16000;
    const FLOATS = 8;            // pos.xy, vel.xy, home.xy, seed, size
    const GATHER_MS = 950;       // until the DOM title fades back in under the swarm
    const SCATTER_MS = 750;

    const SHADER = `
struct Particle { pos: vec2f, vel: vec2f, home: vec2f, seed: f32, size: f32 };
struct Uniforms {
    a: vec4f,        // dt, time, mode (0 gather, 1 scatter), kick (one frame, on scatter)
    b: vec4f,        // viewport w, h, burst centre x, y  (CSS px)
    tintA: vec4f,    // rgb, global fade
    tintB: vec4f,    // rgb, unused
};
@group(0) @binding(0) var<uniform> u: Uniforms;

// ── compute ──
@group(0) @binding(1) var<storage, read_write> parts: array<Particle>;

@compute @workgroup_size(64)
fn step(@builtin(global_invocation_id) gid: vec3u) {
    let i = gid.x;
    if (i >= arrayLength(&parts)) { return; }
    var p = parts[i];
    let dt = u.a.x;
    let t = u.a.y;
    let ph = p.seed * 6.2831853;
    // A cheap divergence-free-looking swirl: two crossed sines. No noise texture.
    let swirl = vec2f(sin(p.pos.y * 0.011 + t * 1.7 + ph), cos(p.pos.x * 0.011 - t * 1.3 + ph));
    var acc: vec2f;
    if (u.a.z < 0.5) {
        // Spring home. Stiffness varies by seed so the title fills in over half a second
        // instead of every particle landing on the same frame; the swirl scales with the
        // distance left, so paths curl far out and run straight at the end. The constant
        // term is the shimmer once settled.
        let to = p.home - p.pos;
        let k = 40.0 + 60.0 * p.seed;
        acc = to * k - p.vel * (2.0 * sqrt(k) * 0.78) + swirl * (min(length(to), 260.0) * 5.0 + 14.0);
    } else {
        // Thrown outward from the card's centre, then gravity and drag.
        let out = p.pos - u.b.zw;
        p.vel = p.vel + normalize(out + vec2f(0.001, 0.0)) * u.a.w * (0.35 + p.seed);
        acc = vec2f(0.0, 1100.0) - p.vel * 1.4 + swirl * 260.0;
    }
    p.vel = p.vel + acc * dt;
    p.pos = p.pos + p.vel * dt;
    parts[i] = p;
}

// ── render: one instanced quad per particle, read straight from the vertex buffer ──
struct VOut { @builtin(position) clip: vec4f, @location(0) uv: vec2f, @location(1) mixv: f32 };

@vertex
fn vs(@builtin(vertex_index) vi: u32,
      @location(0) pos: vec2f, @location(1) vel: vec2f, @location(2) home: vec2f,
      @location(3) seedSize: vec2f) -> VOut {
    let corner = vec2f(f32(vi & 1u) * 2.0 - 1.0, f32(vi >> 1u) * 2.0 - 1.0);
    // Stretch along the velocity a little: a streak in flight, a dot at rest.
    let speed = length(vel);
    let dir = select(vec2f(1.0, 0.0), vel / max(speed, 0.0001), speed > 1.0);
    let stretch = 1.0 + min(speed / 420.0, 2.2);
    let local = dir * corner.x * seedSize.y * stretch + vec2f(-dir.y, dir.x) * corner.y * seedSize.y;
    let px = pos + local;
    var o: VOut;
    o.clip = vec4f(px.x / u.b.x * 2.0 - 1.0, 1.0 - px.y / u.b.y * 2.0, 0.0, 1.0);
    o.uv = corner;
    o.mixv = seedSize.x;
    return o;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4f {
    let a = smoothstep(1.0, 0.15, length(in.uv)) * u.tintA.a;
    let rgb = mix(u.tintA.rgb, u.tintB.rgb, in.mixv);
    return vec4f(rgb * a, a);   // premultiplied, to match the canvas alpha mode
}`;

    let _device = null;          // kept across swarms; a lost device is dropped and re-requested
    let _pipes = null;           // { compute, render, format }
    let _dead = false;           // WebGPU tried and unusable on this machine: stop asking
    let _run = null;             // the live swarm, or null
    let _token = 0;              // bumps on every assemble/end, so a slow setup can tell it is stale

    function quiet() {
        if (document.documentElement.dataset.motion === 'reduce') return true;
        try { if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return true; } catch { /* no matchMedia */ }
        return document.documentElement.getAttribute('data-gfx') === 'low';
    }

    function rgbOf(name, fallback) {
        try {
            const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
            const m = /^#([0-9a-f]{6})$/i.exec(raw);
            if (!m) return fallback;
            const v = parseInt(m[1], 16);
            return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
        } catch { return fallback; }
    }

    async function device() {
        if (_device) return _device;
        if (_dead || !navigator.gpu) { _dead = true; return null; }
        try {
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) throw new Error('no adapter');
            const dev = await adapter.requestDevice();
            dev.lost.then(function () { if (_device === dev) { _device = null; _pipes = null; } end(); });
            // A validation error here is this module's bug, not the page's: stop for the
            // session rather than repeat it on every intro card.
            dev.addEventListener('uncapturederror', function (e) {
                console.debug('gpuFxWebGPU: disabled —', e.error && e.error.message);
                _dead = true;
                end();
            });
            const format = navigator.gpu.getPreferredCanvasFormat();
            const module = dev.createShaderModule({ code: SHADER });
            const layout = dev.createBindGroupLayout({
                entries: [
                    { binding: 0, visibility: GPUShaderStage.COMPUTE | GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
                    { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                ],
            });
            // The render pass reads particles as an instanced VERTEX buffer, not through the
            // storage binding, so it gets its own layout with the uniform alone: a buffer
            // cannot be bound writable-storage and vertex in one pass.
            const drawLayout = dev.createBindGroupLayout({
                entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
            });
            _pipes = {
                format: format,
                layout: layout,
                drawLayout: drawLayout,
                compute: dev.createComputePipeline({
                    layout: dev.createPipelineLayout({ bindGroupLayouts: [layout] }),
                    compute: { module: module, entryPoint: 'step' },
                }),
                render: dev.createRenderPipeline({
                    layout: dev.createPipelineLayout({ bindGroupLayouts: [drawLayout] }),
                    vertex: {
                        module: module, entryPoint: 'vs',
                        buffers: [{
                            arrayStride: FLOATS * 4, stepMode: 'instance',
                            attributes: [
                                { shaderLocation: 0, offset: 0, format: 'float32x2' },
                                { shaderLocation: 1, offset: 8, format: 'float32x2' },
                                { shaderLocation: 2, offset: 16, format: 'float32x2' },
                                { shaderLocation: 3, offset: 24, format: 'float32x2' },
                            ],
                        }],
                    },
                    fragment: {
                        module: module, entryPoint: 'fs',
                        // Plain "over", not additive: additive is white-on-white on the
                        // light theme's card, and this has to read in both schemes.
                        targets: [{
                            format: format,
                            blend: {
                                color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
                                alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
                            },
                        }],
                    },
                    primitive: { topology: 'triangle-strip' },
                }),
            };
            _device = dev;
            return dev;
        } catch (e) {
            // debug, not warn or error: no WebGPU is the expected case on most machines, and
            // errorReporter.js posts console.error to the server.
            console.debug('gpuFxWebGPU: unavailable —', e && e.message);
            _dead = true;
            return null;
        }
    }

    /**
     * The title's ink, as home positions in viewport CSS px. Each text node is drawn where
     * the browser laid it out (its own client rects), at 3x so a 22 px heading still yields
     * thousands of distinct homes.
     */
    function homesOf(title) {
        const box = title.getBoundingClientRect();
        if (box.width < 8 || box.height < 8) return null;
        const SS = 3;
        const c = document.createElement('canvas');
        c.width = Math.ceil(box.width * SS);
        c.height = Math.ceil(box.height * SS);
        const g = c.getContext('2d', { willReadFrequently: true });
        g.scale(SS, SS);
        g.textBaseline = 'middle';
        g.fillStyle = '#fff';
        const walker = document.createTreeWalker(title, NodeFilter.SHOW_TEXT);
        const range = document.createRange();
        let drew = false;
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const text = n.nodeValue;
            if (!text || !text.trim() || !n.parentElement) continue;
            const cs = getComputedStyle(n.parentElement);
            g.font = cs.fontStyle + ' ' + cs.fontWeight + ' ' + cs.fontSize + ' ' + cs.fontFamily;
            try { g.letterSpacing = cs.letterSpacing; } catch { /* older canvas: no letterSpacing */ }
            range.selectNodeContents(n);
            // One rect per line box. A wrapped title is drawn whole on its first line,
            // which is wrong for the second line and still lands inside the heading.
            const r = range.getClientRects()[0];
            if (!r) continue;
            g.fillText(text.replace(/\s+/g, ' '), r.left - box.left, r.top - box.top + r.height / 2);
            drew = true;
        }
        if (!drew) return null;

        const data = g.getImageData(0, 0, c.width, c.height).data;
        let ink = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 110) ink++;
        if (ink < 40) return null;
        const keep = Math.min(1, MAX_PARTICLES / ink);
        const homes = [];
        for (let y = 0; y < c.height; y++) {
            for (let x = 0; x < c.width; x++) {
                if (data[(y * c.width + x) * 4 + 3] > 110 && Math.random() < keep) {
                    homes.push(box.left + x / SS, box.top + y / SS);
                }
            }
        }
        return { homes: homes, box: box };
    }

    function end() {
        _token++;
        const r = _run;
        _run = null;
        if (!r) return;
        cancelAnimationFrame(r.raf);
        window.removeEventListener('resize', end);
        try { r.title.style.opacity = ''; r.title.style.transition = ''; } catch { /* gone */ }
        try { r.canvas.remove(); } catch { /* gone */ }
        try { r.parts.destroy(); r.uniform.destroy(); } catch { /* device lost */ }
    }

    function scatter() {
        const r = _run;
        if (!r || r.scatterAt) return;
        r.scatterAt = performance.now();
        r.kick = 520;
        try { r.title.style.opacity = ''; } catch { /* gone */ }
    }

    function frame(now) {
        const r = _run;
        if (!r || !_device) return;
        r.raf = requestAnimationFrame(frame);
        const dt = Math.min(0.033, (now - r.last) / 1000);
        r.last = now;

        // The card closed (Start pressed, demo timer, a skip): that is the cue to burst.
        if (!r.scatterAt && !r.title.isConnected) scatter();
        // The heading is hidden while the swarm draws it, then fades back in underneath.
        if (!r.shown && now - r.t0 > GATHER_MS) {
            r.shown = true;
            try { r.title.style.transition = 'opacity 0.45s ease'; r.title.style.opacity = ''; } catch { /* gone */ }
        }

        let fade;
        if (r.scatterAt) {
            fade = 1 - (now - r.scatterAt) / SCATTER_MS;
            if (fade <= 0) { end(); return; }
        } else {
            // Full strength while assembling, then out entirely as the real heading fades in
            // under it: left on, the swarm tints the letters (and the title's emoji) blue.
            const age = now - r.t0;
            fade = Math.min(1, age / 220) * (age < GATHER_MS ? 1 : 1 - (age - GATHER_MS) / 900);
            if (fade <= 0) {
                // Parked: the particles sit on their homes in the buffer and nothing is
                // simulated or drawn until the card closes. One last empty frame clears
                // the canvas; after that this is a single isConnected read per frame.
                if (r.parked) return;
                r.parked = true;
                fade = 0;
            }
        }

        const u = r.u;
        u[0] = dt; u[1] = now / 1000; u[2] = r.scatterAt ? 1 : 0; u[3] = r.kick;
        u[4] = r.w; u[5] = r.h; u[6] = r.cx; u[7] = r.cy;
        u[8] = r.a[0]; u[9] = r.a[1]; u[10] = r.a[2]; u[11] = fade * 0.9;
        u[12] = r.b[0]; u[13] = r.b[1]; u[14] = r.b[2]; u[15] = 0;
        r.kick = 0;
        _device.queue.writeBuffer(r.uniform, 0, u);

        try {
            const enc = _device.createCommandEncoder();
            const cp = enc.beginComputePass();
            cp.setPipeline(_pipes.compute);
            cp.setBindGroup(0, r.simGroup);
            cp.dispatchWorkgroups(Math.ceil(r.count / 64));
            cp.end();
            const pass = enc.beginRenderPass({
                colorAttachments: [{
                    view: r.ctx.getCurrentTexture().createView(),
                    loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 },
                }],
            });
            pass.setPipeline(_pipes.render);
            pass.setBindGroup(0, r.drawGroup);
            pass.setVertexBuffer(0, r.parts);
            pass.draw(4, r.count);
            pass.end();
            _device.queue.submit([enc.finish()]);
        } catch (e) {
            console.debug('gpuFxWebGPU: frame failed —', e && e.message);
            _dead = true;
            end();
        }
    }

    /**
     * Assemble the swarm on the heading inside `root` (the intro overlay). Safe to call for
     * every intro card: returns false, having drawn nothing, wherever it cannot run.
     * @param {Element} root
     * @returns {Promise<boolean>}
     */
    async function assemble(root) {
        try {
            end();
            const token = _token;
            if (_dead || quiet() || !root || !root.querySelector) return false;
            const title = root.querySelector('.gps-intro-title');
            if (!title) return false;
            const dev = await device();
            if (!dev || token !== _token) return false;

            // The card animates in (a pop, or a sheet sliding up on phones); the heading's
            // rect is only its final one after that.
            const card = title.closest('.gps-intro-card');
            if (card && card.getAnimations) {
                await Promise.all(card.getAnimations().map(function (a) { return a.finished.catch(function () { }); }));
            }
            if (token !== _token || !title.isConnected || quiet()) return false;
            const found = homesOf(title);
            if (!found) return false;

            const count = found.homes.length / 2;
            const w = window.innerWidth, h = window.innerHeight;
            const data = new Float32Array(count * FLOATS);
            for (let i = 0; i < count; i++) {
                const o = i * FLOATS;
                // Anywhere on screen, already drifting, so the first frame is a field in
                // motion and not a stationary cloud that then lurches.
                data[o] = Math.random() * w;
                data[o + 1] = Math.random() * h;
                data[o + 2] = (Math.random() - 0.5) * 240;
                data[o + 3] = (Math.random() - 0.5) * 240;
                data[o + 4] = found.homes[i * 2];
                data[o + 5] = found.homes[i * 2 + 1];
                data[o + 6] = Math.random();
                data[o + 7] = 0.55 + Math.random() * 0.75;
            }

            const canvas = document.createElement('canvas');
            canvas.className = 'po-title-swarm';
            canvas.setAttribute('aria-hidden', 'true');
            // Above the intro overlay (--z-overlay 500), below the modal and toast layers.
            canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:900;';
            const dpr = Math.min(2, window.devicePixelRatio || 1);
            canvas.width = Math.round(w * dpr);
            canvas.height = Math.round(h * dpr);
            const ctx = canvas.getContext('webgpu');
            if (!ctx) throw new Error('no webgpu canvas context');
            ctx.configure({ device: dev, format: _pipes.format, alphaMode: 'premultiplied' });

            const parts = dev.createBuffer({
                size: data.byteLength,
                usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
            });
            dev.queue.writeBuffer(parts, 0, data);
            const uniform = dev.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

            document.body.appendChild(canvas);
            title.style.opacity = '0';
            const now = performance.now();
            _run = {
                title: title, canvas: canvas, ctx: ctx, parts: parts, uniform: uniform, count: count,
                simGroup: dev.createBindGroup({
                    layout: _pipes.layout,
                    entries: [{ binding: 0, resource: { buffer: uniform } }, { binding: 1, resource: { buffer: parts } }],
                }),
                drawGroup: dev.createBindGroup({
                    layout: _pipes.drawLayout,
                    entries: [{ binding: 0, resource: { buffer: uniform } }],
                }),
                u: new Float32Array(16),
                w: w, h: h,
                cx: found.box.left + found.box.width / 2, cy: found.box.top + found.box.height / 2,
                a: rgbOf('--fx-accent', [0.39, 0.4, 0.95]), b: rgbOf('--fx-accent-2', [0.13, 0.83, 0.93]),
                t0: now, last: now, raf: 0, kick: 0, scatterAt: 0, shown: false,
            };
            // The homes are viewport positions measured once; a resize moves the heading out
            // from under them, so the swarm simply ends.
            window.addEventListener('resize', end);
            _run.raf = requestAnimationFrame(frame);
            return true;
        } catch (e) {
            console.debug('gpuFxWebGPU: assemble failed —', e && e.message);
            end();
            return false;
        }
    }

    window.PoGpuWebGPU = {
        assemble: assemble,
        scatter: scatter,
        active: function () { return !!_run; },
        /** For the headless check: how many particles the live swarm holds (0 when none). */
        count: function () { return _run ? _run.count : 0; },
    };
})();
