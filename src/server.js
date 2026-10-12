// src/server.js
// Punto de entrada de Cerebro World.
// Orquesta: DB → mundo → poller → HTTP → WS → simulación → shutdown.
//
// CAMBIOS V1.1.0 (endurecimiento):
//   - [SEC] WORLD_WS_TOKEN obligatorio en producción.
//   - [SEC] Rate limit dedicado para /api/simulate (por IP).
//   - [SEC] Cuota de simuladas por IP (default 20).
//   - [SEC] Límite global de entidades (default 500).
//   - [SEC] Sanitización de labels (blacklist + normalización Unicode).
//   - [PERF] Primer poll silencioso: no spamea entity_born al arrancar.
//   - [FEAT] Endpoint GET /api/events (histórico de eventos).
//   - [FEAT] Endpoint GET /api/entities/:id/events (eventos por entidad).
//   - [FIX] Rutas de /api/simulate montadas correctamente (sin hack).
//   - [FIX] Eliminado require() roto en el router de /api/events.

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

// ============================================================
// Constantes y estado global
// ============================================================

const log = logger.child('server');
const STARTED_AT = Date.now();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

// Límites duros de seguridad
const LIMITS = Object.freeze({
  // Máximo de entidades totales (reales + simuladas) vivas en el mundo
  MAX_TOTAL_ENTITIES: Number(process.env.MAX_TOTAL_ENTITIES) || 500,
  // Máximo de simuladas activas por IP
  MAX_SIMULATED_PER_IP: Number(process.env.MAX_SIMULATED_PER_IP) || 20,
  // Rate limit específico de /api/simulate (por IP)
  SIMULATE_RATE_WINDOW_MS: Number(process.env.SIMULATE_RATE_WINDOW_MS) || 60000,
  SIMULATE_RATE_MAX: Number(process.env.SIMULATE_RATE_MAX) || 5,
  // Longitud máxima de label
  MAX_LABEL_LENGTH: 60,
});

// Estado global (singleton)
let world = null;
let poller = null;
let wsServer = null;
let httpServer = null;
let expressApp = null;

let tickTimer = null;
let snapshotTimer = null;
let pruneTimer = null;
let lastTickAt = Date.now();

// Para detectar primer poll y silenciar eventos
let firstPollCompleted = false;

// Estado de shutdown
let shuttingDown = false;

// ============================================================
// Rate limiting
// ============================================================

/**
 * Crea un rate limiter en memoria. Limpia entradas expiradas periódicamente.
 */
function createRateLimiter({ windowMs, max, keyPrefix = 'rl' }) {
  const hits = new Map();

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) {
      if (v.resetAt < now) hits.delete(k);
    }
  }, Math.max(30000, windowMs));
  if (cleanup.unref) cleanup.unref();

  const middleware = (req, res, next) => {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const key = `${keyPrefix}:${ip}`;
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
      return res.status(429).json({
        success: false,
        error: 'Demasiadas peticiones. Intenta más tarde.',
        retryAfter,
      });
    }
    next();
  };

  middleware.reset = (ip) => {
    for (const k of hits.keys()) {
      if (k.endsWith(`:${ip}`)) hits.delete(k);
    }
  };
  middleware.stats = () => ({ size: hits.size, windowMs, max });

  return middleware;
}

// ============================================================
// Cuotas por IP
// ============================================================

/**
 * Registro de simuladas activas por IP.
 * Se rellena cuando se crea una simulada y se limpia cuando muere.
 */
class IpQuota {
  constructor(maxPerIp) {
    this.maxPerIp = maxPerIp;
    this.byIp = new Map();  // ip → Set<entityId>
  }

  canCreate(ip) {
    const set = this.byIp.get(ip);
    if (!set) return true;
    return set.size < this.maxPerIp;
  }

  register(ip, entityId) {
    let set = this.byIp.get(ip);
    if (!set) {
      set = new Set();
      this.byIp.set(ip, set);
    }
    set.add(entityId);
  }

  unregister(entityId) {
    for (const set of this.byIp.values()) {
      if (set.has(entityId)) set.delete(entityId);
    }
  }

  countForIp(ip) {
    return this.byIp.get(ip)?.size || 0;
  }

  getStats() {
    return {
      maxPerIp: this.maxPerIp,
      uniqueIps: this.byIp.size,
      totalTracked: Array.from(this.byIp.values()).reduce((s, v) => s + v.size, 0),
    };
  }
}

let ipQuota = null;

// ============================================================
// Sanitización de labels
// ============================================================

