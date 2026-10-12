// src/persistence/repository.js
// Capa de acceso a datos. Toda la lógica de SQL vive aquí.

import { getDb } from './db.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const log = logger.child('repo');

// ============================================================
// Entidades
// ============================================================

export const EntityRepo = {
  upsertMany(rows) {
    if (!rows || rows.length === 0) return 0;
    const db = getDb();

    const stmt = db.prepare(`
      INSERT INTO entities (
        id, is_simulated, label, x, y, vx, vy,
        turn_count, sentiment, intensity,
        dominant_emotion, dominant_intent,
        topics_json, traits_json,
        born_at, last_seen_at, last_updated_at,
        interaction_count, dead
      ) VALUES (
        @id, @isSimulated, @label, @x, @y, @vx, @vy,
        @turnCount, @sentiment, @intensity,
        @dominantEmotion, @dominantIntent,
        @topicsJson, @traitsJson,
        @bornAt, @lastSeenAt, @lastUpdatedAt,
        @interactionCount, 0
      )
      ON CONFLICT(id) DO UPDATE SET
        is_simulated = excluded.is_simulated,
        label = excluded.label,
        x = excluded.x,
        y = excluded.y,
        vx = excluded.vx,
        vy = excluded.vy,
        turn_count = excluded.turn_count,
        sentiment = excluded.sentiment,
        intensity = excluded.intensity,
        dominant_emotion = excluded.dominant_emotion,
        dominant_intent = excluded.dominant_intent,
        topics_json = excluded.topics_json,
        traits_json = excluded.traits_json,
        last_seen_at = excluded.last_seen_at,
        last_updated_at = excluded.last_updated_at,
        interaction_count = excluded.interaction_count,
        dead = 0
    `);

    const tx = db.transaction((items) => {
      for (const r of items) stmt.run(r);
    });

    tx(rows);
    return rows.length;
  },

  getById(id) {
    const db = getDb();
    return db.prepare('SELECT * FROM entities WHERE id = ? AND dead = 0').get(id);
  },

  listAlive(limit = 1000) {
    const db = getDb();
    return db.prepare(`
      SELECT * FROM entities
      WHERE dead = 0
      ORDER BY last_seen_at DESC
      LIMIT ?
    `).all(limit);
  },

  listSimulated() {
    const db = getDb();
    return db.prepare(`
      SELECT * FROM entities
      WHERE dead = 0 AND is_simulated = 1
      ORDER BY born_at DESC
    `).all();
  },

  listAll(limit = 5000) {
    const db = getDb();
    return db.prepare(`
      SELECT * FROM entities
      ORDER BY last_updated_at DESC
      LIMIT ?
    `).all(limit);
  },

  markDead(id, reason = 'unknown') {
    const db = getDb();
    return db.prepare(`
      UPDATE entities SET dead = 1, last_updated_at = ?
      WHERE id = ?
    `).run(Date.now(), id);
  },

  delete(id) {
    const db = getDb();
    return db.prepare('DELETE FROM entities WHERE id = ?').run(id);
  },

  count() {
    const db = getDb();
    const r = db.prepare('SELECT COUNT(*) AS c FROM entities WHERE dead = 0').get();
    return r.c;
  },

  countSimulated() {
    const db = getDb();
    const r = db.prepare(
      'SELECT COUNT(*) AS c FROM entities WHERE dead = 0 AND is_simulated = 1'
    ).get();
    return r.c;
  },
};

// ============================================================
// Relaciones
// ============================================================

export const RelationshipRepo = {
  upsertMany(rows) {
    if (!rows || rows.length === 0) return 0;
    const db = getDb();

    const stmt = db.prepare(`
      INSERT INTO relationships (a, b, strength, updated_at)
      VALUES (@a, @b, @strength, @updatedAt)
      ON CONFLICT(a, b) DO UPDATE SET
        strength = excluded.strength,
        updated_at = excluded.updated_at
    `);

    const tx = db.transaction((items) => {
      for (const r of items) stmt.run(r);
    });

    tx(rows);
    return rows.length;
  },

  deleteBelowThreshold(minStrength = 0.01) {
    const db = getDb();
    return db.prepare('DELETE FROM relationships WHERE strength < ?').run(minStrength);
  },

  /**
   * Reemplaza TODAS las relaciones. Útil para snapshot atómico.
   */
  replaceAll(rows) {
    const db = getDb();
    const del = db.prepare('DELETE FROM relationships');
    const ins = db.prepare(`
      INSERT INTO relationships (a, b, strength, updated_at)
      VALUES (@a, @b, @strength, @updatedAt)
    `);

    const tx = db.transaction((items) => {
      del.run();
      for (const r of items) ins.run(r);
    });
    tx(rows || []);
    return rows?.length || 0;
  },

  listAbove(minStrength = 0.01) {
    const db = getDb();
    return db.prepare(`
      SELECT * FROM relationships
      WHERE strength >= ?
      ORDER BY strength DESC
    `).all(minStrength);
  },

  listForEntity(id) {
    const db = getDb();
    return db.prepare(`
      SELECT * FROM relationships
      WHERE a = ? OR b = ?
      ORDER BY strength DESC
    `).all(id, id);
  },

  count() {
    const db = getDb();
    const r = db.prepare('SELECT COUNT(*) AS c FROM relationships').get();
    return r.c;
  },
};

// ============================================================
// Eventos
// ============================================================

