// public/world.js
// Bootstrap del frontend. Conecta WS, mantiene el estado interpolado
// y delega el render y los controles.

import { Renderer } from './renderer.js';
import { Controls } from './controls.js';
import { Panel } from './panel.js';

// ============================================================
// Estado global del frontend
// ============================================================

const state = {
  // Últimos snapshots para interpolación
  prevSnapshot: null,
  currSnapshot: null,
  prevServerTime: 0,
  currServerTime: 0,

  // Estado "vivo" para render (se recalcula en cada frame)
  entities: new Map(),          // id → entity interpolada
  relationships: [],            // [{ a, b, strength }]
  particles: [],                // partículas efímeras

  // Config del servidor
  config: {
    world: { width: 2000, height: 2000, margin: 100, attractRadius: 350, interactRadius: 45 },
    ws: { broadcastHz: 15 },
    requiresWsToken: false,
  },

  // Flags de UI
  options: {
    showRelations: true,
    showLabels: true,
    showTrails: false,
  },

  // Estado de conexión
  wsStatus: 'connecting',       // connecting | connected | disconnected | error
  lastEventAt: 0,
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
  onEntitySelected: (id) => {
    panel.show(id);
  },
  onBackgroundSelected: () => {
    panel.hide();
  },
});

// Exponer en window para debug
window.__world = { state, renderer, controls, panel };

// ============================================================
// WebSocket
// ============================================================

let ws = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 15000;
let reconnectTimer = null;

function connectWS() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws`;

  setWsStatus('connecting');

  try {
    ws = new WebSocket(url);
  } catch (err) {
    console.error('WS: no se pudo crear', err);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    setWsStatus('connected');
    reconnectDelay = 1000;
    console.log('🔌 WS conectado');
  };

  ws.onclose = (ev) => {
    setWsStatus('disconnected');
    if (ev.code === 4001) {
      showToast('Token WS inválido', 'error');
    }
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
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 1.7, MAX_RECONNECT_DELAY);
  console.log(`WS reconectando en ${Math.round(delay)}ms...`);
  reconnectTimer = setTimeout(connectWS, delay);
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'welcome':
      applySnapshot(msg.snapshot);
      break;

    case 'tick':
      // El servidor envía { type: 'tick', snapshot, events }
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
      // Refresca el panel si está abierto en esa entidad
      if (msg.entity?.id) {
        const e = msg.entity;
        showToast(
          `🌱 Nueva entidad ${e.isSimulated ? '(simulada) ' : ''}${shortId(e.id)}`,
          'success',
        );
      }
      break;

    case 'entity_removed':
      if (panel.currentId === msg.id) {
        panel.hide();
      }
      break;

    case 'entities_cleared':
      showToast(`🧹 ${msg.count} entidades simuladas borradas`, 'success');
      break;

    case 'pong':
      break;

    case 'stats':
      // Opcional: mostrar stats completos
      break;

    default:
      break;
  }
}

// ============================================================
// Aplicar snapshot (con interpolación)
// ============================================================

function applySnapshot(snap) {
  if (!snap || !Array.isArray(snap.entities)) return;

  // Guarda snapshots para interpolar
  state.prevSnapshot = state.currSnapshot;
  state.prevServerTime = state.currServerTime;

  state.currSnapshot = snap;
  state.currServerTime = snap.serverTime || Date.now();

  if (!state.prevSnapshot) {
    state.prevSnapshot = state.currSnapshot;
    state.prevServerTime = state.prevServerTime || state.currServerTime;
  }

  // Actualiza stats del HUD
  statEntities.textContent = `${snap.entityCount} entidades`;
  statTick.textContent = `tick ${snap.tick}`;
  if (Array.isArray(snap.relationships)) {
    statRelations.textContent = `${snap.relationships.length} relaciones`;
  }
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
    }
  }

  // Limita partículas
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

  // t = cuánto tiempo ha pasado desde que recibimos curr, en unidades de intervalo
  const interval = Math.max(1, state.currServerTime - state.prevServerTime);
  const elapsed = Date.now() - state.currServerTime;
  let t = elapsed / interval;
  // Clamp: no extrapolar más allá de 1.5x para evitar saltos
  if (t > 1.5) t = 1.5;
  if (t < 0) t = 0;

  const prevMap = new Map();
  if (prev && Array.isArray(prev.entities)) {
    for (const e of prev.entities) prevMap.set(e.id, e);
  }

  const out = new Map();

  for (const e of curr.entities) {
    const p = prevMap.get(e.id);
    if (!p) {
      // Entidad nueva: sin interpolación
      out.set(e.id, { ...e });
      continue;
    }

    // Interpola posición y velocidad
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
  state.relationships = curr.relationships || [];
}

// ============================================================
// Loop de render
// ============================================================

let lastFrameAt = performance.now();
let frameCount = 0;
let fpsAccum = 0;

function loop(now) {
  const dt = Math.min(0.1, (now - lastFrameAt) / 1000);
  lastFrameAt = now;

  interpolateEntities();
  updateParticles(dt);
  renderer.render(dt);

  // FPS (opcional)
  frameCount++;
  fpsAccum += dt;
  if (fpsAccum >= 1) {
    frameCount = 0;
    fpsAccum = 0;
  }

  requestAnimationFrame(loop);
}

function updateParticles(dt) {
  const arr = state.particles;
  for (let i = arr.length - 1; i >= 0; i--) {
    const p = arr[i];
    p.life -= dt / (p.kind === 'birth' ? 1.4 : 0.9);
    if (p.life <= 0) {
      arr.splice(i, 1);
    }
  }
}

// ============================================================
// HUD
// ============================================================

function setWsStatus(status) {
  state.wsStatus = status;
  const map = {
    connecting:   { text: 'conectando…', color: '#f6c453' },
    connected:    { text: 'conectado',   color: '#61c9a8' },
    disconnected: { text: 'reconectando…', color: '#e05252' },
    error:        { text: 'error de conexión', color: '#e05252' },
  };
  const cfg = map[status] || map.connecting;
  statWs.textContent = cfg.text;
  dotWs.style.background = cfg.color;
  dotWs.style.color = cfg.color;
  dotWs.classList.toggle('pulse', status !== 'connected');
}

function showToast(text, kind = '') {
  toast.textContent = text;
  toast.className = kind;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => {
    toast.classList.add('hidden');
  }, 3200);
}

// ============================================================
// Leyenda dinámica (colores desde renderer)
// ============================================================

function buildLegend() {
  const palette = renderer.getEmotionPalette();
  const entries = Object.entries(palette);
  legendGrid.innerHTML = entries.map(([name, color]) => (
    `<div><span class="swatch" style="background:${color};color:${color}"></span>${name}</div>`
  )).join('');
}

// ============================================================
// Carga de config inicial
// ============================================================

async function loadConfig() {
  try {
    const r = await fetch('/api/config');
    const data = await r.json();
    if (data?.config) {
      state.config = { ...state.config, ...data.config };
    }
  } catch (_) {}
}

// ============================================================
// Click en enlaces del panel → focus
// ============================================================

// (el Panel llama a controls.focusOnEntity vía callback)

// ============================================================
// Arranque
// ============================================================

async function boot() {
  await loadConfig();
  buildLegend();
  connectWS();
  requestAnimationFrame(loop);
  console.log('%c🌍 Cerebro World', 'color:#4fc3f7;font-weight:bold;font-size:14px');
}

boot();

// ============================================================
// Helpers
// ============================================================

function shortId(id) {
  return id.length > 12 ? id.slice(-10) : id;
}
