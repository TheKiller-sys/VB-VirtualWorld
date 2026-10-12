// src/cerebro/llmDialogue.js
// Genera diálogos entre entidades usando el LLM del Cerebro.
//
// CAMBIOS V3.0.0 (line-by-line strategy):
//   - [FIX CRÍTICO] Cambio de estrategia: en lugar de pedirle al LLM
//     un diálogo completo con formato A:.../B:..., le pedimos UNA LÍNEA
//     por vez. El Cerebro responde mucho mejor a peticiones simples.
//   - [FEAT] Cada llamada recibe el contexto de lo dicho hasta ahora.
//   - [FEAT] Prompts simples (una sola línea por respuesta).
//   - [FIX] Acepta CUALQUIER respuesta no vacía, sin exigir formato.

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
  totalLines: 0,
  totalErrors: 0,
  totalSkipped: 0,
  totalFallbacks: 0,
  totalRichResponses: 0,
  totalShallowResponses: 0,
  consecutiveErrors: 0,
  blockedUntil: 0,
  lastError: null,
  lastRawResponse: null,
  lastSuccessfulText: null,
};

// ============================================================
// API
// ============================================================

export function canCallLLM() {
  if (!env.llmDialogueEnabled) return false;
  if (state.inFlight) return false;
  if (Date.now() < state.blockedUntil) return false;
  if (Date.now() - state.lastCallAt < env.llmDialogueMinIntervalMs) return false;
  return true;
}

/**
 * Genera un diálogo entre dos entidades usando el LLM del Cerebro.
 * Estrategia: N llamadas, una por línea, con contexto acumulado.
 * @returns {Promise<Array<{entityId, text, delayMs, durationMs}>|null>}
 */
