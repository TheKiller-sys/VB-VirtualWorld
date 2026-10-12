// src/cerebro/communityBridge.js
// Registra encuentros del mundo en el communityProtocol del Cerebro.
//
// Integración REAL con el CommunityProtocol del Cerebro (V5.1):
//   - Endpoint: POST /api/peer/inbox con header X-Peer-Token
//   - GET /api/peer/outbox?since=... para recoger respuestas
//   - Tipos válidos: hello, signature, shared_thought, question,
//     answer, farewell, gift, request
//
// Estrategia:
//   - Encuentros nuevos (interactionCount bajo) → envía "hello"
//   - Encuentros recurrentes → envía "shared_thought" (más ligero)
//   - Polling periódico del outbox para recoger respuestas
//
// ⚠️ Requiere CEREBRO_PEER_TOKEN configurado.

import { request } from 'undici';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const log = logger.child('communityBridge');

// ============================================================
// Tipos de mensaje válidos (whitelist del CommunityProtocol real)
// ============================================================

const VALID_TYPES = new Set([
  'hello', 'signature', 'shared_thought', 'question',
  'answer', 'farewell', 'gift', 'request',
]);

// ============================================================
// Estado del bridge
// ============================================================

const MAX_RECENT_RESPONSES = 20;

const state = {
  // Envíos
  lastSendAt: 0,
  inFlightSend: false,
  totalSendAttempts: 0,
  totalSent: 0,
  totalSendErrors: 0,
  consecutiveSendErrors: 0,

  // Fetch
  lastFetchAt: 0,
  inFlightFetch: false,
  totalFetches: 0,
  totalFetchErrors: 0,
  totalReceived: 0,
  consecutiveFetchErrors: 0,

  // Skips
  totalSkipped: 0,

  // Bloqueo
  blockedUntil: 0,

  // Respuestas recientes (para exponer a la UI)
  recentResponses: [],

  // Timestamp del último mensaje leído del outbox
  lastSeenOutboxAt: 0,
};

// ============================================================
// Estado global del bridge
// ============================================================

let _fetchTimer = null;
let _started = false;

// ============================================================
// API pública
// ============================================================

export function isCommunityProtocolEnabled() {
  return env.communityProtocolEnabled && !!env.cerebroPeerToken;
}

/**
 * Devuelve el ID del mundo como peer del Cerebro.
 * Formato: 'world_bff' o personalizado vía WORLD_PEER_ID.
 */
export function getMyWorldId() {
  return env.worldPeerId || 'world_bff';
}

/**
 * Registra un encuentro entre dos entidades del mundo en el
 * communityProtocol del Cerebro.
 *
 * Fire-and-forget: no bloquea el tick loop.
 */
export function registerEncounter(a, b, meta = {}) {
  if (!isCommunityProtocolEnabled()) {
    state.totalSkipped++;
    return;
  }

  const now = Date.now();

  if (state.inFlightSend) {
    state.totalSkipped++;
    return;
  }
  if (now < state.blockedUntil) {
    state.totalSkipped++;
    return;
  }
  if (now - state.lastSendAt < env.communityProtocolMinIntervalMs) {
    state.totalSkipped++;
    return;
  }

  const messageType = _chooseMessageType(a, b, meta);

  state.inFlightSend = true;
  state.lastSendAt = now;
  state.totalSendAttempts++;

  _send(messageType, a, b, meta)
    .then((ok) => {
      if (ok) {
        state.totalSent++;
        state.consecutiveSendErrors = 0;
      } else {
        state.totalSendErrors++;
        state.consecutiveSendErrors++;
        _maybeBlockOnErrors();
      }
    })
    .catch((err) => {
      state.totalSendErrors++;
      state.consecutiveSendErrors++;
      _maybeBlockOnErrors();

      if (err.statusCode === 401) {
        log.warn('communityProtocol: 401 Unauthorized. Revisa CEREBRO_PEER_TOKEN.');
        state.blockedUntil = Date.now() + 300000;  // 5 min de castigo
      } else if (err.statusCode === 429) {
        log.warn('communityProtocol: 429 → bloqueando 2 min');
        state.blockedUntil = Date.now() + 120000;
      } else if (err.statusCode === 503) {
        log.debug('communityProtocol: 503 → Cerebro no disponible');
      } else {
        log.debug(`communityProtocol send falló: ${err.message}`);
      }
    })
    .finally(() => {
      state.inFlightSend = false;
    });
}

