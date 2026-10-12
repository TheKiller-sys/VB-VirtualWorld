// src/server.js
// Punto de entrada. Orquesta: DB → mundo → poller → HTTP → WS → simulación → shutdown.

import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import compression from 'compression';
import helmet from 'helmet';

import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { World } from './world/World.js';
import { Poller } from './cerebro/poller.js';
import { createWSServer } from './transport/ws.js';
import { createApiRouter } from './routes/api.js';
import { createEntitiesRouter } from './routes/entities.js';

import {
  initDb,
  closeDb,
} from './persistence/db.js';

import {
  persistWorld,
  restoreWorld,
  getDbStats,
  EventRepo,
  SnapshotRepo,
} from './persistence/repository.js';

const log = logger.child('server');
const STARTED_AT = Date.now();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

// ============================================================
// Estado global
// ============================================================

let world = null;
let poller = null;
let wsServer = null;
let httpServer = null;
let expressApp = null;

let tickTimer = null;
let snapshotTimer = null;
let pruneTimer = null;
let lastTickAt = Date.now();

let shuttingDown = false;

// ============================================================
// Rate limit simple en memoria
// ============================================================

function createRateLimiter({ windowMs, max }) {
  const hits = new Map();

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) {
      if (v.resetAt < now) hits.delete(k);
    }
  }, windowMs);
  if (cleanup.unref) cleanup.unref();

  return (req, res, next) => {
    const key = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();

    let entry = hits.get(key);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
    }
    entry.count++;
    hits.set(key, entry);

    res.set('X-RateLimit-Limit', String(max));
    res.set('X-RateLimit-Remaining', String(Math.max(0, max - entry.count)));
    res.set('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ success: false, error: 'Demasiadas peticiones' });
    }
    next();
  };
}

// ============================================================
// Arranque
// ============================================================

