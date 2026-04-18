// ============================================================
// Observatory — main app
// ============================================================

// ----- Settings -------------------------------------------------------------

const SETTINGS_KEY = 'observatory.settings.v1';

const DEFAULT_SETTINGS = {
  baseUrl: '',
  projectId: 'default',
  userId: 'default',
  token: 'dev-token',
};

const ENTITY_TYPES = [
  'PERSON',
  'OBJECT',
  'LOCATION',
  'EVENT',
  'ORGANIZATION',
  'CUSTOM',
];

const TYPE_COLORS = {
  PERSON: '#8FB892',
  OBJECT: '#D4A574',
  LOCATION: '#C49B95',
  EVENT: '#A87C9F',
  ORGANIZATION: '#D4B574',
  CUSTOM: '#7DA8A4',
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

let settings = loadSettings();

// ----- API client -----------------------------------------------------------

async function api(path, opts = {}) {
  const url = (settings.baseUrl || '') + path;
  const headers = {
    'Authorization': `Bearer ${settings.token}`,
    'X-Project-Id': settings.projectId,
    'X-User-Id': settings.userId,
    ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    ...(opts.headers || {}),
  };
  const res = await fetch(url, { ...opts, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText} — ${text || path}`);
  }
  return res.json();
}

// ----- DOM helpers ----------------------------------------------------------

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v !== undefined && v !== null) {
      node.setAttribute(k, v);
    }
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function setStatus(state, label) {
  const node = $('#status');
  node.dataset.state = state;
  node.querySelector('.status__label').textContent = label;
}

function showToast(msg, tone = 'error') {
  const node = $('#toast');
  node.textContent = msg;
  node.dataset.tone = tone;
  node.classList.add('is-visible');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => node.classList.remove('is-visible'), 4500);
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (sameDay) return `${hh}:${mm}`;
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mo}-${dd} ${hh}:${mm}`;
}

function fmtDuration(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

function animateCount(node, target) {
  const start = parseInt(node.textContent, 10) || 0;
  const duration = 600;
  const t0 = performance.now();
  function tick(now) {
    const t = Math.min(1, (now - t0) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const value = Math.round(start + (target - start) * eased);
    node.textContent = value.toLocaleString();
    if (t < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// ----- Force-directed graph -------------------------------------------------

class GraphView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.nodes = [];
    this.edges = [];
    this.byId = new Map();
    this.alpha = 1;
    this.hoverNode = null;
    this.hoverEdge = null;
    this.selectedId = null;
    this.dragNode = null;
    this.dragOffset = [0, 0];
    this.typeFilter = new Set(ENTITY_TYPES);
    this.searchHighlight = new Set();
    this.dpr = window.devicePixelRatio || 1;
    this.fit();
    window.addEventListener('resize', () => this.fit());
    this._wireEvents();
    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  fit() {
    const rect = this.canvas.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = rect.width * this.dpr;
    this.canvas.height = rect.height * this.dpr;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  setData(entities, relations) {
    const prev = new Map(this.nodes.map((n) => [n.id, n]));
    const cx = this.width / 2;
    const cy = this.height / 2;
    this.nodes = entities.map((e, i) => {
      const old = prev.get(e.id);
      const angle = (i / Math.max(1, entities.length)) * Math.PI * 2;
      const r = Math.min(this.width, this.height) * 0.32;
      return {
        ...e,
        x: old?.x ?? cx + Math.cos(angle) * r * (0.6 + Math.random() * 0.4),
        y: old?.y ?? cy + Math.sin(angle) * r * (0.6 + Math.random() * 0.4),
        vx: 0,
        vy: 0,
        degree: 0,
      };
    });
    this.byId = new Map(this.nodes.map((n) => [n.id, n]));

    this.edges = relations
      .map((r) => ({
        ...r,
        a: this.byId.get(r.source_entity_id),
        b: this.byId.get(r.target_entity_id),
      }))
      .filter((e) => e.a && e.b);

    for (const e of this.edges) {
      e.a.degree += 1;
      e.b.degree += 1;
    }

    this.alpha = 1;
  }

  setTypeFilter(types) {
    this.typeFilter = new Set(types);
  }

  setSearchHighlight(ids) {
    this.searchHighlight = new Set(ids);
  }

  setSelected(id) {
    this.selectedId = id;
    this.alpha = Math.max(this.alpha, 0.4);
  }

  _isVisible(n) {
    return this.typeFilter.has(n.entity_type);
  }

  _step() {
    if (this.alpha < 0.02) return;

    const nodes = this.nodes.filter((n) => this._isVisible(n));
    if (!nodes.length) return;

    const REPULSION = 7000;
    const LINK_DIST = 100;
    const LINK_K = 0.06;
    const CENTER_K = 0.008;
    const FRICTION = 0.84;

    // Repulsion (O(n²); fine for our scale)
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d2 = dx * dx + dy * dy + 0.01;
        const d = Math.sqrt(d2);
        const force = REPULSION / d2;
        const fx = (force * dx) / d;
        const fy = (force * dy) / d;
        a.vx -= fx; a.vy -= fy;
        b.vx += fx; b.vy += fy;
      }
    }

    // Spring along edges
    for (const e of this.edges) {
      if (!this._isVisible(e.a) || !this._isVisible(e.b)) continue;
      const dx = e.b.x - e.a.x;
      const dy = e.b.y - e.a.y;
      const d = Math.sqrt(dx * dx + dy * dy) + 0.01;
      const f = (d - LINK_DIST) * LINK_K;
      const fx = (f * dx) / d;
      const fy = (f * dy) / d;
      e.a.vx += fx; e.a.vy += fy;
      e.b.vx -= fx; e.b.vy -= fy;
    }

    // Centering
    const cx = this.width / 2;
    const cy = this.height / 2;
    for (const n of nodes) {
      n.vx += (cx - n.x) * CENTER_K;
      n.vy += (cy - n.y) * CENTER_K;
    }

    // Integrate
    for (const n of nodes) {
      if (n === this.dragNode) continue;
      n.vx *= FRICTION;
      n.vy *= FRICTION;
      n.x += n.vx * this.alpha;
      n.y += n.vy * this.alpha;

      // Soft bounds
      const margin = 30;
      if (n.x < margin)              { n.x = margin; n.vx *= -0.3; }
      if (n.x > this.width - margin) { n.x = this.width - margin; n.vx *= -0.3; }
      if (n.y < margin)              { n.y = margin; n.vy *= -0.3; }
      if (n.y > this.height - margin){ n.y = this.height - margin; n.vy *= -0.3; }
    }

    this.alpha *= 0.992;
  }

  _radius(n) {
    return 5 + Math.min(12, Math.sqrt(n.degree) * 2.5);
  }

  _draw() {
    const { ctx } = this;
    ctx.clearRect(0, 0, this.width, this.height);

    const visible = this.nodes.filter((n) => this._isVisible(n));
    const hasHover = !!this.hoverNode;
    const hasSelected = !!this.selectedId;
    const focusId = this.hoverNode?.id ?? this.selectedId ?? null;
    const focusedNeighbours = focusId ? this._neighbourSet(focusId) : null;

    // Edges
    for (const e of this.edges) {
      if (!this._isVisible(e.a) || !this._isVisible(e.b)) continue;
      const isFocused = focusId && (e.a.id === focusId || e.b.id === focusId);
      const dimmed = focusId && !isFocused;
      ctx.beginPath();
      ctx.moveTo(e.a.x, e.a.y);
      ctx.lineTo(e.b.x, e.b.y);
      ctx.lineWidth = isFocused ? 1.4 : 0.6;
      ctx.strokeStyle = isFocused
        ? 'rgba(232, 185, 106, 0.7)'
        : dimmed
        ? 'rgba(212, 165, 116, 0.04)'
        : 'rgba(212, 165, 116, 0.18)';
      ctx.stroke();

      // Edge label on hover
      if (this.hoverEdge === e) {
        const mx = (e.a.x + e.b.x) / 2;
        const my = (e.a.y + e.b.y) / 2;
        ctx.font = '500 10px "IBM Plex Mono", monospace';
        const text = e.relation_type;
        const w = ctx.measureText(text).width + 10;
        ctx.fillStyle = 'rgba(11, 14, 15, 0.9)';
        ctx.fillRect(mx - w / 2, my - 9, w, 16);
        ctx.strokeStyle = 'rgba(212, 165, 116, 0.4)';
        ctx.lineWidth = 0.6;
        ctx.strokeRect(mx - w / 2, my - 9, w, 16);
        ctx.fillStyle = '#F0E8D2';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, mx, my);
      }
    }

    // Nodes
    for (const n of visible) {
      const r = this._radius(n);
      const isHover = this.hoverNode === n;
      const isSelected = this.selectedId === n.id;
      const isHighlighted = this.searchHighlight.has(n.id);
      const dimmed = focusId && focusId !== n.id && focusedNeighbours && !focusedNeighbours.has(n.id);
      const color = TYPE_COLORS[n.entity_type] || '#8B8170';

      // Halo for selected / hovered / highlighted
      if (isSelected || isHover || isHighlighted) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + 6, 0, Math.PI * 2);
        ctx.fillStyle = isSelected ? 'rgba(232, 185, 106, 0.18)' : `${color}33`;
        ctx.fill();
      }

      // Outer ring (subtle)
      ctx.beginPath();
      ctx.arc(n.x, n.y, r + 1.5, 0, Math.PI * 2);
      ctx.strokeStyle = dimmed ? 'rgba(60, 56, 46, 0.4)' : 'rgba(14, 17, 18, 0.9)';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Body
      ctx.beginPath();
      ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      ctx.fillStyle = dimmed ? this._dim(color) : color;
      ctx.fill();

      // Inner highlight
      ctx.beginPath();
      ctx.arc(n.x - r * 0.3, n.y - r * 0.3, r * 0.4, 0, Math.PI * 2);
      ctx.fillStyle = dimmed ? 'rgba(255, 255, 255, 0.04)' : 'rgba(255, 255, 255, 0.12)';
      ctx.fill();

      // Label (only for hovered, selected, or large nodes)
      if (isHover || isSelected || (n.degree >= 3 && !focusId)) {
        ctx.font = `italic 12px "Fraunces", "Cormorant Garamond", serif`;
        const text = n.name;
        const tw = ctx.measureText(text).width;
        const tx = n.x;
        const ty = n.y + r + 14;
        ctx.fillStyle = 'rgba(11, 14, 15, 0.85)';
        ctx.fillRect(tx - tw / 2 - 5, ty - 10, tw + 10, 16);
        ctx.fillStyle = isSelected ? '#E8B96A' : '#F0E8D2';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, tx, ty - 1);
      }
    }
  }

  _neighbourSet(id) {
    const set = new Set([id]);
    for (const e of this.edges) {
      if (e.a.id === id) set.add(e.b.id);
      if (e.b.id === id) set.add(e.a.id);
    }
    return set;
  }

  _dim(hex) {
    return hex + '33'; // tack on alpha
  }

  _loop() {
    this._step();
    this._draw();
    requestAnimationFrame(this._loop);
  }

  _hitTest(x, y) {
    // Iterate in reverse so visually-top nodes win
    const visible = this.nodes.filter((n) => this._isVisible(n));
    for (let i = visible.length - 1; i >= 0; i--) {
      const n = visible[i];
      const r = this._radius(n) + 4;
      const dx = x - n.x;
      const dy = y - n.y;
      if (dx * dx + dy * dy <= r * r) return { kind: 'node', node: n };
    }
    // Edges: distance to segment
    for (const e of this.edges) {
      if (!this._isVisible(e.a) || !this._isVisible(e.b)) continue;
      const d = pointToSegment(x, y, e.a.x, e.a.y, e.b.x, e.b.y);
      if (d < 4) return { kind: 'edge', edge: e };
    }
    return null;
  }

  _wireEvents() {
    const c = this.canvas;
    const overlay = $('#hover-legend');

    c.addEventListener('mousemove', (e) => {
      const rect = c.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      if (this.dragNode) {
        this.dragNode.x = x - this.dragOffset[0];
        this.dragNode.y = y - this.dragOffset[1];
        this.dragNode.vx = 0;
        this.dragNode.vy = 0;
        this.alpha = Math.max(this.alpha, 0.5);
        return;
      }

      const hit = this._hitTest(x, y);
      const prevHoverNode = this.hoverNode;
      const prevHoverEdge = this.hoverEdge;
      this.hoverNode = hit?.kind === 'node' ? hit.node : null;
      this.hoverEdge = hit?.kind === 'edge' ? hit.edge : null;

      if (this.hoverNode || this.hoverEdge !== prevHoverEdge || prevHoverNode !== this.hoverNode) {
        this.alpha = Math.max(this.alpha, 0.15);
      }

      // Tooltip
      if (this.hoverNode) {
        c.style.cursor = 'pointer';
        const n = this.hoverNode;
        overlay.innerHTML = `<strong>${escapeHtml(n.name)}</strong><span class="meta">${n.entity_type}${n.degree ? ' · ' + n.degree + ' edge' + (n.degree > 1 ? 's' : '') : ''}</span>`;
        overlay.hidden = false;
        overlay.style.left = `${x}px`;
        overlay.style.top = `${y}px`;
      } else {
        c.style.cursor = this.hoverEdge ? 'pointer' : 'grab';
        overlay.hidden = true;
      }
    });

    c.addEventListener('mouseleave', () => {
      this.hoverNode = null;
      this.hoverEdge = null;
      overlay.hidden = true;
    });

    c.addEventListener('mousedown', (e) => {
      const rect = c.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const hit = this._hitTest(x, y);
      if (hit?.kind === 'node') {
        this.dragNode = hit.node;
        this.dragOffset = [x - hit.node.x, y - hit.node.y];
      }
    });

    c.addEventListener('mouseup', () => {
      this.dragNode = null;
    });

    c.addEventListener('click', (e) => {
      const rect = c.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const hit = this._hitTest(x, y);
      if (hit?.kind === 'node' && this.onSelect) {
        this.onSelect(hit.node);
      }
    });
  }
}

function pointToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// ----- App state ------------------------------------------------------------

const state = {
  snapshot: null,
  typeCounts: {},
  enabledTypes: new Set(ENTITY_TYPES),
  traversal: { depth: 2, direction: 'both' },
};

let graph;

// ----- Settings drawer ------------------------------------------------------

function bindSettings() {
  const drawer = $('#drawer');
  const toggle = $('#settings-toggle');
  const cancel = $('#settings-cancel');
  const form = $('#settings-form');

  function open() {
    $('#setting-base-url').value = settings.baseUrl;
    $('#setting-project').value = settings.projectId;
    $('#setting-user').value = settings.userId;
    $('#setting-token').value = settings.token;
    drawer.hidden = false;
  }
  function close() { drawer.hidden = true; }

  toggle.addEventListener('click', () => (drawer.hidden ? open() : close()));
  cancel.addEventListener('click', close);
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    settings = {
      baseUrl: $('#setting-base-url').value.trim().replace(/\/$/, ''),
      projectId: $('#setting-project').value.trim() || 'default',
      userId: $('#setting-user').value.trim() || 'default',
      token: $('#setting-token').value,
    };
    saveSettings(settings);
    updateScopeDisplay();
    close();
    void refresh();
  });
}

