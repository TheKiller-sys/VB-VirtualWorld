// src/routes/api.js
// Rutas de información general del mundo: health, world snapshot, stats, config.
//
// CAMBIOS V1.1.0:
//   - [FIX] Eliminado el require() roto en /api/events (ahora está en server.js).
//   - [SEC] Acepta ipQuota y limits para exponerlos en /health, /stats, /config.
//   - [FEAT] /config expone security.maxTotalEntities y maxSimulatedPerIp
//            (para que el frontend pinte "X/Y entidades" en el HUD).
//   - [FEAT] /health reporta cuota y límites.
//   - [FEAT] Nuevo GET /recent-events (últimos N eventos sin paginación compleja).

import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { pingCerebro } from '../cerebro/client.js';
import { getDbStats, EventRepo } from '../persistence/repository.js';
import { env } from '../config/env.js';

export function createApiRouter({ world, poller, wsServer, startedAt, ipQuota, limits }) {
  const router = Router();

  // ------------------------------------------------------------
  // GET /health
  // ------------------------------------------------------------
  router.get('/health', asyncHandler(async (req, res) => {
    const uptimeSec = Math.round((Date.now() - startedAt) / 1000);
    const mem = process.memoryUsage();

    const cerebro = await pingCerebro().catch(() => ({ ok: false }));
    const dbStats = safeDbStats();

    res.json({
      ok: true,
      service: 'cerebro-world',
      version: '1.1.0',
      uptimeSec,
      now: Date.now(),
      environment: env.nodeEnv,
      demoMode: env.demoMode,
      world: {
        tick: world.tickCount,
        entities: world.entities.size,
        relationships: world.getRelationshipLinks(0.15).length,
      },
      poller: poller.getState(),
      ws: wsServer.getStats(),
      db: dbStats,
      cerebro: {
        url: env.cerebroUrl,
        reachable: cerebro.ok,
        latencyMs: cerebro.latencyMs,
      },
      security: {
        maxTotalEntities: limits?.MAX_TOTAL_ENTITIES ?? env.maxTotalEntities,
        maxSimulatedPerIp: limits?.MAX_SIMULATED_PER_IP ?? env.maxSimulatedPerIp,
        requiresAdminToken: !!env.worldAdminToken,
        requiresWsToken: !!env.worldWsToken,
        quota: ipQuota?.getStats?.() || null,
      },
      memory: {
        heapUsedMB: round1(mem.heapUsed / 1024 / 1024),
        rssMB: round1(mem.rss / 1024 / 1024),
      },
    });
  }));

  // ------------------------------------------------------------
  // GET /world
  // Snapshot completo del mundo (para polling manual sin WS)
  // ------------------------------------------------------------
  router.get('/world', (req, res) => {
    res.json({
      success: true,
      world: world.snapshot(),
    });
  });

  // ------------------------------------------------------------
  // GET /stats
  // Métricas agregadas del mundo
  // ------------------------------------------------------------
  router.get('/stats', (req, res) => {
    res.json({
      success: true,
      stats: world.getStats(),
      db: safeDbStats(),
      ws: wsServer.getStats(),
      poller: poller.getState(),
      quota: ipQuota?.getStats?.() || null,
      limits: {
        maxTotalEntities: limits?.MAX_TOTAL_ENTITIES ?? env.maxTotalEntities,
        maxSimulatedPerIp: limits?.MAX_SIMULATED_PER_IP ?? env.maxSimulatedPerIp,
      },
    });
  });

  // ------------------------------------------------------------
  // GET /config
  // Configuración no sensible para el frontend
  // ------------------------------------------------------------
  router.get('/config', (req, res) => {
    res.json({
      success: true,
      config: {
        world: {
          width: world.width,
          height: world.height,
          margin: world.margin,
          attractRadius: world.attractRadius,
          interactRadius: world.interactRadius,
        },
        ws: {
          broadcastHz: env.wsBroadcastHz,
        },
        demoMode: env.demoMode,
        requiresWsToken: !!env.worldWsToken,
        security: {
          maxTotalEntities: limits?.MAX_TOTAL_ENTITIES ?? env.maxTotalEntities,
          maxSimulatedPerIp: limits?.MAX_SIMULATED_PER_IP ?? env.maxSimulatedPerIp,
        },
      },
    });
  });

  // ------------------------------------------------------------
  // GET /recent-events
  // Últimos eventos (wrapper simple de EventRepo)
  // ------------------------------------------------------------
  router.get('/recent-events', (req, res) => {
    try {
      const limit = clampInt(req.query.limit, 50, 1, 500);
      const type = typeof req.query.type === 'string'
        ? req.query.type.slice(0, 60)
        : null;

      const rows = EventRepo.recent(limit, type);

      const events = rows.map(r => {
        let payload = null;
        try { payload = JSON.parse(r.payload_json); } catch (_) {}
        return {
          id: r.id,
          type: r.type,
          payload,
          createdAt: r.created_at,
        };
      });

      res.json({ success: true, count: events.length, events });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}

// ============================================================
// Helpers
// ============================================================

function clampInt(v, def, min, max) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

function round1(v) {
  return Math.round(v * 10) / 10;
}

function safeDbStats() {
  try {
    return getDbStats();
  } catch {
    return null;
  }
}
