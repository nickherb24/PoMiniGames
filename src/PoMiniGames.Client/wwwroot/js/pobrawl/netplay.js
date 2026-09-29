// netplay.js — the online 1v1 in the arena (2026-09-29).
//
// The server (PoBrawlMatchService) is authoritative for everything the result depends on:
// HP, energy, each corner's X on a one-dimensional ring, and whether every swing hit, was
// blocked or whiffed. This engine runs the fight as a PUPPET of its 10 Hz snapshots:
//
//   • Both fighters are driven by a NetController. It walks its fighter to the server's X —
//     the remote one 100 ms behind (interpolated between snapshots), the local one ahead of
//     the last snapshot by the keys held right now, so your own feet answer at once.
//   • A swing is thrown when the SERVER fires it (never on the key press — the server may
//     buffer it behind a cooldown or refuse a special), carrying the server's verdict. The
//     verdict lands when the limb actually connects (the ordinary hit pipeline, with the
//     server's damage in place of the engine's roll), or at the end of the active window if
//     the two rigs never quite touch. So every point of HP the HUD shows is the server's.
//   • Personalities, supers and prop chip damage are off: each would move HP the server never
//     moved. The KO, the ragdoll, the replay, the news desk — all the presentation — is the
//     same code the local modes run.
//
// Keys (local corner only): A/D walk (held), R or S guard (held), F punch, G kick, H special.
// The touch pad and gamepads dispatch the same codes, so they need nothing of their own.

import * as THREE from 'three';
import { ATTACKS } from './constants.js';
import { testAttackHit, regionForHurtBone } from './hitboxes.js';
import { regionEffect } from './combat.js';

// Server walk speeds (PoBrawlMatchService.WalkInPerSecond / WalkOutPerSecond) — used only to
// lead the local fighter; the server's X always wins within a snapshot or two.
const WALK_IN = 2.4;
const WALK_OUT = 1.9;
// How far behind real time the remote fighter is drawn: one server tick, so there is always a
// later snapshot to interpolate toward.
const REMOTE_DELAY = 0.1;
// Cap on how far the local fighter is led past its last snapshot.
const MAX_LEAD = 0.2;
// The engine's countdown ends ("FIGHT!") at phaseT 3.7 — see game.js _tick.
const COUNTDOWN_END = 3.7;

const HELD = ['idle', 'forward', 'back', 'block']; // PoBrawlMatchAction 0..3
const SWING = { 4: 'punch', 5: 'kick', 6: 'special' };

/** Drives one fighter toward the server's view of it. */
export class NetController {
  isHuman = false;

  constructor(isLocal) {
    this.isLocal = isLocal;
    this.fighter = null;       // bound after spawn
    this.samples = [];         // [{ t, x }] recent snapshots, oldest first
    this.held = 'idle';        // the server's held state for this corner
    this.localDir = 0;         // local corner only: screen direction held right now (-1/0/+1)
    this.localBlock = false;
  }

  push(t, x, held) {
    this.samples.push({ t, x });
    if (this.samples.length > 8) this.samples.shift();
    this.held = held;
  }

  /** Where this fighter should stand now, or null before the first snapshot. */
  targetX(now) {
    const s = this.samples;
    if (!s.length) return null;
    if (this.isLocal) {
      const last = s[s.length - 1];
      const lead = Math.min(MAX_LEAD, Math.max(0, now - last.t) + 0.05);
      // localDir is screen-relative (+1 = right). Which of in/out that is depends on the corner.
      const speed = this.localDir === 0 ? 0 : (this.localDir === this.inwardDir ? WALK_IN : WALK_OUT);
      return last.x + this.localDir * speed * lead;
    }
    const at = now - REMOTE_DELAY;
    for (let i = s.length - 1; i > 0; i--) {
      const a = s[i - 1], b = s[i];
      if (at >= a.t) {
        const k = b.t > a.t ? Math.min(1, (at - a.t) / (b.t - a.t)) : 1;
        return a.x + (b.x - a.x) * k;
      }
    }
    return s[0].x;
  }

  update(ctx) {
    const f = this.fighter;
    const intent = { move: 0, side: 0, punch: false, kick: false, punchHeld: false, kickHeld: false, block: false, super: false };
    if (!f) return intent;
    const tx = this.targetX(performance.now() / 1000);
    if (tx !== null) {
      const err = tx - f.rig.root.position.x;
      // `move` is opponent-relative (+1 = toward them). The deadband stops a fighter standing on
      // its mark from shuffling on every snapshot's rounding.
      if (Math.abs(err) > 0.06) intent.move = Math.sign(err) * ((ctx && ctx.towardX) || 1);
    }
    intent.block = this.isLocal ? (this.localBlock || this.held === 'block') : this.held === 'block';
    return intent;
  }

