// src/world/Entity.js
// Entidad viva del mundo. Puede ser real (chatID del Cerebro) o simulada.

const EMOTION_PALETTE = Object.freeze({
  alegria:    '#f6c453',
  tristeza:   '#5b8def',
  miedo:      '#8e6cc9',
  ira:        '#e05252',
  ansiedad:   '#c97b3f',
  calma:      '#61c9a8',
  curiosidad: '#4fc3f7',
  neutral:    '#9aa3b2',
  sorpresa:   '#ff8fb1',
  nostalgia:  '#b58ec9',
  gratitud:   '#7ed957',
  confusion:  '#a0a0a0',
});

const ALLOWED_EMOTIONS = new Set(Object.keys(EMOTION_PALETTE));

export const TRAIT_KEYS = Object.freeze([
  'openness',
  'curiosity',
  'emotionality',
  'sociality',
  'stability',
]);

export class Entity {
  constructor(profile) {
    // ---------- Identidad ----------
    this.id = String(profile.id);
    this.isSimulated = !!profile.isSimulated;
    this.label = profile.label || null;

    const now = Date.now();
    this.bornAt = Number(profile.bornAt) || now;
    this.lastSeenAt = Number(profile.lastSeenAt) || now;
    this.lastUpdatedAt = now;

    // ---------- Posición y movimiento ----------
    this.x = Number.isFinite(profile.x) ? profile.x : Math.random() * 1800 + 100;
    this.y = Number.isFinite(profile.y) ? profile.y : Math.random() * 1800 + 100;
    this.vx = Number.isFinite(profile.vx) ? profile.vx : 0;
    this.vy = Number.isFinite(profile.vy) ? profile.vy : 0;

    // ---------- Perfil ----------
    this.turnCount = Number(profile.turnCount) || 0;
    this.sentiment = clamp(Number(profile.sentiment) || 0, -1, 1);
    this.intensity = clamp(Number(profile.intensity) || 0.5, 0, 1);
    this.dominantEmotion = sanitizeEmotion(profile.dominantEmotion);
    this.dominantIntent = String(profile.dominantIntent || 'charla').slice(0, 40);
    this.topics = Array.isArray(profile.topics)
      ? profile.topics.slice(0, 8).map(t => String(t).slice(0, 40))
      : [];
    this.traits = sanitizeTraits(profile.traits);

    // ---------- Visual ----------
    this.radius = computeRadius(this.turnCount, this.intensity);
    this.color = EMOTION_PALETTE[this.dominantEmotion] || EMOTION_PALETTE.neutral;
    this.alpha = clamp(Number(profile.alpha) || 1, 0, 1);
    this.fading = false;
    this.dead = false;
    this.pulse = 0;

    // ---------- Social ----------
    this.relationships = new Map();
    if (profile.relationships && typeof profile.relationships === 'object') {
      for (const [k, v] of Object.entries(profile.relationships)) {
        const s = clamp(Number(v) || 0, 0, 1);
        if (s > 0) this.relationships.set(String(k), s);
      }
    }
    this.lastInteractionAt = Number(profile.lastInteractionAt) || 0;
    this.interactionCount = Number(profile.interactionCount) || 0;
  }

  // ------------------------------------------------------------
  // Derivados
  // ------------------------------------------------------------

  ageMs() {
    return Date.now() - this.lastUpdatedAt;
  }

  isStale(timeoutMs) {
    return this.ageMs() > timeoutMs;
  }

  // ------------------------------------------------------------
  // Similitud entre dos entidades (0..1)
  // ------------------------------------------------------------
  similarityTo(other) {
    if (!other) return 0;
    let sum = 0;
    let n = 0;
    for (const k of TRAIT_KEYS) {
      const a = this.traits[k] ?? 0;
      const b = other.traits[k] ?? 0;
      sum += 1 - Math.abs(a - b);
      n++;
    }
    // Bonus por compartir intent dominante
    const intentBonus = this.dominantIntent === other.dominantIntent ? 0.1 : 0;
    // Bonus por topics compartidos
    const sharedTopics = this._countSharedTopics(other);
    const topicBonus = Math.min(0.15, sharedTopics * 0.05);

    const base = n > 0 ? sum / n : 0;
    return clamp(base + intentBonus + topicBonus, 0, 1);
  }

  _countSharedTopics(other) {
    if (!this.topics.length || !other.topics.length) return 0;
    const a = new Set(this.topics);
    let c = 0;
    for (const t of other.topics) if (a.has(t)) c++;
    return c;
  }

