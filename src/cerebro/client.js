// src/cerebro/client.js
// Cliente HTTP contra el Cerebro Digital. Con timeout, retries y validación.

import { request } from 'undici';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const log = logger.child('cerebro');

// Mapa centralizado de endpoints.
// Si el Cerebro cambia una ruta, se cambia SOLO aquí.
const ENDPOINTS = {
  sessionList: {
    method: 'GET',
    path: '/api/session/list',
    auth: false,
  },
  sessionHistory: {
    method: 'GET',
    path: '/api/conversation/history',
    auth: false,
  },
  sessionTopics: {
    method: 'GET',
    path: '/api/conversation/topics',
    auth: false,
  },
  sessionStats: {
    method: 'GET',
    path: '/api/conversation/stats',
    auth: false,
  },
  health: {
    method: 'GET',
    path: '/api/health',
    auth: false,
  },
  yoState: {
    method: 'GET',
    path: '/api/yo/state',
    auth: false,
  },
};

/**
 * Llama a un endpoint del Cerebro.
 * @param {string} key   clave en ENDPOINTS
 * @param {object} opts  { query, body, sessionId, timeoutMs, retries }
 */
export async function callCerebro(key, opts = {}) {
  const spec = ENDPOINTS[key];
  if (!spec) throw new Error(`Endpoint desconocido en cliente Cerebro: ${key}`);

  const {
    query,
    body,
    sessionId,
    timeoutMs = env.cerebroTimeoutMs,
    retries = 0,
  } = opts;

  let lastErr = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await _callOnce(spec, { query, body, sessionId, timeoutMs });
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const backoff = 250 * Math.pow(2, attempt);
        log.warn(`Reintento ${attempt + 1}/${retries} para ${key} en ${backoff}ms: ${err.message}`);
        await new Promise(r => setTimeout(r, backoff));
      }
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

    if (res.statusCode >= 400) {
      const err = new Error(`Cerebro ${spec.path} → HTTP ${res.statusCode}`);
      err.statusCode = res.statusCode;
      err.body = text?.slice(0, 500);
      throw err;
    }

    let data = null;
    if (text) {
      try { data = JSON.parse(text); }
      catch (e) {
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

/**
 * Health check del Cerebro. No lanza: devuelve { ok, latencyMs } o { ok: false }.
 */
export async function pingCerebro() {
  const t0 = Date.now();
  try {
    await callCerebro('health', { timeoutMs: 3000 });
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - t0, error: err.message };
  }
}

export const CEREBRO_ENDPOINTS = Object.freeze(ENDPOINTS);
