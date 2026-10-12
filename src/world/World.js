// src/world/World.js
// El mundo compartido. Contiene todas las entidades, el tick de simulación
// y la lista de eventos recientes para broadcast.

import { Entity } from './Entity.js';
import {
  applyWander,
  applyFriction,
  clampVelocity,
  applyBoundaries,
  integrate,
} from './physics.js';
import { findInteractionPairs, performInteraction } from './interactions.js';

export class World {
  constructor(config) {
    // Dimensiones
    this.width = config.width;
    this.height = config.height;
    this.margin = config.margin;

    // Física
    this.wanderStrength = config.wanderStrength;
    this.attractStrength = config.attractStrength;
    this.repelStrength = config.repelStrength;
    this.maxVelocity = config.maxVelocity;
    this.friction = config.friction;

    // Interacciones
    this.attractRadius = config.attractRadius;
    this.interactRadius = config.interactRadius;
    this.interactCooldownMs = config.interactCooldownMs;
    this.relationDecayPerHour = config.relationDecayPerHour;

    // Vida
    this.entityTimeoutMs = config.entityTimeoutMs;
    this.entityFadeMs = config.entityFadeMs;

    // Estado
    this.entities = new Map();     // id → Entity
    this.events = [];              // eventos pendientes de broadcast
    this.eventRetention = config.eventRetention ?? 5000;
    this.tickCount = 0;
    this.startedAt = Date.now();
    this.stats = {
      born: 0,
      died: 0,
      interactions: 0,
    };
  }

  // ------------------------------------------------------------
  // Gestión de entidades
  // ------------------------------------------------------------

  /**
   * Inserta o actualiza una entidad desde un perfil.
   * Devuelve { entity, created }.
   */
  upsertEntity(profile) {
    if (!profile || !profile.id) throw new Error('profile.id es obligatorio');

    let entity = this.entities.get(profile.id);
    let created = false;

    if (!entity) {
      entity = new Entity(profile);
      this.entities.set(entity.id, entity);
      this.stats.born++;
      created = true;

      this._pushEvent({
        type: 'entity_born',
        at: Date.now(),
        payload: {
          id: entity.id,
          x: entity.x,
          y: entity.y,
          color: entity.color,
          isSimulated: entity.isSimulated,
          label: entity.label,
        },
      });
    } else {
      entity.updateFromProfile(profile);
    }

    return { entity, created };
  }

  getEntity(id) {
    return this.entities.get(id) || null;
  }

  removeEntity(id, reason = 'removed') {
    const entity = this.entities.get(id);
    if (!entity) return false;

    this.entities.delete(id);
    this.stats.died++;

    // Limpiar relaciones entrantes
    for (const other of this.entities.values()) {
      other.relationships.delete(id);
    }

    this._pushEvent({
      type: 'entity_died',
      at: Date.now(),
      payload: { id, reason },
    });
    return true;
  }

  // ------------------------------------------------------------
  // Tick principal
  // ------------------------------------------------------------

  tick(dt) {
    this.tickCount++;
    const entities = Array.from(this.entities.values());

    // 1. Física por entidad
    for (const e of entities) {
      if (e.dead) continue;
      this._applySingleEntityPhysics(e, dt);
    }

    // 2. Atracción/repulsión entre entidades (O(n²) — aceptable hasta ~500)
    this._applyPairwiseForces(entities, dt);

    // 3. Interacciones
    if (entities.length > 1) {
      const pairs = findInteractionPairs(this);
      for (const [a, b] of pairs) {
        if (a.dead || b.dead) continue;
        const event = performInteraction(this, a, b);
        this.stats.interactions++;
        this._pushEvent(event);
      }
    }

    // 4. Post-física
    for (const e of entities) {
      if (e.dead) continue;
      clampVelocity(e, this.maxVelocity);
      integrate(e, dt);
      applyBoundaries(e, this);
      e.tickPulse();
    }

    // 5. Fade por inactividad
    for (const e of entities) {
      if (e.dead) continue;
      e.tickFade(dt, this);
    }

    // 6. Decay de relaciones
    for (const e of entities) {
      if (e.dead) continue;
      e.decayRelationships(dt, this.relationDecayPerHour);
    }

    // 7. Limpiar muertos
    for (const e of entities) {
      if (e.dead) this.removeEntity(e.id, 'faded');
    }

    // 8. Podar eventos
    if (this.events.length > this.eventRetention) {
      this.events.splice(0, this.events.length - this.eventRetention);
    }
  }

