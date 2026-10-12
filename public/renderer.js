// public/renderer.js
// Renderer 2D por canvas. Interpolación ya viene del state.entities.
//
// CAMBIOS V1.3.0:
//   - [FEAT] Dibujo de burbujas de diálogo sobre las entidades.
//   - [FEAT] Soporte para partícula kind='death'.
//   - [FEAT] Borde de "fading" en entidades desvaneciéndose.

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
const BIG_GRID_MULT = 5;

export class Renderer {
  constructor(canvas, state) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.state = state;

    this.dpr = window.devicePixelRatio || 1;
    this.width = 0;
    this.height = 0;

    this.camera = {
      x: 1000,
      y: 1000,
      zoom: 1,
      minZoom: 0.15,
      maxZoom: 5,
    };

    this.trails = new Map();

    this._bindResize();
    this.resize();
  }

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

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = 'rgba(6, 9, 15, 0.35)';
    ctx.fillRect(0, 0, this.width, this.height);

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

    // Diálogos encima de todo
    if (this.state.options.showDialogues !== false) {
      this._drawDialogues();
    }

    ctx.restore();
  }

  // ------------------------------------------------------------
  // Grid
  // ------------------------------------------------------------

  _drawGrid() {
    const ctx = this.ctx;
    const cam = this.camera;

    if (cam.zoom < 0.25) return;

    const halfW = this.width / 2 / cam.zoom;
    const halfH = this.height / 2 / cam.zoom;
    const x0 = Math.floor((cam.x - halfW) / GRID_SIZE) * GRID_SIZE;
    const y0 = Math.floor((cam.y - halfH) / GRID_SIZE) * GRID_SIZE;
    const x1 = cam.x + halfW;
    const y1 = cam.y + halfH;

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

    const BIG = GRID_SIZE * BIG_GRID_MULT;
    const bx0 = Math.floor((cam.x - halfW) / BIG) * BIG;
    const by0 = Math.floor((cam.y - halfH) / BIG) * BIG;

    ctx.strokeStyle = 'rgba(80, 120, 180, 0.12)';
    ctx.beginPath();
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

      const alpha = Math.min(0.75, 0.15 + s * 0.7);
      const lineWidth = Math.max(0.4, (0.6 + s * 2.2)) / zoom;

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

    for (const [id, e] of entities) {
      if (e.fading) continue;
      let arr = this.trails.get(id);
      if (!arr) {
        arr = [];
        this.trails.set(id, arr);
      }
      const last = arr[arr.length - 1];
      if (!last || Math.hypot(e.x - last.x, e.y - last.y) > 3) {
        arr.push({ x: e.x, y: e.y, t: now });
        if (arr.length > 24) arr.shift();
      }
    }

    for (const id of this.trails.keys()) {
      if (!entities.has(id)) this.trails.delete(id);
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

      // Aura exterior
      const auraRadius = radius * (2.6 + pulse * 1.8);
      const grad = ctx.createRadialGradient(x, y, radius * 0.35, x, y, auraRadius);
      grad.addColorStop(0, hexWithAlpha(color, 0.42 * alpha));
      grad.addColorStop(0.6, hexWithAlpha(color, 0.10 * alpha));
      grad.addColorStop(1, hexWithAlpha(color, 0));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, auraRadius, 0, Math.PI * 2);
      ctx.fill();

      // Núcleo
      ctx.fillStyle = hexWithAlpha(color, alpha);
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();

      // Anillo interior
      ctx.strokeStyle = hexWithAlpha('#ffffff', 0.35 * alpha);
      ctx.lineWidth = Math.max(0.5, 1) / zoom;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.stroke();

      // Borde de simulada
      if (e.isSimulated) {
        ctx.strokeStyle = hexWithAlpha('#ffffff', 0.7 * alpha);
        ctx.lineWidth = Math.max(0.6, 1.2) / zoom;
        ctx.setLineDash([2 / zoom, 2 / zoom]);
        ctx.beginPath();
        ctx.arc(x, y, radius * 1.6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Borde de fading
      if (e.fading) {
        ctx.strokeStyle = hexWithAlpha('#8892a4', 0.4 * alpha);
        ctx.lineWidth = Math.max(0.5, 1) / zoom;
        ctx.setLineDash([4 / zoom, 4 / zoom]);
        ctx.beginPath();
        ctx.arc(x, y, radius * 1.3, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Pulso de interacción
      if (pulse > 0.05) {
        const ringR = radius * (1.2 + (1 - pulse) * 2.5);
        ctx.strokeStyle = hexWithAlpha(color, pulse * 0.55 * alpha);
        ctx.lineWidth = Math.max(0.5, 2 * pulse) / zoom;
        ctx.beginPath();
        ctx.arc(x, y, ringR, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Etiqueta
      if (showLabels) {
        const label = e.label || shortId(e.id);
        const fontSize = Math.max(9, 10 / zoom);
        ctx.font = `${fontSize}px ui-monospace, monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        const textY = y - radius - 8 / zoom;

        ctx.fillStyle = `rgba(0,0,0,${0.55 * alpha})`;
        ctx.fillText(label, x + 0.5 / zoom, textY + 0.5 / zoom);

        ctx.fillStyle = `rgba(230, 240, 255, ${0.75 * alpha})`;
        ctx.fillText(label, x, textY);
      }
    }
  }

  // ------------------------------------------------------------
  // Burbujas de diálogo
  // ------------------------------------------------------------

  _drawDialogues() {
    const api = window.__dialogueApi;
    if (!api) return;

    const ctx = this.ctx;
    const now = performance.now();
    const zoom = this.camera.zoom;

    if (zoom < 0.35) return;

    const entities = this.state.entities;

    // Ordena las entidades por Y descendente para que las burbujas
    // de las entidades más arriba se dibujen primero
    const sorted = Array.from(entities.values())
      .sort((a, b) => a.y - b.y);

    for (const e of sorted) {
      if (e.alpha < 0.3) continue;

      const dialogue = api.getActiveDialogue(e.id, now);
      if (!dialogue) continue;

      const age = now - dialogue.bornAt;
      const total = dialogue.hideAt - dialogue.showAt;

      let opacity = 1;
      if (age < 200) opacity = age / 200;
      const remaining = total - age;
      if (remaining < 400) opacity = Math.min(opacity, remaining / 400);
      opacity = Math.max(0, Math.min(1, opacity));

      this._drawBubble(e, dialogue.text, opacity, zoom);
    }
  }

  _drawBubble(entity, text, opacity, zoom) {
    const ctx = this.ctx;
    const { x, y, radius, color } = entity;

    const fontSize = Math.max(10, Math.round(11 / zoom));
    const padding = { x: 10 / zoom, y: 7 / zoom };
    const lineHeight = fontSize * 1.35;
    const maxWidth = 180 / zoom;
    const cornerRadius = 8 / zoom;

    ctx.font = `${fontSize}px ui-monospace, "SF Mono", Menlo, monospace`;

    // Word wrap
    const words = String(text).split(/\s+/);
    const lines = [];
    let currentLine = '';
    for (const word of words) {
      const test = currentLine ? currentLine + ' ' + word : word;
      if (ctx.measureText(test).width > maxWidth - padding.x * 2) {
        if (currentLine) lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = test;
      }
    }
    if (currentLine) lines.push(currentLine);
    if (lines.length === 0) lines.push(text);

    let textWidth = 0;
    for (const line of lines) {
      const w = ctx.measureText(line).width;
      if (w > textWidth) textWidth = w;
    }

    const boxW = textWidth + padding.x * 2;
    const boxH = lines.length * lineHeight + padding.y * 2;

    const bubbleX = x - boxW / 2;
    const bubbleY = y - radius - boxH - 12 / zoom;

    const tailSize = 5 / zoom;
    const tailX = x;
    const tailY = y - radius - 4 / zoom;

    ctx.globalAlpha = opacity;

    // Sombra
    ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
    ctx.shadowBlur = 12 / zoom;
    ctx.shadowOffsetY = 2 / zoom;

    // Cuerpo
    this._roundRect(bubbleX, bubbleY, boxW, boxH, cornerRadius);
    ctx.fillStyle = 'rgba(12, 17, 28, 0.94)';
    ctx.fill();

    // Borde
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    ctx.strokeStyle = hexWithAlpha(color, 0.55);
    ctx.lineWidth = 1 / zoom;
    this._roundRect(bubbleX, bubbleY, boxW, boxH, cornerRadius);
    ctx.stroke();

    // Colita
    ctx.fillStyle = 'rgba(12, 17, 28, 0.94)';
    ctx.beginPath();
    ctx.moveTo(tailX - tailSize, tailY - tailSize * 0.2);
    ctx.lineTo(tailX + tailSize, tailY - tailSize * 0.2);
    ctx.lineTo(tailX, tailY + tailSize);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = hexWithAlpha(color, 0.55);
    ctx.beginPath();
    ctx.moveTo(tailX - tailSize, tailY - tailSize * 0.2);
    ctx.lineTo(tailX, tailY + tailSize);
    ctx.lineTo(tailX + tailSize, tailY - tailSize * 0.2);
    ctx.stroke();

    // Texto
    ctx.fillStyle = `rgba(230, 240, 255, 0.95)`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(
        lines[i],
        bubbleX + padding.x,
        bubbleY + padding.y + i * lineHeight,
      );
    }

    ctx.globalAlpha = 1;
  }

  _roundRect(x, y, w, h, r) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
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
      const t = 1 - p.life;
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
      } else if (p.kind === 'death') {
        const r = 10 + ease * 55;
        const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
        grad.addColorStop(0, hexWithAlpha('#8892a4', p.life * 0.5));
        grad.addColorStop(0.5, hexWithAlpha('#5a6478', p.life * 0.25));
        grad.addColorStop(1, hexWithAlpha('#5a6478', 0));
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();

        ctx.strokeStyle = hexWithAlpha('#8892a4', p.life * 0.4);
        ctx.lineWidth = Math.max(0.5, 1) / zoom;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * 0.7, 0, Math.PI * 2);
        ctx.stroke();
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