function updateScopeDisplay() {
  $('[data-scope-project]').textContent = settings.projectId;
  $('[data-scope-user]').textContent = settings.userId;
}

// ----- Type filters ---------------------------------------------------------

function renderTypeFilters() {
  const list = $('#type-filters');
  list.innerHTML = '';
  for (const t of ENTITY_TYPES) {
    const count = state.typeCounts[t] ?? 0;
    const item = el('li', {
      class: `legend__item${state.enabledTypes.has(t) ? '' : ' is-off'}`,
      onClick: () => {
        if (state.enabledTypes.has(t)) state.enabledTypes.delete(t);
        else state.enabledTypes.add(t);
        graph.setTypeFilter([...state.enabledTypes]);
        renderTypeFilters();
      },
    }, [
      el('span', { class: 'legend__swatch', style: `--swatch: ${TYPE_COLORS[t]}` }),
      el('span', { class: 'legend__label' }, t.toLowerCase()),
      el('span', { class: 'legend__count' }, String(count)),
    ]);
    list.append(item);
  }
}

// ----- Stats ----------------------------------------------------------------

function renderStats(stats) {
  for (const [key, value] of Object.entries(stats)) {
    const node = document.querySelector(`[data-stat="${key}"]`);
    if (node) animateCount(node, value);
  }
}

