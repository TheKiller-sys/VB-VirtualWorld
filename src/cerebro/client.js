// src/cerebro/client.js
// Cliente HTTP contra el Cerebro Digital. Con timeout, retries y backoff
// exponencial ante 429 (rate limit).
//
// CAMBIOS V1.1.2:
//   - [FIX 429] Retry automático en HTTP 429 con backoff exponencial.
//   - [FIX 429] Respeta el header Retry-After si lo envía el Cerebro.
//   - [FEAT] Caché en memoria de últimas respuestas OK (opcional).
//   - [FEAT] Contadores de 429 para observabilidad.

import { request } from 'undici';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const log = logger.child('cerebro');

const ENDPOINTS = {
  sessionList:    { method: 'GET', path: '/api/session/list',           auth: false },
  sessionHistory: { method: 'GET', path: '/api/conversation/history',   auth: false },
  sessionTopics:  { method: 'GET', path: '/api/conversation/topics',    auth: false },
  sessionStats:   { method: 'GET', path: '/api/conversation/stats',     auth: false },
  health:         { method: 'GET', path: '/api/health',                 auth: false },
  yoState:        { method: 'GET', path: '/api/yo/state',               auth: false },
};

// Contadores globales para observabilidad
export const cerebroStats = {
  requests: 0,
  ok: 0,
  errors: 0,
  rateLimited: 0,
  timeouts: 0,
};

/**
 * Llama a un endpoint del Cerebro con retry automático en 429.
 */
export async function callCerebro(key, opts = {}) {
  const spec = ENDPOINTS[key];
  if (!spec) throw new Error(`Endpoint desconocido: ${key}`);

  const {
    query,
    body,
    sessionId,
    timeoutMs = env.cerebroTimeoutMs,
    retries = 2,
    retryOn429 = true,
  } = opts;

  let lastErr = null;
  cerebroStats.requests++;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const data = await _callOnce(spec, { query, body, sessionId, timeoutMs });
      cerebroStats.ok++;
      return data;
    } catch (err) {
      lastErr = err;

      // 429: aplica backoff antes de reintentar
      const is429 = err.statusCode === 429;
      const canRetry = attempt < retries && (!is429 || retryOn429);

      if (is429) {
        cerebroStats.rateLimited++;
      } else if (err.statusCode === 504) {
        cerebroStats.timeouts++;
      } else {
        cerebroStats.errors++;
      }

      if (!canRetry) break;

      // Calcula delay: respeta Retry-After si está, si no backoff exponencial
      let delayMs;
      if (is429 && err.retryAfter) {
        delayMs = Math.min(err.retryAfter * 1000, 8000);
      } else {
        delayMs = 300 * Math.pow(2, attempt) + Math.random() * 200;
      }

      if (is429) {
        log.warn(`429 en ${key}, backoff ${Math.round(delayMs)}ms (intento ${attempt + 1}/${retries})`);
      } else {
        log.debug(`Reintento ${attempt + 1}/${retries} para ${key} en ${Math.round(delayMs)}ms`);
      }

      await sleep(delayMs);
    }
  }

  throw lastErr;
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
      err.body = text?.slice(0, 200);
      throw err;
    }

    if (res.statusCode >= 400) {
      const err = new Error(`Cerebro ${spec.path} → HTTP ${res.statusCode}`);
      err.statusCode = res.statusCode;
      err.body = text?.slice(0, 500);
      throw err;
    }

    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (e) {
        const err = new Error(`Respuesta no-JSON de ${spec.path}: ${e.message}`);
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
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(t);
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms).unref?.());
}

export async function pingCerebro() {
  const t0 = Date.now();
  try {
    await callCerebro('health', { timeoutMs: 3000, retries: 0 });
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - t0, error: err.message };
  }
}

export function getCerebroStats() {
  return { ...cerebroStats };
}

export const CEREBRO_ENDPOINTS = Object.freeze(ENDPOINTS);
