// src/routes/entities.js
// Rutas de entidades + simulación + diálogos.
//
// CAMBIOS V1.6.0:
//   - [FEAT] GET /api/entities/:id/dialogues → todos los diálogos de la entidad
//   - [FEAT] GET /api/entities/:id/dialogues/:otherId → diálogos entre dos
//   - [FEAT] GET /api/entities/:id/relationships incluye lastDialogueAt

import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { DialogueRepo } from '../persistence/repository.js';

const log = logger.child('routes/entities');

// ============================================================
// Guard de admin
// ============================================================

function requireWorldAdmin(req, res, next) {
  if (!env.worldAdminToken) {
    if (env.isProd) {
      return res.status(503).json({
        success: false,
        error: 'WORLD_ADMIN_TOKEN no configurado en producción',
      });
    }
    return next();
  }

  const token = req.headers['x-world-token'] || req.query.token;
  if (token !== env.worldAdminToken) {
    return res.status(401).json({ success: false, error: 'No autorizado' });
  }
  next();
}

// ============================================================
// Validación de payloads
// ============================================================

const EMOTIONS = new Set([
  'alegria', 'tristeza', 'miedo', 'ira', 'ansiedad',
  'calma', 'curiosidad', 'neutral', 'sorpresa', 'nostalgia',
  'gratitud', 'confusion',
]);

const TRAIT_KEYS = ['openness', 'curiosity', 'emotionality', 'sociality', 'stability'];

function validateSimulateBody(body) {
  const errors = [];
  const out = {};

  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'Body debe ser un objeto' };
  }

  if (body.label !== undefined && body.label !== null) {
    if (typeof body.label !== 'string') {
      errors.push('label debe ser string');
    } else {
      out.label = body.label.slice(0, 60);
    }
  }

  if (body.emotion !== undefined && body.emotion !== null) {
    const e = String(body.emotion).toLowerCase();
    if (!EMOTIONS.has(e)) {
      errors.push(`emotion inválida: ${body.emotion}`);
    } else {
      out.dominantEmotion = e;
    }
  }

  if (body.intent !== undefined && body.intent !== null) {
    if (typeof body.intent !== 'string') {
      errors.push('intent debe ser string');
    } else {
      out.dominantIntent = body.intent.slice(0, 40);
    }
  }

  if (body.turnCount !== undefined && body.turnCount !== null) {
    const n = Number(body.turnCount);
    if (!Number.isFinite(n) || n < 0 || n > 100000) {
      errors.push('turnCount inválido');
    } else {
      out.turnCount = Math.floor(n);
    }
  }

  if (body.sentiment !== undefined && body.sentiment !== null) {
    const n = Number(body.sentiment);
    if (!Number.isFinite(n) || n < -1 || n > 1) {
      errors.push('sentiment debe estar entre -1 y 1');
    } else {
      out.sentiment = n;
    }
  }

  if (body.intensity !== undefined && body.intensity !== null) {
    const n = Number(body.intensity);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      errors.push('intensity debe estar entre 0 y 1');
    } else {
      out.intensity = n;
    }
  }

  if (body.topics !== undefined && body.topics !== null) {
    if (!Array.isArray(body.topics)) {
      errors.push('topics debe ser array');
    } else {
      out.topics = body.topics.slice(0, 8).map(t => String(t).slice(0, 40));
    }
  }

  if (body.traits !== undefined && body.traits !== null) {
    if (typeof body.traits !== 'object' || Array.isArray(body.traits)) {
      errors.push('traits debe ser objeto');
    } else {
      const cleaned = {};
      for (const k of TRAIT_KEYS) {
        if (body.traits[k] === undefined) continue;
        const n = Number(body.traits[k]);
        if (!Number.isFinite(n) || n < 0 || n > 1) {
          errors.push(`trait ${k} debe estar entre 0 y 1`);
        } else {
          cleaned[k] = n;
        }
      }
      out.traits = cleaned;
    }
  }

  if (body.x !== undefined && body.x !== null) {
    const n = Number(body.x);
    if (Number.isFinite(n)) out.x = n;
  }
  if (body.y !== undefined && body.y !== null) {
    const n = Number(body.y);
    if (Number.isFinite(n)) out.y = n;
  }

  if (errors.length > 0) return { ok: false, error: errors.join('; ') };
  return { ok: true, value: out };
}

// ============================================================
// Router
// ============================================================