// ----- Streams (messages & traces) ------------------------------------------

function renderRecords(preferences, facts) {
  const list = $('#stream-records');
  const total = preferences.length + facts.length;
  $('#stream-records-count').textContent = total;
  list.innerHTML = '';
  if (total === 0) {
    list.append(el('li', { class: 'stream__empty' }, 'No long-term records yet.'));
    return;
  }
  // Interleave by recency. Preferences use updated_at, facts use created_at.
  const items = [
    ...preferences.map((p) => ({ kind: 'pref', when: p.updated_at, row: p })),
    ...facts.map((f) => ({ kind: 'fact', when: f.created_at, row: f })),
  ].sort((a, b) => (a.when < b.when ? 1 : -1));

  for (const item of items) {
    const body = el('span', { class: 'record__body' });
    if (item.kind === 'pref') {
      body.append(
        el('strong', {}, item.row.category),
        document.createTextNode(item.row.preference)
      );
    } else {
      body.append(
        el('strong', {}, item.row.predicate),
        document.createTextNode(`${item.row.subject} → ${item.row.object}`)
      );
    }
    list.append(
      el('li', { class: 'record' }, [
        el('span', { class: 'record__kind', dataset: { kind: item.kind } }, item.kind),
        body,
      ])
    );
  }
}