  _applySingleEntityPhysics(entity, dt) {
    applyWander(entity, dt, this.wanderStrength);
    applyFriction(entity, this.friction);
  }

  _applyPairwiseForces(entities, dt) {
    const n = entities.length;
    const r = this.attractRadius;
    const rSq = r * r;
    const rSmall = this.interactRadius * 1.2;

    for (let i = 0; i < n; i++) {
      const a = entities[i];
      if (a.dead || a.fading) continue;

      for (let j = i + 1; j < n; j++) {
        const b = entities[j];
        if (b.dead || b.fading) continue;

        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dSq = dx * dx + dy * dy;
        if (dSq > rSq || dSq < 1e-6) continue;

        const dist = Math.sqrt(dSq);

        // Atracción efectiva: mezcla similitud + relación existente
        const similarity = a.similarityTo(b);
        const relation = Math.max(
          a.relationships.get(b.id) || 0,
          b.relationships.get(a.id) || 0,
        );
        const attraction = Math.max(similarity, relation);

        let fx = 0;
        let fy = 0;

        if (attraction > 0.4 && dist > rSmall) {
          // Atracción
          const t = 1 - dist / r;
          const force = this.attractStrength * attraction * t * dt;
          fx += (dx / dist) * force;
          fy += (dy / dist) * force;
        } else if (attraction < 0.2 && dist < r * 0.7) {
          // Repulsión por incompatibilidad
          const t = 1 - dist / (r * 0.7);
          const force = this.repelStrength * (1 - attraction) * t * dt;
          fx -= (dx / dist) * force;
          fy -= (dy / dist) * force;
        }

        // Repulsión mínima para evitar solapamiento
        if (dist < rSmall) {
          const overlap = rSmall - dist;
          const push = overlap * 0.8 * dt * 60;
          fx -= (dx / dist) * push;
          fy -= (dy / dist) * push;
        }

        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }
    }
  }

  // ------------------------------------------------------------
  // Eventos
  // ------------------------------------------------------------

  _pushEvent(ev) {
    this.events.push(ev);
  }

  /**
   * Drena los eventos acumulados (para broadcast).
   * Devuelve un array y vacía el buffer.
   */
  drainEvents() {
    if (this.events.length === 0) return [];
    const out = this.events;
    this.events = [];
    return out;
  }

  // ------------------------------------------------------------
  // Relaciones agregadas (para el frontend)
  // ------------------------------------------------------------

  getRelationshipLinks(minStrength = 0.15) {
    const seen = new Set();
    const links = [];

    for (const a of this.entities.values()) {
      if (a.dead) continue;
      for (const [bId, strength] of a.relationships) {
        if (strength < minStrength) continue;
        const b = this.entities.get(bId);
        if (!b || b.dead) continue;

        const key = a.id < bId ? `${a.id}|${bId}` : `${bId}|${a.id}`;
        if (seen.has(key)) continue;
        seen.add(key);

        links.push({
          a: a.id,
          b: bId,
          strength: round3(strength),
        });
      }
    }

    return links;
  }

  // ------------------------------------------------------------
  // Snapshot para el frontend
  // ------------------------------------------------------------

