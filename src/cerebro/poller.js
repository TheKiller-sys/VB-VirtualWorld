// src/cerebro/poller.js
// Sondea /api/session/list y materializa cada sesión como entidad.
//
// CAMBIOS V1.1.2 (fix 429 + rendimiento):
//   - [PERF] Cache de lastActivityAt por sesión: solo se perfila completo
//     si la sesión cambió desde el último poll. Las sesiones viejas se
//     actualizan con perfil ligero (sin llamadas extra al Cerebro).
//   - [PERF] Concurrencia reducida de 4 a 2.
//   - [PERF] Delay entre batches de perfiles (300ms) para no saturar.
//   - [PERF] Máximo de sesiones a perfilar por poll (LIMITE_FULL_PROFILES).
//   - [PERF] Límite de sesiones a procesar (default 100).
//   - [FEAT] Backoff adaptativo si detecta muchos 429.
//   - [FEAT] Stats con contadores de skip y full-profiles.

import { callCerebro } from './client.js';
import { buildProfile, buildProfileFromMeta } from './profiler.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const log = logger.child('poller');

// Solo perfilamos COMPLETO (con historial+topics) a las sesiones que
// cambiaron recientemente. El resto se actualizan con perfil ligero.
const MAX_FULL_PROFILES_PER_POLL = 8;

// Concurrencia y delays
const CONCURRENCY = 2;
const DELAY_BETWEEN_BATCHES_MS = 300;

export class Poller {
  constructor(world, opts = {}) {
    this.world = world;
    this.intervalMs = opts.intervalMs ?? env.pollIntervalMs;
    this.sessionsLimit = opts.sessionsLimit ?? env.pollSessionsLimit;
    this.onNewEntity = opts.onNewEntity || null;
    this.onSessionSeen = opts.onSessionSeen || null;

    this.timer = null;
    this.running = false;
    this.knownIds = new Set();

    // Cache: sessionId → { lastActivityAt, turnCount }
    // Sirve para saber si la sesión cambió desde el último poll.
    this.sessionCache = new Map();

    // Stats
    this.stats = {
      polls: 0,
      errors: 0,
      lastPollAt: 0,
      lastErrorAt: 0,
      lastErrorMsg: null,
      consecutiveErrors: 0,
      entitiesCreated: 0,
      entitiesUpdated: 0,
      skippedUnchanged: 0,
      fullProfiles: 0,
      lightProfiles: 0,
      rateLimitedHits: 0,
    };

    // Backoff adaptativo: si detectamos muchos 429, subimos el intervalo
    this.adaptiveBackoffMs = 0;
  }

