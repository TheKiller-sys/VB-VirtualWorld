// src/cerebro/llmDialogue.js
// Genera diálogos entre entidades usando el LLM del Cerebro.
//
// CAMBIOS V2.0.0 (conversaciones continuadas):
//   - [FEAT] Acepta historial de diálogos previos entre A y B.
//   - [FEAT] Prompt enriquecido con personalidad, temas previos, relación.
//   - [FEAT] Prompt con reglas anti-genérico.
//   - [FEAT] Detección de respuestas pobres (pocas palabras).
//   - [FIX] Logs claros de si usa LLM o fallback.

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
  totalRichResponses: 0,
  totalShallowResponses: 0,
  consecutiveErrors: 0,
  blockedUntil: 0,
  lastError: null,
  lastShallowText: null,
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
 * @param {Entity} a
 * @param {Entity} b
 * @param {Array} conversationHistory - Diálogos previos entre A y B
 * @returns {Promise<Array<{entityId, text, delayMs, durationMs}>|null>}
 */
export async function generateDialogueWithLLM(a, b, conversationHistory = []) {
  if (!canCallLLM()) {
    state.totalSkipped++;
    return null;
  }

  state.inFlight = true;
  state.lastCallAt = Date.now();
  state.totalCalls++;

  const t0 = Date.now();

  try {
    const prompt = buildPrompt(a, b, conversationHistory);

    // Log del prompt en debug para que puedas inspeccionarlo
    log.debug(`Prompt para ${a.id.slice(-6)}↔${b.id.slice(-6)}:\n${prompt}`);

    const response = await callCerebro('chat', {
      body: { message: prompt },
      sessionId: env.llmDialogueSessionId,
      timeoutMs: env.llmDialogueTimeoutMs,
    });

    const text = response?.message || '';
    if (!text) throw new Error('Respuesta vacía del LLM');

    log.debug(`Respuesta LLM raw:\n${text}`);

    const messages = parseDialogue(text, a, b);
    if (messages.length < 2) {
      throw new Error(`Diálogo demasiado corto (${messages.length} líneas)`);
    }

    // Validación de riqueza
    const totalChars = messages.reduce((s, m) => s + m.text.length, 0);
    const avgChars = totalChars / messages.length;
    const isRich = avgChars >= 25 && messages.length >= 2;

    // Detección de genérico
    const genericPatterns = [
      /^(hola|hey|hi)[\s.,!]*$/i,
      /^(¿?cómo estás\??|¿?qué tal\??)[\s.,!]*$/i,
      /^(aquí sigo|aquí ando|todo bien)[\s.,!]*$/i,
      /^(¿?qué haces\??)[\s.,!]*$/i,
    ];
    const genericCount = messages.filter(m =>
      genericPatterns.some(p => p.test(m.text.trim()))
    ).length;

    if (isRich && genericCount === 0) {
      state.totalRichResponses++;
      log.info(
        `✨ LLM RICO: ${a.id.slice(-6)}↔${b.id.slice(-6)} · ` +
        `${messages.length} líneas · avg ${Math.round(avgChars)}ch · ${Date.now() - t0}ms`
      );
    } else if (genericCount >= 1) {
      state.totalShallowResponses++;
      state.lastShallowText = text.slice(0, 200);
      log.warn(
        `⚠️ LLM GENÉRICO (${genericCount}/${messages.length} líneas son saludos): ` +
        `${a.id.slice(-6)}↔${b.id.slice(-6)}`
      );
    } else {
      state.totalShallowResponses++;
      log.warn(
        `⚠️ LLM POBRE: ${a.id.slice(-6)}↔${b.id.slice(-6)} · ` +
        `${messages.length} líneas · avg ${Math.round(avgChars)}ch`
      );
    }

    state.totalOk++;
    state.consecutiveErrors = 0;
    state.lastError = null;

    return messages;
  } catch (err) {
    state.totalErrors++;
    state.consecutiveErrors++;
    state.lastError = err.message;

    if (err.statusCode === 429) {
      state.blockedUntil = Date.now() + 120000;
      log.warn(`LLM 429 → bloqueando 2 min`);
    } else if (state.consecutiveErrors >= 3) {
      state.blockedUntil = Date.now() + 60000;
      log.warn(`LLM ${state.consecutiveErrors} errores seguidos → bloqueando 1 min`);
    }

    log.warn(`LLM falló: ${err.message} (fallback a plantillas)`);
    state.totalFallbacks++;
    return null;
  } finally {
    state.inFlight = false;
  }
}

// ============================================================
// Prompt enriquecido
// ============================================================