export function createEntitiesRouter({ world, wsServer, ipQuota }) {
  const router = Router();

  // ------------------------------------------------------------
  // GET /
  // Lista de entidades
  // ------------------------------------------------------------
  router.get('/', (req, res) => {
    const limit = clampInt(req.query.limit, 500, 1, 2000);
    const type = req.query.type;

    let entities = Array.from(world.entities.values())
      .filter(e => !e.dead);

    if (type === 'simulated') {
      entities = entities.filter(e => e.isSimulated);
    } else if (type === 'real') {
      entities = entities.filter(e => !e.isSimulated);
    }

    entities = entities
      .sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt)
      .slice(0, limit);

    res.json({
      success: true,
      count: entities.length,
      total: world.entities.size,
      entities: entities.map(e => e.toJSON()),
    });
  });

  // ------------------------------------------------------------
  // GET /:id
  // Detalle de una entidad con sus relaciones
  // ------------------------------------------------------------
  router.get('/:id', (req, res) => {
    const id = String(req.params.id);
    const entity = world.getEntity(id);
    if (!entity || entity.dead) {
      return res.status(404).json({ success: false, error: 'Entidad no encontrada' });
    }

    const relationships = [];
    for (const [otherId, strength] of entity.relationships) {
      const other = world.getEntity(otherId);
      if (!other || other.dead) continue;
      relationships.push({
        id: otherId,
        strength: round3(strength),
        emotion: other.dominantEmotion,
        isSimulated: other.isSimulated,
        label: other.label,
        x: round2(other.x),
        y: round2(other.y),
        dialogueCount: safeCountDialogues(entity.id, otherId),
      });
    }
    relationships.sort((a, b) => b.strength - a.strength);

    res.json({
      success: true,
      entity: entity.toJSON(),
      relationships,
    });
  });

  // ------------------------------------------------------------
  // GET /:id/relationships
  // Solo relaciones (más ligero)
  // ------------------------------------------------------------
  router.get('/:id/relationships', (req, res) => {
    const id = String(req.params.id);
    const entity = world.getEntity(id);
    if (!entity || entity.dead) {
      return res.status(404).json({ success: false, error: 'Entidad no encontrada' });
    }

    const relationships = [];
    for (const [otherId, strength] of entity.relationships) {
      const other = world.getEntity(otherId);
      if (!other || other.dead) continue;
      relationships.push({
        id: otherId,
        strength: round3(strength),
        other: other.toJSON(),
        dialogueCount: safeCountDialogues(entity.id, otherId),
      });
    }

    relationships.sort((a, b) => b.strength - a.strength);

    res.json({
      success: true,
      entityId: id,
      count: relationships.length,
      relationships,
    });
  });

  // ------------------------------------------------------------
  // GET /:id/dialogues
  // Todos los diálogos donde participa la entidad.
  // Query params:
  //   - limit (default 50, max 200)
  //   - with=otherId  → filtra solo diálogos con esa entidad
  // ------------------------------------------------------------
  router.get('/:id/dialogues', (req, res) => {
    const id = String(req.params.id);
    const entity = world.getEntity(id);

    if (!entity) {
      // La entidad puede haber muerto pero sus diálogos siguen en DB
      // Solo advertimos, no bloqueamos
    }

    const limit = clampInt(req.query.limit, 50, 1, 200);
    const withId = req.query.with ? String(req.query.with) : null;

    try {
      let dialogues;

      if (withId) {
        dialogues = DialogueRepo.listByPair(id, withId, limit);
      } else {
        dialogues = DialogueRepo.listByEntity(id, limit);
      }

      res.json({
        success: true,
        entityId: id,
        withId: withId || null,
        count: dialogues.length,
        dialogues: dialogues.map(d => serializeDialogue(d, world, id)),
      });
    } catch (err) {
      log.error(`GET /:id/dialogues falló: ${err.message}`);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ------------------------------------------------------------
  // GET /:id/dialogues/:otherId
  // Diálogos entre dos entidades específicas.
  // ------------------------------------------------------------
  router.get('/:id/dialogues/:otherId', (req, res) => {
    const id = String(req.params.id);
    const otherId = String(req.params.otherId);
    const limit = clampInt(req.query.limit, 100, 1, 200);

    try {
      const dialogues = DialogueRepo.listByPair(id, otherId, limit);

      res.json({
        success: true,
        entityId: id,
        otherId,
        count: dialogues.length,
        dialogues: dialogues.map(d => serializeDialogue(d, world, id)),
      });
    } catch (err) {
      log.error(`GET /:id/dialogues/:otherId falló: ${err.message}`);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ------------------------------------------------------------
  // POST /simulate
  // ------------------------------------------------------------
  router.post('/simulate', requireWorldAdmin, asyncHandler(async (req, res) => {
    const v = validateSimulateBody(req.body);
    if (!v.ok) {
      return res.status(400).json({ success: false, error: v.error });
    }

    const id = generateSimId();
    const now = Date.now();
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';

    const profile = {
      id,
      isSimulated: true,
      label: v.value.label || null,
      x: v.value.x,
      y: v.value.y,
      turnCount: v.value.turnCount ?? 0,
      sentiment: v.value.sentiment ?? 0,
      intensity: v.value.intensity ?? 0.5,
      dominantEmotion: v.value.dominantEmotion || 'neutral',
      dominantIntent: v.value.dominantIntent || 'charla',
      topics: v.value.topics || [],
      traits: v.value.traits || {},
      bornAt: now,
      lastSeenAt: now,
    };

    try {
      const { entity, created } = world.upsertEntity(profile);

      if (created && ipQuota) {
        ipQuota.register(ip, entity.id);
      }

      log.info(
        `Entidad simulada ${created ? 'creada' : 'actualizada'}: ${id} ` +
        `(${entity.dominantEmotion}/${entity.dominantIntent}) desde ${ip}`
      );

      wsServer.broadcast({
        type: 'entity_created',
        entity: entity.toJSON(),
        isSimulated: true,
        at: now,
      });

      res.status(201).json({
        success: true,
        created,
        entity: entity.toJSON(),
        quota: ipQuota ? {
          used: ipQuota.countForIp(ip),
          max: ipQuota.maxPerIp,
        } : null,
      });
    } catch (err) {
      log.warn(`Error creando entidad simulada: ${err.message}`);
      res.status(500).json({ success: false, error: err.message });
    }
  }));

  // ------------------------------------------------------------
  // GET /simulate
  // ------------------------------------------------------------
  router.get('/simulate', (req, res) => {
    const list = Array.from(world.entities.values())
      .filter(e => !e.dead && e.isSimulated)
      .map(e => e.toJSON());

    res.json({
      success: true,
      count: list.length,
      entities: list,
    });
  });

  // ------------------------------------------------------------
  // DELETE /simulate/:id
  // ------------------------------------------------------------
  router.delete('/simulate/:id', requireWorldAdmin, (req, res) => {
    const id = String(req.params.id);
    const entity = world.getEntity(id);

    if (!entity) {
      return res.status(404).json({ success: false, error: 'Entidad no encontrada' });
    }
    if (!entity.isSimulated) {
      return res.status(403).json({
        success: false,
        error: 'Solo se pueden eliminar entidades simuladas',
      });
    }

    const ok = world.removeEntity(id, 'admin_delete');

    if (ok) {
      if (ipQuota) ipQuota.unregister(id);
      log.info(`Entidad simulada eliminada: ${id}`);
      wsServer.broadcast({
        type: 'entity_removed',
        id,
        reason: 'admin_delete',
        at: Date.now(),
      });
    }

    res.json({ success: ok, id });
  });

  // ------------------------------------------------------------
  // DELETE /simulate
  // ------------------------------------------------------------
  router.delete('/simulate', requireWorldAdmin, (req, res) => {
    const ids = [];
    for (const e of world.entities.values()) {
      if (!e.dead && e.isSimulated) ids.push(e.id);
    }

    for (const id of ids) {
      world.removeEntity(id, 'admin_clear');
      if (ipQuota) ipQuota.unregister(id);
    }

    log.info(`Borradas ${ids.length} entidades simuladas`);

    wsServer.broadcast({
      type: 'entities_cleared',
      count: ids.length,
      at: Date.now(),
    });

    res.json({ success: true, removed: ids.length });
  });

  return router;
}

// ============================================================
// Helpers
// ============================================================

function serializeDialogue(d, world, viewerId) {
  const entityA = world.getEntity(d.aId);
  const entityB = world.getEntity(d.bId);

  return {
    id: d.id,
    source: d.source,
    createdAt: d.createdAt,
    startedAt: d.startedAt,
    participants: {
      a: entityA ? {
        id: entityA.id,
        label: entityA.label,
        emotion: entityA.dominantEmotion,
        color: entityA.color,
      } : { id: d.aId, label: null, emotion: 'neutral', color: '#9aa3b2' },
      b: entityB ? {
        id: entityB.id,
        label: entityB.label,
        emotion: entityB.dominantEmotion,
        color: entityB.color,
      } : { id: d.bId, label: null, emotion: 'neutral', color: '#9aa3b2' },
    },
    messages: d.messages.map(m => ({
      entityId: m.entityId,
      text: m.text,
      delayMs: m.delayMs,
      durationMs: m.durationMs,
      // Marca quién habla respecto al viewer
      side: m.entityId === viewerId ? 'self' : 'other',
    })),
  };
}

function safeCountDialogues(aId, bId) {
  try {
    return DialogueRepo.listByPair(aId, bId, 200).length;
  } catch (_) {
    return 0;
  }
}

function generateSimId() {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `sim_${t}_${r}`;
}

function clampInt(v, def, min, max) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

function round2(v) { return Math.round(v * 100) / 100; }
function round3(v) { return Math.round(v * 1000) / 1000; }
