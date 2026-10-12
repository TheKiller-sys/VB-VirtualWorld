// src/cerebro/profiler.js
// Construye un "perfil de entidad" a partir de una sesión del Cerebro.
// El Cerebro NO expone estado por sesión directamente, así que combinamos
// session/list + historial + topics.

import { callCerebro } from './client.js';
import { logger } from '../utils/logger.js';

const log = logger.child('profiler');

const HISTORY_LIMIT = 50;
const TOPICS_LIMIT = 6;

/**
 * Construye el perfil de una entidad desde el meta de sesión.
 * @param {object} sessionMeta  fila de /api/session/list
 * @returns {object|null}       perfil listo para World.upsertEntity
 */
export async function buildProfile(sessionMeta) {
  if (!sessionMeta || !sessionMeta.sessionId) return null;

  const id = String(sessionMeta.sessionId);

  // Enriquecimiento en paralelo, tolerante a fallos
  const [turns, topics] = await Promise.all([
    fetchHistory(id).catch(err => {
      log.warn(`Historial ${id.slice(-8)} falló: ${err.message}`);
      return [];
    }),
    fetchTopics(id).catch(() => []),
  ]);

  const derived = deriveFromTurns(turns);

  const avgSentiment = derived.avgSentiment !== null
    ? derived.avgSentiment
    : Number(sessionMeta.avgSentiment) || 0;

  const turnCount = Number(sessionMeta.turnCount) || turns.length || 0;

  const dominantEmotion = derived.dominantEmotion || inferEmotionFromSentiment(avgSentiment);
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

  const profile = {
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

  return profile;
}

// ------------------------------------------------------------
// Fetches
// ------------------------------------------------------------

async function fetchHistory(sessionId) {
  const res = await callCerebro('sessionHistory', {
    query: { limit: HISTORY_LIMIT },
    sessionId,
    timeoutMs: 5000,
  });
  const turns = res?.turns;
  return Array.isArray(turns) ? turns : [];
}

async function fetchTopics(sessionId) {
  const res = await callCerebro('sessionTopics', {
    sessionId,
    timeoutMs: 5000,
  });
  const topics = res?.topics;
  if (!Array.isArray(topics)) return [];
  return topics
    .map(t => (typeof t === 'string' ? t : t?.topic || t?.name))
    .filter(Boolean)
    .map(t => String(t).slice(0, 40));
}

// ------------------------------------------------------------
// Derivaciones
// ------------------------------------------------------------

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
  const recency = Math.exp(-hoursSince / 6);        // 6h de vida media
  const activity = Math.min(1, Math.log10(1 + turnCount) / 2); // 100 turnos ≈ 1.0
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
    openness: clamp(
      0.4 + philosophy * 0.08 + (turnCount > 10 ? 0.1 : 0),
      0,
      1,
    ),
    curiosity: clamp(
      0.4 + curiositySignals * 0.06,
      0,
      1,
    ),
    emotionality: clamp(
      0.3 + emotionalSignals * 0.07,
      0,
      1,
    ),
    sociality: clamp(
      0.3 + socialSignals * 0.1 + (turnCount > 20 ? 0.15 : 0),
      0,
      1,
    ),
    stability: clamp(
      0.5 + avgSentiment * 0.3 - (emotionCounts.ansiedad || 0) * 0.05,
      0,
      1,
    ),
  };
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

const EMOTION_ALIASES = {
  alegria: 'alegria',
  alegría: 'alegria',
  joy: 'alegria',
  happy: 'alegria',
  tristeza: 'tristeza',
  sad: 'tristeza',
  sadness: 'tristeza',
  miedo: 'miedo',
  fear: 'miedo',
  ira: 'ira',
  anger: 'ira',
  angry: 'ira',
  ansiedad: 'ansiedad',
  anxiety: 'ansiedad',
  calma: 'calma',
  calm: 'calma',
  curiosidad: 'curiosidad',
  curiosity: 'curiosidad',
  sorpresa: 'sorpresa',
  surprise: 'sorpresa',
  nostalgia: 'nostalgia',
  neutral: 'neutral',
  neutro: 'neutral',
  gratitud: 'gratitud',
  gratitude: 'gratitud',
  confusion: 'confusion',
  confusión: 'confusion',
};

function normalizeEmotion(e) {
  if (!e) return null;
  const s = String(e).toLowerCase().trim();
  return EMOTION_ALIASES[s] || null;
}

function topKey(obj) {
  let best = null;
  let bestV = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (v > bestV) { bestV = v; best = k; }
  }
  return best;
}

function clamp(v, min, max) {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}