  snapshot({ includeRelationships = true } = {}) {
    const entities = [];
    for (const e of this.entities.values()) {
      if (e.dead) continue;
      entities.push(e.toJSON());
    }

    const snap = {
      tick: this.tickCount,
      width: this.width,
      height: this.height,
      entityCount: entities.length,
      entities,
      serverTime: Date.now(),
      uptimeSec: round1((Date.now() - this.startedAt) / 1000),
      stats: { ...this.stats },
    };

    if (includeRelationships) {
      snap.relationships = this.getRelationshipLinks();
    }

    return snap;
  }

  // ------------------------------------------------------------
  // Persistencia: import/export
  // ------------------------------------------------------------

  /**
   * Devuelve el estado persistible completo (entidades + relaciones).
   */
  toPersistable() {
    const entities = [];
    const relations = [];

    for (const e of this.entities.values()) {
      if (e.dead) continue;
      entities.push(e.toPersistRow());
      for (const [bId, strength] of e.relationships) {
        if (strength <= 0) continue;
        // Guardamos solo una dirección (a < b) para evitar duplicados
        if (e.id < bId) {
          relations.push({ a: e.id, b: bId, strength });
        }
      }
    }

    return { entities, relations };
  }

  /**
   * Reconstruye el mundo desde filas persistidas.
   * No dispara eventos.
   */
  restoreFrom({ entities, relations }) {
    this.entities.clear();
    this.stats = { born: 0, died: 0, interactions: 0 };

    for (const row of entities) {
      try {
        const profile = {
          id: row.id,
          isSimulated: !!row.isSimulated,
          label: row.label,
          x: row.x,
          y: row.y,
          vx: row.vx,
          vy: row.vy,
          turnCount: row.turnCount,
          sentiment: row.sentiment,
          intensity: row.intensity,
          dominantEmotion: row.dominantEmotion,
          dominantIntent: row.dominantIntent,
          topics: safeParse(row.topicsJson, []),
          traits: safeParse(row.traitsJson, {}),
          bornAt: row.bornAt,
          lastSeenAt: row.lastSeenAt,
          lastUpdatedAt: row.lastUpdatedAt,
          interactionCount: row.interactionCount,
        };
        const e = new Entity(profile);
        e.lastUpdatedAt = row.lastUpdatedAt || Date.now();
        // Ojo: Entity constructor pisa lastUpdatedAt con Date.now().
        // Lo restauramos después:
        this.entities.set(e.id, e);
      } catch (err) {
        // Ignorar filas corruptas
      }
    }

    for (const rel of relations) {
      const a = this.entities.get(rel.a);
      const b = this.entities.get(rel.b);
      if (!a || !b) continue;
      const s = Math.max(0, Math.min(1, rel.strength));
      a.relationships.set(b.id, s);
      b.relationships.set(a.id, s);
    }

    return this.entities.size;
  }

  // ------------------------------------------------------------
  // Estadísticas agregadas
  // ------------------------------------------------------------

  getStats() {
    const byEmotion = {};
    const byIntent = {};
    let real = 0;
    let simulated = 0;

    for (const e of this.entities.values()) {
      if (e.dead) continue;
      byEmotion[e.dominantEmotion] = (byEmotion[e.dominantEmotion] || 0) + 1;
      byIntent[e.dominantIntent] = (byIntent[e.dominantIntent] || 0) + 1;
      if (e.isSimulated) simulated++;
      else real++;
    }

    const links = this.getRelationshipLinks(0.15);

    return {
      tick: this.tickCount,
      uptimeSec: round1((Date.now() - this.startedAt) / 1000),
      entities: {
        total: real + simulated,
        real,
        simulated,
      },
      relationships: {
        total: links.length,
        strong: links.filter(l => l.strength >= 0.6).length,
      },
      byEmotion,
      byIntent,
      lifetime: { ...this.stats },
    };
  }
}

// ============================================================
// Helpers
// ============================================================

function round1(v) { return Math.round(v * 10) / 10; }
function round3(v) { return Math.round(v * 1000) / 1000; }
function safeParse(str, def) {
  try { return JSON.parse(str); } catch { return def; }
}

export default World;