  dispose() {}
}

/**
 * The local corner's keys → the server's two input kinds: HELD states (sent on every change,
 * down AND up) and attack PRESSES (sent once per key-down). `send(kind, value)` is the page's
 * hub call. Also feeds the local NetController so the fighter moves before the server answers.
 */
export class NetInput {
  constructor(controller, send) {
    this.controller = controller;
    this.send = send;
    this.down = new Set();
    this.lastWalk = null;
    this.lastSent = 'idle';
    this._onDown = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (e.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable) return;
      const code = e.code;
      if (code === 'KeyA' || code === 'KeyD' || code === 'KeyR' || code === 'KeyS') {
        e.preventDefault?.();
        if (e.repeat) return;
        this.down.add(code);
        if (code === 'KeyA' || code === 'KeyD') this.lastWalk = code;
        this._sync();
      } else if (code === 'KeyF' || code === 'KeyG' || code === 'KeyH') {
        e.preventDefault?.();
        if (e.repeat) return;
        this.send('press', code === 'KeyF' ? 'punch' : code === 'KeyG' ? 'kick' : 'special');
      }
    };
    this._onUp = (e) => {
      if (this.down.delete(e.code)) this._sync();
    };
    // A window that loses focus never sees the key-ups: release everything, or the fighter
    // marches into the ropes.
    this._onBlur = () => {
      if (!this.down.size) return;
      this.down.clear();
      this._sync();
    };
    window.addEventListener('keydown', this._onDown);
    window.addEventListener('keyup', this._onUp);
    window.addEventListener('blur', this._onBlur);
  }

  _sync() {
    const block = this.down.has('KeyR') || this.down.has('KeyS');
    const l = this.down.has('KeyA'), r = this.down.has('KeyD');
    const dir = l && r ? (this.lastWalk === 'KeyA' ? -1 : 1) : l ? -1 : r ? 1 : 0;
    this.controller.localDir = block ? 0 : dir;
    this.controller.localBlock = block;
    const state = block ? 'block' : dir < 0 ? 'left' : dir > 0 ? 'right' : 'idle';
    if (state === this.lastSent) return;
    this.lastSent = state;
    this.send('held', state);
  }

  dispose() {
    window.removeEventListener('keydown', this._onDown);
    window.removeEventListener('keyup', this._onUp);
    window.removeEventListener('blur', this._onBlur);
  }
}

// A stand-in contact for a verdict whose limb never touched: the defender's chest.
function chestHit(defender) {
  const point = new THREE.Vector3();
  (defender.rig.joints.torso || defender.rig.root).getWorldPosition(point);
  point.y += 0.15;
  return { point, capsule: 'torso' };
}

class NetplayMethods {
  /** Online setup, from start(): who is local, and the input bridge. */
  _initNet() {
    const o = this.options;
    this.online = { localSide: o.localSide || 0, lastTick: -1, final: null, finalAt: 0 };
    const local = this.online.localSide ? this.fighters[this.online.localSide - 1] : null;
    for (const f of this.fighters) {
      f.controller.fighter = f;
      // +1 = the screen direction that walks this corner toward the other (P1 stands left).
      f.controller.inwardDir = f.index === 1 ? 1 : -1;
    }
    if (local && this.dotnet) {
      this.netInput = new NetInput(local.controller, (kind, value) => {
        this.dotnet.invokeMethodAsync(kind === 'held' ? 'OnNetHeld' : 'OnNetPress', value).catch(() => {});
      });
    }
  }