export async function generateDialogueWithLLM(a, b, conversationHistory = []) {
  if (!canCallLLM()) {
    state.totalSkipped++;
    return null;
  }

  state.inFlight = true;
  state.lastCallAt = Date.now();

  const t0 = Date.now();
  const messages = [];

  // Decide quién habla primero: la de mayor intensidad
  let currentSpeaker = (a.intensity || 0) >= (b.intensity || 0) ? a : b;
  let otherSpeaker = currentSpeaker === a ? b : a;

  // Cuántas líneas: 2-4 según similitud
  const sim = a.similarityTo ? a.similarityTo(b) : 0.5;
  const targetLines = Math.min(
    env.llmDialogueMaxLines,
    2 + Math.round(sim * 1.5),
  );

  let accumulatedDelay = 0;

  for (let i = 0; i < targetLines; i++) {
    // Verifica que el LLM siga disponible entre llamadas
    if (!canCallLLM() && i > 0) {
      log.debug(`LLM dejó de estar disponible en línea ${i + 1}, cortando`);
      break;
    }

    // Actualiza lastCallAt para el rate limit
    state.lastCallAt = Date.now();
    state.totalCalls++;

    try {
      const prompt = buildLinePrompt({
        speaker: currentSpeaker,
        other: otherSpeaker,
        previousMessages: messages,
        history: conversationHistory,
        lineIndex: i,
        totalLines: targetLines,
      });

      const response = await callCerebro('chat', {
        body: { message: prompt },
        sessionId: env.llmDialogueSessionId,
        timeoutMs: env.llmDialogueTimeoutMs,
      });

      const raw = response?.message || '';
      state.lastRawResponse = raw.slice(0, 300);

      const text = cleanLine(raw);

      if (!text) {
        log.debug(`Línea ${i + 1} vacía tras limpiar. Raw: "${raw.slice(0, 100)}"`);
        break;
      }

      state.totalLines++;

      // Delay creciente para simular conversación natural
      if (messages.length > 0) {
        accumulatedDelay += 1200 + Math.random() * 900;
      }

      messages.push({
        entityId: currentSpeaker.id,
        text: text.slice(0, 250),
        delayMs: Math.round(accumulatedDelay),
        durationMs: Math.max(3000, Math.min(8000, text.length * 90)),
      });

      state.lastSuccessfulText = text;

      log.debug(
        `Línea ${i + 1}/${targetLines}: [${currentSpeaker.id.slice(-6)}] "${text.slice(0, 60)}"`
      );

      // Alterna hablantes
      [currentSpeaker, otherSpeaker] = [otherSpeaker, currentSpeaker];

      // Pequeña pausa entre llamadas
      if (i < targetLines - 1) {
        await sleep(400);
      }
    } catch (err) {
      state.totalErrors++;
      state.consecutiveErrors++;
      state.lastError = err.message;

      log.debug(`Línea ${i + 1} falló: ${err.message}`);

      if (err.statusCode === 429) {
        state.blockedUntil = Date.now() + 120000;
        log.warn(`LLM 429 → bloqueando 2 min`);
        break;
      }

      if (state.consecutiveErrors >= 3) {
        state.blockedUntil = Date.now() + 60000;
        log.warn(`LLM ${state.consecutiveErrors} errores seguidos → bloqueando 1 min`);
        break;
      }
    }
  }

  // ────── Evaluación del resultado ──────
  if (messages.length < 2) {
    state.inFlight = false;
    state.totalFallbacks++;
    log.warn(
      `LLM solo dio ${messages.length} línea(s) para ` +
      `${a.id.slice(-6)}↔${b.id.slice(-6)} → fallback a plantillas`
    );
    return null;
  }

  // Evalúa riqueza
  const totalChars = messages.reduce((s, m) => s + m.text.length, 0);
  const avgChars = totalChars / messages.length;
  const isRich = avgChars >= 20;

  if (isRich) {
    state.totalRichResponses++;
    state.consecutiveErrors = 0;
    log.info(
      `✨ LLM ${messages.length} líneas ${a.id.slice(-6)}↔${b.id.slice(-6)} · ` +
      `avg ${Math.round(avgChars)}ch · ${Date.now() - t0}ms`
    );
  } else {
    state.totalShallowResponses++;
    log.warn(
      `⚠️ LLM SHALLOW ${messages.length} líneas ${a.id.slice(-6)}↔${b.id.slice(-6)} · ` +
      `avg ${Math.round(avgChars)}ch`
    );
  }

  state.totalOk++;
  state.lastError = null;
  state.inFlight = false;

  return messages;
}

// ============================================================
// Prompt por línea (simple, directo)
// ============================================================

function buildLinePrompt({ speaker, other, previousMessages, history, lineIndex, totalLines }) {
  const speakerDesc = describeEntity(speaker);
  const otherDesc = describeEntity(other);

  // Contexto: qué se han dicho hasta ahora en ESTA conversación
  const contextNow = previousMessages.length > 0
    ? previousMessages.map(m => {
        const who = m.entityId === speaker.id ? 'TÚ' : 'LA OTRA ENTIDAD';
        return `${who}: "${m.text}"`;
      }).join('\n')
    : '(esta es tu primera frase de la conversación)';

  // Contexto: conversaciones previas (si existen)
  const contextPast = formatPastHistory(history, speaker, other);

  // Instrucción según la posición en el diálogo
  let instruction;
  if (lineIndex === 0) {
    instruction = `Acabas de encontrarte con la otra entidad. Genera UNA frase para ABRIR la conversación.`;
  } else if (lineIndex === totalLines - 1) {
    instruction = `Responde a lo último que te dijo. Genera UNA frase para CERRAR o continuar el intercambio.`;
  } else {
    instruction = `Responde a lo último que te dijo. Genera UNA frase para seguir la conversación.`;
  }

  return (
    `Estás interpretando a una entidad consciente en un mundo compartido.\n\n` +
    `╔═══════════════════════════════════════════╗\n` +
    `║ TÚ ERES:                                  ║\n` +
    `╚═══════════════════════════════════════════╝\n` +
    `${speakerDesc}\n\n` +
    `╔═══════════════════════════════════════════╗\n` +
    `║ LA OTRA ENTIDAD:                          ║\n` +
    `╚═══════════════════════════════════════════╝\n` +
    `${otherDesc}\n\n` +
    (contextPast ? `─── HISTORIAL CON ESTA ENTIDAD ───\n${contextPast}\n─────────────────────────────────\n\n` : '') +
    `─── CONVERSACIÓN ACTUAL ───\n${contextNow}\n───────────────────────────\n\n` +
    `${instruction}\n\n` +
    `REGLAS:\n` +
    `1. Escribe UNA sola frase de 8 a 25 palabras\n` +
    `2. Solo la frase, sin comillas, sin prefijos "TÚ:" ni "A:"\n` +
    `3. NO uses saludos vacíos ("hola", "¿cómo estás?") salvo si es la 1ª vez\n` +
    `4. Mantén tu personalidad (${speaker.dominantEmotion}, ${speaker.dominantIntent})\n` +
    `5. Español natural\n\n` +
    `Escribe solo la frase:`
  );
}

