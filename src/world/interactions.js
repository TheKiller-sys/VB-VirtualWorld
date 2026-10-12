// src/world/interactions.js
// Detección de encuentros y aplicación de efectos sociales.
//
// CAMBIOS V1.3.0:
//   - [FEAT] Diálogo asíncrono via LLM del Cerebro (con fallback a plantillas).
//   - [FEAT] Registro de encuentro en communityProtocol (opcional).
//   - [FIX] El tick del mundo no se bloquea esperando al LLM.

import { generateDialogue, notifyCommunity } from './dialogue.js';
import { logger } from '../utils/logger.js';

const log = logger.child('interactions');

const DIALOGUE_COOLDOWN_MS = 15000;
const RELATION_GAIN_BASE = 0.25;
const RELATION_GAIN_SIMILARITY_BONUS = 0.35;
const MAX_RELATION_GAIN_PER_INTERACTION = 0.5;

export function findInteractionPairs(world) {
  const entities = Array.from(world.entities.values())
    .filter(e => !e.dead && !e.fading);

  const now = Date.now();
  const pairs = [];
  const r = world.interactRadius;
  const rSq = r * r;

  for (let i = 0; i < entities.length; i++) {
    const a = entities[i];
    for (let j = i + 1; j < entities.length; j++) {
      const b = entities[j];

      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const dSq = dx * dx + dy * dy;
      if (dSq > rSq) continue;

      if (now - a.lastInteractionAt < world.interactCooldownMs) continue;
      if (now - b.lastInteractionAt < world.interactCooldownMs) continue;

      pairs.push([a, b]);
    }
  }

  return pairs;
}

export function performInteraction(world, a, b) {
  const now = Date.now();
  a.lastInteractionAt = now;
  b.lastInteractionAt = now;
  a.interactionCount++;
  b.interactionCount++;

  a.setPulse(1);
  b.setPulse(1);

  const sim = a.similarityTo(b);
  const emotionalCharge = Math.abs(a.sentiment - b.sentiment) * 0.2;

  let gain = RELATION_GAIN_BASE + sim * RELATION_GAIN_SIMILARITY_BONUS;
  gain = Math.min(MAX_RELATION_GAIN_PER_INTERACTION, gain + emotionalCharge);

  a.reinforceRelationship(b.id, gain);
  b.reinforceRelationship(a.id, gain);

  // Empujón físico suave
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dist = Math.hypot(dx, dy) || 1;
  const overlap = Math.max(0, world.interactRadius - dist);
  const push = overlap * 0.3;
  a.vx += (dx / dist) * push;
  a.vy += (dy / dist) * push;
  b.vx -= (dx / dist) * push;
  b.vy -= (dy / dist) * push;

  const event = {
    type: 'interaction',
    at: now,
    payload: {
      a: a.id,
      b: b.id,
      aIsSim: a.isSimulated,
      bIsSim: b.isSimulated,
      strength: round3(sim),
      x: round1((a.x + b.x) / 2),
      y: round1((a.y + b.y) / 2),
      colorA: a.color,
      colorB: b.color,
      gain: round3(gain),
    },
  };

  // ============================================================
  // Diálogo (asíncrono)
  // ============================================================
  const aLastDialogue = a.lastDialogueAt || 0;
  const bLastDialogue = b.lastDialogueAt || 0;
  const canDialogueA = (now - aLastDialogue) > DIALOGUE_COOLDOWN_MS;
  const canDialogueB = (now - bLastDialogue) > DIALOGUE_COOLDOWN_MS;

  if (canDialogueA && canDialogueB) {
    a.lastDialogueAt = now;
    b.lastDialogueAt = now;
    a.lastDialoguePartnerId = b.id;
    b.lastDialoguePartnerId = a.id;

    // Fire-and-forget: no bloquea el tick
    _generateAndEmitDialogue(world, a, b, {
      similarity: sim,
      gain,
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
    }).catch(err => {
      log.debug(`Diálogo falló: ${err.message}`);
    });

    // Notifica al communityProtocol (fire-and-forget)
    notifyCommunity(a, b, {
      similarity: sim,
      gain,
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
    });
  }

  return event;
}

/**
 * Genera el diálogo (async) y emite un evento separado al World.
 */
async function _generateAndEmitDialogue(world, a, b, meta) {
  const result = await generateDialogue(a, b);

  if (!result || !Array.isArray(result.messages) || result.messages.length === 0) {
    return;
  }

  world._pushEvent({
    type: 'dialogue',
    at: Date.now(),
    payload: {
      a: a.id,
      b: b.id,
      source: result.source,
      x: meta.x,
      y: meta.y,
      messages: result.messages.map(m => ({
        entityId: m.entityId,
        text: m.text,
        delayMs: m.delayMs,
        durationMs: m.durationMs,
      })),
    },
  });
}

function round1(v) { return Math.round(v * 10) / 10; }
function round3(v) { return Math.round(v * 1000) / 1000; }