  /** One server snapshot (PoBrawlMatchState, camelCase). */
  applyNet(s) {
    if (!this.online || !this.fighters || !s) return;
    if (s.tick <= this.online.lastTick) return; // late or duplicate
    this.online.lastTick = s.tick;
    this.online.last = s; // read-only introspection via PoBrawl._game, like the rest of it
    const now = performance.now() / 1000;
    const corners = [
      { f: this.fighters[0], x: s.player1X, hp: s.player1Hp, en: s.player1Energy, held: s.player1Held, swing: s.player1Swing, outcome: s.player1Outcome, dmg: s.player1Damage },
      { f: this.fighters[1], x: s.player2X, hp: s.player2Hp, en: s.player2Energy, held: s.player2Held, swing: s.player2Swing, outcome: s.player2Outcome, dmg: s.player2Damage },
    ];

    // ── Clock and phase: the server's pre-roll drives the engine's countdown ──
    const elapsed = s.elapsedSeconds;
    if (elapsed < 0 && !s.finished) {
      if (this.phase === 'intro') {
        clearTimeout(this._splashTimer);
        this._hideSplash();
        this._startCountdown();
      }
      if (this.phase === 'countdown') {
        const want = COUNTDOWN_END + elapsed;
        if (Math.abs(this.phaseT - want) > 0.25) this.phaseT = want;
      }
    } else if (this.phase === 'intro' || this.phase === 'countdown') {
      // Joined after the bell (a reconnect, a spectator): straight into the fight.
      clearTimeout(this._splashTimer);
      this._hideSplash();
      this._snapCameraToFraming();
      this.phase = 'fighting';
      this.phaseT = 0;
      this.combat.startGame();
      this._setBanner('');
    }
    if (this.phase === 'fighting') this.clock = Math.max(0, elapsed);

    for (const c of corners) {
      c.f.controller.push(now, c.x, HELD[c.held] || 'idle');
      c.f.energy = Math.max(0, Math.min(1, c.en / 100));
      c.f.gassed = false;
    }

    // ── Swings: the server fired them this tick, with their verdicts ──
    if (this.phase === 'fighting') {
      for (const c of corners) {
        const name = SWING[c.swing];
        if (name) this._netSwing(c.f, name, { outcome: c.outcome || 'whiff', damage: c.dmg || 0, special: name === 'special' });
      }
      // HP: the server's, plus whatever it already took that this screen has not shown landing.
      for (const c of corners) {
        const opp = c.f === this.fighters[0] ? this.fighters[1] : this.fighters[0];
        const pending = opp.netVerdict && opp.netVerdict.outcome !== 'whiff' ? opp.netVerdict.damage : 0;
        const player = this.combat.getPlayer(c.f.playerId);
        if (player && player.alive && c.f.state !== 'ko') {
          const want = Math.min(player.maxHealth, c.hp + pending);
          if (Math.abs(player.health - want) > 0.01) { player.health = want; this.hudDirty = true; }
        }
      }
    }

    if (s.finished && !this.online.final) {
      this.online.final = { winner: s.winner === 0 ? 1 : s.winner === 1 ? 2 : 0, event: s.lastEvent || '' };
      this.online.finalAt = now;
    }
  }

  /** Throw the swing the server fired. Any verdict still in the air lands first. */
  _netSwing(f, name, verdict) {
    const opp = f === this.fighters[0] ? this.fighters[1] : this.fighters[0];
    if (f.netVerdict) this._presentNetVerdict(f, opp, f.attack || ATTACKS.punch, f.netVerdict, chestHit(opp), null);
    if (f.state === 'ko') return;
    const attackName = name === 'special' ? 'kick' : name;
    this._destroySwingPhysics(f);
    f.blockStunT = 0;
    f.animator.setBlocking(false);
    f.animator.setCharge(null, 0);
    // A special is the kick at full charge: the gold trail, the big lunge, the heavy whoosh.
    this._enterAttack(f, attackName, verdict.special ? 1 : 0);
    if (verdict.special) {
      const p = f.rig.root.position;
      this._spawnCallout(new THREE.Vector3(p.x, 2.1, p.z), 'SPECIAL!');
    }
    f.netVerdict = verdict;
    // No limb to swing (a torn-off punching arm): land it now rather than never.
    if (f.state !== attackName) this._presentNetVerdict(f, opp, ATTACKS[attackName], verdict, chestHit(opp), null);
  }

  /** The hit pipeline's online door (from _tryHit): the limb touched — land the server's verdict. */
  _tryHitNet(attacker, defender, attack, contact) {
    const v = attacker.netVerdict;
    if (!v) { attacker.hasHit = true; return; }
    if (v.outcome === 'whiff') return; // the server says it missed: let the limb sail through
    const wMul = attacker.swingWindupMul ?? 1.0;
    const aMul = attacker.swingActiveMul ?? 1.0;
    const phase = attacker.stateT > attack.windup * wMul + attack.active * aMul ? 'recover' : 'active';
    const hit = testAttackHit(attacker.rig, attack.name, phase, defender.rig);
    // A cannon contact with no capsule overlap still counts: the physics saw the touch.
    if (!hit && !contact) return;
    this._presentNetVerdict(attacker, defender, attack, v, hit || chestHit(defender), contact);
  }

  /** After each fighter's tick: a verdict whose swing ended (or was interrupted) without contact lands now. */
  _netDeadline(f, opp) {
    const v = f.netVerdict;
    if (!v) return;
    const a = f.attack;
    const swinging = a && (f.state === 'punch' || f.state === 'kick');
    if (swinging && f.stateT <= a.windup + a.active + 0.02) return;
    this._presentNetVerdict(f, opp, a || ATTACKS.punch, v, chestHit(opp), null);
  }

