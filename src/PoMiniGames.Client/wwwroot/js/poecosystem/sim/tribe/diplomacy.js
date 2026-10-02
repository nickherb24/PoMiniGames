// diplomacy.js — inter-tribe relations state machine, trade caravans & war triggers.
'use strict';

import { TRIBE_DIPLOMACY, CARAVAN_STATUS } from './contracts.js';
import { TRIBES } from '../core/config.js';

// Every chance below draws from the `tribes` stream (passed in by the store), never
// Math.random, which sim/core/prng.js forbids. The caravan timer and id are saved too, so a
// restored world dispatches its caravans on the same beat it was saved on.
export function createDiplomacyManager(rng = null) {
  const caravans = [];
  let nextCaravanId = 1;
  let caravanTimer = 0;
  const chance = () => (rng ? rng.next() : 0.5);

  return {
    caravans,

    step(tribes, territory, log = null, tick = 0) {
      const events = [];

      for (let i = 0; i < tribes.length; i++) {
        const tribeA = tribes[i];
        if (tribeA.warCooldownTicks > 0) {
          tribeA.warCooldownTicks--;
        }

        for (let j = i + 1; j < tribes.length; j++) {
          const tribeB = tribes[j];
          const currentRelation = tribeA.relations[tribeB.id];
          const friction = territory.computeBorderFriction(tribeA, tribeB);

          // 1. If at WAR: check casualty/peace thresholds
          if (currentRelation === TRIBE_DIPLOMACY.WAR) {
            const highCasualtiesA = tribeA.casualtyCount >= Math.max(1, tribeA.population * TRIBES.warCasualtyThreshold);
            const highCasualtiesB = tribeB.casualtyCount >= Math.max(1, tribeB.population * TRIBES.warCasualtyThreshold);

            if (highCasualtiesA || highCasualtiesB || (tribeA.warCooldownTicks === 0 && chance() < 0.005)) {
              // Conclude peace treaty
              tribeA.relations[tribeB.id] = TRIBE_DIPLOMACY.NEUTRAL;
              tribeB.relations[tribeA.id] = TRIBE_DIPLOMACY.NEUTRAL;
              tribeA.warCooldownTicks = TRIBES.peaceCooldownTicks;
              tribeB.warCooldownTicks = TRIBES.peaceCooldownTicks;
              tribeA.casualtyCount = 0;
              tribeB.casualtyCount = 0;

              const event = {
                kind: 'peace_treaty',
                tribeAId: tribeA.id,
                tribeAName: tribeA.name,
                tribeBId: tribeB.id,
                tribeBName: tribeB.name,
                text: `${tribeA.name} and ${tribeB.name} forged a lasting peace treaty`,
                treatyPending: true,
                reason: 'casualty armistice and resource depletion',
              };
              events.push(event);
              // The log entry carries the pair and the moment, so the page can ask the
              // Chieftain Council (/api/ecosystem/treaty) what the peace actually says.
              if (log) log.push({ tick, kind: 'diplomacy', action: 'peace', tribeA: tribeA.id, tribeB: tribeB.id, reason: event.reason, text: event.text });
            }
          }
          // 2. If NEUTRAL or RIVAL: check if war triggers
          else if (currentRelation !== TRIBE_DIPLOMACY.ALLIED && tribeA.warCooldownTicks === 0 && tribeB.warCooldownTicks === 0) {
            const scarcityA = tribeA.food < 30 || tribeA.wood < 20;
            const tension = friction * TRIBES.frictionBorderOverlapWeight + (scarcityA ? 0.3 : 0);

            if (tension > 0.45 && currentRelation !== TRIBE_DIPLOMACY.RIVAL) {
              tribeA.relations[tribeB.id] = TRIBE_DIPLOMACY.RIVAL;
              tribeB.relations[tribeA.id] = TRIBE_DIPLOMACY.RIVAL;
            } else if (tension > 0.75) {
              // Outbreak of war
              tribeA.relations[tribeB.id] = TRIBE_DIPLOMACY.WAR;
              tribeB.relations[tribeA.id] = TRIBE_DIPLOMACY.WAR;
              tribeA.warCooldownTicks = 800; // Minimum war engagement window
              tribeB.warCooldownTicks = 800;

              const event = {
                kind: 'war_declared',
                tribeAId: tribeA.id,
                tribeAName: tribeA.name,
                tribeBId: tribeB.id,
                tribeBName: tribeB.name,
                text: `${tribeA.name} declared war on ${tribeB.name} over disputed borders`,
              };
              events.push(event);
              if (log) log.push({ tick, kind: 'diplomacy', action: 'war', tribeA: tribeA.id, tribeB: tribeB.id, reason: 'disputed borders and scarcity', text: event.text });
            }
          }
        }
      }

      return events;
    },

    stepCaravans(tribes, territory, log = null, tick = 0) {
      caravanTimer++;

      // Dispatch evaluation every 120 ticks (6 seconds)
      if (caravanTimer % 120 === 0 && caravans.length < 6) {
        for (let i = 0; i < tribes.length; i++) {
          const from = tribes[i];
          for (let j = 0; j < tribes.length; j++) {
            if (i === j) continue;
            const to = tribes[j];
            const rel = from.relations[to.id];
            if (rel === TRIBE_DIPLOMACY.WAR || rel === TRIBE_DIPLOMACY.RIVAL) continue;

            const existing = caravans.find(c => (c.fromTribeId === from.id && c.toTribeId === to.id) || (c.fromTribeId === to.id && c.toTribeId === from.id));
            if (existing) continue;

            // Complementary trade opportunity:
            // Wood for Food
            if (from.wood >= 40 && from.food < 70 && to.food >= 60 && to.wood < 50) {
              from.wood -= 15;
              caravans.push({
                id: nextCaravanId++,
                fromTribeId: from.id,
                toTribeId: to.id,
                cargoKind: 'wood',
                amount: 15,
                returnKind: 'food',
                returnAmount: 15,
                x: from.centerX,
                z: from.centerZ,
                progress: 0.0,
                returning: false,
                status: CARAVAN_STATUS.DISPATCHED,
              });
              if (log) log.push({ tick, kind: 'trade', text: `${from.name} dispatched a trade caravan of timber to ${to.name}` });
              break;
            }
            // Stone for Wood
            else if (from.stone >= 35 && from.wood < 40 && to.wood >= 50 && to.stone < 25) {
              from.stone -= 10;
              caravans.push({
                id: nextCaravanId++,
                fromTribeId: from.id,
                toTribeId: to.id,
                cargoKind: 'stone',
                amount: 10,
                returnKind: 'wood',
                returnAmount: 15,
                x: from.centerX,
                z: from.centerZ,
                progress: 0.0,
                returning: false,
                status: CARAVAN_STATUS.DISPATCHED,
              });
              if (log) log.push({ tick, kind: 'trade', text: `${from.name} dispatched a quarry caravan to ${to.name}` });
              break;
            }
          }
        }
      }

      // Step existing caravans
      for (let k = caravans.length - 1; k >= 0; k--) {
        const c = caravans[k];
        const from = tribes.find(t => t.id === c.fromTribeId);
        const to = tribes.find(t => t.id === c.toTribeId);

        if (!from || !to) {
          caravans.splice(k, 1);
          continue;
        }

        const dx = to.centerX - from.centerX;
        const dz = to.centerZ - from.centerZ;

        if (!c.returning) {
          c.progress = Math.min(1.0, c.progress + 0.008);
          c.x = from.centerX + dx * c.progress;
          c.z = from.centerZ + dz * c.progress;

          // Check for hostile third-party ambushes
          for (const enemy of tribes) {
            if (enemy.id !== from.id && enemy.id !== to.id) {
              if (enemy.relations[from.id] === TRIBE_DIPLOMACY.WAR || enemy.relations[to.id] === TRIBE_DIPLOMACY.WAR) {
                const distToEnemy = Math.hypot(c.x - enemy.centerX, c.z - enemy.centerZ);
                if (distToEnemy < enemy.territoryRadius && chance() < 0.015) {
                  // Ambush!
                  if (c.cargoKind === 'wood') enemy.wood += c.amount;
                  else if (c.cargoKind === 'stone') enemy.stone += c.amount;
                  else if (c.cargoKind === 'food') enemy.food += c.amount;

                  from.casualtyCount += 1;
                  c.status = CARAVAN_STATUS.AMBUSHED;
                  if (log) log.push({ tick, kind: 'trade', text: `${enemy.name} raiders ambushed and plundered ${from.name}'s trade caravan!` });
                  caravans.splice(k, 1);
                  break;
                }
              }
            }
          }

          if (c.status === CARAVAN_STATUS.AMBUSHED) continue;

          // Reached destination
          if (c.progress >= 1.0) {
            if (c.cargoKind === 'wood') to.wood += c.amount;
            else if (c.cargoKind === 'stone') to.stone += c.amount;
            else if (c.cargoKind === 'food') to.food += c.amount;

            // Load return cargo
            if (c.returnKind === 'food') to.food = Math.max(0, to.food - c.returnAmount);
            else if (c.returnKind === 'wood') to.wood = Math.max(0, to.wood - c.returnAmount);

            c.returning = true;
            c.status = CARAVAN_STATUS.RETURNING;
          }
        } else {
          // Returning to home base
          c.progress = Math.max(0.0, c.progress - 0.008);
          c.x = from.centerX + dx * c.progress;
          c.z = from.centerZ + dz * c.progress;

          if (c.progress <= 0.0) {
            // Arrived back home safely
            if (c.returnKind === 'food') from.food += c.returnAmount;
            else if (c.returnKind === 'wood') from.wood += c.returnAmount;
            else if (c.returnKind === 'stone') from.stone += c.returnAmount;

            // Successful trade pact milestone
            if (from.relations[to.id] === TRIBE_DIPLOMACY.NEUTRAL && chance() < 0.25) {
              from.relations[to.id] = TRIBE_DIPLOMACY.ALLIED;
              to.relations[from.id] = TRIBE_DIPLOMACY.ALLIED;
              if (log) log.push({ tick, kind: 'diplomacy', action: 'alliance', tribeA: from.id, tribeB: to.id, text: `${from.name} and ${to.name} formed an official Alliance through prosperous trade` });
            }

            caravans.splice(k, 1);
          }
        }
      }
    },

    toTelemetry() {
      return caravans.map(c => ({
        id: c.id,
        fromTribeId: c.fromTribeId,
        toTribeId: c.toTribeId,
        cargoKind: c.cargoKind,
        amount: c.amount,
        x: Math.round(c.x * 10) / 10,
        z: Math.round(c.z * 10) / 10,
        progress: Math.round(c.progress * 100) / 100,
        returning: c.returning,
      }));
    },

    getState() {
      return { caravans: caravans.map(c => ({ ...c })), nextCaravanId, caravanTimer };
    },

    setState(s) {
      caravans.length = 0;
      // Older saves stored the bare caravan array.
      const list = Array.isArray(s) ? s : s?.caravans;
      if (Array.isArray(list)) for (const c of list) caravans.push({ ...c });
      if (s && !Array.isArray(s)) {
        nextCaravanId = Number.isInteger(s.nextCaravanId) ? s.nextCaravanId : nextCaravanId;
        caravanTimer = Number.isInteger(s.caravanTimer) ? s.caravanTimer : caravanTimer;
      }
    },
  };
}