async function start() {
  log.info(`🌍 Cerebro World arrancando (env=${env.nodeEnv}, demo=${env.demoMode})`);

  // ---------- 1. DB ----------
  initDb();

  // ---------- 2. Mundo ----------
  world = new World({
    width: env.world.width,
    height: env.world.height,
    margin: env.world.margin,
    wanderStrength: env.world.wanderStrength,
    attractStrength: env.world.attractStrength,
    repelStrength: env.world.repelStrength,
    maxVelocity: env.world.maxVelocity,
    friction: env.world.friction,
    attractRadius: env.world.attractRadius,
    interactRadius: env.world.interactRadius,
    interactCooldownMs: env.world.interactCooldownMs,
    relationDecayPerHour: env.world.relationDecayPerHour,
    entityTimeoutMs: env.world.entityTimeoutMs,
    entityFadeMs: env.world.entityFadeMs,
    eventRetention: env.eventRetention,
  });

  // ---------- 3. Restaurar desde DB ----------
  try {
    restoreWorld(world);
  } catch (err) {
    log.warn(`No se pudo restaurar el mundo: ${err.message}`);
  }

  // ---------- 4. Demo mode ----------
  if (env.demoMode) {
    seedDemoEntities(world, env.demoEntityCount);
  }

  // ---------- 5. Poller ----------
  poller = new Poller(world, {
    intervalMs: env.pollIntervalMs,
    sessionsLimit: env.pollSessionsLimit,
    onNewEntity: (profile) => {
      if (wsServer) {
        const e = world.getEntity(profile.id);
        if (e) {
          wsServer.broadcast({
            type: 'entity_created',
            entity: e.toJSON(),
            isSimulated: false,
            at: Date.now(),
          });
        }
      }
    },
  });

  if (!env.demoMode) {
    poller.start();
  } else {
    log.info('🚧 Demo mode: poller NO iniciado');
  }

  // ---------- 6. Express ----------
  expressApp = express();
  expressApp.set('trust proxy', 1);

  expressApp.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }));
  expressApp.use(compression());
  expressApp.use(express.json({ limit: '256kb' }));

  // Rate limit global
  const globalLimiter = createRateLimiter({
    windowMs: env.rateLimitWindowMs,
    max: env.rateLimitMax,
  });
  expressApp.use('/api/', globalLimiter);

  // CORS permisivo para el mundo público
  expressApp.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-World-Token');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  // ---------- 7. HTTP server + WS ----------
  httpServer = http.createServer(expressApp);
  wsServer = createWSServer(httpServer, world);

  // ---------- 8. Rutas ----------
  // Nota: /api/entities se monta primero porque tiene rutas más específicas.
  expressApp.use('/api/entities', createEntitiesRouter({ world, wsServer }));

  // Simulate vive dentro de entities.js y ya está montado bajo /api/entities.
  // Pero queremos exponer /api/simulate y /api/simulate/:id también.
  // Los añadimos al router principal de API.

  const apiRouter = createApiRouter({
    world,
    poller,
    wsServer,
    startedAt: STARTED_AT,
  });

  // Alias: /api/simulate → /api/entities/simulate
  expressApp.post('/api/simulate', (req, res, next) => {
    req.url = '/simulate';
    expressApp.handle(req, res, next);
  });

  expressApp.use('/api', apiRouter);

  // ---------- 9. Estáticos ----------
  expressApp.use(express.static(PUBLIC_DIR, {
    maxAge: env.isProd ? '1h' : 0,
    etag: true,
    index: 'index.html',
  }));

  // Fallback a index.html (SPA)
  expressApp.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/ws')) {
      return next();
    }
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  // 404 API
  expressApp.use('/api', (req, res) => {
    res.status(404).json({ success: false, error: 'Endpoint no encontrado' });
  });

  // Error handler
  expressApp.use((err, req, res, next) => {
    log.error(`Express error en ${req.method} ${req.path}: ${err.message}`);
    if (res.headersSent) return next(err);
    res.status(err.statusCode || 500).json({
      success: false,
      error: err.message,
    });
  });

  // ---------- 10. Bucle de simulación ----------
  lastTickAt = Date.now();
  tickTimer = setInterval(() => {
    try {
      const now = Date.now();
      const dt = Math.min(0.1, (now - lastTickAt) / 1000);
      lastTickAt = now;
      world.tick(dt);
    } catch (err) {
      log.error(`Tick falló: ${err.message}`);
    }
  }, env.tickIntervalMs);
  if (tickTimer.unref) tickTimer.unref();

  // ---------- 11. Persistencia periódica ----------
  snapshotTimer = setInterval(() => {
    persistSafely('periodic');
  }, env.snapshotIntervalMs);
  if (snapshotTimer.unref) snapshotTimer.unref();

  // ---------- 12. Pruning ----------
  pruneTimer = setInterval(() => {
    try {
      EventRepo.prune(env.eventRetention);
      SnapshotRepo.prune(20);
    } catch (err) {
      log.warn(`Prune falló: ${err.message}`);
    }
  }, 5 * 60 * 1000); // cada 5 min
  if (pruneTimer.unref) pruneTimer.unref();

  // ---------- 13. Escuchar ----------
  await new Promise((resolve) => {
    httpServer.listen(env.port, env.host, () => {
      log.info(`✅ HTTP escuchando en http://${env.host}:${env.port}`);
      log.info(`🔌 WebSocket en ws://${env.host}:${env.port}/ws`);
      log.info(`📊 Estado del mundo: ${world.entities.size} entidades`);
      resolve();
    });
  });

  // Banner
  printBanner();
}

// ============================================================
// Persistencia
// ============================================================

function persistSafely(reason = 'manual') {
  if (!world) return;
  try {
    const t0 = Date.now();

    // 1. Entidades + relaciones
    const r = persistWorld(world);

    // 2. Eventos drenados (persistimos los pendientes)
    const events = world.drainEvents();
    if (events.length > 0) {
      EventRepo.insertMany(events);
    }

    // 3. Snapshot (opcional, solo cada cierto tiempo)
    if (reason === 'periodic' || reason === 'shutdown') {
      const snap = world.snapshot({ includeRelationships: true });
      SnapshotRepo.insert({
        tick: snap.tick,
        entityCount: snap.entityCount,
        payload: {
          entities: snap.entities,
          relationships: snap.relationships,
        },
      });
    }

    log.debug(
      `Persistencia (${reason}): ${r.entities} entidades, ${r.relations} relaciones, ` +
      `${events.length} eventos en ${Date.now() - t0}ms`
    );
  } catch (err) {
    log.error(`Persistencia falló (${reason}): ${err.message}`);
  }
}

// ============================================================
// Demo seed
// ============================================================