  /** Land one verdict with the ordinary presentation: the engine's own block and hit code paths. */
  _presentNetVerdict(attacker, defender, attack, v, hit, contact) {
    attacker.netVerdict = null;
    attacker.hasHit = true;
    if (v.outcome === 'whiff' || defender.state === 'ko') return;
    const dpos = defender.rig.root.position;
    const apos = attacker.rig.root.position;
    const knockDir = new THREE.Vector3(dpos.x - apos.x, 0, dpos.z - apos.z);
    if (knockDir.lengthSq() > 1e-6) knockDir.normalize(); else knockDir.set(1, 0, 0);
    const impulseDir = knockDir.clone();
    if (contact && contact.normal) {
      impulseDir.set(contact.normal.x, contact.normal.y, contact.normal.z);
      if (impulseDir.lengthSq() < 1e-6) impulseDir.copy(knockDir);
      else if (impulseDir.dot(knockDir) < 0) impulseDir.negate();
      impulseDir.normalize();
    }
    const atkMass = attacker.rig.config.mass;
    const defMass = defender.rig.config.mass;
    const region = regionForHurtBone(hit.capsule);
    const s = {
      attacker, defender, attack, contact, hit, phase: 'active', region, regionMod: 1,
      effect: regionEffect(defender.regionDmg), knockDir, impulseDir,
      chargeMul: v.special ? 2.5 : 1, atkMass, defMass,
      powerScale: attacker.rig.config.attackPower * (atkMass / defMass), dpos,
      baseDmg: v.damage, torqueY: 0,
    };

    if (v.outcome === 'blocked') {
      // The guard held: the block's sparks, sound and absorb, plus any chip the server took.
      this._spawnSparks(hit.point, 0x9ad0ff, 6, 1.0);
      this._flashImpactLight(hit.point, 3, 0x9ad0ff, 0.1);
      this.audio.block(hit.point);
      attacker.animator.applyReaction('shoulderR', 4, 0, -3);
      attacker.animator.applyReaction('elbowR', -6, 0, 0);
      defender.animator.applyReaction('elbowL', -3.5, 0, 0);
      defender.animator.applyReaction('elbowR', -3.5, 0, 0);
      defender.animator.applyReaction('torso', -1.5, 0, 0);
      defender.knockback.add(knockDir.clone().multiplyScalar(2.0 / defMass));
      defender.stats.blocks += 1;
      this._hitFeedback(attack, false);
      if (v.damage > 0) {
        this.combat.damage({ playerId: defender.playerId, amount: v.damage, sourceId: attacker.playerId });
        this.hudDirty = true;
        this._resolveCombatEvents(s);
      }
      return;
    }
    this._landHit(s);
    this._resolveCombatEvents(s);
    this._heavyHitStagger(s);
  }

  /**
   * Per sim tick while fighting: pull each fighter onto its mark (the controller's steering
   * does the walking; this removes the residue — lunges, knockback, rounding), and end the
   * fight when the server has.
   */
  _tickNet(dt) {
    const now = performance.now() / 1000;
    // Wall-clock, not sim time: on a slow device the render loop caps dt (MAX_FRAME_DT), so
    // the sim runs slower than real time — and a fighter steered on sim time would trail the
    // server's X further every second. The server's ring is real time; so is this.
    const realDt = Math.min(0.25, Math.max(dt, now - (this.online.steerAt || now)));
    this.online.steerAt = now;
    const k = 1 - Math.exp(-realDt * 6);
    for (const f of this.fighters) {
      if (f.state === 'ko') continue;
      const tx = f.controller.targetX(now);
      const pos = f.rig.root.position;
      if (tx !== null) pos.x += (tx - pos.x) * k;
      // The server's ring is a line; circling and knockback drift come back to it.
      pos.z *= 1 - k;
    }
    const fin = this.online.final;
    if (!fin || this.phase !== 'fighting') return;
    // A KO lands through its verdict (the killing blow is on its way to the chin). Anything
    // else — the bell, a forfeit — ends it now; a KO that somehow never lands gets 1.5 s.
    const koPending = fin.event === 'ko' && now - this.online.finalAt < 1.5;
    if (koPending) return;
    for (const f of this.fighters) {
      const opp = f === this.fighters[0] ? this.fighters[1] : this.fighters[0];
      if (f.netVerdict) this._presentNetVerdict(f, opp, f.attack || ATTACKS.punch, f.netVerdict, chestHit(opp), null);
    }
    if (this.phase !== 'fighting') return; // that verdict was the KO
    const label = fin.event === 'forfeit' ? 'FORFEIT!' : fin.event === 'abandoned' ? 'NO CONTEST' : 'TIME!';
    this._endMatch(fin.winner, label);
  }

  _disposeNet() {
    if (this.netInput) { this.netInput.dispose(); this.netInput = null; }
  }
}

export const Netplay = NetplayMethods.prototype;