export const EventRepo = {
  insertMany(events) {
    if (!events || events.length === 0) return 0;
    const db = getDb();

    const stmt = db.prepare(`
      INSERT INTO events (type, payload_json, created_at)
      VALUES (?, ?, ?)
    `);

    const now = Date.now();
    const tx = db.transaction((items) => {
      for (const e of items) {
        stmt.run(
          String(e.type || 'unknown').slice(0, 60),
          JSON.stringify(e.payload || e),
          Number(e.at) || now,
        );
      }
    });
    tx(events);
    return events.length;
  },

  recent(limit = 100, type = null) {
    const db = getDb();
    if (type) {
      return db.prepare(`
        SELECT * FROM events
        WHERE type = ?
        ORDER BY id DESC
        LIMIT ?
      `).all(type, limit);
    }
    return db.prepare(`
      SELECT * FROM events
      ORDER BY id DESC
      LIMIT ?
    `).all(limit);
  },

  prune(maxRows) {
    const db = getDb();
    const keep = Math.max(100, Number(maxRows) || 5000);
    const r = db.prepare(`
      DELETE FROM events
      WHERE id NOT IN (
        SELECT id FROM events ORDER BY id DESC LIMIT ?
      )
    `).run(keep);
    return r.changes;
  },

  count() {
    const db = getDb();
    const r = db.prepare('SELECT COUNT(*) AS c FROM events').get();
    return r.c;
  },
};

// ============================================================
// Snapshots
// ============================================================

export const SnapshotRepo = {
  insert(snapshot) {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO snapshots (tick, entity_count, payload_json, created_at)
      VALUES (?, ?, ?, ?)
    `);
    const r = stmt.run(
      Number(snapshot.tick) || 0,
      Number(snapshot.entityCount) || 0,
      JSON.stringify(snapshot.payload || {}),
      Date.now(),
    );
    return r.lastInsertRowid;
  },

  latest() {
    const db = getDb();
    const row = db.prepare(`
      SELECT * FROM snapshots ORDER BY id DESC LIMIT 1
    `).get();
    if (!row) return null;
    try {
      return {
        id: row.id,
        tick: row.tick,
        entityCount: row.entity_count,
        payload: JSON.parse(row.payload_json),
        createdAt: row.created_at,
      };
    } catch {
      return null;
    }
  },

  prune(maxRows) {
    const db = getDb();
    const keep = Math.max(5, Number(maxRows) || 20);
    const r = db.prepare(`
      DELETE FROM snapshots
      WHERE id NOT IN (
        SELECT id FROM snapshots ORDER BY id DESC LIMIT ?
      )
    `).run(keep);
    return r.changes;
  },

  count() {
    const db = getDb();
    const r = db.prepare('SELECT COUNT(*) AS c FROM snapshots').get();
    return r.c;
  },
};

// ============================================================
// Persistencia agregada del mundo
// ============================================================

/**
 * Guarda el estado completo del mundo en una transacción.
 * @param {import('../world/World.js').World} world
 */
export function persistWorld(world) {
  const { entities, relations } = world.toPersistable();
  const now = Date.now();

  const entityRows = entities.map(e => ({
    id: e.id,
    isSimulated: e.isSimulated,
    label: e.label,
    x: e.x,
    y: e.y,
    vx: e.vx,
    vy: e.vy,
    turnCount: e.turnCount,
    sentiment: e.sentiment,
    intensity: e.intensity,
    dominantEmotion: e.dominantEmotion,
    dominantIntent: e.dominantIntent,
    topicsJson: e.topicsJson,
    traitsJson: e.traitsJson,
    bornAt: e.bornAt,
    lastSeenAt: e.lastSeenAt,
    lastUpdatedAt: e.lastUpdatedAt,
    interactionCount: e.interactionCount,
  }));

  const relRows = relations.map(r => ({
    a: r.a,
    b: r.b,
    strength: r.strength,
    updatedAt: now,
  }));

  EntityRepo.upsertMany(entityRows);
  RelationshipRepo.replaceAll(relRows);

  return { entities: entityRows.length, relations: relRows.length };
}

/**
 * Reconstruye el mundo desde la DB.
 * @param {import('../world/World.js').World} world
 */
export function restoreWorld(world) {
  const entityRows = EntityRepo.listAlive(5000);
  const relRows = RelationshipRepo.listAbove(0.001);

  // Adaptar al formato que espera world.restoreFrom
  const entities = entityRows.map(r => ({
    id: r.id,
    isSimulated: r.is_simulated,
    label: r.label,
    x: r.x,
    y: r.y,
    vx: r.vx,
    vy: r.vy,
    turnCount: r.turn_count,
    sentiment: r.sentiment,
    intensity: r.intensity,
    dominantEmotion: r.dominant_emotion,
    dominantIntent: r.dominant_intent,
    topicsJson: r.topics_json,
    traitsJson: r.traits_json,
    bornAt: r.born_at,
    lastSeenAt: r.last_seen_at,
    lastUpdatedAt: r.last_updated_at,
    interactionCount: r.interaction_count,
  }));

  const relations = relRows.map(r => ({
    a: r.a,
    b: r.b,
    strength: r.strength,
  }));

  const n = world.restoreFrom({ entities, relations });
  log.info(`Mundo restaurado: ${n} entidades, ${relations.length} relaciones`);
  return n;
}

export function getDbStats() {
  return {
    entities: EntityRepo.count(),
    entitiesSimulated: EntityRepo.countSimulated(),
    relationships: RelationshipRepo.count(),
    events: EventRepo.count(),
    snapshots: SnapshotRepo.count(),
  };
}
