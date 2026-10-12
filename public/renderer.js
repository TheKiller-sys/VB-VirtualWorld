// public/renderer.js
// Renderer 2D por canvas. Interpolación ya viene del state.entities.

const EMOTION_PALETTE = Object.freeze({
  alegria:    '#f6c453',
  tristeza:   '#5b8def',
  miedo:      '#8e6cc9',
  ira:        '#e05252',
  ansiedad:   '#c97b3f',
  calma:      '#61c9a8',
  curiosidad: '#4fc3f7',
  neutral:    '#9aa3b2',
  sorpresa:   '#ff8fb1',
  nostalgia:  '#b58ec9',
  gratitud:   '#7ed957',
  confusion:  '#a0a0a0',
});

const GRID_SIZE = 100;

export class Renderer {
  constructor(canvas, state) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.state = state;

    this.dpr = window.devicePixelRatio || 1;
    this.width = 0;
    this.height = 0;

    // Cámara (referenciada desde controls, pero con defaults)
    this.camera = {
      x: 1000,
      y: 1000,
      zoom: 1,
      minZoom: 0.15,
      maxZoom: 5,
    };

    // Estela de cada entidad
    this.trails = new Map();     // id → array de {x, y, t}

    this._bindResize();
    this.resize();
  }

  // ------------------------------------------------------------
  // Resize
  // ------------------------------------------------------------

  _bindResize() {
    window.addEventListener('resize', () => this.resize());
  }

  resize() {
    this.dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;

    this.canvas.width = Math.floor(w * this.dpr);
    this.canvas.height = Math.floor(h * this.dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';

    this.width = w;
    this.height = h;
  }

  getEmotionPalette() {
    return EMOTION_PALETTE;
  }

  // ------------------------------------------------------------
  // Render principal
  // ------------------------------------------------------------

  render(dt) {
    const ctx = this.ctx;
    const { camera } = this;

    // Fondo (con leve estela para suavizar el movimiento)
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = 'rgba(6, 9, 15, 0.35)';
    ctx.fillRect(0, 0, this.width, this.height);

    // Aplica cámara
    ctx.save();
    ctx.translate(this.width / 2, this.height / 2);
    ctx.scale(camera.zoom, camera.zoom);
    ctx.translate(-camera.x, -camera.y);

    this._drawGrid();
    this._drawWorldBounds();

    if (this.state.options.showRelations) {
      this._drawRelationships();
    }

    this._updateTrails(dt);

    if (this.state.options.showTrails) {
      this._drawTrails();
    }

    this._drawEntities();
    this._drawParticles();

    ctx.restore();
  }

  // ------------------------------------------------------------
  // Grid
  // ------------------------------------------------------------

  _drawGrid() {
    const ctx = this.ctx;
    const cam = this.camera;
    const world = this.state.config.world;

    // Rango visible
    const halfW = this.width / 2 / cam.zoom;
    const halfH = this.height / 2 / cam.zoom;
    const x0 = Math.floor((cam.x - halfW) / GRID_SIZE) * GRID_SIZE;
    const y0 = Math.floor((cam.y - halfH) / GRID_SIZE) * GRID_SIZE;
    const x1 = cam.x + halfW;
    const y1 = cam.y + halfH;

    // Si el grid se ve muy denso, oculta
    if (cam.zoom < 0.25) return;

    ctx.strokeStyle = 'rgba(80, 120, 180, 0.06)';
    ctx.lineWidth = 1 / cam.zoom;

    ctx.beginPath();
    for (let x = x0; x < x1; x += GRID_SIZE) {
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y1);
    }
    for (let y = y0; y < y1; y += GRID_SIZE) {
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
    }
    ctx.stroke();

    // Grid cada 500px más marcado
    ctx.strokeStyle = 'rgba(80, 120, 180, 0.12)';
    ctx.beginPath();
    const BIG = GRID_SIZE * 5;
    const bx0 = Math.floor((cam.x - halfW) / BIG) * BIG;
    const by0 = Math.floor((cam.y - halfH) / BIG) * BIG;
    for (let x = bx0; x < x1; x += BIG) {
      ctx.moveTo(x, by0);
      ctx.lineTo(x, y1);
    }
    for (let y = by0; y < y1; y += BIG) {
      ctx.moveTo(bx0, y);
      ctx.lineTo(x1, y);
    }
    ctx.stroke();
  }

  // ------------------------------------------------------------
  // Límites del mundo
  // ------------------------------------------------------------

  _drawWorldBounds() {
    const ctx = this.ctx;
    const w = this.state.config.world;

    ctx.strokeStyle = 'rgba(120, 180, 255, 0.18)';
    ctx.lineWidth = 2 / this.camera.zoom;
    ctx.setLineDash([8 / this.camera.zoom, 6 / this.camera.zoom]);
    ctx.strokeRect(0, 0, w.width, w.height);
    ctx.setLineDash([]);
  }

  // ------------------------------------------------------------
  // Relaciones
  // ------------------------------------------------------------

  _drawRelationships() {
    const ctx = this.ctx;
    const entities = this.state.entities;
    const rels = this.state.relationships;
    if (!rels || rels.length === 0) return;

    const zoom = this.camera.zoom;

    for (const rel of rels) {
      const a = entities.get(rel.a);
      const b = entities.get(rel.b);
      if (!a || !b) continue;

      const s = rel.strength;
      if (s < 0.08) continue;

      // Grosor y alpha en función de la fuerza
      const alpha = Math.min(0.75, 0.15 + s * 0.7);
      const lineWidth = Math.max(0.4, (0.6 + s * 2.2)) / zoom;

      // Color: mezcla entre los colores de ambas entidades
      const grad = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
      grad.addColorStop(0, hexWithAlpha(a.color, alpha));
      grad.addColorStop(1, hexWithAlpha(b.color, alpha));

      ctx.strokeStyle = grad;
      ctx.lineWidth = lineWidth;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  // ------------------------------------------------------------
  // Estelas
  // ------------------------------------------------------------

  _updateTrails(dt) {
    const entities = this.state.entities;
    const now = performance.now();

    // Añade punto a la estela
    for (const [id, e] of entities) {
      if (e.fading) continue;
      let arr = this.trails.get(id);
      if (!arr) {
        arr = [];
        this.trails.set(id, arr);
      }
      // Solo añade si se ha movido lo suficiente
      const last = arr[arr.length - 1];
      if (!last || Math.hypot(e.x - last.x, e.y - last.y) > 3) {
        arr.push({ x: e.x, y: e.y, t: now });
        if (arr.length > 24) arr.shift();
      }
    }

    // Limpia estelas de entidades muertas
    for (const id of this.trails.keys()) {
      if (!entities.has(id)) {
        this.trails.delete(id);
      }
    }
  }

  _drawTrails() {
    const ctx = this.ctx;
    const zoom = this.camera.zoom;

    for (const [id, arr] of this.trails) {
      const e = this.state.entities.get(id);
      if (!e || arr.length < 2) continue;

      ctx.lineWidth = Math.max(0.5, 2) / zoom;
      ctx.lineCap = 'round';

      for (let i = 1; i < arr.length; i++) {
        const t = i / arr.length;
        ctx.strokeStyle = hexWithAlpha(e.color, t * 0.4 * e.alpha);
        ctx.beginPath();
        ctx.moveTo(arr[i - 1].x, arr[i - 1].y);
        ctx.lineTo(arr[i].x, arr[i].y);
        ctx.stroke();
      }
    }
  }

  // ------------------------------------------------------------
  // Entidades
  // ------------------------------------------------------------

  _drawEntities() {
    const ctx = this.ctx;
    const zoom = this.camera.zoom;
    const showLabels = this.state.options.showLabels && zoom > 0.55;

    for (const e of this.state.entities.values()) {
      if (e.alpha <= 0.01) continue;

      const { x, y, radius, color, alpha, pulse } = e;

      // ---------- Aura exterior ----------
      const auraRadius = radius * (2.6 + pulse * 1.8);
      const grad = ctx.createRadialGradient(x, y, radius * 0.35, x, y, auraRadius);
      grad.addColorStop(0, hexWithAlpha(color, 0.42 * alpha));
      grad.addColorStop(0.6, hexWithAlpha(color, 0.10 * alpha));
      grad.addColorStop(1, hexWithAlpha(color, 0));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, auraRadius, 0, Math.PI * 2);
      ctx.fill();

      // ---------- Núcleo ----------
      ctx.fillStyle = hexWithAlpha(color, alpha);
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();

      // ---------- Anillo interior ----------
      ctx.strokeStyle = hexWithAlpha('#ffffff', 0.35 * alpha);
      ctx.lineWidth = Math.max(0.5, 1) / zoom;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.stroke();

      // ---------- Marca de simulada ----------
      if (e.isSimulated) {
        ctx.strokeStyle = hexWithAlpha('#ffffff', 0.7 * alpha);
        ctx.lineWidth = Math.max(0.6, 1.2) / zoom;
        ctx.setLineDash([2 / zoom, 2 / zoom]);
        ctx.beginPath();
        ctx.arc(x, y, radius * 1.6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // ---------- Pulso de interacción ----------
      if (pulse > 0.05) {
        const ringR = radius * (1.2 + (1 - pulse) * 2.5);
        ctx.strokeStyle = hexWithAlpha(color, pulse * 0.55 * alpha);
        ctx.lineWidth = Math.max(0.5, 2 * pulse) / zoom;
        ctx.beginPath();
        ctx.arc(x, y, ringR, 0, Math.PI * 2);
        ctx.stroke();
      }

      // ---------- Etiqueta ----------
      if (showLabels) {
        const label = e.label || shortId(e.id);
        const fontSize = Math.max(9, 10 / zoom);
        ctx.font = `${fontSize}px ui-monospace, monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        const textY = y - radius - 8 / zoom;

        // Sombra
        ctx.fillStyle = `rgba(0,0,0,${0.55 * alpha})`;
        ctx.fillText(label, x + 0.5 / zoom, textY + 0.5 / zoom);

        // Texto
        ctx.fillStyle = `rgba(230, 240, 255, ${0.75 * alpha})`;
        ctx.fillText(label, x, textY);
      }
    }
  }

  // ------------------------------------------------------------
  // Partículas
  // ------------------------------------------------------------

  _drawParticles() {
    const ctx = this.ctx;
    const zoom = this.camera.zoom;
    const particles = this.state.particles;
    if (!particles.length) return;

    for (const p of particles) {
      const t = 1 - p.life;             // 0 → 1
      const ease = 1 - Math.pow(1 - t, 3);

      if (p.kind === 'interaction') {
        const r = 12 + ease * 70;
        ctx.strokeStyle = hexWithAlpha(p.colorA, p.life * 0.5);
        ctx.lineWidth = Math.max(0.6, (1.6 - ease) * 2) / zoom;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.stroke();

        ctx.strokeStyle = hexWithAlpha(p.colorB, p.life * 0.32);
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * 0.62, 0, Math.PI * 2);
        ctx.stroke();
      } else if (p.kind === 'birth') {
        const r = 5 + ease * 45;
        const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
        grad.addColorStop(0, hexWithAlpha(p.colorA, p.life * 0.7));
        grad.addColorStop(1, hexWithAlpha(p.colorA, 0));
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

// ============================================================
// Helpers
// ============================================================

function hexWithAlpha(hex, alpha) {
  if (typeof hex !== 'string') return `rgba(200,200,200,${alpha})`;
  if (hex.startsWith('rgba')) return hex;
  if (hex.startsWith('rgb(')) {
    return hex.replace('rgb(', 'rgba(').replace(')', `,${alpha})`);
  }
  if (!hex.startsWith('#') || (hex.length !== 7 && hex.length !== 4)) {
    return `rgba(200,200,200,${alpha})`;
  }
  let r, g, b;
  if (hex.length === 4) {
    r = parseInt(hex[1] + hex[1], 16);
    g = parseInt(hex[2] + hex[2], 16);
    b = parseInt(hex[3] + hex[3], 16);
  } else {
    r = parseInt(hex.slice(1, 3), 16);
    g = parseInt(hex.slice(3, 5), 16);
    b = parseInt(hex.slice(5, 7), 16);
  }
  return `rgba(${r},${g},${b},${alpha})`;
}

function shortId(id) {
  if (typeof id !== 'string') return '';
  return id.length > 10 ? id.slice(-8) : id;
}
