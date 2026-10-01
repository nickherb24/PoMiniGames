// avatar.js — the voxel soldier the player and every squadmate is drawn as.
//
// It replaces a bare capsule. Seven boxes on three pivots: legs and the off arm swing with
// ground speed, the gun arm stays levelled at the aim line, the gun kicks when it fires and
// glows as it heats. Render-only — the physics body is still the sphere in game.js, and
// nothing here is read back by the simulation.
//
// The group's origin is the body centre (0.9 above the feet), which is where game.js has
// always placed the player mesh, so swapping the capsule for this moved nothing.

import * as THREE from 'three';
import { createActorMaterial } from './materials.js';

export class Avatar {
  constructor(color) {
    this.group = new THREE.Group();
    // Everything that poses hangs off the rig, so lying down is one rotation and the name
    // tag (a child of the group) stays upright above a downed squadmate.
    this.rig = new THREE.Group();
    this.group.add(this.rig);

    this.geometry = new THREE.BoxGeometry(1, 1, 1);
    this.materials = [
      createActorMaterial({ color }),
      createActorMaterial({ color: new THREE.Color(color).lerp(new THREE.Color(0xffe2c4), 0.72) }),
      createActorMaterial({ color: 0x2b2d33, emissive: 0x000000 }),
    ];
    const [cloth, skin, metal] = this.materials;
    this.gunMaterial = metal;

    const box = (parent, material, sx, sy, sz, x, y, z) => {
      const m = new THREE.Mesh(this.geometry, material);
      m.scale.set(sx, sy, sz);
      m.position.set(x, y, z);
      m.castShadow = true;
      parent.add(m);
      return m;
    };
    const pivot = (x, y, z) => {
      const p = new THREE.Group();
      p.position.set(x, y, z);
      this.rig.add(p);
      return p;
    };

    box(this.rig, cloth, 0.62, 0.62, 0.34, 0, 0.2, 0);          // torso
    box(this.rig, skin, 0.4, 0.4, 0.4, 0, 0.74, 0);             // head
    this.legL = pivot(-0.16, -0.12, 0);
    this.legR = pivot(0.16, -0.12, 0);
    box(this.legL, cloth, 0.24, 0.78, 0.26, 0, -0.39, 0);
    box(this.legR, cloth, 0.24, 0.78, 0.26, 0, -0.39, 0);
    this.armL = pivot(-0.42, 0.46, 0);
    box(this.armL, cloth, 0.18, 0.58, 0.2, 0, -0.29, 0);
    // Gun arm: pointed down −Z, which is "forward" for a group whose rotation.y is the yaw.
    this.armR = pivot(0.42, 0.42, 0);
    this.armR.rotation.x = Math.PI / 2;
    box(this.armR, cloth, 0.18, 0.5, 0.2, 0, -0.25, 0);
    this.gun = box(this.armR, metal, 0.16, 0.74, 0.18, 0, -0.72, -0.06);

    this.phase = 0;
    this.kick = 0;
    this.down = false;
  }

  /**
   * @param speed ground speed, m/s
   * @param firing true on a frame the primary is cycling
   * @param heat weapon heat 0..1 (squadmates pass 0 — their heat is not on the wire)
   */
  update(dt, speed, firing, heat = 0) {
    if (this.down) return;
    const stride = Math.min(1, speed / 6);
    this.phase += dt * Math.min(speed, 16) * 1.35;
    const swing = Math.sin(this.phase) * stride * 0.75;
    this.legL.rotation.x = swing;
    this.legR.rotation.x = -swing;
    this.armL.rotation.x = -swing * 0.8;
    this.rig.position.y = Math.abs(Math.sin(this.phase)) * 0.05 * stride;

    this.kick = firing ? 1 : this.kick * Math.exp(-dt * 16);
    this.gun.position.y = -0.72 + this.kick * 0.09;
    this.armR.rotation.x = Math.PI / 2 + this.kick * 0.06;
    // Barrel glow. Both actor materials (Lambert and Standard) carry an emissive colour.
    this.gunMaterial.emissive.setRGB(heat * heat * 1.6, heat * heat * 0.42, 0);
  }

  /** Lay the figure flat (a downed squadmate) or stand it back up. */
  setDown(down) {
    if (down === this.down) return;
    this.down = down;
    this.rig.rotation.x = down ? -Math.PI / 2 : 0;
    this.rig.position.y = down ? -0.62 : 0;
  }

  /** Floating name above the head. Drawn through walls: finding a squadmate is its job. */
  setName(text) {
    if (this.tag) { this.group.remove(this.tag); this.tag.material.map.dispose(); this.tag.material.dispose(); }
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 64;
    const g = canvas.getContext('2d');
    g.fillStyle = 'rgba(15, 23, 42, 0.62)';
    g.beginPath();
    g.roundRect(8, 10, 240, 44, 14);
    g.fill();
    g.font = '600 28px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#f4f7fd';
    g.fillText(String(text).slice(0, 16), 128, 33);
    const map = new THREE.CanvasTexture(canvas);
    map.colorSpace = THREE.SRGBColorSpace;
    this.tag = new THREE.Sprite(new THREE.SpriteMaterial({
      map, transparent: true, depthTest: false, depthWrite: false, fog: false,
    }));
    this.tag.scale.set(2.3, 0.58, 1);
    this.tag.position.y = 1.45;
    this.tag.renderOrder = 10;
    this.group.add(this.tag);
  }

  dispose() {
    this.group.parent?.remove(this.group);
    this.geometry.dispose();
    for (const m of this.materials) m.dispose();
    if (this.tag) { this.tag.material.map.dispose(); this.tag.material.dispose(); }
  }
}