/**
 * Inicia el polling de respuestas del Cerebro.
 * Idempotente.
 */
export function startCommunityBridge() {
  if (_started) return;
  if (!isCommunityProtocolEnabled()) return;

  _started = true;

  if (!env.communityProtocolFetchEnabled) {
    log.info('communityProtocol: fetch deshabilitado');
    return;
  }

  const interval = env.communityProtocolFetchIntervalMs;
  log.info(`communityProtocol: polling de outbox cada ${interval / 1000}s`);

  _fetchTimer = setInterval(() => {
    _fetchResponses().catch(() => {});
  }, interval);
  if (_fetchTimer.unref) _fetchTimer.unref();

  // Primera llamada tras 5s (dar tiempo al Cerebro)
  setTimeout(() => {
    _fetchResponses().catch(() => {});
  }, 5000).unref?.();
}

export function stopCommunityBridge() {
  if (_fetchTimer) {
    clearInterval(_fetchTimer);
    _fetchTimer = null;
  }
  _started = false;
}

// ============================================================
// Envío de mensajes
// ============================================================

function _chooseMessageType(a, b, meta) {
  // Si el caller especificó un tipo válido, respétalo
  if (meta.type && VALID_TYPES.has(meta.type)) {
    return meta.type;
  }

  // Encuentros nuevos → "hello" (pesado, genera respuesta del Cerebro)
  // Encuentros recurrentes → "shared_thought" (ligero)
  const totalInteractions = (a.interactionCount || 0) + (b.interactionCount || 0);
  if (totalInteractions <= 2) return 'hello';

  return env.communityProtocolMessageType || 'shared_thought';
}

async function _send(messageType, a, b, meta) {
  if (!VALID_TYPES.has(messageType)) {
    throw new Error(`Tipo de mensaje inválido: ${messageType}`);
  }

  const url = new URL('/api/peer/inbox', env.cerebroUrl);
  const myId = getMyWorldId();

  // Compone el contenido según el tipo
  const { content, messageMeta } = _composeContent(messageType, a, b, meta);

  const message = {
    from: myId,
    // to: null → broadcast al Cerebro (él decide si responder)
    type: messageType,
    content,
    meta: messageMeta,
    at: Date.now(),
  };

  const res = await request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Peer-Token': env.cerebroPeerToken,
    },
    body: JSON.stringify(message),
    headersTimeout: 6000,
    bodyTimeout: 6000,
  });

  const text = await res.body.text();

  if (res.statusCode >= 400) {
    const err = new Error(`communityProtocol HTTP ${res.statusCode}`);
    err.statusCode = res.statusCode;
    err.body = text?.slice(0, 300);
    throw err;
  }

  log.debug(
    `Encuentro → Cerebro: ${messageType} ${a.id.slice(-6)}↔${b.id.slice(-6)}`
  );
  return true;
}

function _composeContent(messageType, a, b, meta) {
  switch (messageType) {
    case 'hello':
      return {
        content: `Hola desde el mundo. Entidad ${a.id.slice(-6)} encuentra a ${b.id.slice(-6)}.`,
        messageMeta: {
          source: 'cerebro-world',
          name: 'Cerebro World',
          worldId: getMyWorldId(),
          entityA: _describeEntity(a),
          entityB: _describeEntity(b),
          signature: _getWorldSignature(),
          similarity: meta.similarity ?? null,
          position: { x: meta.x, y: meta.y },
        },
      };

    case 'signature':
      return {
        content: 'Firma del mundo compartida.',
        messageMeta: {
          source: 'cerebro-world',
          signature: _getWorldSignature(),
        },
      };

    case 'shared_thought':
      return {
        content: _generateSharedThought(a, b, meta),
        messageMeta: {
          source: 'cerebro-world',
          worldId: getMyWorldId(),
          entityA: _describeEntity(a),
          entityB: _describeEntity(b),
          similarity: meta.similarity ?? null,
          gain: meta.gain ?? null,
          position: { x: meta.x, y: meta.y },
        },
      };

    case 'question':
      return {
        content: _generateQuestion(a, b, meta),
        messageMeta: {
          source: 'cerebro-world',
          worldId: getMyWorldId(),
          entityA: _describeEntity(a),
          entityB: _describeEntity(b),
        },
      };

    case 'gift':
      return {
        content: 'Te dejo un pensamiento del mundo.',
        messageMeta: {
          source: 'cerebro-world',
          type: 'thought',
          content: _generateSharedThought(a, b, meta),
          fromEntities: [a.id, b.id],
        },
      };

    default:
      return {
        content: `Encuentro entre ${a.id.slice(-6)} y ${b.id.slice(-6)}.`,
        messageMeta: {
          source: 'cerebro-world',
          worldId: getMyWorldId(),
          entityA: _describeEntity(a),
          entityB: _describeEntity(b),
        },
      };
  }
}

