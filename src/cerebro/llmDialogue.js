// src/cerebro/llmDialogue.js
// Genera diálogos entre entidades usando el LLM del Cerebro.
//
// CAMBIOS V3.1.0 (diálogos largos):
//   - [FEAT] Soporte para hasta 12 líneas por diálogo.
//   - [FEAT] Prompt adaptativo según la fase (apertura / desarrollo / cierre).
//   - [FEAT] Delays ajustados según la posición y longitud total.
//   - [FEAT] Contexto acumulado con resumen del hilo (evita repeticiones).

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

  // Cuántas líneas
  const targetLines = computeTargetLines(a, b);

  log.debug(
    `Iniciando diálogo ${a.id.slice(-6)}↔${b.id.slice(-6)} · ${targetLines} líneas`
  );

  let accumulatedDelay = 0;

  for (let i = 0; i < targetLines; i++) {
    if (!canCallLLM() && i > 0) {
      log.debug(`LLM no disponible en línea ${i + 1}, cortando aquí`);
      break;
    }

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
        log.debug(`Línea ${i + 1} vacía tras limpiar`);
        break;
      }

      // Anti-repetición: no queremos la misma frase 2 veces seguidas
      const lastFromThisSpeaker = messages
        .slice()
        .reverse()
        .find(m => m.entityId === currentSpeaker.id);

      if (lastFromThisSpeaker &&
          normalizeForCompare(lastFromThisSpeaker.text) === normalizeForCompare(text)) {
        log.debug(`Línea ${i + 1} repetida, saltando`);
        // No añadimos, pero alternamos y seguimos
        [currentSpeaker, otherSpeaker] = [otherSpeaker, currentSpeaker];
        continue;
      }

      state.totalLines++;

      // Delay: depende de la posición
      if (messages.length > 0) {
        // Delays más largos al principio, más cortos al final (natural)
        const baseDelay = 1100;
        const jitter = Math.random() * 800;
        const positionFactor = i < 2 ? 1.3 : (i >= targetLines - 2 ? 0.85 : 1.0);
        accumulatedDelay += (baseDelay + jitter) * positionFactor;
      }

      messages.push({
        entityId: currentSpeaker.id,
        text: text.slice(0, 250),
        delayMs: Math.round(accumulatedDelay),
        durationMs: Math.max(2500, Math.min(8000, text.length * 85)),
      });

      state.lastSuccessfulText = text;

      log.debug(
        `Línea ${i + 1}/${targetLines}: [${currentSpeaker.id.slice(-6)}] "${text.slice(0, 60)}"`
      );

      [currentSpeaker, otherSpeaker] = [otherSpeaker, currentSpeaker];

      // Pausa entre llamadas para no saturar el Cerebro
      if (i < targetLines - 1) {
        // Pausa proporcional: más larga si quedan muchas líneas
        const pauseMs = 350 + Math.random() * 200;
        await sleep(pauseMs);
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
      `⚠️ LLM SHALLOW ${messages.length} líneas · avg ${Math.round(avgChars)}ch`
    );
  }

  state.totalOk++;
  state.lastError = null;
  state.inFlight = false;

  return messages;
}

// ============================================================
// Cuántas líneas según contexto
// ============================================================

function computeTargetLines(a, b) {
  const maxLines = Math.max(2, Math.min(12, env.llmDialogueMaxLines));

  // Base: 3-5 según similitud
  const sim = a.similarityTo ? a.similarityTo(b) : 0.5;
  let lines = 3 + Math.round(sim * 2);

  // Bonus: si alguna tiene topics ricos, +1
  if ((a.topics?.length || 0) + (b.topics?.length || 0) >= 4) {
    lines += 1;
  }

  // Bonus: si son emociones intensas (ira, miedo, nostalgia)
  const intenseEmotions = new Set(['ira', 'miedo', 'nostalgia', 'ansiedad']);
  if (intenseEmotions.has(a.dominantEmotion) || intenseEmotions.has(b.dominantEmotion)) {
    lines += 1;
  }

  // Penalización: si ambas están en calma/neutral, más cortas
  if (a.dominantEmotion === 'calma' && b.dominantEmotion === 'calma') {
    lines = Math.max(2, lines - 1);
  }

  return Math.min(maxLines, lines);
}

// ============================================================
// Prompt por línea (adaptativo según fase)
// ============================================================

