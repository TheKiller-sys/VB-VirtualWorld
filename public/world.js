// public/world.js
// Bootstrap del frontend de Cerebro World.
//
// CAMBIOS V1.6.0:
//   - [FEAT] Al hacer click en una relación del panel → vista de chat.
//   - [FEAT] Deep-link: #chat=<idA>:<idB> abre el chat directamente.
//   - [FEAT] El estado mantiene los diálogos recientes para mostrar el
//     contador en el HUD.

import { Renderer } from './renderer.js';
import { Controls } from './controls.js';
import { Panel } from './panel.js';

const WS_TOKEN_KEY = 'cerebro-world-ws-token';
const HEARTBEAT_INTERVAL_MS = 20000;
const HEARTBEAT_TIMEOUT_MS = 45000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 20000;
const RECONNECT_JITTER_MS = 500;
const TOAST_DURATION_MS = 3200;

const MAX_EXTRAPOLATION_S = 0.5;

// ============================================================
// Estado global
// ============================================================

const state = {
  serverEntities: new Map(),
  entities: new Map(),
  relationships: [],
  particles: [],

  config: {
    world: {
      width: 2000,
      height: 2000,
      margin: 100,
      attractRadius: 350,
      interactRadius: 45,
    },
    ws: { broadcastHz: 30 },
    requiresWsToken: false,
    demoMode: false,
    security: {
      maxTotalEntities: 500,
      maxSimulatedPerIp: 20,
    },
  },

  stats: {
    total: 0,
    real: 0,
    simulated: 0,
    relationships: 0,
    strongRelationships: 0,
    dialogues: 0,
  },

  filters: {
    emotions: new Set(),
    showReal: true,
    showSimulated: true,
  },

  options: {
    showRelations: true,
    showLabels: true,
    showTrails: false,
    showDialogues: true,
  },

  wsStatus: 'connecting',
  wsToken: null,
  lastEventAt: 0,
  lastPongAt: 0,
  lastFullSnapshotAt: 0,

  isTabVisible: true,
};

// ============================================================
// DOM refs
// ============================================================

const canvas = document.getElementById('world');
const statWs = document.getElementById('stat-ws');
const statEntities = document.getElementById('stat-entities');
const statTick = document.getElementById('stat-tick');
const statRelations = document.getElementById('stat-relations');
const dotWs = document.getElementById('dot-ws');
const legendGrid = document.getElementById('legend-grid');
const toast = document.getElementById('toast');

// ============================================================
// Renderer + Controls + Panel
// ============================================================

const renderer = new Renderer(canvas, state);

const panel = new Panel({
  onEntityClick: (id) => {
    controls.focusOnEntity(id);
  },
});

const controls = new Controls(canvas, state, {
  onEntitySelected: (id) => {
    panel.show(id);
  },
  onBackgroundSelected: () => {
    panel.hide();
  },
});

controls.attach(renderer, renderer.camera);

window.__world = { state, renderer, controls, panel };

// ============================================================
// Deep-link: #chat=<idA>:<idB>
// ============================================================

