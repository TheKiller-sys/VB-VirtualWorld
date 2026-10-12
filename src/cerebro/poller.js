// src/cerebro/poller.js
// Sondea /api/session/list cada N ms y materializa cada sesión como entidad.

import { callCerebro } from './client.js';
import { buildProfile } from './profiler.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const log = logger.child('poller');

export class Poller {
  /**
   * @param {import('../world/World.js').World} world
   * @param {object} [opts]
   * @param {number} [opts.intervalMs]
   * @param {number} [opts.sessionsLimit]
   * @param {(profile) => void} [opts.onNewEntity]
   * @param {(meta) => void} [opts.onSessionSeen]
   */
  constructor(world, opts = {}) {
    this.world = world;
    this.intervalMs = opts.intervalMs ?? env.pollIntervalMs;
    this.sessionsLimit = opts.sessionsLimit ?? env.pollSessionsLimit;
    this.onNewEntity = opts.onNewEntity || null;
    this.onSessionSeen = opts.onSessionSeen || null;

    this.timer = null;
    this.running = false;
    this.knownIds = new Set();

    // Métricas
    this.stats = {
      polls: 0,
      errors: 0,
      lastPollAt: 0,
      lastErrorAt: 0,
      lastErrorMsg: null,
      consecutiveErrors: 0,
      entitiesCreated: 0,
      entitiesUpdated: 0,
    };
  }

  start() {
    if (this.running) return;
    this.running = true;

    // Primer poll inmediato (sin await)
    this._safePoll();

    this.timer = setInterval(() => this._safePoll(), this.intervalMs);
    if (this.timer.unref) this.timer.unref();

    log.info(`Poller iniciado (intervalo=${this.intervalMs}ms, límite=${this.sessionsLimit})`);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    log.info('Poller detenido');
  }

  async _safePoll() {
    try {
      await this._poll();
      this.stats.consecutiveErrors = 0;
    } catch (err) {
      this.stats.errors++;
      this.stats.consecutiveErrors++;
      this.stats.lastErrorAt = Date.now();
      this.stats.lastErrorMsg = err.message;

      // Log decreciente: solo avisa en el 1º, luego cada 10
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

    // Procesamos perfiles en paralelo, pero limitado para no saturar el Cerebro.
    const profiles = await this._buildProfilesLimited(sessions, 4);

    let created = 0;
    let updated = 0;

    for (const profile of profiles) {
      if (!profile) continue;

      if (this.onSessionSeen) {
        try { this.onSessionSeen(profile); } catch (_) {}
      }

      const wasKnown = this.knownIds.has(profile.id);

      try {
        const { created: isNew } = this.world.upsertEntity(profile);
        if (isNew) {
          created++;
          this.knownIds.add(profile.id);
          if (this.onNewEntity) {
            try { this.onNewEntity(profile); } catch (_) {}
          }
          log.info(`🌱 Nueva entidad: ${profile.id.slice(-12)} (${profile.dominantEmotion}/${profile.dominantIntent})`);
        } else {
          updated++;
        }
      } catch (err) {
        log.warn(`upsertEntity falló para ${profile.id}: ${err.message}`);
      }

      if (!wasKnown) {
        // doble seguro
      }
    }

    this.stats.entitiesCreated += created;
    this.stats.entitiesUpdated += updated;

    log.debug(
      `Poll OK: ${sessions.length} sesiones · ${created} nuevas · ${updated} actualizadas · ${Date.now() - t0}ms`
    );
  }

  /**
   * Construye perfiles con concurrencia limitada.
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
            log.warn(`Profiler falló para ${sessions[i]?.sessionId}: ${err.message}`);
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
      sessionsLimit: this.sessionsLimit,
      knownIds: this.knownIds.size,
      stats: { ...this.stats },
    };
  }
}

export default Poller;