// Palabras prohibidas (amplía según necesidad)
// Se comparan en minúsculas, sin acentos, sin caracteres especiales
const LABEL_BLACKLIST = [
  // Insultos comunes
  'puta', 'puto', 'mierda', 'cabron', 'cabrona', 'pendejo', 'pendeja',
  'culero', 'culera', 'verga', 'chinga', 'joder', 'coño', 'hostia',
  'fuck', 'shit', 'bitch', 'asshole', 'bastard', 'dick', 'cunt',
  // Slurs (lista corta; amplía con cuidado)
  'nigger', 'nigga', 'faggot', 'retard',
  // Contenido peligroso
  'kys', 'kill yourself', 'matate',
];

// Regex de control: elimina caracteres de control y de formato bidi
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

// Regex de HTML/JS obvio
const HTML_TAG_RE = /<[^>]*>/g;
const SCRIPT_PROTO_RE = /javascript:|data:text\/html|vbscript:/gi;

function normalizeForFilter(s) {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // elimina acentos
    .replace(/[^a-z0-9\s]/g, '')     // solo letras/números/espacios
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeLabel(rawLabel) {
  if (rawLabel === null || rawLabel === undefined) {
    return { ok: true, value: null };
  }
  if (typeof rawLabel !== 'string') {
    return { ok: false, error: 'label debe ser string' };
  }

  let s = rawLabel;

  // 1. Elimina caracteres de control
  s = s.replace(CONTROL_CHARS_RE, '');

  // 2. Elimina tags HTML
  s = s.replace(HTML_TAG_RE, '');

  // 3. Elimina protocolos peligrosos
  s = s.replace(SCRIPT_PROTO_RE, '');

  // 4. Trim y colapsa espacios
  s = s.replace(/\s+/g, ' ').trim();

  // 5. Trunca
  if (s.length > LIMITS.MAX_LABEL_LENGTH) {
    s = s.slice(0, LIMITS.MAX_LABEL_LENGTH).trim();
  }

  // 6. Verifica blacklist
  const normalized = normalizeForFilter(s);
  for (const bad of LABEL_BLACKLIST) {
    if (normalized.includes(bad)) {
      return { ok: false, error: 'El label contiene contenido no permitido' };
    }
  }

  // 7. Longitud mínima
  if (s.length > 0 && s.length < 2) {
    return { ok: false, error: 'label demasiado corto (mínimo 2 caracteres)' };
  }

  return { ok: true, value: s || null };
}

// ============================================================
// Middlewares específicos del server
// ============================================================

/**
 * Middleware de sanitización del label para POST /api/simulate.
 * Sustituye req.body.label por su versión saneada.
 */
function labelSanitizer(req, res, next) {
  if (req.method !== 'POST') return next();
  if (!req.body || typeof req.body !== 'object') return next();

  const result = sanitizeLabel(req.body.label);
  if (!result.ok) {
    return res.status(400).json({ success: false, error: result.error });
  }
  req.body.label = result.value;
  next();
}

/**
 * Middleware de cuota por IP para POST /api/simulate.
 */
function quotaGuard(req, res, next) {
  if (req.method !== 'POST') return next();

  const ip = req.ip || req.socket?.remoteAddress || 'unknown';

  if (!ipQuota.canCreate(ip)) {
    log.warn(`Cuota excedida para IP ${ip} (${ipQuota.countForIp(ip)}/${LIMITS.MAX_SIMULATED_PER_IP})`);
    return res.status(429).json({
      success: false,
      error: `Has alcanzado el límite de ${LIMITS.MAX_SIMULATED_PER_IP} entidades simuladas activas`,
      quota: {
        used: ipQuota.countForIp(ip),
        max: LIMITS.MAX_SIMULATED_PER_IP,
      },
    });
  }
  next();
}

/**
 * Middleware de límite global de entidades.
 */
function globalEntityLimitGuard(req, res, next) {
  if (req.method !== 'POST') return next();

  const current = world.entities.size;
  if (current >= LIMITS.MAX_TOTAL_ENTITIES) {
    log.warn(`Límite global de entidades alcanzado (${current}/${LIMITS.MAX_TOTAL_ENTITIES})`);
    return res.status(503).json({
      success: false,
      error: 'El mundo está lleno. Intenta más tarde.',
      limit: LIMITS.MAX_TOTAL_ENTITIES,
      current,
    });
  }
  next();
}

// ============================================================
// Arranque
// ============================================================

async function start() {
  log.info(`🌍 Cerebro World arrancando (env=${env.nodeEnv}, demo=${env.demoMode})`);

  // ---------- 0. Validaciones de seguridad críticas ----------
  validateSecurityConfig();

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

  // ---------- 4. Cuota por IP ----------
  ipQuota = new IpQuota(LIMITS.MAX_SIMULATED_PER_IP);

  // Re-registra simuladas restauradas (best effort: sin IP original, las
  // marcamos como "sistema"). En la práctica, al morir se desregistrarán.
  for (const e of world.entities.values()) {
    if (e.isSimulated) {
      ipQuota.register('__restored__', e.id);
    }
  }

  // ---------- 5. Demo mode ----------
  if (env.demoMode) {
    seedDemoEntities(world, env.demoEntityCount);
  }

  // ---------- 6. Poller ----------
  poller = new Poller(world, {
    intervalMs: env.pollIntervalMs,
    sessionsLimit: env.pollSessionsLimit,
    onNewEntity: (profile) => {
      // Silencia el primer poll para no spamear entity_born al arrancar
      if (!firstPollCompleted) return;
      if (!wsServer) return;
      const e = world.getEntity(profile.id);
      if (e) {
        wsServer.broadcast({
          type: 'entity_created',
          entity: e.toJSON(),
          isSimulated: false,
          at: Date.now(),
        });
      }
    },
  });

  if (!env.demoMode) {
    poller.start();
    // Marca el primer poll como completado tras un ciclo
    setTimeout(() => { firstPollCompleted = true; }, env.pollIntervalMs + 2000).unref?.();
  } else {
    log.info('🚧 Demo mode: poller NO iniciado');
    firstPollCompleted = true;
  }

  // ---------- 7. Express ----------
  expressApp = express();
  expressApp.set('trust proxy', 1);

  expressApp.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }));
  expressApp.use(compression());
  expressApp.use(express.json({ limit: '256kb' }));

  // CORS
  expressApp.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-World-Token');
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  // Rate limit global /api/*
  const globalLimiter = createRateLimiter({
    windowMs: env.rateLimitWindowMs,
    max: env.rateLimitMax,
    keyPrefix: 'global',
  });
  expressApp.use('/api/', globalLimiter);

  // ---------- 8. HTTP server + WS ----------
  httpServer = http.createServer(expressApp);
  wsServer = createWSServer(httpServer, world);

  // ---------- 9. Rutas ----------
  const entitiesRouter = createEntitiesRouter({ world, wsServer, ipQuota });

  // Guardas específicas para POST /api/simulate
  const simulateRateLimiter = createRateLimiter({
    windowMs: LIMITS.SIMULATE_RATE_WINDOW_MS,
    max: LIMITS.SIMULATE_RATE_MAX,
    keyPrefix: 'simulate',
  });

  // Endpoint para /api/simulate (POST/GET/DELETE)
  expressApp.all('/api/simulate{/*path}', (req, res, next) => {
    // Aplica guardas solo a POST
    if (req.method === 'POST') {
      return simulateRateLimiter(req, res, (err) => {
        if (err) return next(err);
        return globalEntityLimitGuard(req, res, (err2) => {
          if (err2) return next(err2);
          return quotaGuard(req, res, (err3) => {
            if (err3) return next(err3);
            return labelSanitizer(req, res, (err4) => {
              if (err4) return next(err4);
              // Reescribe la URL para que el router la reconozca
              req.url = req.url.replace(/^\/api\/simulate/, '/simulate');
              return entitiesRouter(req, res, next);
            });
          });
        });
      });
    }
    // GET, DELETE pasan directo
    req.url = req.url.replace(/^\/api\/simulate/, '/simulate');
    return entitiesRouter(req, res, next);
  });

  // /api/entities/*
  expressApp.use('/api/entities', entitiesRouter);

  // /api/* genérico
  const apiRouter = createApiRouter({
    world,
    poller,
    wsServer,
    startedAt: STARTED_AT,
    ipQuota,
    limits: LIMITS,
  });
  expressApp.use('/api', apiRouter);

  // ---------- 10. Endpoint /api/events ----------
  expressApp.get('/api/events', (req, res) => {
    try {
      const limit = clampInt(req.query.limit, 50, 1, 500);
      const type = typeof req.query.type === 'string'
        ? req.query.type.slice(0, 60)
        : null;

      const rows = EventRepo.recent(limit, type);
      res.json({
        success: true,
        count: rows.length,
        events: rows.map(r => {
          let payload = null;
          try { payload = JSON.parse(r.payload_json); } catch (_) {}
          return {
            id: r.id,
            type: r.type,
            payload,
            createdAt: r.created_at,
          };
        }),
      });
    } catch (err) {
      log.error(`/api/events: ${err.message}`);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ---------- 11. Endpoint /api/entities/:id/events ----------
  expressApp.get('/api/entities/:id/events', (req, res) => {
    try {
      const id = String(req.params.id).slice(0, 200);
      const limit = clampInt(req.query.limit, 50, 1, 500);

      // Filtramos eventos que mencionan esta entidad en su payload
      const rows = EventRepo.recent(500, null);
      const filtered = [];

      for (const r of rows) {
        let payload = null;
        try { payload = JSON.parse(r.payload_json); } catch (_) {}
        if (!payload) continue;

        const mentions =
          payload.id === id ||
          payload.a === id ||
          payload.b === id ||
          payload.entityId === id;

        if (mentions) {
          filtered.push({
            id: r.id,
            type: r.type,
            payload,
            createdAt: r.created_at,
          });
          if (filtered.length >= limit) break;
        }
      }

      res.json({
        success: true,
        entityId: id,
        count: filtered.length,
        events: filtered,
      });
    } catch (err) {
      log.error(`/api/entities/:id/events: ${err.message}`);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ---------- 12. Estáticos ----------
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

  // ---------- 13. Bucle de simulación ----------
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

  // ---------- 14. Persistencia periódica ----------
  snapshotTimer = setInterval(() => {
    persistSafely('periodic');
  }, env.snapshotIntervalMs);
  if (snapshotTimer.unref) snapshotTimer.unref();

  // ---------- 15. Pruning ----------
  pruneTimer = setInterval(() => {
    try {
      EventRepo.prune(env.eventRetention);
      SnapshotRepo.prune(20);
    } catch (err) {
      log.warn(`Prune falló: ${err.message}`);
    }
  }, 5 * 60 * 1000);
  if (pruneTimer.unref) pruneTimer.unref();

  // ---------- 16. Escuchar ----------
  await new Promise((resolve) => {
    httpServer.listen(env.port, env.host, () => {
      log.info(`✅ HTTP escuchando en http://${env.host}:${env.port}`);
      log.info(`🔌 WebSocket en ws://${env.host}:${env.port}/ws`);
      log.info(`📊 Estado del mundo: ${world.entities.size} entidades`);
      resolve();
    });
  });

  printBanner();
}

// ============================================================
// Validaciones de seguridad
// ============================================================

function validateSecurityConfig() {
  const errors = [];

  if (env.isProd) {
    if (!env.worldWsToken) {
      errors.push(
        'WORLD_WS_TOKEN es OBLIGATORIO en producción. ' +
        'El WebSocket público sin auth permite DoS trivial.'
      );
    } else if (env.worldWsToken.length < 16) {
      errors.push('WORLD_WS_TOKEN debe tener al menos 16 caracteres en producción.');
    }

    if (!env.worldAdminToken) {
      errors.push(
        'WORLD_ADMIN_TOKEN es OBLIGATORIO en producción. ' +
        'Sin él, /api/simulate queda abierto a cualquiera.'
      );
    } else if (env.worldAdminToken.length < 16) {
      errors.push('WORLD_ADMIN_TOKEN debe tener al menos 16 caracteres en producción.');
    }
  }

  if (errors.length > 0) {
    log.error('❌ Errores de seguridad en la configuración:');
    for (const e of errors) log.error(`   - ${e}`);
    process.exit(1);
  }

  if (!env.isProd) {
    if (!env.worldWsToken) {
      log.warn('⚠️ WORLD_WS_TOKEN no configurado (modo dev). WS público.');
    }
    if (!env.worldAdminToken) {
      log.warn('⚠️ WORLD_ADMIN_TOKEN no configurado (modo dev). /api/simulate abierto.');
    }
  }
}

// ============================================================
// Persistencia
// ============================================================

function persistSafely(reason = 'manual') {
  if (!world) return;
  try {
    const t0 = Date.now();

    const r = persistWorld(world);

    const events = world.drainEvents();
    if (events.length > 0) {
      EventRepo.insertMany(events);
    }

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
${line}
   SEGURIDAD
${line}
   Admin Token:   ${env.worldAdminToken ? '🔒 configurado' : '⚠️  NO configurado'}
   WS Token:      ${env.worldWsToken ? '🔒 configurado' : '⚠️  público'}
   Máx total:     ${LIMITS.MAX_TOTAL_ENTITIES} entidades
   Máx por IP:    ${LIMITS.MAX_SIMULATED_PER_IP} simuladas
   Rate simulate: ${LIMITS.SIMULATE_RATE_MAX} cada ${LIMITS.SIMULATE_RATE_WINDOW_MS / 1000}s
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

  if (tickTimer) clearInterval(tickTimer);
  if (snapshotTimer) clearInterval(snapshotTimer);
  if (pruneTimer) clearInterval(pruneTimer);

  if (poller) poller.stop();

  persistSafely('shutdown');

  if (wsServer) {
    try { await wsServer.close(); } catch (_) {}
  }

  if (httpServer) {
    await new Promise((resolve) => httpServer.close(resolve));
  }

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

// ============================================================
// Helpers
// ============================================================

function clampInt(v, def, min, max) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}
