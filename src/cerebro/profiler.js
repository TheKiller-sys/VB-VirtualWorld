// src/cerebro/profiler.js
// Construye un "perfil de entidad" a partir de una sesión del Cerebro.
//
// CAMBIOS V1.1.2 (fix 429):
//   - [PERF] History limit reducido de 50 a 20 turnos.
//   - [PERF] Topics solo se piden si el historial tuvo éxito.
//   - [PERF] Retries deshabilitados (el poller ya maneja backoff global).
//   - [PERF] Timeouts más cortos (3s en vez de 5s).
//   - [FEAT] Exporta buildProfileFromMeta() para el modo "ligero"
//     (sin historial): solo metadatos de /session/list.

import { callCerebro } from './client.js';
import { logger } from '../utils/logger.js';

const log = logger.child('profiler');

const HISTORY_LIMIT = 20;   // bajado de 50 → menos carga por request
const TOPICS_LIMIT = 6;
const TIMEOUT_MS = 3000;    // bajado de 5000

/**
 * Perfil "completo" con historial + topics.
 * Usado para sesiones nuevas o que cambiaron.
 */
export async function buildProfile(sessionMeta) {
  if (!sessionMeta || !sessionMeta.sessionId) return null;

  const id = String(sessionMeta.sessionId);

  // 1. Historial primero (es lo importante)
  let turns = [];
  try {
    const h = await callCerebro('sessionHistory', {
      query: { limit: HISTORY_LIMIT },
      sessionId: id,
      timeoutMs: TIMEOUT_MS,
      retries: 1,  // 1 retry local, el poller ya tiene backoff global
    });
    turns = Array.isArray(h?.turns) ? h.turns : [];
  } catch (err) {
    // Si falla el historial, caemos al perfil ligero
    log.debug(`Historial ${id.slice(-8)} falló: ${err.message}`);
    return buildProfileFromMeta(sessionMeta);
  }

  // 2. Topics solo si el historial fue OK
  let topics = [];
  try {
    const t = await callCerebro('sessionTopics', {
      sessionId: id,
      timeoutMs: TIMEOUT_MS,
      retries: 0,  // sin retry para topics, no es crítico
    });
    topics = extractTopics(t);
  } catch (err) {
    // Topics es opcional, no bloquea
    log.debug(`Topics ${id.slice(-8)} falló: ${err.message}`);
  }

  const derived = deriveFromTurns(turns);

  const avgSentiment = derived.avgSentiment !== null
    ? derived.avgSentiment
    : Number(sessionMeta.avgSentiment) || 0;

  const turnCount = Number(sessionMeta.turnCount) || turns.length || 0;

  const dominantEmotion = derived.dominantEmotion
    || inferEmotionFromSentiment(avgSentiment);

  const dominantIntent = derived.dominantIntent || 'charla';

  const intensity = computeIntensity({
    turnCount,
    lastActivityAt: sessionMeta.lastActivityAt || Date.now(),
  });

  const traits = deriveTraits({
    intentCounts: derived.intentCounts,
    emotionCounts: derived.emotionCounts,
    turnCount,
    avgSentiment,
  });

  return {
    id,
    isSimulated: false,
    label: null,
    bornAt: Number(sessionMeta.createdAt) || Date.now(),
    lastSeenAt: Number(sessionMeta.lastActivityAt) || Date.now(),
    turnCount,
    sentiment: avgSentiment,
    intensity,
    dominantEmotion,
    dominantIntent,
    topics: topics.slice(0, TOPICS_LIMIT),
    traits,
  };
}

/**
 * Perfil "ligero": solo con los metadatos de /session/list.
 * No hace NINGUNA request adicional al Cerebro.
 * Usado:
 *   - como fallback cuando el historial falla
 *   - para sesiones viejas que no han cambiado
 */
export function buildProfileFromMeta(sessionMeta) {
  if (!sessionMeta || !sessionMeta.sessionId) return null;

  const id = String(sessionMeta.sessionId);
  const turnCount = Number(sessionMeta.turnCount) || 0;
  const avgSentiment = Number(sessionMeta.avgSentiment) || 0;

  const dominantEmotion = inferEmotionFromSentiment(avgSentiment);

  const intensity = computeIntensity({
    turnCount,
    lastActivityAt: sessionMeta.lastActivityAt || Date.now(),
  });

  return {
    id,
    isSimulated: false,
    label: null,
    bornAt: Number(sessionMeta.createdAt) || Date.now(),
    lastSeenAt: Number(sessionMeta.lastActivityAt) || Date.now(),
    turnCount,
    sentiment: avgSentiment,
    intensity,
    dominantEmotion,
    dominantIntent: 'charla',
    topics: [],
    traits: {
      openness: 0.5,
      curiosity: 0.5,
      emotionality: 0.5,
      sociality: 0.5,
      stability: 0.5,
    },
  };
}