function renderMessages(messages) {
  const list = $('#stream-messages');
  $('#stream-messages-count').textContent = messages.length;
  list.innerHTML = '';
  if (!messages.length) {
    list.append(el('li', { class: 'stream__empty' }, 'No transmissions yet.'));
    return;
  }
  for (const m of messages) {
    list.append(
      el('li', { class: 'message' }, [
        el('span', { class: 'message__time' }, fmtTime(m.created_at)),
        el('span', { class: 'message__role', dataset: { role: m.role } }, m.role),
        el('span', { class: 'message__content' }, m.content),
      ])
    );
  }
}

function renderTraces(traces) {
  const list = $('#stream-traces');
  $('#stream-traces-count').textContent = traces.length;
  list.innerHTML = '';
  if (!traces.length) {
    list.append(el('li', { class: 'stream__empty' }, 'No reasoning traces recorded.'));
    return;
  }
  for (const t of traces) {
    const successKey = t.success === 1 ? '1' : t.success === 0 ? '0' : '-';
    list.append(
      el('li', { class: 'trace' }, [
        el('span', { class: 'trace__time' }, fmtTime(t.started_at)),
        el('span', { class: 'trace__bullet', dataset: { success: successKey } }),
        el('span', { class: 'trace__task' }, t.task),
        el('span', { class: 'trace__duration' }, fmtDuration(t.duration_ms)),
      ])
    );
  }
}

