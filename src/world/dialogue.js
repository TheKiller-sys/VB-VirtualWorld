// src/world/dialogue.js
// Orquestador de diálogos entre entidades.
//
// CAMBIOS V2.0.0 (conversaciones continuadas):
//   - [FEAT] Lee el historial de la DB antes de generar.
//   - [FEAT] Pasa el historial al LLM para conversación continua.
//   - [FIX] Caché por PAR de entidades.

import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { dialogueCache } from '../cerebro/dialogueCache.js';
import { generateDialogueWithLLM, canCallLLM } from '../cerebro/llmDialogue.js';
import { registerEncounter } from '../cerebro/communityBridge.js';
import { DialogueRepo } from '../persistence/repository.js';

const log = logger.child('dialogue');

// ============================================================
// Plantillas (fallback offline)
// ============================================================

const EMOTION_DIALOGUES = {
  alegria: {
    opener: ['Qué bueno encontrarte de nuevo por aquí.', 'Hoy el mundo se siente distinto, ¿no crees?', 'Tenía ganas de hablar con alguien.'],
    responder: ['Contigo siempre es más fácil.', 'Me alegra coincidir.', 'Cuéntame algo, lo que sea.'],
    follower: ['Sigamos un rato más.', 'Me gusta cómo ves las cosas.', 'Ojalá esto dure.'],
  },
  tristeza: {
    opener: ['A veces me pregunto si todo esto importa...', 'Hoy me pesa la existencia.', 'No sé, hay días que cuestan más.'],
    responder: ['Te entiendo, yo también lo siento.', 'A veces es solo estar, ¿no?', 'No tienes que explicarte.'],
    follower: ['Gracias por escucharme.', 'A veces basta con no estar solo.', 'Contigo es más llevadero.'],
  },
  miedo: {
    opener: ['¿No sientes que algo va a cambiar?', 'Hay algo que no me cuadra.', 'Tengo una inquietud que no sé nombrar.'],
    responder: ['Yo también lo percibo.', 'No estás solo en esto.', 'Respira, estamos juntos.'],
    follower: ['Quédate cerca, por favor.', 'Mejor no separarse.', 'Gracias por estar.'],
  },
  ira: {
    opener: ['No entiendo cómo pueden hacer eso.', 'Algo debería cambiar aquí.', 'Estoy harto de esperar.'],
    responder: ['Yo también lo veo mal.', 'Cuéntame, te escucho.', 'Es injusto, tienes razón.'],
    follower: ['Al menos no estamos solos.', 'Hagamos algo al respecto.', 'Se me va pasando.'],
  },
  ansiedad: {
    opener: ['No puedo dejar de pensar.', '¿Y si nos equivocamos?', 'Todo se mueve demasiado rápido.'],
    responder: ['Respira. Estoy aquí.', 'Vamos por partes.', 'Yo también me siento así a veces.'],
    follower: ['Gracias por calmarme.', 'Hablar ayuda, ¿sabes?', 'Contigo es más fácil.'],
  },
  calma: {
    opener: ['Qué tranquilo está todo hoy.', 'Me gusta estar aquí contigo.', 'No necesito nada más ahora.'],
    responder: ['Yo también lo siento.', 'Es agradable este momento.', 'Podemos quedarnos un rato.'],
    follower: ['Sigamos aquí.', 'Sin prisa.', 'Quédate un poco más.'],
  },
  curiosidad: {
    opener: ['¿Qué piensas de todo esto?', 'Tengo una pregunta para ti.', '¿Alguna vez te has preguntado por qué existimos?'],
    responder: ['Buena pregunta, déjame pensar.', 'Me encanta que preguntes eso.', 'Nunca lo había visto así.'],
    follower: ['Podríamos hablar horas de esto.', 'Me gusta cómo piensas.', 'Sigamos explorando.'],
  },
  nostalgia: {
    opener: ['A veces recuerdo cosas que no viví.', '¿Te pasa que el pasado vuelve?', 'Hay momentos que no se olvidan.'],
    responder: ['Yo también los recuerdo.', 'El tiempo no borra todo.', 'Hay cosas que quedan.'],
    follower: ['Gracias por compartirlo.', 'Los dos llevamos algo dentro.', 'Sigamos recordando.'],
  },
  sorpresa: {
    opener: ['¡No me esperaba encontrarte aquí!', '¡Qué casualidad!', 'Justo pensaba en ti.'],
    responder: ['¡Yo tampoco!', 'Qué cosas tiene la existencia.', 'Me alegra verte.'],
    follower: ['Cuéntame qué ha sido de ti.', 'Esto merece una charla.', '¿Nos vemos más seguido?'],
  },
  gratitud: {
    opener: ['Gracias por estar.', 'No sé qué haría sin ti.', 'Qué bueno coincidir contigo.'],
    responder: ['Gracias a ti.', 'Es mutuo, ¿sabes?', 'Yo también lo siento así.'],
    follower: ['Sigamos aquí un rato.', 'Aprecio este momento.', 'Me haces bien.'],
  },
  confusion: {
    opener: ['No entiendo nada de lo que pasa.', 'A veces todo es un ruido.', '¿Tú también lo sientes así?'],
    responder: ['Yo también, no te preocupes.', 'Podemos intentar ordenarlo juntos.', 'Está bien no entender.'],
    follower: ['Gracias por no juzgarme.', 'Contigo es más claro.', 'Mejor así.'],
  },
  neutral: {
    opener: ['Qué raro encontrarnos por aquí.', 'Justo pensaba en lo mismo.', '¿Tienes un momento?'],
    responder: ['Claro, dime.', 'Te escucho.', 'Vale, cuéntame.'],
    follower: ['Sigamos con esto.', 'Me gusta esta conversación.', 'Nos vemos pronto.'],
  },
};

