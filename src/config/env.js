// src/config/env.js
// Carga y valida variables de entorno. Falla temprano si falta algo crítico.
//
// CAMBIOS V1.3.0:
//   - [FIX] communityProtocol: ahora usa CEREBRO_PEER_TOKEN (no admin token)
//     porque el endpoint real es POST /api/peer/inbox que requiere peer token.
//   - [FEAT] WORLD_PEER_ID: identificador estable del mundo ante el Cerebro.
//   - [FEAT] COMMUNITY_PROTOCOL_FETCH_INTERVAL_MS: polling de respuestas.

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

const resolvedPort = toInt(
  process.env.PORT,
  toInt(process.env.BFF_PORT, 10000),
);

export const env = {
  // ---------- Servidor ----------
  nodeEnv: NODE_ENV,
  isProd: IS_PROD,
  port: resolvedPort,
  host: process.env.BFF_HOST || '0.0.0.0',
  logLevel: process.env.LOG_LEVEL || (IS_PROD ? 'info' : 'debug'),
  logJson: toBool(process.env.LOG_JSON, IS_PROD),

  // ---------- Cerebro Digital ----------
  cerebroUrl: (process.env.CEREBRO_URL || 'http://localhost:3000').replace(/\/+$/, ''),
  cerebroAdminToken: process.env.CEREBRO_ADMIN_TOKEN || '',
  cerebroPeerToken: process.env.CEREBRO_PEER_TOKEN || '',
  cerebroTimeoutMs: toInt(process.env.CEREBRO_TIMEOUT_MS, 8000),

  pollInitialDelayMs: toInt(process.env.CEREBRO_INITIAL_DELAY_MS, 30000),
  pollIntervalMs: toInt(process.env.CEREBRO_MIN_INTERVAL_MS,
    toInt(process.env.POLL_INTERVAL_MS, 30000)),
  pollMaxIntervalMs: toInt(process.env.CEREBRO_MAX_INTERVAL_MS, 300000),
  pollSessionsLimit: toInt(process.env.CEREBRO_MAX_SESSIONS_PER_POLL,
    toInt(process.env.POLL_SESSIONS_LIMIT, 50)),
  pollMaxFullProfiles: toInt(process.env.CEREBRO_MAX_FULL_PROFILES, 3),

  // ---------- Autenticación del mundo ----------
  worldAdminToken: process.env.WORLD_ADMIN_TOKEN || '',
  worldWsToken: process.env.WORLD_WS_TOKEN || '',
  worldPeerId: process.env.WORLD_PEER_ID || 'world_bff',

  // ---------- Seguridad y cuotas ----------
  maxTotalEntities: toInt(process.env.MAX_TOTAL_ENTITIES, 500),
  maxSimulatedPerIp: toInt(process.env.MAX_SIMULATED_PER_IP, 20),
  simulateRateWindowMs: toInt(process.env.SIMULATE_RATE_WINDOW_MS, 60000),
  simulateRateMax: toInt(process.env.SIMULATE_RATE_MAX, 5),

  // ---------- Diálogo con LLM del Cerebro ----------
  llmDialogueEnabled: toBool(process.env.LLM_DIALOGUE_ENABLED, true),
  llmDialogueMinIntervalMs: toInt(process.env.LLM_DIALOGUE_MIN_INTERVAL_MS, 30000),
  llmDialogueTimeoutMs: toInt(process.env.LLM_DIALOGUE_TIMEOUT_MS, 20000),
  llmDialogueCacheSize: toInt(process.env.LLM_DIALOGUE_CACHE_SIZE, 200),
  llmDialogueCacheTtlMs: toInt(process.env.LLM_DIALOGUE_CACHE_TTL_MS, 7200000),
  llmDialogueSessionId: process.env.LLM_DIALOGUE_SESSION_ID || 'world_sim_v1',
  llmDialogueMaxLines: toInt(process.env.LLM_DIALOGUE_MAX_LINES, 3),

  // ---------- communityProtocol ----------
  // Habilita el envío de encuentros al Cerebro
  communityProtocolEnabled: toBool(process.env.COMMUNITY_PROTOCOL_ENABLED, false),

  // Intervalo entre envíos al Cerebro (evita saturar)
  communityProtocolMinIntervalMs: toInt(process.env.COMMUNITY_PROTOCOL_MIN_INTERVAL_MS, 15000),

  // Tipo de mensaje por defecto (debe ser uno de los válidos del CommunityProtocol)
  // Válidos: hello, signature, shared_thought, question, answer, farewell, gift, request
  communityProtocolMessageType: process.env.COMMUNITY_PROTOCOL_MESSAGE_TYPE || 'shared_thought',

  // Intervalo de polling del outbox del Cerebro (para recoger respuestas)
  communityProtocolFetchIntervalMs: toInt(
    process.env.COMMUNITY_PROTOCOL_FETCH_INTERVAL_MS, 15000
  ),

  // Habilitar el polling de respuestas
  communityProtocolFetchEnabled: toBool(
    process.env.COMMUNITY_PROTOCOL_FETCH_ENABLED, true
  ),

  // ---------- Simulación ----------
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

  // ---------- WebSocket ----------
  wsMaxClients: toInt(process.env.WS_MAX_CLIENTS, 100),
  wsBroadcastHz: toInt(process.env.WS_BROADCAST_HZ, 15),

  // ---------- Persistencia ----------
  worldDbPath: process.env.WORLD_DB_PATH || './data/world.db',
  snapshotIntervalMs: toInt(process.env.SNAPSHOT_INTERVAL_MS, 60000),
  eventRetention: toInt(process.env.EVENT_RETENTION, 5000),

  // ---------- Demo mode ----------
  demoMode: toBool(process.env.DEMO_MODE, false),
  demoEntityCount: toInt(process.env.DEMO_ENTITY_COUNT, 12),

  // ---------- Rate limiting global del BFF ----------
  rateLimitWindowMs: toInt(process.env.RATE_LIMIT_WINDOW_MS, 60000),
  rateLimitMax: toInt(process.env.RATE_LIMIT_MAX, 120),
};