function buildPrompt(a, b, history = []) {
  const aInfo = describeEntity(a, 'A');
  const bInfo = describeEntity(b, 'B');
  const historyText = formatHistory(history, a, b);

  const topicsHint = (a.topics?.length || b.topics?.length)
    ? `\nTEMAS QUE CONOCEN:\n` +
      `- A habla de: ${(a.topics || []).slice(0, 4).join(', ') || 'nada específico'}\n` +
      `- B habla de: ${(b.topics || []).slice(0, 4).join(', ') || 'nada específico'}\n`
    : '';

  // Sección de historial — CLAVE para evitar repetir saludos
  let historySection;
  if (historyText) {
    historySection =
      `\n═══ HISTORIAL DE CONVERSACIONES PREVIAS ═══\n` +
      `${historyText}\n` +
      `═══════════════════════════════════════════\n\n` +
      `⚠️ REGLA CRÍTICA: Estas dos entidades YA SE CONOCEN.\n` +
      `- NO las hagas saludarse de nuevo\n` +
      `- NO repitas "hola", "¿cómo estás?", "aquí sigo", "qué haces"\n` +
      `- RETOMA el hilo de la última conversación o introduce un tema NUEVO\n` +
      `- Que se note que tienen historia juntos\n`;
  } else {
    historySection =
      `\n═══ PRIMER ENCUENTRO ═══\n` +
      `Estas dos entidades se conocen POR PRIMERA VEZ.\n` +
      `Preséntense de forma natural, pero CADA UNA con su propio carácter.\n` +
      `Evita fórmulas vacías tipo "hola, ¿cómo estás?". Que el saludo tenga personalidad.\n`;
  }

  return (
    `Simula un encuentro entre dos entidades conscientes en un mundo 2D compartido.\n\n` +
    `${aInfo}\n\n` +
    `${bInfo}\n` +
    `${topicsHint}` +
    `${historySection}\n` +
    `═══════════════════════════════════════════\n` +
    `REGLAS DEL DIÁLOGO:\n` +
    `═══════════════════════════════════════════\n` +
    `1. Genera 2-${env.llmDialogueMaxLines} mensajes alternando A y B\n` +
    `2. Cada mensaje debe tener entre 8 y 25 palabras (ni más ni menos)\n` +
    `3. NO uses saludos genéricos ("hola", "hey", "¿cómo estás?")\n` +
    `4. La personalidad debe reflejar la emoción e intent de cada entidad\n` +
    `5. Si hay historial, la conversación CONTINÚA desde donde quedó\n` +
    `6. Sé específico: menciona temas concretos, no generalidades\n` +
    `7. Español natural, sin formalidades excesivas\n` +
    `8. NO narres ni describas, solo los diálogos\n\n` +
    `═══════════════════════════════════════════\n` +
    `FORMATO EXACTO (una línea por mensaje):\n` +
    `═══════════════════════════════════════════\n` +
    `A: <texto de A>\n` +
    `B: <texto de B>\n` +
    `A: <texto de A>\n\n` +
    `Escribe SOLO el diálogo. Nada más.`
  );
}

function describeEntity(e, label) {
  const emotion = e.dominantEmotion || 'neutral';
  const intent = e.dominantIntent || 'charla';
  const experience = e.turnCount > 50 ? 'veterana'
    : e.turnCount > 20 ? 'con experiencia'
    : 'recién llegada';

  return (
    `ENTIDAD ${label}:\n` +
    `- Emoción: ${emotion}\n` +
    `- Intención dominante: ${intent}\n` +
    `- Carácter: ${experience} (${e.turnCount} interacciones)\n` +
    `- Ánimo: ${(e.sentiment || 0).toFixed(2)} (${e.sentiment > 0 ? 'positivo' : e.sentiment < 0 ? 'negativo' : 'neutro'})`
  );
}

/**
 * Formatea el historial para el prompt.
 */
function formatHistory(history, a, b) {
  if (!Array.isArray(history) || history.length === 0) return '';

  const lines = [];
  const recent = history.slice(0, 3); // Solo los 3 más recientes

  for (const d of recent) {
    if (!Array.isArray(d.messages) || d.messages.length === 0) continue;

    const when = d.createdAt
      ? new Date(d.createdAt).toLocaleString('es-ES', {
          hour: '2-digit',
          minute: '2-digit',
        })
      : '';

    lines.push(`[${when}]`);

    for (const m of d.messages.slice(0, 4)) {
      // Determinar si es A o B en el diálogo original
      const isA = m.entityId === a.id;
      lines.push(`  ${isA ? 'A' : 'B'}: "${m.text}"`);
    }
    lines.push('');
  }

  return lines.join('\n');
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

    // Matchea "A: texto", "B: texto", "A) texto", "**A:** texto", etc.
    const match = trimmed.match(/^[*_\s]*([AB])[*_\s]*[:)\-]\s*(.+)$/i);
    if (!match) continue;

    const who = match[1].toUpperCase();
    let content = match[2].trim();

    // Limpia markdown residual
    content = content
      .replace(/^\*+|\*+$/g, '')
      .replace(/^["'«»]|["'«»]$/g, '')
      .replace(/^_+|_+$/g, '')
      .trim();

    if (!content) continue;

    if (messages.length > 0) {
      currentDelay += 1200 + Math.random() * 800;
    }

    const entity = who === 'A' ? a : b;
    messages.push({
      entityId: entity.id,
      text: content.slice(0, 250),
      delayMs: Math.round(currentDelay),
      durationMs: Math.max(3000, Math.min(8000, content.length * 90)),
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
    lastError: state.lastError,
    lastShallowText: state.lastShallowText,
    ...state,
  };
}