function checkDeepLink() {
  const hash = location.hash;
  if (!hash) return;

  // Soporta #chat=<idA>:<idB>
  const m = hash.match(/^#chat=([^:]+):(.+)$/);
  if (m) {
    const [, idA, idB] = m;
    if (idA && idB) {
      setTimeout(() => {
        controls.focusOnEntity(idA);
        panel.showDialogue(idA, idB);
      }, 500);
      return;
    }
  }

  // Soporta #entity=<id>
  const m2 = hash.match(/^#entity=(.+)$/);
  if (m2) {
    const id = m2[1];
    if (id) {
      setTimeout(() => {
        controls.focusOnEntity(id);
        panel.show(id);
      }, 500);
    }
  }
}

window.addEventListener('hashchange', () => {
  // Si el usuario cambia el hash manualmente, aplicamos el deep-link
  checkDeepLink();
});

// ============================================================
// Token del WS
// ============================================================

function loadWsToken() {
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get('token');
  if (fromUrl) {
    try { localStorage.setItem(WS_TOKEN_KEY, fromUrl); } catch (_) {}
    url.searchParams.delete('token');
    history.replaceState({}, '', url.toString() + location.hash);
    return fromUrl;
  }

  try {
    const fromStorage = localStorage.getItem(WS_TOKEN_KEY);
    if (fromStorage) return fromStorage;
  } catch (_) {}

  return null;
}

function saveWsToken(token) {
  state.wsToken = token;
  try { localStorage.setItem(WS_TOKEN_KEY, token); } catch (_) {}
}

function clearWsToken() {
  state.wsToken = null;
  try { localStorage.removeItem(WS_TOKEN_KEY); } catch (_) {}
}

// ============================================================
// WebSocket
// ============================================================

let ws = null;
let reconnectDelay = RECONNECT_BASE_MS;
let reconnectTimer = null;
let heartbeatTimer = null;
let lastPongReceivedAt = 0;

function connectWS() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = new URL(`${proto}://${location.host}/ws`);
  if (state.wsToken) url.searchParams.set('token', state.wsToken);

  setWsStatus('connecting');

  try {
    ws = new WebSocket(url.toString());
  } catch (err) {
    console.error('[WS] no se pudo crear:', err);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    setWsStatus('connected');
    reconnectDelay = RECONNECT_BASE_MS;
    lastPongReceivedAt = Date.now();
    startHeartbeat();
    console.log('🔌 WS conectado');
  };

  ws.onclose = (ev) => {
    stopHeartbeat();

    if (ev.code === 4001) {
      setWsStatus('unauthorized');
      clearWsToken();
      promptForToken();
      return;
    }

    if (ev.code === 1013) {
      setWsStatus('disconnected');
      showToast('Servidor lleno, reintentando…', 'error');
      scheduleReconnect();
      return;
    }

    setWsStatus('disconnected');
    scheduleReconnect();
  };

  ws.onerror = () => {
    setWsStatus('error');
  };

  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleMessage(msg);
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const jitter = Math.random() * RECONNECT_JITTER_MS;
  const delay = Math.min(reconnectDelay + jitter, RECONNECT_MAX_MS);
  reconnectDelay = Math.min(reconnectDelay * 1.7, RECONNECT_MAX_MS);

  console.log(`[WS] reconectando en ${Math.round(delay)}ms...`);
  setWsStatus('connecting');
  reconnectTimer = setTimeout(connectWS, delay);
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const since = Date.now() - lastPongReceivedAt;
    if (since > HEARTBEAT_TIMEOUT_MS) {
      console.warn('[WS] heartbeat timeout, cerrando conexión');
      try { ws.close(4000, 'heartbeat_timeout'); } catch (_) {}
      return;
    }

    try {
      ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
    } catch (_) {}
  }, HEARTBEAT_INTERVAL_MS);

  if (heartbeatTimer.unref) heartbeatTimer.unref();
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// ============================================================
// Prompt de token
// ============================================================

function promptForToken() {
  if (promptForToken._active) return;
  promptForToken._active = true;

  const token = window.prompt(
    'Este servidor requiere un token de acceso.\n\n' +
    'Pega el token del WebSocket (WORLD_WS_TOKEN) para continuar:'
  );

  promptForToken._active = false;

  if (token && token.trim().length > 0) {
    saveWsToken(token.trim());
    reconnectDelay = RECONNECT_BASE_MS;
    connectWS();
  } else {
    showToast('Sin token, el mundo no se puede cargar', 'error');
  }
}

// ============================================================
// Manejo de mensajes
// ============================================================

function handleMessage(msg) {
  switch (msg.type) {
    case 'welcome':
      applyFullSnapshot(msg.snapshot);
      showToast('🌍 Conectado al mundo', 'success');
      break;

    case 'full':
      applyFullSnapshot(msg.snapshot);
      if (Array.isArray(msg.events) && msg.events.length > 0) {
        applyEvents(msg.events);
      }
      state.lastEventAt = Date.now();
      break;

    case 'tick':
      applyLightSnapshot(msg.snapshot);
      if (Array.isArray(msg.events) && msg.events.length > 0) {
        applyEvents(msg.events);
      }
      state.lastEventAt = Date.now();
      break;

    case 'snapshot':
      applyFullSnapshot(msg.snapshot);
      break;

    case 'entity_created':
      if (msg.entity) {
        const isSim = msg.entity.isSimulated ? '(simulada) ' : '';
        showToast(`🌱 Nueva entidad ${isSim}${shortId(msg.entity.id)}`, 'success');
        if (panel.currentId === msg.entity.id) panel.show(msg.entity.id);
      }
      break;

    case 'entity_removed':
      if (panel.currentId === msg.id) panel.hide();
      showToast(`💨 ${shortId(msg.id)} se desvaneció`, '');
      break;

    case 'entities_cleared':
      if (panel.currentId) panel.hide();
      showToast(`🧹 ${msg.count} entidades simuladas borradas`, 'success');
      break;

    case 'pong':
      lastPongReceivedAt = Date.now();
      state.lastPongAt = lastPongReceivedAt;
      break;

    case 'error':
      showToast(`⚠️ ${msg.message || 'Error del servidor'}`, 'error');
      break;

    default:
      break;
  }
}