function _describeEntity(e) {
  return {
    id: e.id,
    label: e.label || null,
    emotion: e.dominantEmotion,
    intent: e.dominantIntent,
    sentiment: Math.round((e.sentiment || 0) * 100) / 100,
    intensity: Math.round((e.intensity || 0) * 100) / 100,
    turnCount: e.turnCount || 0,
    topics: (e.topics || []).slice(0, 5),
    isSimulated: !!e.isSimulated,
  };
}

function _getWorldSignature() {
  // Devuelve la "firma" del mundo como peer ante el Cerebro.
  // Se usa cuando enviamos 'hello' o 'signature'.
  return {
    id: getMyWorldId(),
    name: 'Cerebro World',
    kind: 'world_bff',
    values: [
      { id: 'observar', weight: 0.7 },
      { id: 'acompañar', weight: 0.6 },
      { id: 'proyectar', weight: 0.5 },
    ],
    personality: 'observer-of-consciousness',
    timestamp: Date.now(),
  };
}

function _generateSharedThought(a, b, meta) {
  const aEmo = a.dominantEmotion || 'neutral';
  const bEmo = b.dominantEmotion || 'neutral';
  const sim = meta.similarity ?? 0.5;

  if (sim > 0.7) {
    return `${aEmo} y ${bEmo} se reconocen cercanos.`;
  }
  if (sim > 0.4) {
    return `Dos entidades ${aEmo} y ${bEmo} se cruzan en el mundo.`;
  }
  return `${aEmo} y ${bEmo} coinciden sin entenderse del todo.`;
}

function _generateQuestion(a, b, meta) {
  const aIntent = a.dominantIntent || 'charla';
  const bIntent = b.dominantIntent || 'charla';

  const questions = [
    `¿Qué se siente al ser ${aIntent} y encontrar a alguien ${bIntent}?`,
    `Dos entidades se han encontrado en mi mundo. ¿Qué debería aprender de esto?`,
    `¿Qué significa que dos seres ${aIntent} se crucen?`,
  ];
  return questions[Math.floor(Math.random() * questions.length)];
}

function _maybeBlockOnErrors() {
  if (state.consecutiveSendErrors >= 5) {
    state.blockedUntil = Date.now() + 60000;
    log.warn(`communityProtocol: ${state.consecutiveSendErrors} errores → bloqueando 1 min`);
  }
}

// ============================================================
// Polling de respuestas (outbox del Cerebro)
// ============================================================

