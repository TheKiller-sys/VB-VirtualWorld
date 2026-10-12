// public/controls.js
// Cámara (pan/zoom), picking de entidades, atajos de teclado.

export class Controls {
  constructor(canvas, state, opts = {}) {
    this.canvas = canvas;
    this.state = state;
    this.onEntitySelected = opts.onEntitySelected || (() => {});
    this.onBackgroundSelected = opts.onBackgroundSelected || (() => {});

    this.renderer = null;         // se inyecta desde world.js
    this.camera = null;           // idem

    // Estado interno
    this.dragging = false;
    this.dragStart = null;
    this.hasDragged = false;
    this.touchState = null;

    // Picking
    this.hoveredId = null;
    this.lastMouse = { x: 0, y: 0 };

    // Auto-follow
    this.followId = null;

    this._bindMouse();
    this._bindTouch();
    this._bindKeyboard();
    this._bindButtons();
  }

  attach(renderer, camera) {
    this.renderer = renderer;
    this.camera = camera;
  }

  // ------------------------------------------------------------
  // Coordenadas
  // ------------------------------------------------------------

  screenToWorld(sx, sy) {
    const cam = this.camera;
    return {
      x: (sx - window.innerWidth / 2) / cam.zoom + cam.x,
      y: (sy - window.innerHeight / 2) / cam.zoom + cam.y,
    };
  }

  // ------------------------------------------------------------
  // Mouse
  // ------------------------------------------------------------