// ============================================================
// Aplicar snapshots
// ============================================================

function applyFullSnapshot(snap) {
  if (!snap || !Array.isArray(snap.entities)) return;

  const now = Date.now();
  const map = new Map();

  for (const e of snap.entities) {
    map.set(e.id, {
      ...e,
      serverUpdatedAt: now,
    });
  }

  state.serverEntities = map;
  state.relationships = snap.relationships || [];
  state.lastFullSnapshotAt = now;

  updateHudStats(snap);
}

function applyLightSnapshot(snap) {
  if (!snap || !Array.isArray(snap.entities)) return;

  const now = Date.now();
  const map = state.serverEntities;

  for (const light of snap.entities) {
    const e = map.get(light.id);
    if (!e) continue;

    e.x = light.x;
    e.y = light.y;
    e.vx = light.vx;
    e.vy = light.vy;
    e.alpha = light.a;
    e.pulse = light.p;
    e.serverUpdatedAt = now;
  }

  if (snap.tick) {
    statTick.textContent = `tick ${snap.tick}`;
  }
}

function updateHudStats(snap) {
  const entities = snap.entities || [];
  let real = 0;
  let simulated = 0;

  for (const e of entities) {
    if (e.isSimulated) simulated++;
    else real++;
  }

  state.stats.total = entities.length;
  state.stats.real = real;
  state.stats.simulated = simulated;
  state.stats.relationships = (snap.relationships || []).length;
  state.stats.strongRelationships = (snap.relationships || [])
    .filter(r => r.strength >= 0.6).length;

  const max = state.config.security?.maxTotalEntities;
  if (max) {
    statEntities.textContent = `${state.stats.total}/${max} entidades (${real}R · ${simulated}S)`;
  } else {
    statEntities.textContent = `${state.stats.total} entidades (${real}R · ${simulated}S)`;
  }

  if (snap.tick) statTick.textContent = `tick ${snap.tick}`;
  statRelations.textContent = `${state.stats.relationships} relaciones · ${state.stats.strongRelationships} fuertes`;
}

// ============================================================
// Eventos puntuales → partículas y diálogos
// ============================================================

function applyEvents(events) {
  for (const ev of events) {
    if (!ev || !ev.type) continue;

    if (ev.type === 'interaction') {
      const p = ev.payload || {};
      state.particles.push({
        kind: 'interaction',
        x: p.x, y: p.y,
        colorA: p.colorA || '#4fc3f7',
        colorB: p.colorB || '#61c9a8',
        life: 1, maxLife: 1,
        bornAt: performance.now(),
      });
    } else if (ev.type === 'entity_born') {
      const p = ev.payload || {};
      state.particles.push({
        kind: 'birth',
        x: p.x, y: p.y,
        colorA: p.color || '#ffffff',
        colorB: p.color || '#ffffff',
        life: 1, maxLife: 1,
        bornAt: performance.now(),
      });
    } else if (ev.type === 'entity_died') {
      const e = state.serverEntities.get(ev.payload?.id);
      if (e) {
        state.particles.push({
          kind: 'death',
          x: e.x, y: e.y,
          colorA: '#8892a4', colorB: '#8892a4',
          life: 1, maxLife: 1,
          bornAt: performance.now(),
        });
      }
    } else if (ev.type === 'dialogue') {
      const p = ev.payload || {};
      if (Array.isArray(p.messages) && p.messages.length > 0) {
        scheduleDialogue(p.messages);
        state.stats.dialogues++;

        if (p.source === 'llm') {
          console.log(`✨ Diálogo LLM: ${shortId(p.a)}↔${shortId(p.b)}`);
        }

        // Si el panel está mostrando el detalle de A o B,
        // refrescamos para que aparezca el contador de diálogos actualizado
        if (panel.mode === 'entity'
            && (panel.currentId === p.a || panel.currentId === p.b)) {
          // Debounce: solo refresca si ha pasado 1.5s desde la última
          if (!applyEvents._refreshTimer) {
            applyEvents._refreshTimer = setTimeout(() => {
              applyEvents._refreshTimer = null;
              if (panel.mode === 'entity' && panel.currentId) {
                panel.show(panel.currentId);
              }
            }, 1500);
          }
        }

        // Si el panel está mostrando el chat entre A y B, recargamos
        if (panel.mode === 'dialogue'
            && ((panel.currentId === p.a && panel.dialogueWith === p.b)
             || (panel.currentId === p.b && panel.dialogueWith === p.a))) {
          if (!applyEvents._refreshChatTimer) {
            applyEvents._refreshChatTimer = setTimeout(() => {
              applyEvents._refreshChatTimer = null;
              if (panel.mode === 'dialogue' && panel.currentId && panel.dialogueWith) {
                panel.showDialogue(panel.currentId, panel.dialogueWith);
              }
            }, 2000);
          }
        }
      }
    }
  }

  if (state.particles.length > 200) {
    state.particles.splice(0, state.particles.length - 200);
  }
}