  start() {
    if (this.running) return;
    this.running = true;

    this._safePoll();

    const scheduleNext = () => {
      if (!this.running) return;
      const wait = this.intervalMs + this.adaptiveBackoffMs;
      this.timer = setTimeout(() => {
        this._safePoll().finally(scheduleNext);
      }, wait);
      if (this.timer.unref) this.timer.unref();
    };

    // Arranca el ciclo
    this.timer = setTimeout(() => {
      this._safePoll().finally(scheduleNext);
    }, this.intervalMs);
    if (this.timer.unref) this.timer.unref();

    log.info(
      `Poller iniciado (intervalo=${this.intervalMs}ms, límite=${this.sessionsLimit}, ` +
      `concurrencia=${CONCURRENCY})`
    );
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

  async _safePoll() {
    try {
      await this._poll();
      this.stats.consecutiveErrors = 0;
      // Éxito → reduce backoff gradualmente
      if (this.adaptiveBackoffMs > 0) {
        this.adaptiveBackoffMs = Math.max(0, this.adaptiveBackoffMs - 2000);
      }
    } catch (err) {
      this.stats.errors++;
      this.stats.consecutiveErrors++;
      this.stats.lastErrorAt = Date.now();
      this.stats.lastErrorMsg = err.message;

      // Si el error es 429, aplica backoff
      if (err.statusCode === 429) {
        this.stats.rateLimitedHits++;
        this.adaptiveBackoffMs = Math.min(
          this.adaptiveBackoffMs + 5000,
          60000,
        );
        log.warn(`429 del Cerebro → backoff adaptativo +5s (total ${this.adaptiveBackoffMs}ms)`);
      }

      if (this.stats.consecutiveErrors === 1 || this.stats.consecutiveErrors % 10 === 0) {
        log.warn(`Poll falló (${this.stats.consecutiveErrors} seguidos): ${err.message}`);
      }
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

    const sessions = Array.isArray(res?.sessions) ? res.sessions : [];
    if (sessions.length === 0) {
      log.debug('Poll: 0 sesiones');
      return;
    }

    // ---- Clasificación: ¿cuáles necesitan perfil completo? ----
    const { fullProfiles, lightProfiles } = this._classifySessions(sessions);

    log.debug(
      `Poll: ${sessions.length} sesiones · ` +
      `${fullProfiles.length} completas · ${lightProfiles.length} ligeras`
    );

    // ---- 1. Procesar perfiles LIGEROS primero (instantáneos, sin HTTP extra) ----
    for (const meta of lightProfiles) {
      try {
        const profile = buildProfileFromMeta(meta);
        if (!profile) continue;

        const wasKnown = this.knownIds.has(profile.id);
        const { created } = this.world.upsertEntity(profile);

        if (created) {
          this.stats.entitiesCreated++;
          this.knownIds.add(profile.id);
          if (this.onNewEntity) {
            try { this.onNewEntity(profile); } catch (_) {}
          }
          log.info(`🌱 Nueva entidad (ligera): ${profile.id.slice(-12)} (${profile.dominantEmotion})`);
        } else {
          this.stats.entitiesUpdated++;
        }

        if (this.onSessionSeen) {
          try { this.onSessionSeen(profile); } catch (_) {}
        }
      } catch (err) {
        log.warn(`upsert (ligero) falló: ${err.message}`);
      }
    }
    this.stats.lightProfiles += lightProfiles.length;
    this.stats.skippedUnchanged += lightProfiles.length;

    // ---- 2. Procesar perfiles COMPLETOS con concurrencia limitada ----
    if (fullProfiles.length > 0) {
      const profiles = await this._buildProfilesLimited(fullProfiles, CONCURRENCY);
      this.stats.fullProfiles += profiles.filter(Boolean).length;

      for (const profile of profiles) {
        if (!profile) continue;

        if (this.onSessionSeen) {
          try { this.onSessionSeen(profile); } catch (_) {}
        }

        try {
          const wasKnown = this.knownIds.has(profile.id);
          const { created } = this.world.upsertEntity(profile);

          if (created) {
            this.stats.entitiesCreated++;
            this.knownIds.add(profile.id);
            if (this.onNewEntity) {
              try { this.onNewEntity(profile); } catch (_) {}
            }
            log.info(`🌱 Nueva entidad: ${profile.id.slice(-12)} (${profile.dominantEmotion}/${profile.dominantIntent})`);
          } else {
            this.stats.entitiesUpdated++;
          }
        } catch (err) {
          log.warn(`upsert falló: ${err.message}`);
        }
      }
    }

    // ---- 3. Actualiza el cache con el estado actual ----
    for (const s of sessions) {
      if (!s.sessionId) continue;
      this.sessionCache.set(String(s.sessionId), {
        lastActivityAt: Number(s.lastActivityAt) || 0,
        turnCount: Number(s.turnCount) || 0,
      });
    }

    log.debug(`Poll completo en ${Date.now() - t0}ms`);
  }

  /**
   * Decide qué sesiones necesitan perfil completo (con HTTP extra)
   * y cuáles pueden usar perfil ligero (solo metadatos).
   */
  _classifySessions(sessions) {
    const fullProfiles = [];
    const lightProfiles = [];

    for (const s of sessions) {
      if (!s.sessionId) continue;

      const id = String(s.sessionId);
      const cached = this.sessionCache.get(id);
      const lastActivityAt = Number(s.lastActivityAt) || 0;
      const turnCount = Number(s.turnCount) || 0;

      // Es nueva (nunca vista) → perfil completo
      if (!cached) {
        fullProfiles.push(s);
        continue;
      }

      // Cambió desde el último poll → perfil completo
      const changed = cached.lastActivityAt !== lastActivityAt
        || cached.turnCount !== turnCount;

      if (changed) {
        fullProfiles.push(s);
      } else {
        // No cambió → solo metadatos (sin HTTP)
        lightProfiles.push(s);
      }
    }

    // Limita cuántos perfiles completos hacemos por poll.
    // Si hay más, los sobrantes pasan a "ligeros" (se perfilarán en el próximo poll).
    if (fullProfiles.length > MAX_FULL_PROFILES_PER_POLL) {
      const prioritized = fullProfiles
        .sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0))
        .slice(0, MAX_FULL_PROFILES_PER_POLL);

      const overflow = fullProfiles
        .sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0))
        .slice(MAX_FULL_PROFILES_PER_POLL);

      return {
        fullProfiles: prioritized,
        lightProfiles: [...lightProfiles, ...overflow],
      };
    }

    return { fullProfiles, lightProfiles };
  }

  /**
   * Construye perfiles completos con concurrencia limitada y delay entre lotes.
   */
  async _buildProfilesLimited(sessions, concurrency) {
    const out = new Array(sessions.length).fill(null);
    let idx = 0;

    const workers = new Array(Math.min(concurrency, sessions.length))
      .fill(null)
      .map(async () => {
        while (true) {
          const i = idx++;
          if (i >= sessions.length) return;

          try {
            out[i] = await buildProfile(sessions[i]);
          } catch (err) {
            out[i] = null;
            log.debug(`Profiler falló para ${sessions[i]?.sessionId?.slice(-8)}: ${err.message}`);
          }

          // Delay entre perfiles para no saturar
          if (idx < sessions.length) {
            await sleep(DELAY_BETWEEN_BATCHES_MS);
          }
        }
      });

    await Promise.all(workers);
    return out;
  }

  getState() {
    return {
      running: this.running,
      intervalMs: this.intervalMs,
      adaptiveBackoffMs: this.adaptiveBackoffMs,
      sessionsLimit: this.sessionsLimit,
      knownIds: this.knownIds.size,
      cachedSessions: this.sessionCache.size,
      stats: { ...this.stats },
    };
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms).unref?.());
}

export default Poller;
