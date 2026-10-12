// src/cerebro/poller.js
// Sondea /api/session/list y materializa cada sesión como entidad.
//
// CAMBIOS V1.2.0:
//   - [FEAT] Filtro de sesión interna: ignora la sesión del LLM de diálogos
//     (world_sim_v1) para que no aparezca como entidad en el mundo.
//   - [PERF] Delay inicial de 30s antes del primer poll.
//   - [PERF] Intervalo entre polls arranca en 30s, backoff multiplicativo.
//   - [PERF] Máximo de perfiles completos por poll: 3 (configurable).
//   - [PERF] Prioriza perfiles "ligeros" para poblar el mundo rápido.
//   - [FIX] Respeta el circuit breaker del cliente HTTP.

import { callCerebro, isCircuitOpen, getCircuitRemainingMs } from './client.js';
import { buildProfile, buildProfileFromMeta } from './profiler.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const log = logger.child('poller');

const CONCURRENCY = 1;
const DELAY_BETWEEN_PROFILES_MS = 800;
const OK_POLLS_TO_RESET_BACKOFF = 3;

// ============================================================
// Filtro de sesiones internas
// ============================================================
// Estas sesiones NO deben aparecer como entidades en el mundo.
// Sirven para:
//   - world_sim_v1: session dedicada a los diálogos con LLM
//   - _world_*:     futuras sesiones internas del BFF
//   - _internal_*:  reservado para usos administrativos
const INTERNAL_SESSION_PATTERNS = [
  /^world_sim_/i,
  /^_world_/i,
  /^_internal_/i,
];

function isInternalSession(sessionId) {
  if (!sessionId) return false;
  const id = String(sessionId);
  return INTERNAL_SESSION_PATTERNS.some(re => re.test(id));
}

export class Poller {
  constructor(world, opts = {}) {
    this.world = world;

    this.baseIntervalMs = opts.intervalMs ?? env.pollIntervalMs;
    this.currentIntervalMs = this.baseIntervalMs;
    this.maxIntervalMs = opts.maxIntervalMs ?? env.pollMaxIntervalMs;

    this.sessionsLimit = opts.sessionsLimit ?? env.pollSessionsLimit;
    this.maxFullProfiles = opts.maxFullProfiles ?? env.pollMaxFullProfiles;
    this.initialDelayMs = opts.initialDelayMs ?? env.pollInitialDelayMs;

    this.onNewEntity = opts.onNewEntity || null;
    this.onSessionSeen = opts.onSessionSeen || null;

    this.timer = null;
    this.running = false;
    this.knownIds = new Set();
    this.sessionCache = new Map();

    this.consecutiveOkPolls = 0;
    this.consecutiveErrors = 0;

    this.stats = {
      polls: 0,
      okPolls: 0,
      errors: 0,
      lastPollAt: 0,
      lastOkPollAt: 0,
      lastErrorAt: 0,
      lastErrorMsg: null,
      entitiesCreated: 0,
      entitiesUpdated: 0,
      skippedUnchanged: 0,
      fullProfiles: 0,
      lightProfiles: 0,
      backoffHits: 0,
      circuitOpenSkips: 0,
      internalSessionsFiltered: 0,
    };
  }