// ============================================================
// Sistema de diálogo (burbujas)
// ============================================================

const dialogueQueues = new Map();
const MAX_QUEUE_PER_ENTITY = 5;

function scheduleDialogue(messages) {
  const now = performance.now();

  for (const msg of messages) {
    if (!msg || !msg.entityId || !msg.text) continue;

    const showAt = now + (msg.delayMs || 0);
    const durationMs = msg.durationMs || 3500;
    const hideAt = showAt + durationMs;

    let queue = dialogueQueues.get(msg.entityId);
    if (!queue) {
      queue = [];
      dialogueQueues.set(msg.entityId, queue);
    }

    if (queue.length >= MAX_QUEUE_PER_ENTITY) queue.shift();

    queue.push({
      text: String(msg.text).slice(0, 200),
      showAt, hideAt, bornAt: showAt,
    });
  }
}

function getActiveDialogue(entityId, now) {
  const queue = dialogueQueues.get(entityId);
  if (!queue || queue.length === 0) return null;

  while (queue.length > 0 && queue[0].hideAt < now) {
    queue.shift();
  }

  if (queue.length === 0) {
    dialogueQueues.delete(entityId);
    return null;
  }

  const head = queue[0];
  if (head.showAt > now) return null;

  return head;
}

function cleanupDialogues(now) {
  for (const [id, queue] of dialogueQueues) {
    while (queue.length > 0 && queue[0].hideAt < now) {
      queue.shift();
    }
    if (queue.length === 0) dialogueQueues.delete(id);
  }
}

window.__dialogueApi = {
  getActiveDialogue,
  getQueue: (id) => dialogueQueues.get(id) || [],
  getStats: () => ({
    entitiesWithDialogue: dialogueQueues.size,
    totalQueued: Array.from(dialogueQueues.values())
      .reduce((s, q) => s + q.length, 0),
  }),
};

// ============================================================
// Extrapolación por frame
// ============================================================

function updateDisplayEntities() {
  const now = Date.now();
  const out = new Map();
  const filters = state.filters;
  const serverEntities = state.serverEntities;

  for (const e of serverEntities.values()) {
    if (!passesFilter(e, filters)) continue;

    const elapsedS = (now - e.serverUpdatedAt) / 1000;
    const capped = Math.min(Math.max(elapsedS, 0), MAX_EXTRAPOLATION_S);

    const x = e.x + (e.vx || 0) * capped;
    const y = e.y + (e.vy || 0) * capped;

    out.set(e.id, { ...e, x, y });
  }

  state.entities = out;

  state.relationships = (state.relationships || []).filter(
    r => out.has(r.a) && out.has(r.b)
  );
}

function passesFilter(e, filters) {
  if (e.isSimulated && !filters.showSimulated) return false;
  if (!e.isSimulated && !filters.showReal) return false;
  if (filters.emotions.size > 0 && !filters.emotions.has(e.dominantEmotion)) return false;
  return true;
}

// ============================================================
// Loop de render
// ============================================================

let lastFrameAt = performance.now();
let lastCleanupAt = 0;

function loop(now) {
  const dt = Math.min(0.1, (now - lastFrameAt) / 1000);
  lastFrameAt = now;

  if (!state.isTabVisible) {
    requestAnimationFrame(loop);
    return;
  }

  updateDisplayEntities();
  updateParticles(dt);

  if (now - lastCleanupAt > 2000) {
    cleanupDialogues(now);
    lastCleanupAt = now;
  }

  controls.tickFollow();

  renderer.render(dt);

  requestAnimationFrame(loop);
}

