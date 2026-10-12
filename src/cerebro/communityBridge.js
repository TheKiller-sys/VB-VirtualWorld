// src/cerebro/communityBridge.js
// Registra encuentros del mundo en el communityProtocol del Cerebro.
//
// ⚠️ Requiere CEREBRO_ADMIN_TOKEN configurado.

import { request } from 'undici';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const log = logger.child('communityBridge');

const state = {
  lastCallAt: 0,
  inFlight: false,
  totalCalls: 0,
  totalOk: 0,
  totalErrors: 0,
  totalSkipped: 0,
  consecutiveErrors: 0,
  blockedUntil: 0,
};

// ============================================================
// API
// ============================================================

export function isCommunityProtocolEnabled() {
  return env.communityProtocolEnabled && !!env.cerebroAdminToken;
}

/**
 * Registra un encuentro en el communityProtocol del Cerebro.
 * Fire-and-forget: no bloquea el tick loop.
 */
export function registerEncounter(a, b, meta = {}) {
  if (!isCommunityProtocolEnabled()) {
    state.totalSkipped++;
    return;
  }

  const now = Date.now();

  if (state.inFlight) {
    state.totalSkipped++;
    return;
  }
  if (now < state.blockedUntil) {
    state.totalSkipped++;
    return;
  }
  if (now - state.lastCallAt < env.communityProtocolMinIntervalMs) {
    state.totalSkipped++;
    return;
  }

  state.inFlight = true;
  state.lastCallAt = now;
  state.totalCalls++;

  _send(a, b, meta)
    .then(() => {
      state.totalOk++;
      state.consecutiveErrors = 0;
    })
    .catch((err) => {
      state.totalErrors++;
      state.consecutiveErrors++;

      if (err.statusCode === 429) {
        state.blockedUntil = Date.now() + 120000;
        log.warn('communityProtocol 429 → bloqueando 2 min');
      } else if (state.consecutiveErrors >= 5) {
        state.blockedUntil = Date.now() + 60000;
        log.warn(`communityProtocol ${state.consecutiveErrors} errores → bloqueando 1 min`);
      }

      log.debug(`communityProtocol falló: ${err.message}`);
    })
    .finally(() => {
      state.inFlight = false;
    });
}

async function _send(a, b, meta) {
  const url = new URL('/api/yo/admin/simulate-peer-message', env.cerebroUrl);

  const message = {
    from: `world_entity:${b.id}`,
    type: env.communityProtocolMessageType,
    at: Date.now(),
    payload: {
      source: 'cerebro-world',
      entityId: a.id,
      emotion: a.dominantEmotion,
      intent: a.dominantIntent,
      topics: a.topics || [],
      partnerId: b.id,
      partnerEmotion: b.dominantEmotion,
      partnerIntent: b.dominantIntent,
      similarity: meta.similarity ?? null,
      gain: meta.gain ?? null,
      position: { x: meta.x, y: meta.y },
    },
  };

  const res = await request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Token': env.cerebroAdminToken,
    },
    body: JSON.stringify(message),
    headersTimeout: 5000,
    bodyTimeout: 5000,
  });

  const text = await res.body.text();

  if (res.statusCode >= 400) {
    const err = new Error(`communityProtocol HTTP ${res.statusCode}`);
    err.statusCode = res.statusCode;
    err.body = text?.slice(0, 300);
    throw err;
  }

  log.debug(
    `Encuentro registrado: ${a.id.slice(-6)}↔${b.id.slice(-6)}`
  );
}

export function getCommunityStats() {
  return {
    enabled: isCommunityProtocolEnabled(),
    inFlight: state.inFlight,
    blocked: Date.now() < state.blockedUntil,
    blockedRemainingMs: Math.max(0, state.blockedUntil - Date.now()),
    minIntervalMs: env.communityProtocolMinIntervalMs,
    messageType: env.communityProtocolMessageType,
    ...state,
  };
}