  // ------------------------------------------------------------
  // Actualización desde un perfil nuevo
  // ------------------------------------------------------------
  updateFromProfile(profile) {
    const prevEmotion = this.dominantEmotion;
    this.lastSeenAt = Number(profile.lastSeenAt) || Date.now();
    this.lastUpdatedAt = Date.now();

    if (Number.isFinite(profile.turnCount)) this.turnCount = profile.turnCount;
    if (Number.isFinite(profile.sentiment)) this.sentiment = clamp(profile.sentiment, -1, 1);
    if (Number.isFinite(profile.intensity)) this.intensity = clamp(profile.intensity, 0, 1);
    if (profile.dominantEmotion) this.dominantEmotion = sanitizeEmotion(profile.dominantEmotion);
    if (profile.dominantIntent) this.dominantIntent = String(profile.dominantIntent).slice(0, 40);
    if (Array.isArray(profile.topics)) {
      this.topics = profile.topics.slice(0, 8).map(t => String(t).slice(0, 40));
    }
    if (profile.traits) this.traits = sanitizeTraits(profile.traits);

    this.color = EMOTION_PALETTE[this.dominantEmotion] || EMOTION_PALETTE.neutral;
    this.radius = computeRadius(this.turnCount, this.intensity);

    // Reactivar si estaba desvaneciéndose
    if (this.fading) {
      this.fading = false;
      this.alpha = 0.3;
    }
    if (this.alpha < 1) {
      this.alpha = Math.min(1, this.alpha + 0.15);
    }

    // Si cambió de emoción, un pequeño pulso visual
    if (prevEmotion !== this.dominantEmotion) {
      this.pulse = Math.max(this.pulse, 0.6);
    }
  }

  // ------------------------------------------------------------
  // Fade por inactividad
  // ------------------------------------------------------------
  tickFade(dt, world) {
    if (this.isSimulated) return; // simuladas no expiran solas
    if (this.dead) return;

    if (this.isStale(world.entityTimeoutMs)) {
      this.fading = true;
    }
    if (this.fading) {
      const rate = dt / (world.entityFadeMs / 1000);
      this.alpha -= rate;
      if (this.alpha <= 0) {
        this.alpha = 0;
        this.dead = true;
      }
    }
  }

  // ------------------------------------------------------------
  // Relaciones
  // ------------------------------------------------------------
  reinforceRelationship(otherId, delta) {
    const prev = this.relationships.get(otherId) || 0;
    const next = clamp(prev + delta, 0, 1);
    if (next <= 0) this.relationships.delete(otherId);
    else this.relationships.set(otherId, next);
    return next - prev;
  }

  decayRelationships(dt, perHour) {
    if (this.relationships.size === 0) return;
    const decay = (perHour / 3600) * dt;
    for (const [id, v] of this.relationships) {
      const nv = v - decay;
      if (nv <= 0.001) this.relationships.delete(id);
      else this.relationships.set(id, nv);
    }
  }

  setPulse(v) {
    this.pulse = clamp(Math.max(this.pulse, v), 0, 2);
  }

  tickPulse() {
    this.pulse *= 0.92;
    if (this.pulse < 0.001) this.pulse = 0;
  }

  // ------------------------------------------------------------
  // Serialización
  // ------------------------------------------------------------
  toJSON() {
    return {
      id: this.id,
      isSimulated: this.isSimulated,
      label: this.label,
      x: round2(this.x),
      y: round2(this.y),
      vx: round2(this.vx),
      vy: round2(this.vy),
      radius: round2(this.radius),
      color: this.color,
      alpha: round3(this.alpha),
      turnCount: this.turnCount,
      sentiment: round3(this.sentiment),
      intensity: round3(this.intensity),
      dominantEmotion: this.dominantEmotion,
      dominantIntent: this.dominantIntent,
      topics: this.topics,
      traits: this.traits,
      pulse: round3(this.pulse),
      bornAt: this.bornAt,
      lastSeenAt: this.lastSeenAt,
      lastUpdatedAt: this.lastUpdatedAt,
      ageMs: this.ageMs(),
      fading: this.fading,
      interactionCount: this.interactionCount,
    };
  }

  toPersistRow() {
    return {
      id: this.id,
      isSimulated: this.isSimulated ? 1 : 0,
      label: this.label,
      x: this.x,
      y: this.y,
      vx: this.vx,
      vy: this.vy,
      turnCount: this.turnCount,
      sentiment: this.sentiment,
      intensity: this.intensity,
      dominantEmotion: this.dominantEmotion,
      dominantIntent: this.dominantIntent,
      topicsJson: JSON.stringify(this.topics),
      traitsJson: JSON.stringify(this.traits),
      bornAt: this.bornAt,
      lastSeenAt: this.lastSeenAt,
      lastUpdatedAt: this.lastUpdatedAt,
      interactionCount: this.interactionCount,
    };
  }
}

// ============================================================
// Helpers
// ============================================================

function clamp(v, min, max) {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}

function round2(v) { return Math.round(v * 100) / 100; }
function round3(v) { return Math.round(v * 1000) / 1000; }

function computeRadius(turnCount, intensity) {
  const base = 6;
  const fromTurns = Math.min(18, Math.sqrt(Math.max(0, turnCount)) * 1.5);
  const fromIntensity = clamp(intensity, 0, 1) * 4;
  return base + fromTurns + fromIntensity;
}

function sanitizeEmotion(e) {
  if (!e) return 'neutral';
  const s = String(e).toLowerCase().trim();
  return ALLOWED_EMOTIONS.has(s) ? s : 'neutral';
}

function sanitizeTraits(t) {
  const out = {};
  for (const k of TRAIT_KEYS) {
    const v = t && typeof t === 'object' ? t[k] : undefined;
    out[k] = Number.isFinite(Number(v)) ? clamp(Number(v), 0, 1) : 0.5;
  }
  return out;
}

export const EMOTIONS = EMOTION_PALETTE;