// ----- Detail panel ---------------------------------------------------------

async function selectEntity(node) {
  graph.setSelected(node.id);
  const detail = $('#detail');
  detail.innerHTML = '';
  const card = el('div', { class: 'detail-card' });

  const color = TYPE_COLORS[node.entity_type] || '#8B8170';
  card.append(el('div', { class: 'detail-card__type', style: `--type: ${color}` }, node.entity_type));
  card.append(el('h2', { class: 'detail-card__name' }, node.name));

  const meta = el('dl', { class: 'detail-card__meta' });
  meta.append(el('dt', {}, 'id'));
  meta.append(el('dd', {}, node.id));
  if (node.subtype) {
    meta.append(el('dt', {}, 'subtype'));
    meta.append(el('dd', {}, node.subtype));
  }
  meta.append(el('dt', {}, 'project'));
  meta.append(el('dd', {}, node.project_id));
  meta.append(el('dt', {}, 'user'));
  meta.append(el('dd', {}, node.user_id));
  meta.append(el('dt', {}, 'updated'));
  meta.append(el('dd', {}, fmtTime(node.updated_at)));
  card.append(meta);

  if (node.description) {
    card.append(el('p', { class: 'detail-card__desc' }, node.description));
  }

  const relSection = el('section', { class: 'detail-section' });
  relSection.append(el('h4', { class: 'detail-section__title' }, [
    'Direct relations',
    el('span', { class: 'count' }, '…'),
  ]));
  const relList = el('ul', { class: 'relation-list' });
  relSection.append(relList);
  card.append(relSection);

  const neighSection = el('section', { class: 'detail-section' });
  neighSection.append(el('h4', { class: 'detail-section__title' }, [
    `Neighbourhood (${state.traversal.direction}, depth ${state.traversal.depth})`,
    el('span', { class: 'count' }, '…'),
  ]));
  const neighList = el('ul', { class: 'neighbour-list' });
  neighSection.append(neighList);
  card.append(neighSection);

  detail.append(card);

  // Fire requests in parallel
  try {
    const [relations, neighbours] = await Promise.all([
      api(`/api/v1/entities/${encodeURIComponent(node.id)}/relations`),
      api(`/api/v1/entities/${encodeURIComponent(node.id)}/traverse`, {
        method: 'POST',
        body: JSON.stringify({
          max_depth: state.traversal.depth,
          direction: state.traversal.direction,
        }),
      }),
    ]);

    relSection.querySelector('.count').textContent = relations.length;
    if (!relations.length) {
      relList.append(el('li', { class: 'relation' }, [
        el('span', { class: 'relation__dir' }, '∅'),
        el('span', { class: 'relation__type' }, 'no edges'),
      ]));
    } else {
      for (const r of relations) {
        const isOut = r.source_entity_id === node.id;
        const otherId = isOut ? r.target_entity_id : r.source_entity_id;
        const other = graph.byId.get(otherId);
        const otherName = other?.name ?? otherId.slice(0, 10) + '…';
        relList.append(el('li', { class: 'relation' }, [
          el('span', { class: `relation__dir ${isOut ? 'out' : 'in'}` }, isOut ? '→' : '←'),
          el('span', { class: 'relation__type' }, [
            r.relation_type,
            ' ',
            el('span', { class: 'relation__strength' }, `(${otherName}, w=${(r.relation_strength ?? 1).toFixed(2)})`),
          ]),
        ]));
      }
    }

    neighSection.querySelector('.count').textContent = neighbours.length;
    if (!neighbours.length) {
      neighList.append(el('li', { class: 'neighbour' }, [
        el('span', { class: 'neighbour__hop' }, '—'),
        el('span', { class: 'neighbour__name' }, 'no neighbours within depth'),
        el('span', { class: 'neighbour__type' }, ''),
      ]));
    } else {
      for (const n of neighbours) {
        const color = TYPE_COLORS[n.entity_type] || '#8B8170';
        const item = el('li', {
          class: 'neighbour',
          onClick: () => {
            const local = graph.byId.get(n.id);
            if (local) selectEntity(local);
          },
        }, [
          el('span', { class: 'neighbour__hop' }, `h${n.hop_distance}`),
          el('span', { class: 'neighbour__name' }, n.name),
          el('span', { class: 'neighbour__type', style: `--type: ${color}` }, n.entity_type),
        ]);
        neighList.append(item);
      }
    }
  } catch (err) {
    showToast(`Failed to load entity detail: ${err.message}`);
  }
}