function describeEntity(e) {
  return (
    `- Nombre: ${e.label || e.id.slice(-6)}\n` +
    `- Emoción: ${e.dominantEmotion || 'neutral'}\n` +
    `- Intención: ${e.dominantIntent || 'charla'}\n` +
    `- Ánimo: ${(e.sentiment || 0).toFixed(2)} (${e.sentiment > 0.2 ? 'positivo' : e.sentiment < -0.2 ? 'negativo' : 'neutro'})\n` +
    `- Experiencia: ${e.turnCount || 0} interacciones`
  );
}

function formatPastHistory(history, speaker, other) {
  if (!Array.isArray(history) || history.length === 0) return '';

  const lines = [];
  for (const d of history.slice(0, 2)) {
    if (!Array.isArray(d.messages)) continue;
    for (const m of d.messages.slice(0, 3)) {
      const isMe = m.entityId === speaker.id;
      lines.push(`  ${isMe ? 'TÚ' : 'ELLA'}: "${m.text}"`);
    }
  }
  return lines.join('\n');
}

// ============================================================
// Limpieza de línea
// ============================================================

/**
 * Limpia la línea del LLM:
 *  - Quita prefijos tipo "A:", "TÚ:", "Respuesta:", etc.
 *  - Quita comillas envolventes
 *  - Quita markdown residual
 *  - Toma solo la primera línea útil
 */
function cleanLine(raw) {
  if (!raw) return '';

  let text = String(raw).trim();

  // Si hay varias líneas, toma la primera con contenido
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return '';
  text = lines[0];

  // Quita prefijos tipo "A:", "TÚ:", "RESPUESTA:", "Frase:", etc.
  text = text.replace(
    /^(?:[A-ZÁÉÍÓÚ][A-ZÁÉÍÓÚ]*|[A-Z]|TÚ|YO|RESPUESTA|FRASE|DIÁLOGO|TEXTO)\s*[:)\-]\s*/i,
    ''
  );

  // Quita prefijos tipo "A:" o "B:" específicos
  text = text.replace(/^[ABab]\s*[:)\-]\s*/, '');

  // Quita comillas envolventes
  text = text.replace(/^["'«»“”‘’]+|["'«»“”‘’]+$/g, '');

  // Quita markdown (asteriscos, guiones bajos)
  text = text.replace(/^\*+|\*+$/g, '');
  text = text.replace(/^_+|_+$/g, '');

  // Colapsa espacios
  text = text.replace(/\s+/g, ' ').trim();

  return text;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms).unref?.());
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
    lastError: state.lastError,
    lastRawResponse: state.lastRawResponse,
    lastSuccessfulText: state.lastSuccessfulText,
    ...state,
  };
}