// ============================================================
// Derivaciones
// ============================================================

function extractTopics(t) {
  const topics = t?.topics;
  if (!Array.isArray(topics)) return [];
  return topics
    .map(x => (typeof x === 'string' ? x : x?.topic || x?.name))
    .filter(Boolean)
    .map(x => String(x).slice(0, 40));
}

function deriveFromTurns(turns) {
  const emotionCounts = {};
  const intentCounts = {};
  let sentimentSum = 0;
  let sentimentN = 0;

  for (const turn of turns) {
    if (!turn || typeof turn !== 'object') continue;

    const emo = normalizeEmotion(turn.emotion);
    if (emo) emotionCounts[emo] = (emotionCounts[emo] || 0) + 1;

    const intent = turn.intent ? String(turn.intent).slice(0, 40) : null;
    if (intent) intentCounts[intent] = (intentCounts[intent] || 0) + 1;

    if (typeof turn.sentiment === 'number' && Number.isFinite(turn.sentiment)) {
      sentimentSum += turn.sentiment;
      sentimentN++;
    }
  }

  return {
    emotionCounts,
    intentCounts,
    avgSentiment: sentimentN > 0 ? sentimentSum / sentimentN : null,
    dominantEmotion: topKey(emotionCounts),
    dominantIntent: topKey(intentCounts),
  };
}

function inferEmotionFromSentiment(s) {
  if (s > 0.4) return 'alegria';
  if (s > 0.15) return 'calma';
  if (s < -0.4) return 'tristeza';
  if (s < -0.15) return 'ansiedad';
  return 'neutral';
}

function computeIntensity({ turnCount, lastActivityAt }) {
  const hoursSince = (Date.now() - lastActivityAt) / 3600000;
  const recency = Math.exp(-hoursSince / 6);
  const activity = Math.min(1, Math.log10(1 + turnCount) / 2);
  return clamp(0.3 * recency + 0.7 * activity, 0, 1);
}

function deriveTraits({ intentCounts, emotionCounts, turnCount, avgSentiment }) {
  const philosophy = (intentCounts.filosofia || 0) + (intentCounts.pregunta_opinion || 0);
  const curiositySignals = (intentCounts.pregunta_estado || 0)
    + (intentCounts.pregunta_opinion || 0)
    + (intentCounts.filosofia || 0);
  const emotionalSignals = (emotionCounts.tristeza || 0)
    + (emotionCounts.alegria || 0)
    + (emotionCounts.ira || 0)
    + (emotionCounts.ansiedad || 0);
  const socialSignals = (intentCounts.saludo || 0)
    + (intentCounts.despedida || 0)
    + (intentCounts.expresion_alegria || 0);

  return {
    openness: clamp(0.4 + philosophy * 0.08 + (turnCount > 10 ? 0.1 : 0), 0, 1),
    curiosity: clamp(0.4 + curiositySignals * 0.06, 0, 1),
    emotionality: clamp(0.3 + emotionalSignals * 0.07, 0, 1),
    sociality: clamp(0.3 + socialSignals * 0.1 + (turnCount > 20 ? 0.15 : 0), 0, 1),
    stability: clamp(0.5 + avgSentiment * 0.3 - (emotionCounts.ansiedad || 0) * 0.05, 0, 1),
  };
}

// ============================================================
// Helpers
// ============================================================

const EMOTION_ALIASES = {
  alegria: 'alegria', 'alegría': 'alegria', joy: 'alegria', happy: 'alegria',
  tristeza: 'tristeza', sad: 'tristeza', sadness: 'tristeza',
  miedo: 'miedo', fear: 'miedo',
  ira: 'ira', anger: 'ira', angry: 'ira',
  ansiedad: 'ansiedad', anxiety: 'ansiedad',
  calma: 'calma', calm: 'calma',
  curiosidad: 'curiosidad', curiosity: 'curiosidad',
  sorpresa: 'sorpresa', surprise: 'sorpresa',
  nostalgia: 'nostalgia',
  neutral: 'neutral', neutro: 'neutral',
  gratitud: 'gratitud', gratitude: 'gratitud',
  confusion: 'confusion', 'confusión': 'confusion',
};

function normalizeEmotion(e) {
  if (!e) return null;
  const s = String(e).toLowerCase().trim();
  return EMOTION_ALIASES[s] || null;
}

function topKey(obj) {
  let best = null, bestV = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (v > bestV) { bestV = v; best = k; }
  }
  return best;
}

function clamp(v, min, max) {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}