// ----- Search ---------------------------------------------------------------

let searchTimer = null;

function bindSearch() {
  const input = $('#search-input');
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (!q) {
      graph.setSearchHighlight([]);
      return;
    }
    searchTimer = setTimeout(async () => {
      try {
        const results = await api('/api/v1/entities/search', {
          method: 'POST',
          body: JSON.stringify({ query: q, limit: 10 }),
        });
        graph.setSearchHighlight(results.map((r) => r.id));
      } catch (err) {
        showToast(`Search failed: ${err.message}`);
      }
    }, 250);
  });
}

// ----- Traversal controls ---------------------------------------------------

function bindTraversal() {
  const depth = $('#traverse-depth');
  const depthVal = $('#traverse-depth-value');
  depth.addEventListener('input', () => {
    state.traversal.depth = Number(depth.value);
    depthVal.textContent = depth.value;
  });

  for (const seg of $$('.segment[data-dir]')) {
    seg.addEventListener('click', () => {
      $$('.segment[data-dir]').forEach((s) => {
        s.classList.remove('is-active');
        s.setAttribute('aria-checked', 'false');
      });
      seg.classList.add('is-active');
      seg.setAttribute('aria-checked', 'true');
      state.traversal.direction = seg.dataset.dir;
    });
  }
}

