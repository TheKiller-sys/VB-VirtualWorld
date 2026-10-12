// src/config/env.js
// Carga y valida variables de entorno. Falla temprano si falta algo crítico.

import 'dotenv/config';

function toInt(v, def) {
  if (v === undefined || v === null || v === '') return def;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function toFloat(v, def) {
  if (v === undefined || v === null || v === '') return def;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : def;
}

function toBool(v, def) {
  if (v === undefined || v === null || v === '') return def;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return def;
}

const NODE_ENV = process.env.NODE_ENV || 'development';
const IS_PROD = NODE_ENV === 'production';

export const env = {
  // Servidor
  nodeEnv: NODE_ENV,
  isProd: IS_PROD,
  port: toInt(process.env.BFF_PORT, 5000),
  host: process.env.BFF_HOST || '0.0.0.0',
  logLevel: process.env.LOG_LEVEL || (IS_PROD ? 'info' : 'debug'),
  logJson: toBool(process.env.LOG_JSON, IS_PROD),

  // Cerebro
  cerebroUrl: (process.env.CEREBRO_URL || 'http://localhost:3000').replace(/\/+$/, ''),
  cerebroAdminToken: process.env.CEREBRO_ADMIN_TOKEN || '',
  cerebroTimeoutMs: toInt(process.env.CEREBRO_TIMEOUT_MS, 8000),
  pollIntervalMs: toInt(process.env.POLL_INTERVAL_MS, 10000),
  pollSessionsLimit: toInt(process.env.POLL_SESSIONS_LIMIT, 200),

  // Auth
  worldAdminToken: process.env.WORLD_ADMIN_TOKEN || '',
  worldWsToken: process.env.WORLD_WS_TOKEN || '',

  // Simulación
  tickIntervalMs: toInt(process.env.TICK_INTERVAL_MS, 33),
  world: {
    width: toInt(process.env.WORLD_WIDTH, 2000),
    height: toInt(process.env.WORLD_HEIGHT, 2000),
    margin: toInt(process.env.WORLD_MARGIN, 100),
    wanderStrength: toFloat(process.env.WANDER_STRENGTH, 8),
    attractStrength: toFloat(process.env.ATTRACT_STRENGTH, 40),
    repelStrength: toFloat(process.env.REPEL_STRENGTH, 60),
    maxVelocity: toFloat(process.env.MAX_VELOCITY, 30),
    friction: toFloat(process.env.FRICTION, 0.92),
    attractRadius: toFloat(process.env.ATTRACT_RADIUS, 350),
    interactRadius: toFloat(process.env.INTERACT_RADIUS, 45),
    interactCooldownMs: toInt(process.env.INTERACT_COOLDOWN_MS, 8000),
    relationDecayPerHour: toFloat(process.env.RELATION_DECAY_PER_HOUR, 0.05),
    entityTimeoutMs: toInt(process.env.ENTITY_TIMEOUT_MS, 1800000),
    entityFadeMs: toInt(process.env.ENTITY_FADE_MS, 60000),
  },

  // WebSocket
  wsMaxClients: toInt(process.env.WS_MAX_CLIENTS, 100),
  wsBroadcastHz: toInt(process.env.WS_BROADCAST_HZ, 15),

  // Persistencia
  worldDbPath: process.env.WORLD_DB_PATH || './data/world.db',
  snapshotIntervalMs: toInt(process.env.SNAPSHOT_INTERVAL_MS, 60000),
  eventRetention: toInt(process.env.EVENT_RETENTION, 5000),

  // Demo
  demoMode: toBool(process.env.DEMO_MODE, false),
  demoEntityCount: toInt(process.env.DEMO_ENTITY_COUNT, 12),

  // Rate limiting
  rateLimitWindowMs: toInt(process.env.RATE_LIMIT_WINDOW_MS, 60000),
  rateLimitMax: toInt(process.env.RATE_LIMIT_MAX, 120),
};

// ---------- Validación ----------
const errors = [];

if (env.isProd && !env.worldAdminToken) {
  errors.push('WORLD_ADMIN_TOKEN es obligatorio en NODE_ENV=production.');
}
if (env.isProd && env.worldAdminToken && env.worldAdminToken.length < 16) {
  errors.push('WORLD_ADMIN_TOKEN debe tener al menos 16 caracteres en producción.');
}
if (!env.cerebroUrl) {
  errors.push('CEREBRO_URL es obligatorio.');
}

if (errors.length > 0) {
  console.error('\n❌ Errores de configuración:\n');
  for (const e of errors) console.error(`   - ${e}`);
  console.error('');
  process.exit(1);
}

// ---------- Warnings ----------
if (!env.isProd && !env.worldAdminToken) {
  console.warn('⚠️ WORLD_ADMIN_TOKEN no definido (modo dev). /api/simulate está abierto.');
}
if (!env.cerebroAdminToken && !env.demoMode) {
  console.warn('⚠️ CEREBRO_ADMIN_TOKEN no definido. Endpoints admin del Cerebro fallarán.');
}

export default env;
