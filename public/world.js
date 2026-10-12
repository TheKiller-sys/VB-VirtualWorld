// public/world.js
// Bootstrap del frontend de Cerebro World.
//
// CAMBIOS V1.1.0 (endurecimiento + UX):
//   - [SEC] Soporte de WORLD_WS_TOKEN vía ?token= o localStorage.
//   - [SEC] Prompt al usuario si el WS rechaza por token inválido.
//   - [SEC] Persiste el token en localStorage tras validación.
//   - [FEAT] Manejo de errores 429 (quota) y 503 (mundo lleno) con toast.
//   - [FEAT] HUD ampliado: total, reales, simuladas, límite global.
//   - [FEAT] Filtros de visualización por emoción y tipo (real/sim).
//   - [FEAT] Heartbeat cliente-side para detectar conexiones muertas.
//   - [FIX] controls.attach(renderer, camera) inyectado correctamente.
//   - [FIX] controls.tickFollow() llamado en cada frame del loop.
//   - [FIX] Reconexión robusta con backoff exponencial + jitter.
//   - [FIX] Manejo de visibilidad de pestaña (pausa render si está oculta).

import { Renderer } from './renderer.js';
import { Controls } from './controls.js';
import { Panel } from './panel.js';

// ============================================================
// Constantes
// ============================================================

const WS_TOKEN_KEY = 'cerebro-world-ws-token';
const HEARTBEAT_INTERVAL_MS = 20000;
const HEARTBEAT_TIMEOUT_MS = 45000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 20000;
const RECONNECT_JITTER_MS = 500;
const TOAST_DURATION_MS = 3200;

// ============================================================
// Estado global del frontend
// ============================================================

const state = {
  // Snapshots para interpolación
  prevSnapshot: null,
  currSnapshot: null,
  prevServerTime: 0,
  currServerTime: 0,

  // Estado "vivo" interpolado (recalculado en cada frame)
  entities: new Map(),       // id → entity interpolada
  relationships: [],         // [{ a, b, strength }]
  particles: [],             // partículas efímeras

  // Config del servidor (cargada de /api/config)
  config: {
    world: {
      width: 2000,
      height: 2000,
      margin: 100,
      attractRadius: 350,
      interactRadius: 45,
    },
    ws: { broadcastHz: 15 },
    requiresWsToken: false,
    demoMode: false,
    security: {
      maxTotalEntities: 500,
      maxSimulatedPerIp: 20,
    },
  },

  // Stats agregados (del snapshot)
  stats: {
    total: 0,
    real: 0,
    simulated: 0,
    relationships: 0,
    strongRelationships: 0,
  },

  // Filtros de visualización
  filters: {
    emotions: new Set(),     // vacío = todas
    showReal: true,
    showSimulated: true,
  },

  // Flags de UI
  options: {
    showRelations: true,
    showLabels: true,
    showTrails: false,
  },

  // Conexión
  wsStatus: 'connecting',    // connecting | connected | disconnected | error | unauthorized
  wsToken: null,
  lastEventAt: 0,
  lastPongAt: 0,

  // Control de render
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
  onEntityClick: (id) => controls.focusOnEntity(id),
});

const controls = new Controls(canvas, state, {
  onEntitySelected: (id) => panel.show(id),
  onBackgroundSelected: () => panel.hide(),
});

// FIX: inyecta renderer y camera en controls
controls.attach(renderer, renderer.camera);

// Debug
window.__world = { state, renderer, controls, panel };

// ============================================================
// Token del WS
// ============================================================