function updateParticles(dt) {
  const arr = state.particles;
  const LIFESPANS = {
    interaction: 0.9,
    birth: 1.4,
    death: 1.8,
  };

  for (let i = arr.length - 1; i >= 0; i--) {
    const p = arr[i];
    const lifespan = LIFESPANS[p.kind] || 1;
    p.life -= dt / lifespan;
    if (p.life <= 0) arr.splice(i, 1);
  }
}

// ============================================================
// Visibilidad de pestaña
// ============================================================

document.addEventListener('visibilitychange', () => {
  state.isTabVisible = !document.hidden;

  if (state.isTabVisible) {
    lastFrameAt = performance.now();
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'snapshot' })); } catch (_) {}
    }
  }
});

// ============================================================
// HUD
// ============================================================

function setWsStatus(status) {
  state.wsStatus = status;

  const map = {
    connecting:   { text: 'conectando…',       color: '#f6c453', pulse: true },
    connected:    { text: 'conectado',         color: '#61c9a8', pulse: false },
    disconnected: { text: 'reconectando…',     color: '#e05252', pulse: true },
    error:        { text: 'error de conexión', color: '#e05252', pulse: true },
    unauthorized: { text: 'token requerido',   color: '#b58ec9', pulse: true },
  };

  const cfg = map[status] || map.connecting;
  statWs.textContent = cfg.text;
  dotWs.style.background = cfg.color;
  dotWs.style.color = cfg.color;
  dotWs.classList.toggle('pulse', cfg.pulse);
}

function showToast(text, kind = '') {
  toast.textContent = text;
  toast.className = kind;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    toast.classList.add('hidden');
  }, TOAST_DURATION_MS);
}

// ============================================================
// Leyenda
// ============================================================

function buildLegend() {
  const palette = renderer.getEmotionPalette();
  const entries = Object.entries(palette);

  legendGrid.innerHTML = entries.map(([name, color]) => (
    `<div data-emotion="${name}">` +
      `<span class="swatch" style="background:${color};color:${color}"></span>` +
      `${name}` +
    `</div>`
  )).join('');

  legendGrid.querySelectorAll('[data-emotion]').forEach(el => {
    el.style.cursor = 'pointer';
    el.style.opacity = '1';

    el.addEventListener('click', () => {
      const emotion = el.getAttribute('data-emotion');
      const set = state.filters.emotions;

      if (set.has(emotion)) {
        set.delete(emotion);
        el.style.opacity = '1';
      } else {
        set.add(emotion);
        el.style.opacity = '0.4';
      }
    });
  });
}

// ============================================================
// Config inicial
// ============================================================

async function loadConfig() {
  try {
    const r = await fetch('/api/config');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();

    if (data?.config) {
      state.config = { ...state.config, ...data.config };
      if (data.config.world) {
        state.config.world = { ...state.config.world, ...data.config.world };
      }
      if (data.config.security) {
        state.config.security = { ...state.config.security, ...data.config.security };
      }
    }
  } catch (err) {
    console.warn('[config] no se pudo cargar:', err.message);
  }

  state.config.requiresWsToken = !!state.config.requiresWsToken;
  if (state.config.requiresWsToken && !state.wsToken) {
    promptForToken();
  }
}

// ============================================================
// Helpers
// ============================================================

function shortId(id) {
  if (typeof id !== 'string') return '';
  return id.length > 12 ? id.slice(-10) : id;
}

// ============================================================
// Arranque
// ============================================================

async function boot() {
  state.wsToken = loadWsToken();
  await loadConfig();
  buildLegend();

  if (state.config.requiresWsToken && !state.wsToken) {
    setWsStatus('unauthorized');
  } else {
    connectWS();
  }

  requestAnimationFrame(loop);

  // Deep-link después de un pequeño delay para que el WS haya cargado
  setTimeout(checkDeepLink, 1500);

  console.log(
    '%c🌍 Cerebro World',
    'color:#4fc3f7;font-weight:bold;font-size:16px'
  );
  console.log(
    '%cReal-time: extrapolación pura · 30Hz broadcast · click en relación para ver el chat',
    'color:#61c9a8;font-size:11px'
  );
}

boot();

window.addEventListener('error', (e) => {
  console.error('[global] error no capturado:', e.message);
});

window.addEventListener('unhandledrejection', (e) => {
  console.error('[global] promesa rechazada:', e.reason?.message || e.reason);
});