// ----- Refresh / load -------------------------------------------------------

async function refresh() {
  setStatus('loading', 'fetching');
  $('#empty-graph').hidden = true;
  try {
    const snapshot = await api('/api/v1/snapshot?entity_limit=200&relation_limit=500');
    state.snapshot = snapshot;

    const counts = {};
    for (const e of snapshot.entities) {
      counts[e.entity_type] = (counts[e.entity_type] ?? 0) + 1;
    }
    state.typeCounts = counts;

    renderStats(snapshot.stats);
    renderTypeFilters();

    graph.setData(snapshot.entities, snapshot.relations);
    $('#empty-graph').hidden = snapshot.entities.length > 0;

    renderRecords(snapshot.recent_preferences, snapshot.recent_facts);
    renderMessages(snapshot.recent_messages);
    renderTraces(snapshot.recent_traces);

    setStatus('ok', 'connected');
  } catch (err) {
    $('#empty-graph').hidden = false;
    setStatus('error', 'offline');
    showToast(err.message);
  }
}

// ----- Init -----------------------------------------------------------------

function init() {
  graph = new GraphView($('#graph'));
  graph.onSelect = selectEntity;
  bindSettings();
  bindSearch();
  bindTraversal();
  updateScopeDisplay();
  renderTypeFilters();

  $('#refresh').addEventListener('click', () => void refresh());

  document.addEventListener('keydown', (e) => {
    if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      $('#search-input').focus();
    } else if (e.key === 'r' && !e.metaKey && !e.ctrlKey && document.activeElement === document.body) {
      void refresh();
    } else if (e.key === 's' && !e.metaKey && !e.ctrlKey && document.activeElement === document.body) {
      $('#settings-toggle').click();
    } else if (e.key === 'Escape') {
      $('#drawer').hidden = true;
    }
  });

  void refresh();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