function loadWsToken() {
  // 1. Query param
  const url = new URL(location.href);
  const fromUrl = url.searchParams.get('token');
  if (fromUrl) {
    try { localStorage.setItem(WS_TOKEN_KEY, fromUrl); } catch (_) {}
    // Limpia de la URL para no dejarlo en el historial
    url.searchParams.delete('token');
    history.replaceState({}, '', url.toString());
    return fromUrl;
  }

  // 2. localStorage
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

  // Construye URL
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
      // Token inválido
      setWsStatus('unauthorized');
      clearWsToken();
      promptForToken();
      return; // no reconectar automáticamente
    }

    if (ev.code === 1013) {
      // Demasiados clientes
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

    // Si no hemos recibido pong en HEARTBEAT_TIMEOUT_MS, cierra
    const since = Date.now() - lastPongReceivedAt;
    if (since > HEARTBEAT_TIMEOUT_MS) {
      console.warn('[WS] heartbeat timeout, cerrando conexión');
      try { ws.close(4000, 'heartbeat_timeout'); } catch (_) {}
      return;
    }

    // Envía ping
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
  // Si ya estamos en una situación de prompt, evita duplicados
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
// Manejo de mensajes del WS
// ============================================================

function handleMessage(msg) {
  switch (msg.type) {
    case 'welcome':
      applySnapshot(msg.snapshot);
      // Actualiza stats si vienen en el welcome
      if (msg.serverTime) {
        state.lastEventAt = msg.serverTime;
      }
      showToast('🌍 Conectado al mundo', 'success');
      break;

    case 'tick':
      applySnapshot(msg.snapshot);
      if (Array.isArray(msg.events) && msg.events.length > 0) {
        applyEvents(msg.events);
      }
      state.lastEventAt = Date.now();
      break;

    case 'snapshot':
      applySnapshot(msg.snapshot);
      break;

    case 'entity_created':
      if (msg.entity) {
        const isSim = msg.entity.isSimulated ? '(simulada) ' : '';
        showToast(`🌱 Nueva entidad ${isSim}${shortId(msg.entity.id)}`, 'success');
        // Si el panel está mostrando esa entidad, refresca
        if (panel.currentId === msg.entity.id) {
          panel.show(msg.entity.id);
        }
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

    case 'stats':
      // Opcional: el servidor puede mandar stats periódicas
      break;

    case 'error':
      showToast(`⚠️ ${msg.message || 'Error del servidor'}`, 'error');
      break;

    default:
      break;
  }
}

// ============================================================
// Aplicar snapshot
// ============================================================

function applySnapshot(snap) {
  if (!snap || !Array.isArray(snap.entities)) return;

  // Guarda para interpolación
  state.prevSnapshot = state.currSnapshot;
  state.prevServerTime = state.currServerTime;
  state.currSnapshot = snap;
  state.currServerTime = snap.serverTime || Date.now();

  if (!state.prevSnapshot) {
    state.prevSnapshot = state.currSnapshot;
    state.prevServerTime = state.prevServerTime || state.currServerTime;
  }

  // Actualiza stats del HUD
  updateHudStats(snap);
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

  // Actualiza DOM
  const max = state.config.security?.maxTotalEntities;
  if (max) {
    statEntities.textContent = `${state.stats.total}/${max} entidades (${real}R · ${simulated}S)`;
  } else {
    statEntities.textContent = `${state.stats.total} entidades (${real}R · ${simulated}S)`;
  }

  statTick.textContent = `tick ${snap.tick || 0}`;
  statRelations.textContent = `${state.stats.relationships} relaciones · ${state.stats.strongRelationships} fuertes`;
}

// ============================================================
// Eventos puntuales → partículas
// ============================================================

function applyEvents(events) {
  for (const ev of events) {
    if (!ev || !ev.type) continue;

    if (ev.type === 'interaction') {
      const p = ev.payload || {};
      state.particles.push({
        kind: 'interaction',
        x: p.x,
        y: p.y,
        colorA: p.colorA || '#4fc3f7',
        colorB: p.colorB || '#61c9a8',
        life: 1,
        maxLife: 1,
        bornAt: performance.now(),
      });
    } else if (ev.type === 'entity_born') {
      const p = ev.payload || {};
      state.particles.push({
        kind: 'birth',
        x: p.x,
        y: p.y,
        colorA: p.color || '#ffffff',
        colorB: p.color || '#ffffff',
        life: 1,
        maxLife: 1,
        bornAt: performance.now(),
      });
    } else if (ev.type === 'entity_died') {
      // Pequeña nube gris en la posición (si la conocemos)
      const e = state.entities.get(ev.payload?.id);
      if (e) {
        state.particles.push({
          kind: 'death',
          x: e.x,
          y: e.y,
          colorA: '#8892a4',
          colorB: '#8892a4',
          life: 1,
          maxLife: 1,
          bornAt: performance.now(),
        });
      }
    }
  }

  if (state.particles.length > 200) {
    state.particles.splice(0, state.particles.length - 200);
  }
}

// ============================================================
// Interpolación por frame
// ============================================================

function interpolateEntities() {
  const prev = state.prevSnapshot;
  const curr = state.currSnapshot;
  if (!curr) return;

  // t = cuánto tiempo ha pasado desde curr, en unidades del intervalo
  const interval = Math.max(1, state.currServerTime - state.prevServerTime);
  const elapsed = Date.now() - state.currServerTime;
  let t = elapsed / interval;
  if (t > 1.5) t = 1.5;
  if (t < 0) t = 0;

  const prevMap = new Map();
  if (prev && Array.isArray(prev.entities)) {
    for (const e of prev.entities) prevMap.set(e.id, e);
  }

  const out = new Map();
  const filters = state.filters;

  for (const e of curr.entities) {
    // Aplica filtros
    if (!passesFilter(e, filters)) continue;

    const p = prevMap.get(e.id);
    if (!p) {
      out.set(e.id, { ...e });
      continue;
    }

    const x = p.x + (e.x - p.x) * t;
    const y = p.y + (e.y - p.y) * t;
    const vx = p.vx + (e.vx - p.vx) * t;
    const vy = p.vy + (e.vy - p.vy) * t;
    const alpha = p.alpha + (e.alpha - p.alpha) * t;
    const radius = p.radius + (e.radius - p.radius) * t;
    const pulse = p.pulse + (e.pulse - p.pulse) * t;

    out.set(e.id, {
      ...e,
      x, y, vx, vy, alpha, radius, pulse,
    });
  }

  state.entities = out;

  // Filtra relaciones por entidades visibles
  const rels = curr.relationships || [];
  state.relationships = rels.filter(r => out.has(r.a) && out.has(r.b));
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

function loop(now) {
  const dt = Math.min(0.1, (now - lastFrameAt) / 1000);
  lastFrameAt = now;

  // Si la pestaña está oculta, solo mantén el loop sin renderizar
  if (!state.isTabVisible) {
    requestAnimationFrame(loop);
    return;
  }

  interpolateEntities();
  updateParticles(dt);

  // Cámara sigue a la entidad seleccionada (si hay)
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
    if (p.life <= 0) {
      arr.splice(i, 1);
    }
  }
}

// ============================================================
// Visibilidad de pestaña
// ============================================================

document.addEventListener('visibilitychange', () => {
  state.isTabVisible = !document.hidden;

  if (state.isTabVisible) {
    // Al volver, resetea el reloj para evitar saltos de interpolación
    lastFrameAt = performance.now();
    // Pide un snapshot fresco
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
// Leyenda dinámica
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

  // Click en leyenda = filtro toggle
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
// Carga de config inicial
// ============================================================

async function loadConfig() {
  try {
    const r = await fetch('/api/config');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();

    if (data?.config) {
      state.config = { ...state.config, ...data.config };
      // Merge profundo del sub-objeto world
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

  // Extrae el token requerido
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
  // 1. Token primero (puede venir de URL)
  state.wsToken = loadWsToken();

  // 2. Config del servidor
  await loadConfig();

  // 3. Leyenda
  buildLegend();

  // 4. Conectar WS
  if (state.config.requiresWsToken && !state.wsToken) {
    // promptForToken ya se habrá llamado en loadConfig
    setWsStatus('unauthorized');
  } else {
    connectWS();
  }

  // 5. Loop de render
  requestAnimationFrame(loop);

  // 6. Banner
  console.log(
    '%c🌍 Cerebro World',
    'color:#4fc3f7;font-weight:bold;font-size:16px'
  );
  console.log(
    '%cFiltros: click en leyenda · Atajos: R reset, L relaciones, N etiquetas, T estelas, F fullscreen',
    'color:#8892a4;font-size:11px'
  );
}

boot();

// ============================================================
// Handlers globales de error
// ============================================================

window.addEventListener('error', (e) => {
  console.error('[global] error no capturado:', e.message);
});

window.addEventListener('unhandledrejection', (e) => {
  console.error('[global] promesa rechazada:', e.reason?.message || e.reason);
});
