// src/routes/api.js
// Rutas de información general del mundo: health, world snapshot, stats, config.
//
// CAMBIOS V1.6.0:
//   - [FEAT] /stats incluye dialogueCount.
//   - [FEAT] /health expone dialogues en db.

import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { pingCerebro } from '../cerebro/client.js';
import { getDbStats, EventRepo, DialogueRepo } from '../persistence/repository.js';
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
      version: '1.6.0',
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
  // ------------------------------------------------------------
  router.get('/world', (req, res) => {
    res.json({
      success: true,
      world: world.snapshot(),
    });
  });

  // ------------------------------------------------------------
  // GET /stats
  // ------------------------------------------------------------
  router.get('/stats', (req, res) => {
    const dbStats = safeDbStats();

    res.json({
      success: true,
      stats: world.getStats(),
      db: dbStats,
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

  // ------------------------------------------------------------
  // GET /recent-dialogues
  // Últimos diálogos globales (para un feed público opcional).
  // ------------------------------------------------------------
  router.get('/recent-dialogues', (req, res) => {
    try {
      const limit = clampInt(req.query.limit, 30, 1, 200);
      const rows = DialogueRepo.recent ? DialogueRepo.recent(limit) : [];
      res.json({ success: true, count: rows.length, dialogues: rows });
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