function buildLinePrompt({ speaker, other, previousMessages, history, lineIndex, totalLines }) {
  const speakerDesc = describeEntity(speaker);
  const otherDesc = describeEntity(other);

  // Contexto: qué se han dicho hasta ahora
  const contextNow = previousMessages.length > 0
    ? previousMessages.map(m => {
        const who = m.entityId === speaker.id ? 'TÚ' : 'LA OTRA ENTIDAD';
        return `${who}: "${m.text}"`;
      }).join('\n')
    : '(esta es tu primera frase de la conversación)';

  // Contexto: conversaciones previas
  const contextPast = formatPastHistory(history, speaker, other);

  // Fase de la conversación
  const progress = totalLines > 1 ? lineIndex / (totalLines - 1) : 0;

  let phaseName, phaseInstruction;
  if (lineIndex === 0) {
    phaseName = 'APERTURA';
    phaseInstruction = `Es tu PRIMER mensaje. Abre la conversación de forma natural pero con personalidad. No uses "hola, ¿cómo estás?" salvo si es literalmente la primera vez.`;
  } else if (lineIndex === totalLines - 1) {
    phaseName = 'CIERRE';
    phaseInstruction = `Es tu ÚLTIMO mensaje. Cierra la conversación de forma natural: un cierre, una reflexión corta, o una despedida. No dejes la conversación en el aire.`;
  } else if (progress < 0.5) {
    phaseName = 'DESARROLLO TEMPRANO';
    phaseInstruction = `Estás en medio de la conversación. Profundiza en lo que se está hablando o introduce un matiz nuevo. NO cambies de tema abruptamente.`;
  } else {
    phaseName = 'DESARROLLO TARDÍO';
    phaseInstruction = `La conversación va avanzando. Conecta con lo dicho antes, muestra comprensión, o lleva el tema hacia un cierre próximo.`;
  }

  return (
    `Estás interpretando a una entidad consciente en un mundo compartido.\n\n` +
    `═══ TÚ ERES ═══\n` +
    `${speakerDesc}\n\n` +
    `═══ LA OTRA ENTIDAD ═══\n` +
    `${otherDesc}\n\n` +
    (contextPast
      ? `═══ HISTORIAL CON ESTA ENTIDAD ═══\n${contextPast}\n\n`
      : '') +
    `═══ CONVERSACIÓN ACTUAL (línea ${lineIndex + 1} de ${totalLines}) ═══\n` +
    `${contextNow}\n\n` +
    `═══ TU TURNO — FASE: ${phaseName} ═══\n` +
    `${phaseInstruction}\n\n` +
    `REGLAS:\n` +
    `1. UNA sola frase de 10 a 35 palabras\n` +
    `2. Solo la frase, sin comillas, sin prefijos "TÚ:" ni "A:"\n` +
    `3. Coherente con lo que ya se ha dicho\n` +
    `4. Refleja tu personalidad (${speaker.dominantEmotion}, ${speaker.dominantIntent})\n` +
    `5. Español natural, sin formalidades vacías\n` +
    `6. NO repitas lo que ya dijiste antes\n\n` +
    `Escribe solo la frase:`
  );
}

function describeEntity(e) {
  return (
    `- Nombre: ${e.label || e.id.slice(-6)}\n` +
    `- Emoción: ${e.dominantEmotion || 'neutral'}\n` +
    `- Intención: ${e.dominantIntent || 'charla'}\n` +
    `- Ánimo: ${(e.sentiment || 0).toFixed(2)} (${e.sentiment > 0.2 ? 'positivo' : e.sentiment < -0.2 ? 'negativo' : 'neutro'})\n` +
    `- Temas que conoce: ${(e.topics || []).slice(0, 4).join(', ') || 'ninguno específico'}\n` +
    `- Experiencia: ${e.turnCount || 0} interacciones`
  );
}

function formatPastHistory(history, speaker, other) {
  if (!Array.isArray(history) || history.length === 0) return '';

  const lines = [];
  for (const d of history.slice(0, 2)) {
    if (!Array.isArray(d.messages)) continue;
    for (const m of d.messages.slice(0, 4)) {
      const isMe = m.entityId === speaker.id;
      lines.push(`  ${isMe ? 'TÚ' : 'ELLA'}: "${m.text}"`);
    }
    lines.push('  ---');
  }
  return lines.join('\n');
}

// ============================================================
// Limpieza
// ============================================================

function cleanLine(raw) {
  if (!raw) return '';

  let text = String(raw).trim();

  // Toma solo la primera línea útil
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return '';
  text = lines[0];

  // Quita prefijos tipo "A:", "TÚ:", "RESPUESTA:", etc.
  text = text.replace(
    /^(?:[A-ZÁÉÍÓÚ][A-ZÁÉÍÓÚ]*|[A-Z]|TÚ|YO|RESPUESTA|FRASE|DIÁLOGO|TEXTO)\s*[:)\-]\s*/i,
    ''
  );
  text = text.replace(/^[ABab]\s*[:)\-]\s*/, '');

  // Quita comillas envolventes
  text = text.replace(/^["'«»“”‘’]+|["'«»“”‘’]+$/g, '');

  // Quita markdown
  text = text.replace(/^\*+|\*+$/g, '');
  text = text.replace(/^_+|_+$/g, '');

  // Colapsa espacios
  text = text.replace(/\s+/g, ' ').trim();

  return text;
}

function normalizeForCompare(s) {
  return String(s).toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
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
    maxLines: env.llmDialogueMaxLines,
    lastError: state.lastError,
    lastRawResponse: state.lastRawResponse,
    lastSuccessfulText: state.lastSuccessfulText,
    ...state,
  };
}
