// src/cerebro/client.js
// Cliente HTTP contra el Cerebro Digital.
//
// CAMBIOS V1.2.0:
//   - [FEAT] Añadido endpoint 'chat' (POST /api/chat) para LLM.
//   - [FIX 429 CRÍTICO] Circuit breaker propio: al recibir 429, bloquea
//     TODAS las requests durante el tiempo indicado por Retry-After.
//   - [FEAT] Estado global exportable para diagnóstico.

import { request } from 'undici';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const log = logger.child('cerebro');

// ============================================================
// Mapa de endpoints
// ============================================================

const ENDPOINTS = {
  sessionList:    { method: 'GET',  path: '/api/session/list',         auth: false },
  sessionHistory: { method: 'GET',  path: '/api/conversation/history', auth: false },
  sessionTopics:  { method: 'GET',  path: '/api/conversation/topics',  auth: false },
  sessionStats:   { method: 'GET',  path: '/api/conversation/stats',   auth: false },
  health:         { method: 'GET',  path: '/api/health',               auth: false },
  yoState:        { method: 'GET',  path: '/api/yo/state',             auth: false },
  chat:           { method: 'POST', path: '/api/chat',                 auth: false },
};

// ============================================================
// Estado del cliente (circuit breaker)
// ============================================================

const clientState = {
  blockedUntil: 0,
  requests: 0,
  ok: 0,
  errors: 0,
  rateLimited: 0,
  timeouts: 0,
  circuitBreakerOpens: 0,
  lastRateLimitAt: 0,
  lastRateLimitPath: null,
};

export function isCircuitOpen() {
  return Date.now() < clientState.blockedUntil;
}

export function getCircuitRemainingMs() {
  return Math.max(0, clientState.blockedUntil - Date.now());
}

export function getCerebroStats() {
  return {
    ...clientState,
    circuitOpen: isCircuitOpen(),
    circuitRemainingMs: getCircuitRemainingMs(),
  };
}

// ============================================================
// callCerebro
// ============================================================

export async function callCerebro(key, opts = {}) {
  const spec = ENDPOINTS[key];
  if (!spec) throw new Error(`Endpoint desconocido: ${key}`);

  // Circuit breaker
  if (isCircuitOpen()) {
    const remaining = getCircuitRemainingMs();
    const err = new Error(
      `Circuito abierto por 429 previo. Faltan ${Math.ceil(remaining / 1000)}s.`
    );
    err.statusCode = 429;
    err.circuitOpen = true;
    err.retryAfterMs = remaining;
    throw err;
  }

  const {
    query,
    body,
    sessionId,
    timeoutMs = env.cerebroTimeoutMs,
  } = opts;

  clientState.requests++;

  try {
    const data = await _callOnce(spec, { query, body, sessionId, timeoutMs });
    clientState.ok++;
    return data;
  } catch (err) {
    if (err.statusCode === 429) {
      clientState.rateLimited++;
      _openCircuit(err);
      throw err;
    }
    if (err.statusCode === 504) {
      clientState.timeouts++;
    } else {
      clientState.errors++;
    }
    throw err;
  }
}

function _openCircuit(err) {
  const now = Date.now();
  let waitMs = 60000;
  if (err.retryAfter) {
    waitMs = Math.max(err.retryAfter * 1000, 30000);
  }
  waitMs = Math.min(waitMs, 600000);

  const wasOpen = isCircuitOpen();
  clientState.blockedUntil = now + waitMs;
  clientState.lastRateLimitAt = now;
  clientState.lastRateLimitPath = err.path || null;

  if (!wasOpen) {
    clientState.circuitBreakerOpens++;
    log.error(
      `🚨 CIRCUIT BREAKER ABIERTO: Cerebro devolvió 429 en ${err.path || 'unknown'}. ` +
      `Bloqueando requests durante ${Math.round(waitMs / 1000)}s.`
    );
  }
}

async function _callOnce(spec, { query, body, sessionId, timeoutMs }) {
  const url = new URL(spec.path, env.cerebroUrl);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') {
        url.searchParams.set(k, String(v));
      }
    }
  }

  const headers = { 'Content-Type': 'application/json' };
  if (spec.auth === 'admin' && env.cerebroAdminToken) {
    headers['X-Admin-Token'] = env.cerebroAdminToken;
  }
  if (sessionId) headers['X-Session-Id'] = sessionId;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  const t0 = Date.now();
  try {
    const res = await request(url, {
      method: spec.method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });

    const text = await res.body.text();
    const durationMs = Date.now() - t0;

    if (res.statusCode === 429) {
      const retryAfter = Number(res.headers['retry-after']) || null;
      const err = new Error(`Rate limited (429) en ${spec.path}`);
      err.statusCode = 429;
      err.retryAfter = retryAfter;
      err.path = spec.path;
      err.body = text?.slice(0, 200);
      throw err;
    }

    if (res.statusCode >= 400) {
      const err = new Error(`Cerebro ${spec.path} → HTTP ${res.statusCode}`);
      err.statusCode = res.statusCode;
      err.path = spec.path;
      err.body = text?.slice(0, 500);
      throw err;
    }

    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (e) {
        const err = new Error(`Respuesta no-JSON de ${spec.path}: ${e.message}`);
        err.path = spec.path;
        err.body = text?.slice(0, 200);
        throw err;
      }
    }

    log.debug(`${spec.path} OK (${durationMs}ms)`);
    return data;
  } catch (err) {
    if (err.name === 'AbortError' || err.code === 'UND_ERR_ABORTED') {
      const e = new Error(`Timeout tras ${timeoutMs}ms llamando ${spec.path}`);
      e.statusCode = 504;
      e.path = spec.path;
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(t);
  }
}

export async function pingCerebro() {
  if (isCircuitOpen()) {
    return {
      ok: false,
      circuitOpen: true,
      error: `Circuito abierto (${Math.ceil(getCircuitRemainingMs() / 1000)}s restantes)`,
    };
  }
  const t0 = Date.now();
  try {
    await callCerebro('health', { timeoutMs: 3000 });
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - t0, error: err.message };
  }
}

export const CEREBRO_ENDPOINTS = Object.freeze(ENDPOINTS);