  start() {
    if (this.running) return;
    this.running = true;

    log.info(
      `Poller iniciado (delay inicial=${this.initialDelayMs}ms, ` +
      `intervalo base=${this.baseIntervalMs}ms, máx=${this.maxIntervalMs}ms, ` +
      `límite sesiones=${this.sessionsLimit}, ` +
      `máx perfiles completos=${this.maxFullProfiles})`
    );

    this.timer = setTimeout(() => {
      if (!this.running) return;
      this._loop();
    }, this.initialDelayMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    log.info('Poller detenido');
  }

  async _loop() {
    if (!this.running) return;

    if (isCircuitOpen()) {
      this.stats.circuitOpenSkips++;
      const wait = getCircuitRemainingMs() + 5000;
      log.info(
        `Circuito abierto (429 previo). Esperando ${Math.ceil(wait / 1000)}s ` +
        `antes del siguiente intento.`
      );
      this._scheduleNext(wait);
      return;
    }

    try {
      await this._poll();
    } catch (err) {
      this._handlePollError(err);
    }

    this._scheduleNext();
  }

  _scheduleNext(customDelay = null) {
    if (!this.running) return;

    const delay = customDelay ?? this.currentIntervalMs;
    log.debug(`Próximo poll en ${Math.round(delay / 1000)}s`);

    this.timer = setTimeout(() => this._loop(), delay);
    if (this.timer.unref) this.timer.unref();
  }

  _handlePollError(err) {
    this.stats.errors++;
    this.stats.lastErrorAt = Date.now();
    this.stats.lastErrorMsg = err.message;
    this.consecutiveErrors++;
    this.consecutiveOkPolls = 0;

    if (err.statusCode === 429 || err.circuitOpen) {
      const prev = this.currentIntervalMs;
      this.currentIntervalMs = Math.min(
        this.currentIntervalMs * 2,
        this.maxIntervalMs,
      );
      this.stats.backoffHits++;
      log.warn(
        `429 → backoff ${Math.round(prev / 1000)}s → ${Math.round(this.currentIntervalMs / 1000)}s`
      );
    } else {
      const prev = this.currentIntervalMs;
      this.currentIntervalMs = Math.min(
        Math.round(this.currentIntervalMs * 1.5),
        this.maxIntervalMs,
      );
      log.warn(
        `Error de poll: ${err.message}. Intervalo: ${Math.round(prev / 1000)}s → ${Math.round(this.currentIntervalMs / 1000)}s`
      );
    }
  }

  async _poll() {
    const t0 = Date.now();
    this.stats.polls++;
    this.stats.lastPollAt = t0;

    const res = await callCerebro('sessionList', {
      query: { limit: this.sessionsLimit },
      timeoutMs: env.cerebroTimeoutMs,
    });

    const rawSessions = Array.isArray(res?.sessions) ? res.sessions : [];

    // Filtra sesiones internas
    const sessions = rawSessions.filter(s => {
      if (!s.sessionId) return false;
      if (isInternalSession(s.sessionId)) {
        this.stats.internalSessionsFiltered++;
        return false;
      }
      return true;
    });

    // Poll OK
    this.stats.okPolls++;
    this.stats.lastOkPollAt = Date.now();
    this.consecutiveOkPolls++;

    if (
      this.consecutiveOkPolls >= OK_POLLS_TO_RESET_BACKOFF &&
      this.currentIntervalMs > this.baseIntervalMs
    ) {
      const prev = this.currentIntervalMs;
      this.currentIntervalMs = Math.max(
        Math.round(this.currentIntervalMs * 0.7),
        this.baseIntervalMs,
      );
      log.info(
        `Recuperación: ${this.consecutiveOkPolls} polls OK seguidos. ` +
        `Intervalo: ${Math.round(prev / 1000)}s → ${Math.round(this.currentIntervalMs / 1000)}s`
      );
    }

    if (sessions.length === 0) {
      log.debug('Poll: 0 sesiones válidas');
      return;
    }

    const { fullProfiles, lightProfiles } = this._classifySessions(sessions);

    log.debug(
      `Poll: ${sessions.length} sesiones · ` +
      `${fullProfiles.length} completas · ${lightProfiles.length} ligeras`
    );

    // ---- 1. Ligeras primero (sin HTTP extra) ----
    for (const meta of lightProfiles) {
      try {
        const profile = buildProfileFromMeta(meta);
        if (!profile) continue;

        const { created } = this.world.upsertEntity(profile);

        if (created) {
          this.stats.entitiesCreated++;
          this.knownIds.add(profile.id);
          if (this.onNewEntity) {
            try { this.onNewEntity(profile); } catch (_) {}
          }
        } else {
          this.stats.entitiesUpdated++;
        }

        if (this.onSessionSeen) {
          try { this.onSessionSeen(profile); } catch (_) {}
        }
      } catch (err) {
        log.debug(`upsert ligero falló: ${err.message}`);
      }
    }
    this.stats.lightProfiles += lightProfiles.length;
    this.stats.skippedUnchanged += lightProfiles.length;

    // ---- 2. Completas con concurrencia=1 y delay entre cada una ----
    if (fullProfiles.length > 0) {
      for (const meta of fullProfiles) {
        if (isCircuitOpen()) {
          log.warn('Circuito abierto durante perfiles. Cortando lote.');
          break;
        }

        let profile = null;
        try {
          profile = await buildProfile(meta);
        } catch (err) {
          log.debug(`Perfil completo falló: ${err.message}`);
          profile = buildProfileFromMeta(meta);
        }

        if (!profile) continue;
        this.stats.fullProfiles++;

        if (this.onSessionSeen) {
          try { this.onSessionSeen(profile); } catch (_) {}
        }

        try {
          const { created } = this.world.upsertEntity(profile);
          if (created) {
            this.stats.entitiesCreated++;
            this.knownIds.add(profile.id);
            if (this.onNewEntity) {
              try { this.onNewEntity(profile); } catch (_) {}
            }
            log.info(
              `🌱 Nueva entidad: ${profile.id.slice(-12)} ` +
              `(${profile.dominantEmotion}/${profile.dominantIntent})`
            );
          } else {
            this.stats.entitiesUpdated++;
          }
        } catch (err) {
          log.debug(`upsert completo falló: ${err.message}`);
        }

        await sleep(DELAY_BETWEEN_PROFILES_MS);
      }
    }

    // ---- 3. Actualiza cache (solo sesiones válidas) ----
    for (const s of sessions) {
      if (!s.sessionId) continue;
      this.sessionCache.set(String(s.sessionId), {
        lastActivityAt: Number(s.lastActivityAt) || 0,
        turnCount: Number(s.turnCount) || 0,
      });
    }

    log.debug(`Poll completo en ${Date.now() - t0}ms`);
  }

  _classifySessions(sessions) {
    const fullCandidates = [];
    const lightProfiles = [];

    for (const s of sessions) {
      if (!s.sessionId) continue;
      const id = String(s.sessionId);
      const cached = this.sessionCache.get(id);
      const lastActivityAt = Number(s.lastActivityAt) || 0;
      const turnCount = Number(s.turnCount) || 0;

      if (!cached) {
        fullCandidates.push(s);
        continue;
      }

      const changed = cached.lastActivityAt !== lastActivityAt
        || cached.turnCount !== turnCount;

      if (changed) fullCandidates.push(s);
      else lightProfiles.push(s);
    }

    fullCandidates.sort(
      (a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0)
    );

    const fullProfiles = fullCandidates.slice(0, this.maxFullProfiles);
    const overflow = fullCandidates.slice(this.maxFullProfiles);

    return {
      fullProfiles,
      lightProfiles: [...lightProfiles, ...overflow],
    };
  }

  getState() {
    return {
      running: this.running,
      baseIntervalMs: this.baseIntervalMs,
      currentIntervalMs: this.currentIntervalMs,
      maxIntervalMs: this.maxIntervalMs,
      sessionsLimit: this.sessionsLimit,
      maxFullProfiles: this.maxFullProfiles,
      knownIds: this.knownIds.size,
      cachedSessions: this.sessionCache.size,
      consecutiveOkPolls: this.consecutiveOkPolls,
      consecutiveErrors: this.consecutiveErrors,
      internalSessionPatterns: INTERNAL_SESSION_PATTERNS.map(r => r.source),
      stats: { ...this.stats },
    };
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms).unref?.());
}

export default Poller;