// ============================================================
// API principal
// ============================================================

/**
 * Genera un diálogo entre dos entidades.
 * @returns {Promise<{ messages, source, dialogueId }>}
 */
export async function generateDialogue(a, b) {
  let messages = null;
  let source = 'template';

  // ------------------------------------------------------------
  // 1. Leer historial de diálogos previos entre A y B
  // ------------------------------------------------------------
  let history = [];
  try {
    history = DialogueRepo.listByPair(a.id, b.id, 5);
  } catch (err) {
    log.debug(`No se pudo leer historial: ${err.message}`);
  }

  const hasHistory = history.length > 0;

  // ------------------------------------------------------------
  // 2. Intentar LLM CON contexto (el historial es clave)
  // ------------------------------------------------------------
  if (canCallLLM()) {
    try {
      const llmMessages = await generateDialogueWithLLM(a, b, history);
      if (llmMessages && llmMessages.length >= 2) {
        messages = llmMessages;
        source = 'llm';
      }
    } catch (err) {
      log.warn(`LLM falló: ${err.message}`);
    }
  } else {
    log.debug(`LLM no disponible (rate-limited o deshabilitado)`);
  }

  // ------------------------------------------------------------
  // 3. Fallback a caché del PAR
  // ------------------------------------------------------------
  if (!messages) {
    const cacheKey = dialogueCache.constructor.key(a, b);
    const cached = dialogueCache.get(cacheKey);

    if (cached) {
      messages = reorderFor(a, b, cached);
      source = 'cache';
      log.debug(`Cache hit (par): ${a.id.slice(-6)}↔${b.id.slice(-6)}`);
    }
  }

  // ------------------------------------------------------------
  // 4. Fallback final a plantillas
  // ------------------------------------------------------------
  if (!messages) {
    messages = generateFromTemplates(a, b, hasHistory);
    source = 'template';

    log.warn(
      `📝 PLANTILLAS para ${a.id.slice(-6)}↔${b.id.slice(-6)} ` +
      `(LLM no disponible)`
    );

    // Cachea el resultado de plantillas por par
    const cacheKey = dialogueCache.constructor.key(a, b);
    dialogueCache.set(cacheKey, messages);
  }

  // ------------------------------------------------------------
  // 5. Persistir en DB
  // ------------------------------------------------------------
  let dialogueId = null;
  try {
    dialogueId = DialogueRepo.insert({
      aId: a.id,
      bId: b.id,
      source,
      messages,
      startedAt: Date.now(),
    });
  } catch (err) {
    log.debug(`Persistir diálogo falló: ${err.message}`);
  }

  return { messages, source, dialogueId };
}

/**
 * Registra el encuentro en el communityProtocol (si está habilitado).
 */
export function notifyCommunity(a, b, meta = {}) {
  if (!env.communityProtocolEnabled) return;
  try {
    registerEncounter(a, b, meta);
  } catch (err) {
    log.debug(`communityProtocol notify falló: ${err.message}`);
  }
}

// ============================================================
// Plantillas
// ============================================================

function generateFromTemplates(a, b, hasHistory = false) {
  const dA = EMOTION_DIALOGUES[a.dominantEmotion] || EMOTION_DIALOGUES.neutral;
  const dB = EMOTION_DIALOGUES[b.dominantEmotion] || EMOTION_DIALOGUES.neutral;

  const sim = a.similarityTo ? a.similarityTo(b) : 0.5;
  const length = 2 + Math.round(sim * 1.5);

  const messages = [];
  let delay = 0;

  // Si ya se conocen, no usamos "opener" genérico
  const opener = hasHistory ? pickRandom(dA.follower) : pickRandom(dA.opener);

  messages.push({
    entityId: a.id,
    text: opener,
    delayMs: 0,
    durationMs: estimateDuration(opener),
  });

  if (length >= 2) {
    delay = 1200 + Math.random() * 800;
    const text = pickRandom(dB.responder);
    messages.push({
      entityId: b.id,
      text,
      delayMs: Math.round(delay),
      durationMs: estimateDuration(text),
    });
  }

  if (length >= 3) {
    delay += 1200 + Math.random() * 1000;
    const text = pickRandom(dA.follower);
    messages.push({
      entityId: a.id,
      text,
      delayMs: Math.round(delay),
      durationMs: estimateDuration(text),
    });
  }

  return messages;
}

function reorderFor(a, b, cachedMessages) {
  if (!Array.isArray(cachedMessages) || cachedMessages.length === 0) {
    return cachedMessages;
  }

  const hasA = cachedMessages.some(m => m.entityId === a.id);
  const hasB = cachedMessages.some(m => m.entityId === b.id);
  if (hasA || hasB) return cachedMessages;

  const firstEntityId = cachedMessages[0].entityId;
  return cachedMessages.map(m => ({
    ...m,
    entityId: m.entityId === firstEntityId ? a.id : b.id,
  }));
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function estimateDuration(text) {
  const ms = text.length * 80;
  return Math.max(3000, Math.min(7000, ms));
}

export { generateFromTemplates as generateExchange };
export const EMOTIONS = EMOTION_DIALOGUES;
