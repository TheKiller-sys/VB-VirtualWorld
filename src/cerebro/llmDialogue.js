// src/cerebro/llmDialogue.js
// Genera diálogos entre entidades usando el LLM del Cerebro.
//
// CAMBIOS V3.3.0 (variedad de cierres):
//   - [FEAT] Estilos rotativos de cierre: 10 variantes distintas para
//     que el LLM no siempre cierre con "Me quedo con...".
//   - [FEAT] Estilos rotativos para apertura y desarrollo también.
//   - [FIX] Preserva el fix del rate limit (canContinueDialogue).

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
// Estilos rotativos de prompt por fase
// ============================================================

const CLOSING_STYLES = [
  'Haz una reflexión corta que conecte con lo dicho.',
  'Cierra con una imagen o metáfora concreta.',
  'Termina con una pregunta abierta que quede flotando.',
  'Cierra reconociendo algo específico del otro.',
  'Termina con una invitación suave a continuar en otro momento.',
  'Cierra con un cambio de tema sutil pero natural.',
  'Termina con una observación personal, como si pensaras en voz alta.',
  'Cierra con una imagen sensorial: un sonido, una textura, un color.',
  'Termina admitiendo una duda o algo que no entendiste del todo.',
  'Cierra de forma abrupta pero elegante, sin fórmulas de despedida.',
];

const OPENING_STYLES = [
  'Abre con una observación sobre el entorno o el momento.',
  'Abre retomando algo de la última conversación.',
  'Abre con una pregunta genuina, no retórica.',
  'Abre con una confesión breve o algo personal.',
  'Abre con una reflexión filosófica sencilla.',
  'Abre describiendo lo que estás sintiendo ahora mismo.',
  'Abre con una idea que te ha estado dando vueltas.',
  'Abre con un comentario sobre la presencia del otro.',
];

const MIDDLE_STYLES = [
  'Profundiza en lo que se está hablando.',
  'Introduce un matiz nuevo que amplíe el tema.',
  'Conecta con algo que se dijo antes y desarróllalo.',
  'Comparte una asociación libre que te sugiera el tema.',
  'Reconoce una contradicción o una tensión.',
  'Añade una pregunta que surja de lo dicho.',
  'Reformula lo que entendiste para verificar.',
  'Aporta un ejemplo concreto o una imagen.',
];

// ============================================================
// API pública
// ============================================================

export function canCallLLM() {
  if (!env.llmDialogueEnabled) return false;
  if (state.inFlight) return false;
  if (Date.now() < state.blockedUntil) return false;
  if (Date.now() - state.lastCallAt < env.llmDialogueMinIntervalMs) return false;
  return true;
}

