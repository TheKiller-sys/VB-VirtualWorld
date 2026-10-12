// src/routes/entities.js
// Rutas de entidades + simulación.
//
// CAMBIOS V1.1.0:
//   - [SEC] Acepta ipQuota (inyectado desde server.js).
//   - [SEC] Registra/desregistra IPs al crear/eliminar simuladas.
//   - [FIX] Eliminada sanitización duplicada (la hace labelSanitizer en server.js).
//   - [FIX] Validación de label coherente con server.js (más permisiva aquí,
//           porque el server ya lo sanitizó antes).
//   - [FIX] El guard de admin permite dev sin token (aviso en consola).
//   - [FEAT] Los DELETE devuelven más info en la respuesta.

import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const log = logger.child('routes/entities');

// ============================================================
// Guard de admin
// ============================================================

function requireWorldAdmin(req, res, next) {
  // En producción ya lo valida server.js al arrancar.
  // Aquí solo aplicamos el check por request.

  if (!env.worldAdminToken) {
    if (env.isProd) {
      return res.status(503).json({
        success: false,
        error: 'WORLD_ADMIN_TOKEN no configurado en producción',
      });
    }
    return next(); // dev sin token
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

  // label — ya viene saneado por labelSanitizer del server.js.
  // Aquí solo validamos tipo y longitud por defensa.
  if (body.label !== undefined && body.label !== null) {
    if (typeof body.label !== 'string') {
      errors.push('label debe ser string');
    } else {
      out.label = body.label.slice(0, 60);
    }
  }

  // emotion
  if (body.emotion !== undefined && body.emotion !== null) {
    const e = String(body.emotion).toLowerCase();
    if (!EMOTIONS.has(e)) {
      errors.push(`emotion inválida: ${body.emotion}`);
    } else {
      out.dominantEmotion = e;
    }
  }

  // intent
  if (body.intent !== undefined && body.intent !== null) {
    if (typeof body.intent !== 'string') {
      errors.push('intent debe ser string');
    } else {
      out.dominantIntent = body.intent.slice(0, 40);
    }
  }

  // turnCount
  if (body.turnCount !== undefined && body.turnCount !== null) {
    const n = Number(body.turnCount);
    if (!Number.isFinite(n) || n < 0 || n > 100000) {
      errors.push('turnCount inválido');
    } else {
      out.turnCount = Math.floor(n);
    }
  }

  // sentiment
  if (body.sentiment !== undefined && body.sentiment !== null) {
    const n = Number(body.sentiment);
    if (!Number.isFinite(n) || n < -1 || n > 1) {
      errors.push('sentiment debe estar entre -1 y 1');
    } else {
      out.sentiment = n;
    }
  }

  // intensity
  if (body.intensity !== undefined && body.intensity !== null) {
    const n = Number(body.intensity);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      errors.push('intensity debe estar entre 0 y 1');
    } else {
      out.intensity = n;
    }
  }

  // topics
  if (body.topics !== undefined && body.topics !== null) {
    if (!Array.isArray(body.topics)) {
      errors.push('topics debe ser array');
    } else {
      out.topics = body.topics.slice(0, 8).map(t => String(t).slice(0, 40));
    }
  }

  // traits
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

  // position (opcional)
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
    const type = req.query.type; // 'real' | 'simulated' | undefined

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
  // POST /simulate
  // Crea una entidad simulada.
  // Los middlewares (rate, quota, global limit, sanitización) los aplica
  // server.js ANTES de llegar aquí.
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

      // Registra la IP en la cuota SOLO si es creación nueva (no update)
      if (created && ipQuota) {
        ipQuota.register(ip, entity.id);
      }

      log.info(
        `Entidad simulada ${created ? 'creada' : 'actualizada'}: ${id} ` +
        `(${entity.dominantEmotion}/${entity.dominantIntent}) desde ${ip}`
      );

      // Notifica por WS a todos
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
  // Lista de simuladas
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
  // Elimina UNA simulada
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
  // Elimina TODAS las simuladas
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