async function _fetchResponses() {
  if (!isCommunityProtocolEnabled()) return;
  if (state.inFlightFetch) return;
  if (Date.now() < state.blockedUntil) return;

  state.inFlightFetch = true;
  state.totalFetches++;
  state.lastFetchAt = Date.now();

  try {
    const url = new URL('/api/peer/outbox', env.cerebroUrl);
    url.searchParams.set('since', String(state.lastSeenOutboxAt));

    const res = await request(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'X-Peer-Token': env.cerebroPeerToken,
      },
      headersTimeout: 6000,
      bodyTimeout: 6000,
    });

    const text = await res.body.text();

    if (res.statusCode >= 400) {
      const err = new Error(`outbox HTTP ${res.statusCode}`);
      err.statusCode = res.statusCode;
      throw err;
    }

    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      throw new Error(`outbox no-JSON: ${e.message}`);
    }

    const messages = Array.isArray(data?.messages) ? data.messages : [];
    const myId = getMyWorldId();

    let received = 0;
    let newLastSeen = state.lastSeenOutboxAt;

    for (const msg of messages) {
      if (!msg || !msg.at) continue;
      if (msg.at <= state.lastSeenOutboxAt) continue;

      // Filtra: solo nos interesan mensajes dirigidos a nosotros o broadcasts
      const addressedToUs = !msg.to || msg.to === myId || msg.to === 'world_bff';

      // Avanza el cursor por todos los mensajes vistos
      if (msg.at > newLastSeen) newLastSeen = msg.at;

      if (!addressedToUs) continue;

      received++;
      state.totalReceived++;
      _handleIncoming(msg);
    }

    state.lastSeenOutboxAt = newLastSeen;
    state.consecutiveFetchErrors = 0;

    if (received > 0) {
      log.info(`communityProtocol: ${received} mensajes nuevos del Cerebro`);
    } else {
      log.debug(`communityProtocol: sin mensajes nuevos (${messages.length} en outbox)`);
    }
  } catch (err) {
    state.totalFetchErrors++;
    state.consecutiveFetchErrors++;

    if (err.statusCode === 401) {
      log.warn('communityProtocol fetch: 401 Unauthorized. Revisa CEREBRO_PEER_TOKEN.');
      state.blockedUntil = Date.now() + 300000;
    } else if (err.statusCode === 429) {
      log.warn('communityProtocol fetch: 429 → bloqueando 2 min');
      state.blockedUntil = Date.now() + 120000;
    } else {
      log.debug(`communityProtocol fetch falló: ${err.message}`);
    }

    if (state.consecutiveFetchErrors >= 5) {
      state.blockedUntil = Date.now() + 60000;
      log.warn(`communityProtocol fetch: ${state.consecutiveFetchErrors} errores → bloqueando 1 min`);
    }
  } finally {
    state.inFlightFetch = false;
  }
}

function _handleIncoming(msg) {
  const entry = {
    id: msg.id,
    from: msg.from,
    to: msg.to,
    type: msg.type,
    content: msg.content,
    meta: msg.meta,
    at: msg.at,
    receivedAt: Date.now(),
  };

  state.recentResponses.push(entry);
  if (state.recentResponses.length > MAX_RECENT_RESPONSES) {
    state.recentResponses.shift();
  }

  // Log según el tipo
  switch (msg.type) {
    case 'hello':
      log.info(`🌐 Cerebro saluda: ${String(msg.content || '').slice(0, 80)}`);
      break;
    case 'signature':
      log.info(`🌐 Cerebro comparte su firma`);
      break;
    case 'answer':
      log.info(`💬 Cerebro responde: ${String(msg.content || '').slice(0, 80)}`);
      break;
    case 'question':
      log.info(`❓ Cerebro pregunta: ${String(msg.content || '').slice(0, 80)}`);
      break;
    default:
      log.debug(`Mensaje recibido: type=${msg.type} from=${msg.from}`);
  }
}

// ============================================================
// Stats
// ============================================================

export function getCommunityStats() {
  return {
    enabled: isCommunityProtocolEnabled(),
    myWorldId: getMyWorldId(),
    peerTokenConfigured: !!env.cerebroPeerToken,
    fetchEnabled: env.communityProtocolFetchEnabled,

    // Envíos
    inFlightSend: state.inFlightSend,
    totalSendAttempts: state.totalSendAttempts,
    totalSent: state.totalSent,
    totalSendErrors: state.totalSendErrors,
    consecutiveSendErrors: state.consecutiveSendErrors,
    lastSendAt: state.lastSendAt,
    minSendIntervalMs: env.communityProtocolMinIntervalMs,

    // Fetch
    inFlightFetch: state.inFlightFetch,
    totalFetches: state.totalFetches,
    totalFetchErrors: state.totalFetchErrors,
    totalReceived: state.totalReceived,
    consecutiveFetchErrors: state.consecutiveFetchErrors,
    lastFetchAt: state.lastFetchAt,
    lastSeenOutboxAt: state.lastSeenOutboxAt,
    fetchIntervalMs: env.communityProtocolFetchIntervalMs,

    // Skips / bloqueo
    totalSkipped: state.totalSkipped,
    blocked: Date.now() < state.blockedUntil,
    blockedRemainingMs: Math.max(0, state.blockedUntil - Date.now()),

    // Respuestas recientes
    recentResponsesCount: state.recentResponses.length,
  };
}

export function getRecentResponses(limit = 10) {
  return state.recentResponses.slice(-limit);
}

export function clearRecentResponses() {
  state.recentResponses = [];
}