// ============================================================
// Validación
// ============================================================

const errors = [];

if (!env.cerebroUrl) errors.push('CEREBRO_URL es obligatorio.');
if (env.maxTotalEntities < 10) errors.push('MAX_TOTAL_ENTITIES debe ser >= 10.');
if (env.maxSimulatedPerIp < 1) errors.push('MAX_SIMULATED_PER_IP debe ser >= 1.');
if (env.port < 1 || env.port > 65535) errors.push(`Puerto inválido: ${env.port}`);
if (env.pollIntervalMs < 5000) errors.push('CEREBRO_MIN_INTERVAL_MS debe ser >= 5000.');
if (env.pollMaxIntervalMs < env.pollIntervalMs) {
  errors.push('CEREBRO_MAX_INTERVAL_MS debe ser >= CEREBRO_MIN_INTERVAL_MS.');
}
if (env.llmDialogueMinIntervalMs < 5000) {
  errors.push('LLM_DIALOGUE_MIN_INTERVAL_MS debe ser >= 5000.');
}
if (env.llmDialogueMaxLines < 2 || env.llmDialogueMaxLines > 6) {
  errors.push('LLM_DIALOGUE_MAX_LINES debe estar entre 2 y 6.');
}
if (env.communityProtocolFetchIntervalMs < 5000) {
  errors.push('COMMUNITY_PROTOCOL_FETCH_INTERVAL_MS debe ser >= 5000.');
}

// Valida tipo de mensaje contra la whitelist del CommunityProtocol real
const VALID_COMMUNITY_TYPES = new Set([
  'hello', 'signature', 'shared_thought', 'question',
  'answer', 'farewell', 'gift', 'request',
]);
if (!VALID_COMMUNITY_TYPES.has(env.communityProtocolMessageType)) {
  errors.push(
    `COMMUNITY_PROTOCOL_MESSAGE_TYPE inválido: "${env.communityProtocolMessageType}". ` +
    `Válidos: ${Array.from(VALID_COMMUNITY_TYPES).join(', ')}`
  );
}

if (errors.length > 0) {
  console.error('\n❌ Errores de configuración:\n');
  for (const e of errors) console.error(`   - ${e}`);
  console.error('');
  process.exit(1);
}

// ============================================================
// Warnings y avisos
// ============================================================

if (!env.isProd) {
  if (!env.worldAdminToken) console.warn('⚠️ WORLD_ADMIN_TOKEN no definido (modo dev).');
  if (!env.worldWsToken) console.warn('⚠️ WORLD_WS_TOKEN no definido (modo dev).');
}

if (env.llmDialogueEnabled) {
  console.log(
    `ℹ️  LLM diálogo: ACTIVO · min-interval=${env.llmDialogueMinIntervalMs / 1000}s · ` +
    `cache=${env.llmDialogueCacheSize} · TTL=${env.llmDialogueCacheTtlMs / 60000}min · ` +
    `session="${env.llmDialogueSessionId}"`
  );
} else {
  console.log('ℹ️  LLM diálogo: DESACTIVADO (solo plantillas)');
}

if (env.communityProtocolEnabled) {
  if (!env.cerebroPeerToken) {
    console.warn(
      '⚠️  communityProtocol: ACTIVO pero CEREBRO_PEER_TOKEN no está configurado. ' +
      'Los envíos fallarán con 401.'
    );
  } else {
    console.log(
      `ℹ️  communityProtocol: ACTIVO · tipo="${env.communityProtocolMessageType}" · ` +
      `min-interval=${env.communityProtocolMinIntervalMs / 1000}s · ` +
      `fetch=${env.communityProtocolFetchEnabled ? `${env.communityProtocolFetchIntervalMs / 1000}s` : 'off'} · ` +
      `peerId="${env.worldPeerId}"`
    );
  }
} else {
  console.log('ℹ️  communityProtocol: DESACTIVADO');
}

export default env;