function seedDemoEntities(world, count) {
  const emotions = ['alegria', 'tristeza', 'curiosidad', 'calma', 'nostalgia', 'ira', 'neutral'];
  const intents = ['charla', 'filosofia', 'pregunta_opinion', 'saludo', 'despedida'];
  const topicsPool = ['vida', 'muerte', 'amor', 'consciencia', 'tiempo', 'memoria', 'futuro'];

  for (let i = 0; i < count; i++) {
    const emotion = emotions[Math.floor(Math.random() * emotions.length)];
    const intent = intents[Math.floor(Math.random() * intents.length)];
    const turnCount = Math.floor(Math.random() * 100) + 5;
    const sentiment = (Math.random() - 0.5) * 1.5;
    const topics = [];
    const nTopics = Math.floor(Math.random() * 3) + 1;
    for (let j = 0; j < nTopics; j++) {
      topics.push(topicsPool[Math.floor(Math.random() * topicsPool.length)]);
    }

    const traits = {};
    for (const k of ['openness', 'curiosity', 'emotionality', 'sociality', 'stability']) {
      traits[k] = Math.random();
    }

    world.upsertEntity({
      id: `sim_demo_${i}_${Math.random().toString(36).slice(2, 6)}`,
      isSimulated: true,
      label: `Demo #${i}`,
      turnCount,
      sentiment,
      intensity: 0.3 + Math.random() * 0.7,
      dominantEmotion: emotion,
      dominantIntent: intent,
      topics,
      traits,
      bornAt: Date.now() - Math.random() * 3600000,
      lastSeenAt: Date.now(),
    });
  }

  log.info(`Demo: ${count} entidades ficticias generadas`);
}

// ============================================================
// Banner
// ============================================================

function printBanner() {
  const line = '═'.repeat(66);
  const s = world.getStats();

  console.log(`
${line}
   🌍 CEREBRO WORLD — MUNDO VIVO
${line}
   Servidor:      http://${env.host}:${env.port}
   WebSocket:     ws://${env.host}:${env.port}/ws
   Entorno:       ${env.nodeEnv}
   Demo:          ${env.demoMode ? 'SÍ' : 'no'}
   Cerebro:       ${env.cerebroUrl}
   Poller:        ${env.demoMode ? 'DETENIDO (demo)' : `cada ${env.pollIntervalMs}ms`}
   Tick:          cada ${env.tickIntervalMs}ms
   Snapshot:      cada ${env.snapshotIntervalMs}ms
   Mundo:         ${world.width}×${world.height}
   Entidades:     ${s.entities.total} (${s.entities.real} reales, ${s.entities.simulated} simuladas)
   Relaciones:    ${s.relationships.total} (${s.relationships.strong} fuertes)
   Admin Token:   ${env.worldAdminToken ? '🔒 configurado' : '⚠️  NO configurado'}
   WS Token:      ${env.worldWsToken ? '🔒 configurado' : '⚠️  público'}
${line}
`);
}

// ============================================================
// Shutdown
// ============================================================

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  log.info(`🛑 ${signal} recibido, cerrando...`);

  const timeout = setTimeout(() => {
    log.error('Shutdown excedió 10s. Forzando salida.');
    process.exit(1);
  }, 10000);
  if (timeout.unref) timeout.unref();

  // 1. Detener ticks
  if (tickTimer) clearInterval(tickTimer);
  if (snapshotTimer) clearInterval(snapshotTimer);
  if (pruneTimer) clearInterval(pruneTimer);

  // 2. Detener poller
  if (poller) poller.stop();

  // 3. Persistir estado final
  persistSafely('shutdown');

  // 4. Cerrar WS
  if (wsServer) {
    try { await wsServer.close(); } catch (_) {}
  }

  // 5. Cerrar HTTP
  if (httpServer) {
    await new Promise((resolve) => httpServer.close(resolve));
  }

  // 6. Cerrar DB
  closeDb();

  clearTimeout(timeout);
  log.info('✅ Shutdown completado');

  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP', () => shutdown('SIGHUP'));

process.on('uncaughtException', (err) => {
  log.error(`❌ Excepción no capturada: ${err.message}`);
  log.error(err.stack);
  persistSafely('uncaught');
  shutdown('uncaughtException').catch(() => process.exit(1));
});

process.on('unhandledRejection', (reason) => {
  log.error(`❌ Promesa rechazada: ${reason?.message || reason}`);
  if (reason?.stack) log.error(reason.stack);
});

// ============================================================
// Bootstrap
// ============================================================

start().catch((err) => {
  log.error(`❌ Falló el arranque: ${err.message}`);
  log.error(err.stack);
  process.exit(1);
});
