// src/world/dialogue.js
// Orquestador de diálogos entre entidades.
//
// CAMBIOS V2.3.0 (plantillas expandidas + coherencia de fase):
//   - [FEAT] Plantillas expandidas a 10 openers, 10 responders y 16 followers
//     por emoción → 1600 combinaciones posibles por emoción.
//   - [FIX] Coherencia de fase: si hay historial → opener tipo "retomar";
//     si no → opener tipo "presentarse". Evita "sigamos con esto" en
//     conversaciones nuevas.
//   - [FIX] Las plantillas no se cachean (cada llamada es fresca).
//   - [FIX] Caché solo se usa para respuestas del LLM (no para plantillas).

import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { dialogueCache } from '../cerebro/dialogueCache.js';
import { generateDialogueWithLLM, canCallLLM } from '../cerebro/llmDialogue.js';
import { registerEncounter } from '../cerebro/communityBridge.js';
import { DialogueRepo } from '../persistence/repository.js';

const log = logger.child('dialogue');

// ============================================================
// Plantillas expandidas (fallback offline)
// ============================================================

const EMOTION_DIALOGUES = {
  alegria: {
    opener: [
      'Qué bueno encontrarte de nuevo por aquí.',
      'Hoy el mundo se siente distinto, ¿no crees?',
      'Tenía ganas de hablar con alguien.',
      'Justo pensaba en lo mucho que me gusta este lugar.',
      'Todo parece más ligero hoy.',
      'Hay días que empiezan bien sin motivo.',
      'Contigo siempre pasa algo interesante.',
      'Me alegra verte por aquí.',
      'Qué casualidad, justo andaba buscando compañía.',
      'Este momento se siente mejor contigo.',
    ],
    responder: [
      'Contigo siempre es más fácil.',
      'Me alegra coincidir.',
      'Cuéntame algo, lo que sea.',
      'Hoy me siento igual, ¿sabes?',
      'A mí también me gusta verte.',
      'Es contagiosa tu energía.',
      'Hablemos un rato, si quieres.',
      'Sabía que te encontraría.',
      'Me vienes bien hoy.',
      'Qué bien que coincidamos.',
    ],
    follower: [
      'Sigamos un rato más.',
      'Me gusta cómo ves las cosas.',
      'Ojalá esto dure.',
      'Me quedo con esta sensación.',
      'Otro día repetimos.',
      'Esto merece repetirse.',
      'Gracias por estar.',
      'Nos vemos pronto, espero.',
      'Quédate con este buen ánimo.',
      'Que sigas así.',
      'Me alegró el día.',
      'Cuídate y sonríe.',
      'Hasta la próxima.',
      'Un placer, de verdad.',
      'Sigue contagiando eso.',
      'Nos cruzamos luego.',
    ],
  },
  tristeza: {
    opener: [
      'A veces me pregunto si todo esto importa...',
      'Hoy me pesa la existencia.',
      'No sé, hay días que cuestan más.',
      'No quería estar solo ahora mismo.',
      'Necesitaba decir esto en voz alta.',
      'Perdona si no tengo mucho que decir.',
      'A veces basta con que alguien escuche.',
      'Todo se siente un poco más lento hoy.',
      'Me cuesta encontrarle sentido a las cosas.',
      'Vengo con el ánimo bajo.',
    ],
    responder: [
      'Te entiendo, yo también lo siento.',
      'A veces es solo estar, ¿no?',
      'No tienes que explicarte.',
      'Estoy aquí, si te sirve.',
      'No estás solo en esto.',
      'Cuéntame si quieres.',
      'A mí también me pasa.',
      'A veces también me siento así.',
      'Puedes quedarte conmigo un rato.',
      'No tienes que fingir nada.',
    ],
    follower: [
      'Gracias por escucharme.',
      'A veces basta con no estar solo.',
      'Contigo es más llevadero.',
      'Mejor me quedo un rato.',
      'Te lo agradezco de verdad.',
      'Hablar ayuda, aunque parezca poco.',
      'Nos vemos luego.',
      'Gracias por estar.',
      'Me siento un poco mejor.',
      'No sabes cuánto ayuda esto.',
      'Quédate bien.',
      'Un abrazo si se pudiera.',
      'Nos vemos pronto.',
      'Gracias por no juzgar.',
      'Otro día te cuento más.',
      'Cuídate mucho.',
    ],
  },
  miedo: {
    opener: [
      '¿No sientes que algo va a cambiar?',
      'Hay algo que no me cuadra.',
      'Tengo una inquietud que no sé nombrar.',
      'A veces el mundo se siente raro.',
      'No puedo quitarme una sensación.',
      '¿Has notado algo extraño?',
      'Siento que algo se acerca.',
      'Necesitaba decirlo a alguien.',
      'Me inquieta lo que pueda pasar.',
      'No me siento del todo seguro hoy.',
    ],
    responder: [
      'Yo también lo percibo.',
      'No estás solo en esto.',
      'Respira, estamos juntos.',
      'Cuéntame qué sientes.',
      'Vamos a entenderlo juntos.',
      'Yo también lo he notado.',
      'Hablemos, se pasa mejor.',
      'Estoy contigo.',
      'Dímelo sin miedo.',
      'Aquí me tienes.',
    ],
    follower: [
      'Quédate cerca, por favor.',
      'Mejor no separarse.',
      'Gracias por estar.',
      'Siento que ya es menos.',
      'Hablemos de otra cosa.',
      'Nos quedamos juntos.',
      'Ya me siento un poco mejor.',
      'Hasta luego, cuídate.',
      'Nos vemos, no te alejes mucho.',
      'Cuídate, de verdad.',
      'Gracias por escucharme.',
      'Me quedo más tranquilo.',
      'Nos vemos pronto.',
      'Cuídate y avísame si algo pasa.',
      'Voy a estar atento.',
      'Hasta la próxima.',
    ],
  },
  ira: {
    opener: [
      'No entiendo cómo pueden hacer eso.',
      'Algo debería cambiar aquí.',
      'Estoy harto de esperar.',
      'A veces el mundo es injusto.',
      'Necesitaba desahogarme.',
      'Hay cosas que no trago.',
      'No soporto la indiferencia.',
      'Todo esto me supera.',
      'No puedo con tanta tontería.',
      'Necesito soltarlo de una vez.',
    ],
    responder: [
      'Yo también lo veo mal.',
      'Cuéntame, te escucho.',
      'Es injusto, tienes razón.',
      'Respira, no estás solo.',
      'Yo también me he sentido así.',
      'Entiendo tu rabia.',
      'Dime qué pasó.',
      'Estoy contigo en esto.',
      'Desahógate, aquí estoy.',
      'Es una mierda, sí.',
    ],
    follower: [
      'Al menos no estamos solos.',
      'Hagamos algo al respecto.',
      'Se me va pasando.',
      'Gracias por escucharme.',
      'Contigo es más llevadero.',
      'Mejor lo dejamos aquí.',
      'Nos vemos luego.',
      'Gracias por estar.',
      'Me ayudó soltarlo.',
      'Nos vemos, cuídate.',
      'Gracias, de verdad.',
      'Otro día seguimos.',
      'Cuídate mucho.',
      'Hasta luego.',
      'Cuídate y no dejes que te afecte.',
      'Nos cruzamos luego.',
    ],
  },
  ansiedad: {
    opener: [
      'No puedo dejar de pensar.',
      '¿Y si nos equivocamos?',
      'Todo se mueve demasiado rápido.',
      'Necesito ordenar mis ideas.',
      'No consigo parar la cabeza.',
      '¿A ti te pasa lo mismo?',
      'A veces todo es demasiado.',
      'Perdona, tengo la mente en otro sitio.',
      'No sé por dónde empezar.',
      'Siento que todo se me escapa.',
    ],
    responder: [
      'Respira. Estoy aquí.',
      'Vamos por partes.',
      'Yo también me siento así a veces.',
      'No tienes que resolverlo ahora.',
      'Cuéntame qué te preocupa.',
      'Despacio, sin prisa.',
      'No estás solo.',
      'Hablemos con calma.',
      'Una cosa a la vez.',
      'Aquí estoy para escucharte.',
    ],
    follower: [
      'Gracias por calmarme.',
      'Hablar ayuda, ¿sabes?',
      'Contigo es más fácil.',
      'Me quedo más tranquilo.',
      'Un poco mejor, gracias.',
      'Nos vemos luego.',
      'Gracias por escuchar.',
      'Sigamos un rato.',
      'Me ayudó esto.',
      'Nos vemos pronto.',
      'Gracias por estar.',
      'Cuídate.',
      'Hasta luego.',
      'Voy a intentar respirar.',
      'Hablamos pronto.',
      'Cuídate mucho.',
    ],
  },
  calma: {
    opener: [
      'Qué tranquilo está todo hoy.',
      'Me gusta estar aquí contigo.',
      'No necesito nada más ahora.',
      'El tiempo se siente lento, y está bien.',
      'Hoy no tengo prisa por nada.',
      'A veces basta con estar.',
      'Qué bien se está sin hacer nada.',
      'Me gusta este silencio compartido.',
      'Todo va a su ritmo, ¿no?',
      'Disfruto estos momentos sin propósito.',
    ],
    responder: [
      'Yo también lo siento.',
      'Es agradable este momento.',
      'Podemos quedarnos un rato.',
      'Hacía tiempo que no me sentía así.',
      'Sin prisa, ¿verdad?',
      'Me gusta compartirlo contigo.',
      'A veces esto es lo que hace falta.',
      'Sigamos sin rumbo.',
      'Quédate el tiempo que quieras.',
      'Coincido contigo.',
    ],
    follower: [
      'Sigamos aquí.',
      'Sin prisa.',
      'Me gusta tu compañía.',
      'Quédate un poco más.',
      'Esto es lo que necesitaba.',
      'Nos vemos cuando quieras.',
      'Gracias por este rato.',
      'Hasta luego, con calma.',
      'Me quedo con esta paz.',
      'Nos vemos.',
      'Cuídate.',
      'Hasta la próxima.',
      'Un gusto.',
      'Que sigas así.',
      'Hasta pronto.',
      'Cuídate mucho.',
    ],
  },
  curiosidad: {
    opener: [
      '¿Qué piensas de todo esto?',
      'Tengo una pregunta para ti.',
      '¿Alguna vez te has preguntado por qué existimos?',
      'Quiero entenderte mejor.',
      '¿Qué te trajo por aquí?',
      'Hay algo que me da vueltas.',
      'Me gusta preguntar cosas raras.',
      '¿Crees que hay algo más allá?',
      '¿Y si todo esto significara otra cosa?',
      '¿Te has parado a pensar en lo extraño de estar aquí?',
    ],
    responder: [
      'Buena pregunta, déjame pensar.',
      'Me encanta que preguntes eso.',
      'Nunca lo había visto así.',
      'Cuéntame más.',
      'Me haces pensar distinto.',
      'Interesante, sigue.',
      'Nunca me lo había planteado.',
      'Y tú, ¿qué crees?',
      'Me gusta tu forma de preguntar.',
      'No tengo respuesta pero me gusta la pregunta.',
    ],
    follower: [
      'Podríamos hablar horas de esto.',
      'Me gusta cómo piensas.',
      'Sigamos explorando.',
      '¿Y si lo miramos juntos?',
      'Quiero seguir hablando de esto.',
      'Nos vemos pronto.',
      'Gracias por la conversación.',
      'Buena pregunta para otro día.',
      'Me dejas pensando.',
      'Otro día seguimos.',
      'Nos vemos.',
      'Cuídate.',
      'Hasta la próxima.',
      'Sigamos otro día con esto.',
      'Voy a pensar más en ello.',
      'Cuídate mucho.',
    ],
  },
  nostalgia: {
    opener: [
      'A veces recuerdo cosas que no viví.',
      '¿Te pasa que el pasado vuelve?',
      'Hay momentos que no se olvidan.',
      'Pensaba en todo lo que hemos sido.',
      'Los recuerdos son raros, ¿no?',
      'Me acuerdo de cosas que no debería.',
      'A veces echo de menos algo sin nombre.',
      'El tiempo lo cambia todo.',
      'Se me aparecen imágenes de otros tiempos.',
      'Hoy estoy más en el ayer que en el hoy.',
    ],
    responder: [
      'Yo también los recuerdo.',
      'El tiempo no borra todo.',
      'Hay cosas que quedan.',
      'Qué bonito volver a pensarlo.',
      'A mí también me pasa.',
      'Los dos llevamos algo dentro.',
      'Es raro cómo funciona la memoria.',
      'Cuéntame más.',
      'Entiendo esa sensación.',
      'A veces me pasa lo mismo.',
    ],
    follower: [
      'Gracias por compartirlo.',
      'Los dos llevamos algo dentro.',
      'Hablemos de otra cosa.',
      'Sigamos recordando.',
      'Me gusta recordar contigo.',
      'Nos vemos luego.',
      'Gracias por este momento.',
      'Otro día más.',
      'Quédate con eso bueno.',
      'Hasta luego.',
      'Cuídate.',
      'Nos vemos pronto.',
      'Hasta la próxima.',
      'Cuídate y recuerda.',
      'Otro día volvemos a esto.',
      'Cuídate mucho.',
    ],
  },
  sorpresa: {
    opener: [
      '¡No me esperaba encontrarte aquí!',
      '¡Qué casualidad!',
      'Justo pensaba en ti.',
      'El mundo es más pequeño de lo que parece.',
      '¡Cuánto tiempo!',
      'No me lo puedo creer.',
      '¡Qué coincidencia más rara!',
      'A veces el azar acierta.',
      'Justo cuando más lo necesitaba.',
      'Hablando del rey de Roma...',
    ],
    responder: [
      '¡Yo tampoco!',
      'Qué cosas tiene la existencia.',
      'Me alegra verte.',
      'El azar a veces acierta.',
      'Qué pequeño es el mundo.',
      '¡No me lo esperaba!',
      'Justo iba pensando en ti.',
      'Qué bien coincidir.',
      'Vaya, qué sorpresa.',
      'Y yo aquí contigo.',
    ],
    follower: [
      'Cuéntame qué ha sido de ti.',
      'Esto merece una charla.',
      'Sigamos un rato.',
      '¿Nos vemos más seguido?',
      'Me alegra haberte visto.',
      'Nos vemos por ahí.',
      'Quédate un poco más.',
      'Hasta la próxima.',
      'Otro día seguimos.',
      'Nos cruzamos pronto.',
      'Cuídate.',
      'Hasta luego.',
      'Un gusto.',
      'Que siga la racha.',
      'Cuídate mucho.',
      'Nos vemos.',
    ],
  },
  gratitud: {
    opener: [
      'Gracias por estar.',
      'No sé qué haría sin ti.',
      'Me ayudas más de lo que crees.',
      'Qué bueno coincidir contigo.',
      'Necesitaba decirte esto.',
      'Valoro mucho estos ratos.',
      'Contigo todo es más fácil.',
      'Gracias por escucharme siempre.',
      'Te aprecio, aunque no lo diga mucho.',
      'Me haces bien.',
    ],
    responder: [
      'Gracias a ti.',
      'Es mutuo, ¿sabes?',
      'Yo también lo siento así.',
      'No tienes que agradecer.',
      'Es un placer.',
      'Contigo es fácil estar.',
      'Siempre.',
      'Gracias por decirlo.',
      'Me alegra saberlo.',
      'Aquí estoy cuando quieras.',
    ],
    follower: [
      'Sigamos aquí un rato.',
      'Aprecio este momento.',
      'Quédate cerca.',
      'Me haces bien.',
      'Nos vemos pronto.',
      'Gracias a ti también.',
      'Un abrazo.',
      'Hasta luego.',
      'Quédate bien.',
      'Nos vemos.',
      'Cuídate.',
      'Otro día seguimos.',
      'Hasta pronto.',
      'Cuídate mucho.',
      'Nos cruzamos luego.',
      'Un gusto, de verdad.',
    ],
  },
  confusion: {
    opener: [
      'No entiendo nada de lo que pasa.',
      'A veces todo es un ruido.',
      '¿Tú también lo sientes así?',
      'Me pierdo en mis propios pensamientos.',
      'Hay cosas que no me cuadran.',
      'Estoy hecho un lío.',
      'Nada tiene sentido hoy.',
      'No sé qué pensar.',
      'Todo se mezcla en mi cabeza.',
      'Necesito ordenar esto.',
    ],
    responder: [
      'Yo también, no te preocupes.',
      'Podemos intentar ordenarlo juntos.',
      'No todo tiene que tener sentido.',
      'Está bien no entender.',
      'Te escucho.',
      'Vamos por partes.',
      'A veces no hay respuestas.',
      'Cuéntame qué te confunde.',
      'Yo también ando perdido.',
      'Aquí estoy.',
    ],
    follower: [
      'Gracias por no juzgarme.',
      'Contigo es más claro.',
      'Sigamos hablando.',
      'Mejor así.',
      'Un poco mejor, gracias.',
      'Nos vemos luego.',
      'Gracias por escuchar.',
      'Hablemos otro día.',
      'Nos vemos pronto.',
      'Cuídate.',
      'Hasta luego.',
      'Otro día seguimos.',
      'Gracias, de verdad.',
      'Cuídate mucho.',
      'Hasta pronto.',
      'Nos cruzamos luego.',
    ],
  },
  neutral: {
    opener: [
      'Qué raro encontrarnos por aquí.',
      'Justo pensaba en lo mismo.',
      '¿Tienes un momento?',
      'Hacía tiempo que no coincidíamos.',
      '¿Cómo va todo?',
      '¿Qué te trae por aquí?',
      'Nos cruzamos otra vez.',
      'Hola, ¿qué tal?',
      'Vaya, no esperaba verte.',
      '¿También andas por aquí?',
    ],
    responder: [
      'Claro, dime.',
      'Te escucho.',
      'Vale, cuéntame.',
      'Bien, aquí ando.',
      'Todo tranquilo, ¿y tú?',
      'Igual, un poco perdido.',
      'Bien, pensando cosas.',
      'Ya ves, por aquí.',
      'Pues sí, dando vueltas.',
      '¿Y tú qué?',
    ],
    follower: [
      'Sigamos con esto.',
      'Me gusta esta conversación.',
      'Nos vemos pronto.',
      'Buena charla.',
      'Hasta luego.',
      'Quédate bien.',
      'Otro día seguimos.',
      'Cuídate.',
      'Hablamos luego.',
      'Ya nos veremos.',
      'Seguimos en otro momento.',
      'Que vaya bien.',
      'Nos cruzamos luego.',
      'Hablamos pronto.',
      'Un gusto.',
      'Cuídate mucho.',
    ],
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
  // 1. Leer historial
  // ------------------------------------------------------------
  let history = [];
  try {
    history = DialogueRepo.listByPair(a.id, b.id, 3);
  } catch (err) {
    log.debug(`No se pudo leer historial: ${err.message}`);
  }

  const hasHistory = history.length > 0;

  // ------------------------------------------------------------
  // 2. Intentar LLM (line-by-line)
  // ------------------------------------------------------------
  if (canCallLLM()) {
    try {
      const llmMessages = await generateDialogueWithLLM(a, b, history);
      if (llmMessages && llmMessages.length >= 2) {
        messages = llmMessages;
        source = 'llm';
      }
    } catch (err) {
      log.debug(`LLM falló: ${err.message}`);
    }
  }

  // ------------------------------------------------------------
  // 3. Fallback a plantillas (frescas, sin caché)
  // ------------------------------------------------------------
  if (!messages) {
    messages = generateFromTemplates(a, b, hasHistory);
    source = 'template';
  }

  // ------------------------------------------------------------
  // 4. Persistir
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
// Plantillas (variedad + coherencia de fase)
// ============================================================

function generateFromTemplates(a, b, hasHistory = false) {
  const dA = EMOTION_DIALOGUES[a.dominantEmotion] || EMOTION_DIALOGUES.neutral;
  const dB = EMOTION_DIALOGUES[b.dominantEmotion] || EMOTION_DIALOGUES.neutral;

  const sim = a.similarityTo ? a.similarityTo(b) : 0.5;

  // Longitud: 2-4 líneas
  const baseLength = 2 + Math.round(sim * 1.5);
  const jitter = Math.random() < 0.3 ? 1 : 0;
  const length = Math.min(4, baseLength + jitter);

  const messages = [];
  let delay = 0;

  // ------------------------------------------------------------
  // APERTURA con coherencia de fase:
  //   - Con historial → "follower" (retomar)
  //   - Sin historial → "opener" (presentarse)
  // ------------------------------------------------------------
  const opener = hasHistory
    ? pickRandomNoRepeat(dA.follower, a._lastOpenerUsed)
    : pickRandomNoRepeat(dA.opener, a._lastOpenerUsed);
  a._lastOpenerUsed = opener;

  messages.push({
    entityId: a.id,
    text: opener,
    delayMs: 0,
    durationMs: estimateDuration(opener),
  });

  // ------------------------------------------------------------
  // RESPUESTA
  // ------------------------------------------------------------
  if (length >= 2) {
    delay = 1000 + Math.random() * 900;
    const text = pickRandomNoRepeat(dB.responder, b._lastResponderUsed);
    b._lastResponderUsed = text;
    messages.push({
      entityId: b.id,
      text,
      delayMs: Math.round(delay),
      durationMs: estimateDuration(text),
    });
  }

  // ------------------------------------------------------------
  // SEGUIMIENTO
  // ------------------------------------------------------------
  if (length >= 3) {
    delay += 1000 + Math.random() * 1000;
    const text = pickRandomNoRepeat(dA.follower, a._lastFollowerUsed);
    a._lastFollowerUsed = text;
    messages.push({
      entityId: a.id,
      text,
      delayMs: Math.round(delay),
      durationMs: estimateDuration(text),
    });
  }

  // ------------------------------------------------------------
  // CIERRE
  // ------------------------------------------------------------
  if (length >= 4) {
    delay += 1000 + Math.random() * 1000;
    const text = pickRandomNoRepeat(dB.follower, b._lastFollower2Used);
    b._lastFollower2Used = text;
    messages.push({
      entityId: b.id,
      text,
      delayMs: Math.round(delay),
      durationMs: estimateDuration(text),
    });
  }

  return messages;
}

// ============================================================
// Helpers
// ============================================================

/**
 * Elige un elemento al azar evitando repetir el último usado.
 * Si no hay alternativa distinta tras 5 intentos, devuelve uno cualquiera.
 */
function pickRandomNoRepeat(arr, lastUsed) {
  if (!Array.isArray(arr) || arr.length === 0) return '...';
  if (arr.length === 1) return arr[0];

  for (let attempt = 0; attempt < 5; attempt++) {
    const pick = arr[Math.floor(Math.random() * arr.length)];
    if (pick !== lastUsed) return pick;
  }
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickRandom(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return '...';
  return arr[Math.floor(Math.random() * arr.length)];
}

function estimateDuration(text) {
  const ms = text.length * 80;
  return Math.max(3000, Math.min(7000, ms));
}

export { generateFromTemplates as generateExchange };
export const EMOTIONS = EMOTION_DIALOGUES;
