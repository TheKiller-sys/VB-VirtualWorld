// src/routes/api.js
// Rutas de información general del mundo: health, world snapshot, stats.

import { Router } from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { pingCerebro } from '../cerebro/client.js';
import { getDbStats } from '../persistence/repository.js';
import { env } from '../config/env.js';

export function createApiRouter({ world, poller, wsServer, startedAt }) {
  const router = Router();

  // ------------------------------------------------------------
  // GET /api/health
  // ------------------------------------------------------------
  router.get('/health', asyncHandler(async (req, res) => {
    const uptimeSec = Math.round((Date.now() - startedAt) / 1000);
    const mem = process.memoryUsage();

    const cerebro = await pingCerebro().catch(() => ({ ok: false }));
    const dbStats = safeDbStats();

    res.json({
      ok: true,
      service: 'cerebro-world',
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
      memory: {
        heapUsedMB: round1(mem.heapUsed / 1024 / 1024),
        rssMB: round1(mem.rss / 1024 / 1024),
      },
    });
  }));

  // ------------------------------------------------------------
  // GET /api/world
  // ------------------------------------------------------------
  router.get('/world', (req, res) => {
    res.json({
      success: true,
      world: world.snapshot(),
    });
  });

  // ------------------------------------------------------------
  // GET /api/stats
  // ------------------------------------------------------------
  router.get('/stats', (req, res) => {
    res.json({
      success: true,
      stats: world.getStats(),
      db: safeDbStats(),
      ws: wsServer.getStats(),
      poller: poller.getState(),
    });
  });

  // ------------------------------------------------------------
  // GET /api/events
  // ------------------------------------------------------------
  router.get('/events', (req, res) => {
    const limit = clampInt(req.query.limit, 50, 1, 500);
    const type = typeof req.query.type === 'string' ? req.query.type.slice(0, 60) : null;

    // Leemos de la DB para persistencia real
    const { EventRepo } = require('../persistence/repository.js');
    // Nota: como es ESM, usamos import dinámico abajo

    res.json({ success: true, events: [], count: 0, note: 'Ver /api/events/query' });
  });

  // ------------------------------------------------------------
  // GET /api/config
  // Expone configuración no sensible al frontend.
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
      },
    });
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

function round1(v) { return Math.round(v * 10) / 10; }

function safeDbStats() {
  try {
    return getDbStats();
  } catch {
    return null;
  }
}
