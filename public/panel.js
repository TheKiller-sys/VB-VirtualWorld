// public/panel.js
// Panel lateral con dos modos:
//   1. Detalle de entidad (default)
//   2. Vista de chat entre dos entidades
//
// CAMBIOS V1.6.0:
//   - [FEAT] showDialogue(entityId, otherId): vista de chat
//   - [FEAT] Botón "volver" para regresar al detalle
//   - [FEAT] Render de conversaciones con dos lados (self / other)
//   - [FEAT] Click en relación ahora abre el chat
//   - [FEAT] Muestra el contador de diálogos por relación

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

const SOURCE_LABELS = {
  llm: '✨ Generado por IA',
  cache: '📦 Desde caché',
  template: '📝 Plantilla',
  unknown: '❔ Desconocido',
};

export class Panel {
  constructor(opts = {}) {
    this.onEntityClick = opts.onEntityClick || (() => {});

    this.el = document.getElementById('panel');
    this.content = document.getElementById('panel-content');
    this.closeBtn = document.getElementById('panel-close');

    this.currentId = null;         // entidad actualmente mostrada
    this.mode = 'entity';          // 'entity' | 'dialogue'
    this.dialogueWith = null;      // ID de la entidad con la que chateamos
    this._fetchToken = 0;          // para invalidar fetches obsoletos

    this.closeBtn?.addEventListener('click', () => this.hide());
  }

  // ------------------------------------------------------------
  // Mostrar / ocultar
  // ------------------------------------------------------------