  _bindMouse() {
    const c = this.canvas;

    c.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      this.dragging = true;
      this.hasDragged = false;
      this.dragStart = {
        sx: e.clientX,
        sy: e.clientY,
        camX: this.camera.x,
        camY: this.camera.y,
      };
    });

    c.addEventListener('mousemove', (e) => {
      this.lastMouse = { x: e.clientX, y: e.clientY };

      if (this.dragging && this.dragStart) {
        const dx = (e.clientX - this.dragStart.sx) / this.camera.zoom;
        const dy = (e.clientY - this.dragStart.sy) / this.camera.zoom;

        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
          this.hasDragged = true;
        }

        this.camera.x = this.dragStart.camX - dx;
        this.camera.y = this.dragStart.camY - dy;
      }

      // Hover
      const { x, y } = this.screenToWorld(e.clientX, e.clientY);
      this.hoveredId = this._pickEntity(x, y);
      this.canvas.style.cursor = this.hoveredId
        ? 'pointer'
        : (this.dragging ? 'grabbing' : 'grab');
    });

    window.addEventListener('mouseup', (e) => {
      if (!this.dragging) return;
      const wasDragging = this.hasDragged;
      this.dragging = false;
      this.dragStart = null;

      if (!wasDragging && e.button === 0) {
        // Fue un click
        const { x, y } = this.screenToWorld(e.clientX, e.clientY);
        const id = this._pickEntity(x, y);
        if (id) {
          this.followId = id;
          this.onEntitySelected(id);
        } else {
          this.followId = null;
          this.onBackgroundSelected();
        }
      }
    });

    c.addEventListener('wheel', (e) => {
      e.preventDefault();

      const cam = this.camera;
      const before = this.screenToWorld(e.clientX, e.clientY);

      const factor = e.deltaY > 0 ? 1 / 1.12 : 1.12;
      cam.zoom = Math.max(cam.minZoom, Math.min(cam.maxZoom, cam.zoom * factor));

      const after = this.screenToWorld(e.clientX, e.clientY);

      // Ajusta para que el punto bajo el cursor no se mueva
      cam.x += before.x - after.x;
      cam.y += before.y - after.y;
    }, { passive: false });

    c.addEventListener('mouseleave', () => {
      this.hoveredId = null;
    });
  }

  // ------------------------------------------------------------
  // Touch
  // ------------------------------------------------------------

  _bindTouch() {
    const c = this.canvas;

    c.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        const t = e.touches[0];
        this.touchState = {
          mode: 'drag',
          sx: t.clientX,
          sy: t.clientY,
          camX: this.camera.x,
          camY: this.camera.y,
          hasMoved: false,
        };
      } else if (e.touches.length === 2) {
        const [a, b] = e.touches;
        this.touchState = {
          mode: 'pinch',
          d0: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
          zoom0: this.camera.zoom,
          midX: (a.clientX + b.clientX) / 2,
          midY: (a.clientY + b.clientY) / 2,
        };
      }
      e.preventDefault();
    }, { passive: false });

    c.addEventListener('touchmove', (e) => {
      const ts = this.touchState;
      if (!ts) return;

      if (ts.mode === 'drag' && e.touches.length === 1) {
        const t = e.touches[0];
        const dx = (t.clientX - ts.sx) / this.camera.zoom;
        const dy = (t.clientY - ts.sy) / this.camera.zoom;

        if (Math.abs(dx) > 3 || Math.abs(dy) > 3) ts.hasMoved = true;

        this.camera.x = ts.camX - dx;
        this.camera.y = ts.camY - dy;
      } else if (ts.mode === 'pinch' && e.touches.length === 2) {
        const [a, b] = e.touches;
        const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        const scale = d / ts.d0;
        this.camera.zoom = Math.max(
          this.camera.minZoom,
          Math.min(this.camera.maxZoom, ts.zoom0 * scale),
        );
      }

      e.preventDefault();
    }, { passive: false });

    c.addEventListener('touchend', (e) => {
      const ts = this.touchState;
      if (ts && ts.mode === 'drag' && !ts.hasMoved && e.changedTouches.length > 0) {
        const t = e.changedTouches[0];
        const { x, y } = this.screenToWorld(t.clientX, t.clientY);
        const id = this._pickEntity(x, y);
        if (id) {
          this.followId = id;
          this.onEntitySelected(id);
        } else {
          this.followId = null;
          this.onBackgroundSelected();
        }
      }
      this.touchState = null;
    });
  }

  // ------------------------------------------------------------
  // Teclado
  // ------------------------------------------------------------

  _bindKeyboard() {
    window.addEventListener('keydown', (e) => {
      // Ignora si el foco está en un input
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;

      const cam = this.camera;
      const step = 80 / cam.zoom;

      switch (e.key) {
        case 'ArrowLeft':  cam.x -= step; break;
        case 'ArrowRight': cam.x += step; break;
        case 'ArrowUp':    cam.y -= step; break;
        case 'ArrowDown':  cam.y += step; break;

        case '+':
        case '=':
          cam.zoom = Math.min(cam.maxZoom, cam.zoom * 1.15);
          break;
        case '-':
        case '_':
          cam.zoom = Math.max(cam.minZoom, cam.zoom / 1.15);
          break;

        case 'r':
        case 'R':
          this.resetCamera();
          break;

        case 'f':
        case 'F':
          this._toggleFullscreen();
          break;

        case 'l':
        case 'L':
          this._toggleOption('showRelations');
          break;
        case 'n':
        case 'N':
          this._toggleOption('showLabels');
          break;
        case 't':
        case 'T':
          this._toggleOption('showTrails');
          break;

        case 'Escape':
          this.followId = null;
          this.onBackgroundSelected();
          break;

        default: return;
      }
      e.preventDefault();
    });
  }

  // ------------------------------------------------------------
  // Botones de UI
  // ------------------------------------------------------------

  _bindButtons() {
    document.getElementById('btn-reset')?.addEventListener('click', () => this.resetCamera());
    document.getElementById('btn-fullscreen')?.addEventListener('click', () => this._toggleFullscreen());

    document.getElementById('btn-relations')?.addEventListener('click', () => {
      this._toggleOption('showRelations');
    });
    document.getElementById('btn-labels')?.addEventListener('click', () => {
      this._toggleOption('showLabels');
    });
    document.getElementById('btn-trails')?.addEventListener('click', () => {
      this._toggleOption('showTrails');
    });
  }

  _toggleOption(key) {
    this.state.options[key] = !this.state.options[key];
    const btn = {
      showRelations: 'btn-relations',
      showLabels: 'btn-labels',
      showTrails: 'btn-trails',
    }[key];
    if (btn) {
      document.getElementById(btn)?.classList.toggle('active', this.state.options[key]);
    }
  }

  _toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
    } else {
      document.exitFullscreen().catch(() => {});
    }
  }

  // ------------------------------------------------------------
  // Cámara
  // ------------------------------------------------------------

  resetCamera() {
    const w = this.state.config.world;
    this.camera.x = w.width / 2;
    this.camera.y = w.height / 2;
    this.camera.zoom = 1;
    this.followId = null;
  }

  focusOnEntity(id) {
    const e = this.state.entities.get(id);
    if (!e) return;
    this.camera.x = e.x;
    this.camera.y = e.y;
    if (this.camera.zoom < 1.2) this.camera.zoom = 1.2;
    this.followId = id;
    this.onEntitySelected(id);
  }

  /**
   * Llamado desde el loop de render (si quieres que siga al target).
   * El renderer no lo llama automáticamente, se puede invocar desde world.js.
   */
  tickFollow() {
    if (!this.followId) return;
    const e = this.state.entities.get(this.followId);
    if (!e) return;
    this.camera.x += (e.x - this.camera.x) * 0.15;
    this.camera.y += (e.y - this.camera.y) * 0.15;
  }

  // ------------------------------------------------------------
  // Picking
  // ------------------------------------------------------------

  _pickEntity(wx, wy) {
    const entities = this.state.entities;
    if (entities.size === 0) return null;

    const zoom = this.camera.zoom;
    // Radio de tolerancia: mínimo 14px en pantalla o el radio real
    const tolerance = Math.max(14 / zoom, 12 / zoom);

    let best = null;
    let bestDistSq = Infinity;

    for (const e of entities.values()) {
      if (e.alpha < 0.15) continue;
      const dx = e.x - wx;
      const dy = e.y - wy;
      const dSq = dx * dx + dy * dy;
      const r = Math.max(tolerance, e.radius + 6 / zoom);
      if (dSq <= r * r && dSq < bestDistSq) {
        bestDistSq = dSq;
        best = e.id;
      }
    }

    return best;
  }
}