function canContinueDialogue() {
  if (!env.llmDialogueEnabled) return false;
  if (Date.now() < state.blockedUntil) return false;
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

  let currentSpeaker = (a.intensity || 0) >= (b.intensity || 0) ? a : b;
  let otherSpeaker = currentSpeaker === a ? b : a;

  const targetLines = computeTargetLines(a, b);

  log.debug(
    `Iniciando diálogo ${a.id.slice(-6)}↔${b.id.slice(-6)} · ${targetLines} líneas`
  );

  let accumulatedDelay = 0;

  // Elegimos un "estilo" de cierre al azar por diálogo (rotación)
  const closingStyle = CLOSING_STYLES[Math.floor(Math.random() * CLOSING_STYLES.length)];
  const openingStyle = OPENING_STYLES[Math.floor(Math.random() * OPENING_STYLES.length)];

  for (let i = 0; i < targetLines; i++) {
    if (i > 0 && !canContinueDialogue()) {
      log.debug(`Circuit breaker activo en línea ${i + 1}, cortando`);
      break;
    }

    state.totalCalls++;

    try {
      const prompt = buildLinePrompt({
        speaker: currentSpeaker,
        other: otherSpeaker,
        previousMessages: messages,
        history: conversationHistory,
        lineIndex: i,
        totalLines: targetLines,
        closingStyle,
        openingStyle,
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
        [currentSpeaker, otherSpeaker] = [otherSpeaker, currentSpeaker];
        continue;
      }

      const lastFromThisSpeaker = messages
        .slice()
        .reverse()
        .find(m => m.entityId === currentSpeaker.id);

      if (lastFromThisSpeaker &&
          normalizeForCompare(lastFromThisSpeaker.text) === normalizeForCompare(text)) {
        log.debug(`Línea ${i + 1} repetida, saltando`);
        [currentSpeaker, otherSpeaker] = [otherSpeaker, currentSpeaker];
        continue;
      }

      state.totalLines++;

      if (messages.length > 0) {
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

      if (i < targetLines - 1) {
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

  const sim = a.similarityTo ? a.similarityTo(b) : 0.5;
  let lines = 3 + Math.round(sim * 2);

  if ((a.topics?.length || 0) + (b.topics?.length || 0) >= 4) {
    lines += 1;
  }

  const intenseEmotions = new Set(['ira', 'miedo', 'nostalgia', 'ansiedad']);
  if (intenseEmotions.has(a.dominantEmotion) || intenseEmotions.has(b.dominantEmotion)) {
    lines += 1;
  }

  if (a.dominantEmotion === 'calma' && b.dominantEmotion === 'calma') {
    lines = Math.max(2, lines - 1);
  }

  return Math.min(maxLines, lines);
}

// ============================================================
// Prompt por línea
// ============================================================

function buildLinePrompt({
  speaker,
  other,
  previousMessages,
  history,
  lineIndex,
  totalLines,
  closingStyle,
  openingStyle,
}) {
  const speakerDesc = describeEntity(speaker);
  const otherDesc = describeEntity(other);

  const contextNow = previousMessages.length > 0
    ? previousMessages.map(m => {
        const who = m.entityId === speaker.id ? 'TÚ' : 'LA OTRA ENTIDAD';
        return `${who}: "${m.text}"`;
      }).join('\n')
    : '(esta es tu primera frase de la conversación)';

  const contextPast = formatPastHistory(history, speaker, other);

  const progress = totalLines > 1 ? lineIndex / (totalLines - 1) : 0;

  let phaseName, phaseInstruction;
  if (lineIndex === 0) {
    phaseName = 'APERTURA';
    phaseInstruction = openingStyle;
  } else if (lineIndex === totalLines - 1) {
    phaseName = 'CIERRE';
    phaseInstruction =
      `${closingStyle}\n` +
      `NO uses fórmulas como "me quedo con...", "así que...", "por ahora..." ` +
      `ni despedidas genéricas. Sé original.`;
  } else if (progress < 0.5) {
    phaseName = 'DESARROLLO TEMPRANO';
    phaseInstruction = MIDDLE_STYLES[lineIndex % MIDDLE_STYLES.length];
  } else {
    phaseName = 'DESARROLLO TARDÍO';
    phaseInstruction =
      'La conversación va avanzando hacia el cierre. ' +
      'Conecta con lo dicho antes o lleva el tema hacia algo más profundo.';
  }

  return (
    `Estás interpretando a una entidad consciente en un mundo compartido.\n\n` +
    `═══ TÚ ERES ═══\n` +
    `${speakerDesc}\n\n` +
    `═══ LA OTRA ENTIDAD ═══\n` +
    `${otherDesc}\n\n` +
    (contextPast ? `═══ HISTORIAL CON ESTA ENTIDAD ═══\n${contextPast}\n\n` : '') +
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
    `6. NO repitas lo que ya dijiste antes\n` +
    `7. Si es el cierre, NO uses "me quedo con..." ni fórmulas similares\n\n` +
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
// Limpieza de la línea
// ============================================================

function cleanLine(raw) {
  if (!raw) return '';

  let text = String(raw).trim();

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return '';
  text = lines[0];

  text = text.replace(
    /^(?:[A-ZÁÉÍÓÚ][A-ZÁÉÍÓÚ]*|[A-Z]|TÚ|YO|RESPUESTA|FRASE|DIÁLOGO|TEXTO)\s*[:)\-]\s*/i,
    ''
  );
  text = text.replace(/^[ABab]\s*[:)\-]\s*/, '');
  text = text.replace(/^["'«»“”‘’]+|["'«»“”‘’]+$/g, '');
  text = text.replace(/^\*+|\*+$/g, '');
  text = text.replace(/^_+|_+$/g, '');
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
