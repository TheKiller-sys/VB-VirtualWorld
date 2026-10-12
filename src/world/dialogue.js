// src/world/dialogue.js
// Orquestador de diálogos entre entidades.
//
// Estrategia:
//   1. Intenta cache → si hit, usa cache
//   2. Si LLM disponible → genera con LLM y guarda en cache
//   3. Fallback a plantillas si LLM no disponible
//
// Mantiene el repertorio de plantillas como fallback offline.

import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { dialogueCache } from '../cerebro/dialogueCache.js';
import { generateDialogueWithLLM, canCallLLM } from '../cerebro/llmDialogue.js';
import { registerEncounter } from '../cerebro/communityBridge.js';

const log = logger.child('dialogue');

// ============================================================
// Plantillas (fallback offline)
// ============================================================

const EMOTION_DIALOGUES = {
  alegria: {
    opener: ['¡Qué buen día para existir!', '¡Hola! Me alegra verte.', 'Hoy todo se siente ligero.'],
    responder: ['¡Contigo siempre es mejor!', 'Me contagias tu energía.', 'Qué bien encontrarte así.'],
    follower: ['Sigamos un rato más.', 'Me gusta cómo piensas.', 'Ojalá esto dure.'],
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
    opener: ['Hola.', '¿Cómo estás?', '¿Qué haces por aquí?'],
    responder: ['Bien, aquí ando.', 'Pensando, como siempre.', 'Todo tranquilo, ¿y tú?'],
    follower: ['Bueno, sigamos.', 'Un gusto hablar contigo.', 'Nos vemos por ahí.'],
  },
};

// ============================================================
// API principal
// ============================================================

/**
 * Genera un diálogo entre dos entidades.
 * @returns {Promise<{ messages: Array, source: 'llm'|'cache'|'template' }>}
 */
export async function generateDialogue(a, b) {
  // 1. Intenta cache
  const cacheKey = dialogueCache.constructor.key(a, b);
  const cached = dialogueCache.get(cacheKey);
  if (cached) {
    log.debug(`Cache hit: ${cacheKey}`);
    return {
      messages: reorderFor(a, b, cached),
      source: 'cache',
    };
  }

  // 2. Intenta LLM
  if (canCallLLM()) {
    try {
      const messages = await generateDialogueWithLLM(a, b);
      if (messages && messages.length >= 2) {
        dialogueCache.set(cacheKey, messages);
        return { messages, source: 'llm' };
      }
    } catch (err) {
      log.debug(`LLM falló, usando plantillas: ${err.message}`);
    }
  }

  // 3. Fallback a plantillas
  return {
    messages: generateFromTemplates(a, b),
    source: 'template',
  };
}

/**
 * Registra el encuentro en el communityProtocol (si está habilitado).
 * Fire-and-forget.
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

function generateFromTemplates(a, b) {
  const dA = EMOTION_DIALOGUES[a.dominantEmotion] || EMOTION_DIALOGUES.neutral;
  const dB = EMOTION_DIALOGUES[b.dominantEmotion] || EMOTION_DIALOGUES.neutral;

  const sim = a.similarityTo ? a.similarityTo(b) : 0.5;
  const length = 2 + Math.round(sim * 1.5);

  const messages = [];
  let delay = 0;

  messages.push({
    entityId: a.id,
    text: pickRandom(dA.opener),
    delayMs: 0,
    durationMs: 0,
  });
  messages[messages.length - 1].durationMs = estimateDuration(messages[messages.length - 1].text);

  if (length >= 2) {
    delay = 1200 + Math.random() * 800;
    messages.push({
      entityId: b.id,
      text: pickRandom(dB.responder),
      delayMs: Math.round(delay),
      durationMs: 0,
    });
    messages[messages.length - 1].durationMs = estimateDuration(messages[messages.length - 1].text);
  }

  if (length >= 3) {
    delay += 1200 + Math.random() * 1000;
    messages.push({
      entityId: a.id,
      text: pickRandom(dA.follower),
      delayMs: Math.round(delay),
      durationMs: 0,
    });
    messages[messages.length - 1].durationMs = estimateDuration(messages[messages.length - 1].text);
  }

  return messages;
}

/**
 * Reordena los mensajes del cache si A y B están en orden inverso.
 * El cache guarda mensajes con IDs de una instancia previa; aquí
 * los remapeamos a las entidades actuales según la posición en el diálogo.
 */
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
