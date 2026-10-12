// src/world/interactions.js
// Detección de encuentros y aplicación de efectos sociales.

import { Entity } from './Entity.js';

const MIN_INTERACTION_STRENGTH = 0.15;
const RELATION_GAIN_BASE = 0.25;
const RELATION_GAIN_SIMILARITY_BONUS = 0.35;
const MAX_RELATION_GAIN_PER_INTERACTION = 0.5;

/**
 * Detecta pares de entidades que están dentro del radio de interacción
 * y que no están en cooldown. Devuelve los pares únicos.
 */
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

      // Cooldown por entidad (más simple que por par)
      if (now - a.lastInteractionAt < world.interactCooldownMs) continue;
      if (now - b.lastInteractionAt < world.interactCooldownMs) continue;

      pairs.push([a, b]);
    }
  }

  return pairs;
}

/**
 * Ejecuta una interacción entre dos entidades: refuerza relaciones,
 * dispara pulso visual, incrementa contadores y devuelve el evento.
 */
export function performInteraction(world, a, b) {
  const now = Date.now();
  a.lastInteractionAt = now;
  b.lastInteractionAt = now;
  a.interactionCount++;
  b.interactionCount++;

  // Pulso visual
  a.setPulse(1);
  b.setPulse(1);

  // Fuerza de la interacción depende de similitud
  const sim = a.similarityTo(b);
  const emotionalCharge = Math.abs(a.sentiment - b.sentiment) * 0.2;

  let gain = RELATION_GAIN_BASE + sim * RELATION_GAIN_SIMILARITY_BONUS;
  gain = Math.min(MAX_RELATION_GAIN_PER_INTERACTION, gain + emotionalCharge);

  a.reinforceRelationship(b.id, gain);
  b.reinforceRelationship(a.id, gain);

  // Empujón físico suave para que no se solapen
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

  return event;
}

function round1(v) { return Math.round(v * 10) / 10; }
function round3(v) { return Math.round(v * 1000) / 1000; }
