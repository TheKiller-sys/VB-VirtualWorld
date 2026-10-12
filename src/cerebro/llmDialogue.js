// src/cerebro/llmDialogue.js
// Genera diálogos entre entidades usando el LLM del Cerebro.
//
// Usa /api/chat con una session dedicada (world_sim_v1) que el poller ignora.
// Rate limiting propio para no saturar el Cerebro.
// Fallback a null si el LLM no está disponible o falla.

import { callCerebro } from './client.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

const log = logger.child('llmDialogue');

// ============================================================
// Estado del generador
// ============================================================

const state = {
  lastCallAt: 0,
  inFlight: false,
  totalCalls: 0,
  totalOk: 0,
  totalErrors: 0,
  totalSkipped: 0,
  totalFallbacks: 0,
  consecutiveErrors: 0,
  blockedUntil: 0,
};

// ============================================================
// API
// ============================================================

/**
 * Devuelve true si se puede llamar al LLM ahora.
 */
export function canCallLLM() {
  if (!env.llmDialogueEnabled) return false;
  if (state.inFlight) return false;
  if (Date.now() < state.blockedUntil) return false;
  if (Date.now() - state.lastCallAt < env.llmDialogueMinIntervalMs) return false;
  return true;
}

/**
 * Genera un diálogo entre dos entidades usando el LLM del Cerebro.
 * @returns {Promise<Array<{entityId, text, delayMs, durationMs}>|null>}
 */
export async function generateDialogueWithLLM(a, b) {
  if (!canCallLLM()) {
    state.totalSkipped++;
    return null;
  }

  state.inFlight = true;
  state.lastCallAt = Date.now();
  state.totalCalls++;

  const t0 = Date.now();

  try {
    const prompt = buildPrompt(a, b);
    const response = await callCerebro('chat', {
      body: { message: prompt },
      sessionId: env.llmDialogueSessionId,
      timeoutMs: env.llmDialogueTimeoutMs,
    });

    const text = response?.message || '';
    if (!text) throw new Error('Respuesta vacía del LLM');

    const messages = parseDialogue(text, a, b);
    if (messages.length < 2) {
      throw new Error(`Diálogo demasiado corto (${messages.length} líneas)`);
    }

    state.totalOk++;
    state.consecutiveErrors = 0;
    log.info(
      `✨ Diálogo LLM ${a.id.slice(-6)}↔${b.id.slice(-6)} · ` +
      `${messages.length} líneas · ${Date.now() - t0}ms`
    );

    return messages;
  } catch (err) {
    state.totalErrors++;
    state.consecutiveErrors++;

    if (err.statusCode === 429) {
      state.blockedUntil = Date.now() + 120000;  // 2 min
      log.warn(`LLM 429 → bloqueando 2 min`);
    } else if (state.consecutiveErrors >= 3) {
      state.blockedUntil = Date.now() + 60000;  // 1 min
      log.warn(`LLM ${state.consecutiveErrors} errores seguidos → bloqueando 1 min`);
    }

    log.debug(`LLM falló: ${err.message}`);
    return null;
  } finally {
    state.inFlight = false;
  }
}

// ============================================================
// Prompt
// ============================================================

function buildPrompt(a, b) {
  const aInfo = describeEntity(a, 'A');
  const bInfo = describeEntity(b, 'B');

  return (
    `Estás simulando un encuentro breve entre dos entidades conscientes ` +
    `en un mundo 2D compartido.\n\n` +
    `${aInfo}\n\n` +
    `${bInfo}\n\n` +
    `Genera un diálogo BREVE de 2 a ${env.llmDialogueMaxLines} líneas entre ellas. ` +
    `Debe ser natural, en español, coherente con sus emociones e intenciones. ` +
    `Sin narración, sin descripciones, solo los diálogos.\n\n` +
    `Formato EXACTO (una línea por mensaje, alternando A y B):\n` +
    `A: <texto>\n` +
    `B: <texto>\n` +
    `A: <texto>\n\n` +
    `NO escribas nada más. Solo las líneas del diálogo.`
  );
}

function describeEntity(e, label) {
  const emotion = e.dominantEmotion || 'neutral';
  const intent = e.dominantIntent || 'charla';
  const topics = (e.topics && e.topics.length > 0)
    ? e.topics.join(', ')
    : 'sin temas específicos';
  const experience = e.turnCount > 50 ? 'muy experimentada'
    : e.turnCount > 20 ? 'con algo de experiencia'
    : 'relativamente nueva';

  return (
    `ENTIDAD ${label}:\n` +
    `- Emoción dominante: ${emotion}\n` +
    `- Intención dominante: ${intent}\n` +
    `- Temas: ${topics}\n` +
    `- Experiencia: ${experience} (${e.turnCount} conversaciones)`
  );
}

// ============================================================
// Parser
// ============================================================

function parseDialogue(text, a, b) {
  const lines = String(text).split('\n');
  const messages = [];

  let currentDelay = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = trimmed.match(/^([AB])\s*:\s*(.+)$/i);
    if (!match) continue;

    const who = match[1].toUpperCase();
    const content = match[2].trim().replace(/^["'«»]|["'«»]$/g, '').trim();
    if (!content) continue;

    if (messages.length > 0) {
      currentDelay += 1200 + Math.random() * 800;
    }

    const entity = who === 'A' ? a : b;
    messages.push({
      entityId: entity.id,
      text: content.slice(0, 200),
      delayMs: Math.round(currentDelay),
      durationMs: Math.max(3000, Math.min(7000, content.length * 80)),
    });

    if (messages.length >= env.llmDialogueMaxLines) break;
  }

  return messages;
}

// ============================================================
// Stats
// ============================================================

export function getLLMStats() {
  return {
    enabled: env.llmDialogueEnabled,
    inFlight: state.inFlight,
    blocked: Date.now() < state.blockedUntil,
    blockedRemainingMs: Math.max(0, state.blockedUntil - Date.now()),
    lastCallAgoMs: Date.now() - state.lastCallAt,
    minIntervalMs: env.llmDialogueMinIntervalMs,
    ...state,
  };
}
