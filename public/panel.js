// public/panel.js
// Panel lateral de detalle de entidad. Carga desde /api/entities/:id.

const EMOTION_LABELS = {
  alegria: 'Alegría',
  tristeza: 'Tristeza',
  miedo: 'Miedo',
  ira: 'Ira',
  ansiedad: 'Ansiedad',
  calma: 'Calma',
  curiosidad: 'Curiosidad',
  neutral: 'Neutral',
  sorpresa: 'Sorpresa',
  nostalgia: 'Nostalgia',
  gratitud: 'Gratitud',
  confusion: 'Confusión',
};

const TRAIT_LABELS = {
  openness: 'Apertura',
  curiosity: 'Curiosidad',
  emotionality: 'Emotividad',
  sociality: 'Sociabilidad',
  stability: 'Estabilidad',
};

export class Panel {
  constructor(opts = {}) {
    this.onEntityClick = opts.onEntityClick || (() => {});

    this.el = document.getElementById('panel');
    this.content = document.getElementById('panel-content');
    this.closeBtn = document.getElementById('panel-close');

    this.currentId = null;
    this._fetchToken = 0;

    this.closeBtn?.addEventListener('click', () => this.hide());
  }

  // ------------------------------------------------------------
  // Mostrar / ocultar
  // ------------------------------------------------------------

  async show(entityId) {
    this.currentId = entityId;
    this.el.classList.remove('hidden');
    this.el.setAttribute('aria-hidden', 'false');

    this.content.innerHTML = `<div class="loading">cargando…</div>`;

    const token = ++this._fetchToken;

    try {
      const r = await fetch(`/api/entities/${encodeURIComponent(entityId)}`);
      if (!r.ok) {
        throw new Error(`HTTP ${r.status}`);
      }
      const data = await r.json();
      if (token !== this._fetchToken) return; // respuesta obsoleta
      if (!data?.success) throw new Error(data?.error || 'sin datos');
      this._render(data);
    } catch (err) {
      if (token !== this._fetchToken) return;
      this.content.innerHTML = `<div class="error">no se pudo cargar: ${escapeHtml(err.message)}</div>`;
    }
  }

  hide() {
    this.currentId = null;
    this._fetchToken++; // invalida fetch pendiente
    this.el.classList.add('hidden');
    this.el.setAttribute('aria-hidden', 'true');
  }

  // ------------------------------------------------------------
  // Render
  // ------------------------------------------------------------

  _render(data) {
    const e = data.entity;
    const rels = Array.isArray(data.relationships) ? data.relationships : [];

    const bornDate = new Date(e.bornAt).toLocaleString();
    const lastSeenDate = new Date(e.lastSeenAt).toLocaleString();

    const emotionLabel = EMOTION_LABELS[e.dominantEmotion] || e.dominantEmotion;
    const sentimentLabel = formatSentiment(e.sentiment);
    const intensityPct = Math.round((e.intensity || 0) * 100);
    const sentimentPct = Math.round(((e.sentiment + 1) / 2) * 100);

    const topicsHtml = e.topics && e.topics.length > 0
      ? `<div class="topics">${e.topics.map(t => `<span class="topic">${escapeHtml(t)}</span>`).join('')}</div>`
      : `<div class="empty">Sin temas registrados</div>`;

    const traitsHtml = this._renderTraits(e.traits);

    const relsHtml = rels.length > 0
      ? rels.map(r => `
          <div class="rel" data-id="${escapeAttr(r.id)}">
            <div class="rel-id">
              ${escapeHtml(r.label || r.id)}
              ${r.isSimulated ? '<span class="badge sim">sim</span>' : ''}
            </div>
            <div class="rel-strength">${(r.strength * 100).toFixed(0)}%</div>
          </div>
        `).join('')
      : `<div class="empty">Aún no ha interactuado con nadie</div>`;

    const simBadge = e.isSimulated
      ? '<span class="badge sim">simulada</span>'
      : '';

    this.content.innerHTML = `
      <h2>
        ${escapeHtml(e.label || e.id)}
        ${simBadge}
      </h2>

      <div class="kv">
        <span class="k">ID</span>
        <span class="v mono">${escapeHtml(e.id)}</span>
      </div>
      <div class="kv">
        <span class="k">Nacida</span>
        <span class="v">${escapeHtml(bornDate)}</span>
      </div>
      <div class="kv">
        <span class="k">Última señal</span>
        <span class="v">${escapeHtml(lastSeenDate)}</span>
      </div>
      <div class="kv">
        <span class="k">Edad</span>
        <span class="v">${formatAge(e.ageMs)}</span>
      </div>

      <h3>Estado</h3>
      <div class="kv">
        <span class="k">Emoción</span>
        <span class="v">${escapeHtml(emotionLabel)}</span>
      </div>
      <div class="kv">
        <span class="k">Intent dominante</span>
        <span class="v">${escapeHtml(e.dominantIntent || '—')}</span>
      </div>
      <div class="kv">
        <span class="k">Sentiment</span>
        <span class="v">${escapeHtml(sentimentLabel)}</span>
      </div>
      <div class="kv" style="flex-direction:column;align-items:stretch;gap:4px">
        <span class="k">Intensidad</span>
        <span class="v" style="text-align:left">${intensityPct}%</span>
        <div class="bar"><div style="width:${intensityPct}%"></div></div>
      </div>
      <div class="kv" style="flex-direction:column;align-items:stretch;gap:4px">
        <span class="k">Ánimo</span>
        <span class="v" style="text-align:left">${sentimentPct}%</span>
        <div class="bar"><div style="width:${sentimentPct}%"></div></div>
      </div>

      <h3>Actividad</h3>
      <div class="kv">
        <span class="k">Turnos</span>
        <span class="v">${e.turnCount || 0}</span>
      </div>
      <div class="kv">
        <span class="k">Interacciones</span>
        <span class="v">${e.interactionCount || 0}</span>
      </div>
      <div class="kv">
        <span class="k">Vecinos</span>
        <span class="v">${rels.length}</span>
      </div>

      <h3>Temas</h3>
      ${topicsHtml}

      <h3>Rasgos</h3>
      ${traitsHtml}

      <h3>Relaciones (${rels.length})</h3>
      ${relsHtml}
    `;

    // Click en una relación → focus
    this.content.querySelectorAll('.rel').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.getAttribute('data-id');
        if (id) this.onEntityClick(id);
      });
    });
  }

  _renderTraits(traits) {
    if (!traits || typeof traits !== 'object') {
      return `<div class="empty">Sin datos</div>`;
    }

    const rows = [];
    for (const [key, label] of Object.entries(TRAIT_LABELS)) {
      const v = Number(traits[key]) || 0;
      const pct = Math.round(v * 100);
      rows.push(`
        <div class="kv" style="flex-direction:column;align-items:stretch;gap:4px">
          <span class="k">${label}</span>
          <span class="v" style="text-align:left">${pct}%</span>
          <div class="bar"><div style="width:${pct}%"></div></div>
        </div>
      `);
    }
    return rows.join('');
  }
}

// ============================================================
// Helpers
// ============================================================

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s) {
  return escapeHtml(s);
}

function formatAge(ms) {
  if (!Number.isFinite(ms)) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function formatSentiment(s) {
  if (!Number.isFinite(s)) return '0.00';
  const label =
    s > 0.4 ? 'positivo' :
    s > 0.15 ? 'ligeramente positivo' :
    s < -0.4 ? 'negativo' :
    s < -0.15 ? 'ligeramente negativo' :
    'neutro';
  return `${s.toFixed(2)} · ${label}`;
}
