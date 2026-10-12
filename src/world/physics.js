// src/world/physics.js
// Utilidades de física reutilizables. Sin estado.
//
// CAMBIOS V1.5.0 (fix movimiento):
//   - [FIX CRÍTICO] applyFriction ahora interpreta `friction` como
//     "fracción de velocidad retenida por segundo" y convierte con
//     Math.pow(friction, dt). Antes se aplicaba cada tick, lo cual
//     con 0.92 dejaba las entidades casi estáticas.
//   - [FIX CRÍTICO] applyWander amplifica el impulso para dar
//     movimiento visible. Antes el impulso por tick era ~0.13 px/s,
//     produciendo velocidad terminal ~0.19 px/s.
//   - [FEAT] Comentarios de unidades en cada función.

/**
 * Wander browniano: añade una fuerza aleatoria.
 * @param {object} entity
 * @param {number} dt - delta time en segundos
 * @param {number} strength - intensidad base de la fuerza
 *
 * La velocidad terminal esperada ronda:
 *    σ_v ≈ (strength * WANDER_BOOST * dt / √12) / √(1 - friction²_porTick)
 * Con strength=8, friction=0.92 (per-second), produce ~15-25 px/s.
 */
export function applyWander(entity, dt, strength) {
  // Factor empírico: convierte "strength" en movimiento perceptible
  // dado el uso de fricción per-second. No es un valor mágico:
  // 30 * dt se calibra para que strength=8 dé ~20 px/s en régimen.
  const WANDER_BOOST = 30;
  const impulse = strength * WANDER_BOOST * dt;
  entity.vx += (Math.random() - 0.5) * impulse;
  entity.vy += (Math.random() - 0.5) * impulse;
}

/**
 * Fricción por segundo.
 * @param {object} entity
 * @param {number} frictionPerSecond - fracción de velocidad retenida tras 1s
 *                                     (0.92 → 92% retenido, 8% perdido)
 * @param {number} dt - delta time en segundos
 *
 * Ejemplo: friction=0.92 con dt=0.033 → factor por tick = 0.92^0.033 = 0.9973
 * Es decir, pierde 0.27% de velocidad por tick (~8% por segundo). Razonable.
 */
export function applyFriction(entity, frictionPerSecond, dt) {
  const factor = Math.pow(frictionPerSecond, dt);
  entity.vx *= factor;
  entity.vy *= factor;
}

/**
 * Atracción hacia un punto.
 * @returns true si se aplicó (dist > minDist)
 */
export function attractTowards(entity, targetX, targetY, strength, dt, minDist = 0) {
  const dx = targetX - entity.x;
  const dy = targetY - entity.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6 || dist < minDist) return false;
  const force = strength * dt;
  entity.vx += (dx / dist) * force;
  entity.vy += (dy / dist) * force;
  return true;
}

/**
 * Repulsión desde un punto.
 */
export function repelFrom(entity, srcX, srcY, strength, dt, minDist = 0) {
  const dx = entity.x - srcX;
  const dy = entity.y - srcY;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6 || dist < minDist) return false;
  const force = strength * dt;
  entity.vx += (dx / dist) * force;
  entity.vy += (dy / dist) * force;
  return true;
}

/**
 * Limita la velocidad a un máximo.
 */
export function clampVelocity(entity, maxVelocity) {
  const speed = Math.hypot(entity.vx, entity.vy);
  if (speed > maxVelocity && speed > 1e-6) {
    const k = maxVelocity / speed;
    entity.vx *= k;
    entity.vy *= k;
  }
}

/**
 * Aplica fuerzas de borde para que las entidades no se peguen a los límites.
 * Usa un "soft push" cuadrático en lugar de un rebote duro.
 */
export function applyBoundaries(entity, world) {
  const { width, height, margin } = world;
  const softZone = Math.max(20, margin * 0.5);

  if (entity.x < margin) {
    const d = margin - entity.x;
    entity.vx += (d / softZone) * 0.5;
  } else if (entity.x > width - margin) {
    const d = entity.x - (width - margin);
    entity.vx -= (d / softZone) * 0.5;
  }

  if (entity.y < margin) {
    const d = margin - entity.y;
    entity.vy += (d / softZone) * 0.5;
  } else if (entity.y > height - margin) {
    const d = entity.y - (height - margin);
    entity.vy -= (d / softZone) * 0.5;
  }

  // Hard clamp para que nunca salga
  entity.x = Math.max(0, Math.min(width, entity.x));
  entity.y = Math.max(0, Math.min(height, entity.y));
}

/**
 * Integra la velocidad en la posición.
 */
export function integrate(entity, dt) {
  entity.x += entity.vx * dt;
  entity.y += entity.vy * dt;
}

/**
 * Distancia euclídea al cuadrado (más rápido, sin sqrt).
 */
export function distSq(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/**
 * Distancia euclídea.
 */
export function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Normaliza un ángulo a [-PI, PI].
 */
export function normalizeAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}