  async show(entityId) {
    this.currentId = entityId;
    this.mode = 'entity';
    this.dialogueWith = null;

    this.el.classList.remove('hidden');
    this.el.setAttribute('aria-hidden', 'false');

    this.content.innerHTML = `<div class="loading">cargando…</div>`;

    const token = ++this._fetchToken;

    try {
      const r = await fetch(`/api/entities/${encodeURIComponent(entityId)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (token !== this._fetchToken) return;
      if (!data?.success) throw new Error(data?.error || 'sin datos');
      this._renderEntity(data);
    } catch (err) {
      if (token !== this._fetchToken) return;
      this.content.innerHTML = `<div class="error">no se pudo cargar: ${escapeHtml(err.message)}</div>`;
    }
  }

  async showDialogue(entityId, otherId) {
    this.currentId = entityId;
    this.mode = 'dialogue';
    this.dialogueWith = otherId;

    this.el.classList.remove('hidden');
    this.el.setAttribute('aria-hidden', 'false');

    this.content.innerHTML = `<div class="loading">cargando conversación…</div>`;

    const token = ++this._fetchToken;

    try {
      // Cargamos en paralelo:
      //   - la info de ambas entidades
      //   - los diálogos entre ellas
      const [eARes, eBRes, dlgRes] = await Promise.all([
        fetch(`/api/entities/${encodeURIComponent(entityId)}`),
        fetch(`/api/entities/${encodeURIComponent(otherId)}`),
        fetch(`/api/entities/${encodeURIComponent(entityId)}/dialogues/${encodeURIComponent(otherId)}?limit=100`),
      ]);

      if (token !== this._fetchToken) return;

      const eA = eARes.ok ? await eARes.json() : null;
      const eB = eBRes.ok ? await eBRes.json() : null;
      const dlg = dlgRes.ok ? await dlgRes.json() : null;

      this._renderDialogue({
        entityA: eA?.entity || null,
        entityB: eB?.entity || null,
        dialogues: dlg?.dialogues || [],
        relationAtoB: eA?.relationships?.find(r => r.id === otherId) || null,
        relationBtoA: eB?.relationships?.find(r => r.id === entityId) || null,
        viewerId: entityId,
      });
    } catch (err) {
      if (token !== this._fetchToken) return;
      this.content.innerHTML = `<div class="error">no se pudo cargar: ${escapeHtml(err.message)}</div>`;
    }
  }

  hide() {
    this.currentId = null;
    this.mode = 'entity';
    this.dialogueWith = null;
    this._fetchToken++;
    this.el.classList.add('hidden');
    this.el.setAttribute('aria-hidden', 'true');
  }

  // ------------------------------------------------------------
  // Vista: detalle de entidad
  // ------------------------------------------------------------

  _renderEntity(data) {
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
          <div class="rel" data-id="${escapeAttr(r.id)}" title="Click para ver la conversación">
            <div class="rel-id">
              <span class="rel-color" style="background:${escapeAttr(r.color || this._emotionColor(r.emotion))}"></span>
              ${escapeHtml(r.label || r.id)}
              ${r.isSimulated ? '<span class="badge sim">sim</span>' : ''}
              ${r.dialogueCount > 0 ? `<span class="rel-dialogue-count" title="Mensajes intercambiados">💬 ${r.dialogueCount}</span>` : ''}
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

    // Click en una relación → abre el chat con esa entidad
    this.content.querySelectorAll('.rel').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.getAttribute('data-id');
        if (id) this.showDialogue(e.id, id);
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

  // ------------------------------------------------------------
  // Vista: chat entre dos entidades
  // ------------------------------------------------------------

  _renderDialogue({ entityA, entityB, dialogues, relationAtoB, relationBtoA, viewerId }) {
    if (!entityA || !entityB) {
      this.content.innerHTML = `<div class="error">No se pudieron cargar las entidades</div>`;
      return;
    }

    const a = entityA;
    const b = entityB;

    const emotionA = EMOTION_LABELS[a.dominantEmotion] || a.dominantEmotion;
    const emotionB = EMOTION_LABELS[b.dominantEmotion] || b.dominantEmotion;

    const strength = relationAtoB?.strength ?? relationBtoA?.strength ?? 0;
    const strengthPct = Math.round(strength * 100);

    const messagesCount = dialogues.reduce((s, d) => s + (d.messages?.length || 0), 0);
    const llmCount = dialogues.filter(d => d.source === 'llm').length;
    const cacheCount = dialogues.filter(d => d.source === 'cache').length;
    const templateCount = dialogues.filter(d => d.source === 'template').length;

    const dialoguesHtml = dialogues.length > 0
      ? dialogues
          .slice()
          .reverse()  // mostramos los más antiguos primero
          .map(d => this._renderDialogueBlock(d, a, b, viewerId))
          .join('')
      : `<div class="chat-empty">
          Estas dos entidades aún no han hablado entre sí.
          <br><br>
          <small>Espera a que se encuentren en el mundo o acércalas con el zoom.</small>
        </div>`;

    this.content.innerHTML = `
      <button class="panel-back" id="panel-back-btn" title="Volver al detalle">
        ← Volver
      </button>

      <div class="chat-header">
        <div class="chat-participants">
          <div class="chat-participant" data-entity="${escapeAttr(a.id)}">
            <div class="chat-avatar" style="background:${escapeAttr(a.color)};box-shadow:0 0 12px ${escapeAttr(a.color)}"></div>
            <div class="chat-participant-info">
              <div class="chat-participant-name">${escapeHtml(a.label || shortId(a.id))}</div>
              <div class="chat-participant-emotion">${escapeHtml(emotionA)}</div>
            </div>
          </div>
          <div class="chat-link">
            <div class="chat-link-line"></div>
            <div class="chat-link-strength">${strengthPct}%</div>
          </div>
          <div class="chat-participant" data-entity="${escapeAttr(b.id)}">
            <div class="chat-avatar" style="background:${escapeAttr(b.color)};box-shadow:0 0 12px ${escapeAttr(b.color)}"></div>
            <div class="chat-participant-info">
              <div class="chat-participant-name">${escapeHtml(b.label || shortId(b.id))}</div>
              <div class="chat-participant-emotion">${escapeHtml(emotionB)}</div>
            </div>
          </div>
        </div>

        <div class="chat-stats">
          <span>${dialogues.length} conversaciones</span>
          <span>·</span>
          <span>${messagesCount} mensajes</span>
          ${llmCount > 0 ? `<span>·</span><span>✨ ${llmCount}</span>` : ''}
          ${cacheCount > 0 ? `<span>·</span><span>📦 ${cacheCount}</span>` : ''}
          ${templateCount > 0 ? `<span>·</span><span>📝 ${templateCount}</span>` : ''}
        </div>
      </div>

      <div class="chat-stream">
        ${dialoguesHtml}
      </div>
    `;

    // Botón "Volver"
    const backBtn = this.content.querySelector('#panel-back-btn');
    backBtn?.addEventListener('click', () => {
      this.show(viewerId);
    });

    // Click en un participante → abre su detalle
    this.content.querySelectorAll('.chat-participant').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.getAttribute('data-entity');
        if (id) this.show(id);
      });
    });

    // Scroll al final del chat
    const stream = this.content.querySelector('.chat-stream');
    if (stream) stream.scrollTop = stream.scrollHeight;
  }

  _renderDialogueBlock(d, entityA, entityB, viewerId) {
    const sourceLabel = SOURCE_LABELS[d.source] || SOURCE_LABELS.unknown;
    const when = formatRelativeTime(d.createdAt);

    const messagesHtml = (d.messages || []).map(m => {
      const isSelf = m.entityId === viewerId;
      // Determinar el hablante real
      const speaker = m.entityId === entityA.id ? entityA
        : m.entityId === entityB.id ? entityB
        : null;

      const speakerName = speaker?.label || shortId(m.entityId);
      const speakerColor = speaker?.color || '#9aa3b2';

      return `
        <div class="chat-message ${isSelf ? 'self' : 'other'}">
          <div class="chat-bubble" style="border-left-color:${escapeAttr(speakerColor)}">
            <div class="chat-bubble-header">
              <span class="chat-bubble-speaker" style="color:${escapeAttr(speakerColor)}">
                ${escapeHtml(speakerName)}
              </span>
            </div>
            <div class="chat-bubble-text">${escapeHtml(m.text)}</div>
          </div>
        </div>
      `;
    }).join('');

    return `
      <div class="chat-conversation">
        <div class="chat-conversation-header">
          <span class="chat-source">${sourceLabel}</span>
          <span class="chat-when" title="${new Date(d.createdAt).toLocaleString()}">${escapeHtml(when)}</span>
        </div>
        <div class="chat-conversation-body">
          ${messagesHtml}
        </div>
      </div>
    `;
  }

  // ------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------

  _emotionColor(emotion) {
    const palette = {
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
    };
    return palette[emotion] || '#9aa3b2';
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

function shortId(id) {
  if (typeof id !== 'string') return '';
  return id.length > 12 ? id.slice(-10) : id;
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

function formatRelativeTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 0) return 'ahora';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `hace ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `hace ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `hace ${h}h`;
  const d = Math.floor(h / 24);
  return `hace ${d}d`;
}
