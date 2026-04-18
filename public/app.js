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
    'X-Project-Id': settings.projectId,
    'X-User-Id': settings.userId,
    ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    ...(opts.headers || {}),
  };
  // Send bearer if user explicitly set one — useful for cross-origin / service paths
  if (settings.token) headers['Authorization'] = `Bearer ${settings.token}`;
  const res = await fetch(url, {
    ...opts,
    headers,
    credentials: 'same-origin',  // include the session cookie when same-origin
  });
  if (res.status === 401) {
    showLoginVeil();
    throw new Error('Session expired — please sign in again');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText} — ${text || path}`);
  }
  return res.json();
}

// ----- Auth (browser session) -----------------------------------------------

async function checkAuth() {
  try {
    const res = await fetch((settings.baseUrl || '') + '/auth/me', { credentials: 'same-origin' });
    if (!res.ok) return { authenticated: false, password_required: true };
    return res.json();
  } catch {
    return { authenticated: false, password_required: true };
  }
}

function showLoginVeil() {
  $('#login-veil').hidden = false;
  $('#logout-btn').hidden = true;
  $('#login-error').hidden = true;
  setTimeout(() => $('#login-password')?.focus(), 50);
}

function hideLoginVeil() {
  $('#login-veil').hidden = true;
  $('#logout-btn').hidden = false;
}

async function attemptLogin(password) {
  const errBox = $('#login-error');
  const submit = $('#login-submit');
  errBox.hidden = true;
  submit.disabled = true;
  try {
    const res = await fetch((settings.baseUrl || '') + '/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      errBox.textContent = data.error || `${res.status} ${res.statusText}`;
      errBox.hidden = false;
      return false;
    }
    return true;
  } catch (err) {
    errBox.textContent = err.message;
    errBox.hidden = false;
    return false;
  } finally {
    submit.disabled = false;
  }
}

async function attemptLogout() {
  try {
    await fetch((settings.baseUrl || '') + '/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
    });
  } catch { /* ignore */ }
  showLoginVeil();
}

function bindLogin() {
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw = $('#login-password').value;
    const ok = await attemptLogin(pw);
    if (ok) {
      $('#login-password').value = '';
      hideLoginVeil();
      void refresh();
    }
  });
  $('#logout-btn').addEventListener('click', () => void attemptLogout());
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
  atlas: null,
  view: 'observatory',
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
    toggle.setAttribute('aria-expanded', 'true');
  }
  function close() {
    drawer.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  }

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

function renderMessages(messages) {
  const list = $('#stream-messages');
  $('#stream-messages-count').textContent = messages.length;
  list.innerHTML = '';
  if (!messages.length) {
    list.append(emptyStreamCard('messages'));
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
    list.append(emptyStreamCard('traces'));
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
  card.append(
    el('div', { class: 'detail-card__head' }, [
      el('div', { class: 'detail-card__type', style: `--type: ${color}` }, node.entity_type),
      el('button', {
        type: 'button',
        class: 'record-card__edit',
        onClick: () => openEntityEdit(card, node),
      }, 'edit'),
    ])
  );
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

function openEntityEdit(card, entity) {
  card.classList.add('is-editing');
  card.innerHTML = '';
  const form = el('form', {
    class: 'record-edit',
    onSubmit: async (e) => {
      e.preventDefault();
      const updates = {
        name: form.name.value.trim(),
        subtype: form.subtype.value.trim() || null,
        description: form.description.value.trim() || null,
      };
      try {
        const updated = await api(`/api/v1/entities/${encodeURIComponent(entity.id)}`, {
          method: 'PUT',
          body: JSON.stringify(updates),
        });
        Object.assign(entity, updated);
        // Update the in-graph copy too so the label re-renders
        const local = graph.byId.get(entity.id);
        if (local) {
          local.name = updated.name;
          local.description = updated.description;
        }
        showToast('entity updated', 'success');
        await selectEntity(entity); // re-render the panel
      } catch (err) {
        showToast(err.message);
      }
    },
  });

  form.append(
    field('name', 'name', entity.name),
    field('subtype', 'subtype (optional)', entity.subtype ?? ''),
    fieldText('description', 'description', entity.description ?? ''),
    el('div', { class: 'record-edit__actions' }, [
      el('button', {
        type: 'button',
        class: 'btn btn--ghost',
        onClick: () => { card.classList.remove('is-editing'); selectEntity(entity); },
      }, 'cancel'),
      el('button', { type: 'submit', class: 'btn btn--primary' }, 'save'),
    ])
  );
  card.append(form);
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

// ----- Long-term records (preferences + facts) ------------------------------

function renderRecordsView(preferences, facts) {
  state.preferences = preferences;
  state.facts = facts;
  applyRecordsFilter('prefs');
  applyRecordsFilter('facts');
}

/**
 * Re-render either the preferences or facts list, applying the current
 * search filter. Called on initial render AND on every keystroke in the
 * search input — cheap because we only ever paint visible cards.
 */
function applyRecordsFilter(which) {
  const isPref = which === 'prefs';
  const all = isPref ? state.preferences ?? [] : state.facts ?? [];
  const list = $(isPref ? '#records-prefs' : '#records-facts');
  const countNode = $(isPref ? '#records-prefs-count' : '#records-facts-count');
  const input = $(isPref ? '#search-prefs' : '#search-facts');
  const query = input?.value ?? '';

  const matched = all.filter((row) => matchesQuery(query, isPref ? prefSearchText(row) : factSearchText(row)));

  list.innerHTML = '';

  if (query) {
    countNode.dataset.filtered = 'true';
    countNode.dataset.shown = String(matched.length);
    countNode.dataset.total = String(all.length);
    countNode.textContent = '';
  } else {
    delete countNode.dataset.filtered;
    countNode.textContent = String(all.length);
  }

  if (!all.length) {
    list.append(emptyScopeCard(isPref ? 'preferences' : 'facts'));
    return;
  }

  if (!matched.length) {
    list.append(
      el('li', { class: 'records__empty' }, [
        el('p', { style: 'margin: 0;' }, [
          'Nothing matches ',
          el('code', { style: 'color: var(--hot); font-style: normal;' }, query),
          '.',
        ]),
      ])
    );
    return;
  }

  for (const row of matched) {
    list.append(isPref ? renderPreferenceCard(row) : renderFactCard(row));
  }
}

function prefSearchText(p) {
  return [p.category, p.preference, p.context ?? ''].join(' ').toLowerCase();
}

function factSearchText(f) {
  return [f.subject, f.predicate, f.object, f.source ?? ''].join(' ').toLowerCase();
}

/**
 * Multi-token "fuzzy" filter: every whitespace-split token of the query
 * must appear as a case-insensitive substring somewhere in the haystack.
 * Empty query matches everything.
 */
function matchesQuery(query, haystack) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const tokens = q.split(/\s+/);
  return tokens.every((t) => haystack.includes(t));
}

function bindRecordsSearch() {
  const debounce = (fn, ms) => {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  };
  const onPrefs = debounce(() => applyRecordsFilter('prefs'), 100);
  const onFacts = debounce(() => applyRecordsFilter('facts'), 100);
  $('#search-prefs')?.addEventListener('input', onPrefs);
  $('#search-facts')?.addEventListener('input', onFacts);
}

function emptyStreamCard(thing) {
  const wrap = el('li', { class: 'stream__empty' });
  wrap.append(
    el('div', { style: 'margin-bottom: 4px;' }, [
      'No ', thing, ' in ',
      el('code', { style: 'color: var(--long); font-style: normal;' }, settings.projectId),
      ' / ',
      el('code', { style: 'color: var(--short); font-style: normal;' }, settings.userId),
      '.',
    ]),
    el('div', { style: 'font-size: 11px;' }, [
      el('button', {
        style: 'background:none;border:none;color:var(--long);font-style:italic;cursor:pointer;padding:0;text-decoration:underline;text-decoration-color:var(--rule-warm);text-underline-offset:3px;font-family:inherit;font-size:inherit;',
        onClick: () => { switchView('atlas'); void loadAtlas(); },
      }, 'Open Atlas →'),
    ])
  );
  return wrap;
}

function emptyScopeCard(thing) {
  const wrap = el('li', { class: 'records__empty' });
  wrap.append(
    el('p', { style: 'margin: 0 0 8px;' }, [
      'No ', thing, ' in scope ',
      el('code', { style: 'font-style: normal; color: var(--long);' }, settings.projectId),
      ' / ',
      el('code', { style: 'font-style: normal; color: var(--short);' }, settings.userId),
      '.'
    ]),
    el('p', { style: 'margin: 0; font-size: 12px;' }, [
      'Open the ',
      el('button', {
        style: 'background:none;border:none;color:var(--long);font-style:italic;cursor:pointer;padding:0;text-decoration:underline;text-decoration-color:var(--rule-warm);text-underline-offset:3px;font-family:inherit;font-size:inherit;',
        onClick: () => { switchView('atlas'); void loadAtlas(); },
      }, 'Atlas'),
      ' to find a populated scope.',
    ])
  );
  return wrap;
}

function renderPreferenceCard(p) {
  const card = el('li', { class: 'record-card', dataset: { flavor: 'pref', id: p.id } });
  card._render = () => {
    card.innerHTML = '';
    card.append(
      el('div', { class: 'record-card__head' }, [
        el('span', { class: 'record-card__category' }, p.category),
        el('button', {
          class: 'record-card__edit',
          type: 'button',
          onClick: () => openPreferenceEdit(card, p),
        }, 'edit'),
      ]),
      el('p', { class: 'record-card__body' }, p.preference)
    );
    if (p.context) {
      card.append(el('p', { class: 'record-card__context' }, p.context));
    }
    const meta = el('dl', { class: 'record-card__meta' });
    meta.append(
      el('dt', {}, 'confidence'),
      el('dd', {}, (p.confidence ?? 1).toFixed(2)),
      el('dt', {}, 'updated'),
      el('dd', {}, fmtTime(p.updated_at)),
    );
    if (p.promoted_from) {
      meta.append(el('dt', {}, 'promoted from'), el('dd', {}, p.promoted_from));
    }
    card.append(meta);
  };
  card._render();
  return card;
}

function openPreferenceEdit(card, p) {
  card.classList.add('is-editing');
  const initial = card._patch ? { ...p, ...card._patch } : p;
  card.innerHTML = '';
  const form = el('form', {
    class: 'record-edit',
    onSubmit: async (e) => {
      e.preventDefault();
      const updates = {
        category: form.category.value.trim(),
        preference: form.preference.value.trim(),
        context: form.context.value.trim() || null,
        confidence: Number(form.confidence.value),
      };
      try {
        const updated = await api(`/api/v1/preferences/${encodeURIComponent(p.id)}`, {
          method: 'PUT',
          body: JSON.stringify(updates),
        });
        Object.assign(p, updated);
        card.classList.remove('is-editing');
        card._render();
        showToast('preference updated', 'success');
      } catch (err) {
        showToast(err.message);
      }
    },
  });

  form.append(
    field('category', 'category', initial.category),
    fieldText('preference', 'preference', initial.preference),
    fieldText('context', 'context', initial.context ?? ''),
    el('div', { class: 'record-edit__field-row' }, [
      field('confidence', 'confidence (0–1)', String(initial.confidence ?? 1), { type: 'number', min: '0', max: '1', step: '0.01' }),
    ]),
    el('div', { class: 'record-edit__actions' }, [
      el('button', {
        type: 'button',
        class: 'btn btn--ghost',
        onClick: () => { card.classList.remove('is-editing'); card._render(); },
      }, 'cancel'),
      el('button', { type: 'submit', class: 'btn btn--primary' }, 'save'),
    ])
  );

  card.append(form);
}

function renderFactCard(f) {
  const card = el('li', { class: 'record-card', dataset: { flavor: 'fact', id: f.id } });
  card._render = () => {
    card.innerHTML = '';
    card.append(
      el('div', { class: 'record-card__head' }, [
        el('span', { class: 'record-card__category' }, 'fact'),
        el('button', {
          class: 'record-card__edit',
          type: 'button',
          onClick: () => openFactEdit(card, f),
        }, 'edit'),
      ]),
      el('div', { class: 'record-card__triple' }, [
        el('span', { class: 'record-card__subject' }, f.subject),
        el('span', { class: 'record-card__predicate' }, f.predicate),
        el('span', { class: 'record-card__object' }, f.object),
      ]),
    );
    const meta = el('dl', { class: 'record-card__meta' });
    meta.append(el('dt', {}, 'confidence'), el('dd', {}, (f.confidence ?? 1).toFixed(2)));
    if (f.source) meta.append(el('dt', {}, 'source'), el('dd', {}, f.source));
    if (f.valid_from) meta.append(el('dt', {}, 'from'), el('dd', {}, fmtTime(f.valid_from)));
    if (f.valid_until) meta.append(el('dt', {}, 'until'), el('dd', {}, fmtTime(f.valid_until)));
    meta.append(el('dt', {}, 'recorded'), el('dd', {}, fmtTime(f.created_at)));
    card.append(meta);
  };
  card._render();
  return card;
}

function openFactEdit(card, f) {
  card.classList.add('is-editing');
  card.innerHTML = '';
  const form = el('form', {
    class: 'record-edit',
    onSubmit: async (e) => {
      e.preventDefault();
      const updates = {
        subject: form.subject.value.trim(),
        predicate: form.predicate.value.trim(),
        object: form.object.value.trim(),
        confidence: Number(form.confidence.value),
        source: form.source.value.trim() || null,
        valid_from: form.valid_from.value.trim() || null,
        valid_until: form.valid_until.value.trim() || null,
      };
      try {
        const updated = await api(`/api/v1/facts/${encodeURIComponent(f.id)}`, {
          method: 'PUT',
          body: JSON.stringify(updates),
        });
        Object.assign(f, updated);
        card.classList.remove('is-editing');
        card._render();
        showToast('fact updated', 'success');
      } catch (err) {
        showToast(err.message);
      }
    },
  });

  form.append(
    el('div', { class: 'record-edit__field-row' }, [
      field('subject', 'subject', f.subject),
      field('predicate', 'predicate', f.predicate),
      field('confidence', 'confidence', String(f.confidence ?? 1), { type: 'number', min: '0', max: '1', step: '0.01' }),
    ]),
    fieldText('object', 'object', f.object),
    field('source', 'source (optional)', f.source ?? ''),
    el('div', { class: 'record-edit__field-row' }, [
      field('valid_from', 'valid from (ISO, optional)', f.valid_from ?? ''),
      field('valid_until', 'valid until (ISO, optional)', f.valid_until ?? ''),
    ]),
    el('div', { class: 'record-edit__actions' }, [
      el('button', {
        type: 'button',
        class: 'btn btn--ghost',
        onClick: () => { card.classList.remove('is-editing'); card._render(); },
      }, 'cancel'),
      el('button', { type: 'submit', class: 'btn btn--primary' }, 'save'),
    ])
  );

  card.append(form);
}

function field(name, label, value, attrs = {}) {
  const wrap = el('div', { class: 'record-edit__field' });
  wrap.append(el('label', { for: `f-${name}` }, label));
  wrap.append(el('input', { id: `f-${name}`, name, value, ...attrs }));
  return wrap;
}

function fieldText(name, label, value) {
  const wrap = el('div', { class: 'record-edit__field' });
  wrap.append(el('label', { for: `f-${name}` }, label));
  const ta = el('textarea', { id: `f-${name}`, name, rows: '3' }, value);
  ta.value = value;
  wrap.append(ta);
  return wrap;
}

// ----- Atlas view -----------------------------------------------------------

function renderAtlas(atlas) {
  $('#atlas-projects-count').textContent = atlas.projects.length;
  $('#atlas-users-count').textContent = atlas.users.length;
  renderProjectCards(atlas.projects);
  renderUserCards(atlas.users);
}

function renderProjectCards(projects) {
  const list = $('#atlas-projects');
  list.innerHTML = '';
  if (!projects.length) {
    list.append(el('li', { class: 'stream__empty' }, 'No projects registered yet.'));
    return;
  }
  for (const p of projects) {
    const total = p.entities + p.sessions + p.traces + p.preferences + p.facts;
    const isActive = p.id === settings.projectId;
    const flavor = p.id === 'global' ? 'global' : 'project';
    const item = el('li', {
      class: `card${total === 0 ? ' is-empty' : ''}${isActive ? ' is-active' : ''}`,
      dataset: { flavor },
    }, [
      el('div', { class: 'card__head' }, [
        el('span', { class: 'card__name' }, p.display_name || p.id),
        el('span', { class: 'card__id' }, p.id),
      ]),
      el('div', { class: 'card__metrics' }, [
        metric('entities', p.entities),
        metric('sessions', p.sessions),
        metric('traces', p.traces),
        metric('prefs', p.preferences),
        metric('facts', p.facts),
        metric('users', p.user_count),
      ]),
      el('div', { class: 'card__foot' }, [
        el('span', {}, `created ${fmtTime(p.created_at)}`),
        p.last_activity
          ? el('em', {}, `last touched ${fmtTime(p.last_activity)}`)
          : el('em', {}, 'no activity'),
      ]),
    ]);

    // Click anywhere on the card body to set just the project (keeps current user)
    item.addEventListener('click', (e) => {
      // Ignore clicks that originated on a chip (chips have their own handler)
      if (e.target instanceof HTMLElement && e.target.closest('.chip')) return;
      applyScope(p.id, settings.userId, 'project');
    });

    if (p.users_present && p.users_present.length > 0) {
      item.append(buildChipRow('users in', p.users_present, settings.userId, (uid) =>
        applyScope(p.id, uid, 'both')
      ));
    }

    list.append(item);
  }
}

function renderUserCards(users) {
  const list = $('#atlas-users');
  list.innerHTML = '';
  if (!users.length) {
    list.append(el('li', { class: 'stream__empty' }, 'No users registered yet.'));
    return;
  }
  for (const u of users) {
    const total = u.entities + u.sessions + u.traces;
    const isActive = u.id === settings.userId;
    const item = el('li', {
      class: `card${total === 0 ? ' is-empty' : ''}${isActive ? ' is-active' : ''}`,
      dataset: { flavor: 'user' },
    }, [
      el('div', { class: 'card__head' }, [
        el('span', { class: 'card__name' }, u.display_name || u.id),
        el('span', { class: 'card__id' }, u.id),
      ]),
      el('div', { class: 'card__metrics' }, [
        metric('entities', u.entities),
        metric('sessions', u.sessions),
        metric('traces', u.traces),
        metric('projects', u.project_count),
      ]),
      el('div', { class: 'card__foot' }, [
        el('span', {}, `created ${fmtTime(u.created_at)}`),
        u.last_activity
          ? el('em', {}, `last touched ${fmtTime(u.last_activity)}`)
          : el('em', {}, 'no activity'),
      ]),
    ]);

    item.addEventListener('click', (e) => {
      if (e.target instanceof HTMLElement && e.target.closest('.chip')) return;
      applyScope(settings.projectId, u.id, 'user');
    });

    if (u.projects_present && u.projects_present.length > 0) {
      item.append(buildChipRow('projects with', u.projects_present, settings.projectId, (pid) =>
        applyScope(pid, u.id, 'both')
      ));
    }

    list.append(item);
  }
}

function buildChipRow(label, ids, activeId, onPick) {
  const MAX_VISIBLE = 8;
  const visible = ids.slice(0, MAX_VISIBLE);
  const overflow = ids.length - visible.length;
  const row = el('div', { class: 'card__chips' });
  row.append(el('span', { class: 'card__chips-label' }, label));
  for (const id of visible) {
    row.append(
      el('button', {
        type: 'button',
        class: `chip${id === activeId ? ' is-active' : ''}`,
        onClick: (e) => { e.stopPropagation(); onPick(id); },
      }, id)
    );
  }
  if (overflow > 0) {
    row.append(el('span', { class: 'chip chip--more' }, `+${overflow}`));
  }
  return row;
}

/**
 * Set the active scope and route to Observatory.
 * `which` only affects the toast wording so the user knows what changed.
 */
function applyScope(projectId, userId, which) {
  const changed =
    (projectId !== settings.projectId ? 1 : 0) +
    (userId !== settings.userId ? 1 : 0);
  settings = { ...settings, projectId, userId };
  saveSettings(settings);
  updateScopeDisplay();
  switchView('observatory');
  if (changed === 0) {
    showToast(`already on ${projectId} / ${userId}`, 'info');
  } else if (which === 'both' || changed === 2) {
    showToast(`scope set to ${projectId} / ${userId}`, 'info');
  } else if (which === 'project') {
    showToast(`project → ${projectId}`, 'info');
  } else {
    showToast(`user → ${userId}`, 'info');
  }
  void refresh();
}

function metric(label, value) {
  return el('div', { class: 'card__metric' }, [
    el('span', { class: 'card__metric-label' }, label),
    el('span', { class: 'card__metric-value' }, String(value)),
  ]);
}

function switchView(view) {
  state.view = view;
  for (const btn of $$('.view-switch__btn')) {
    const isActive = btn.dataset.view === view;
    btn.classList.toggle('is-active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
  }
  for (const pane of $$('[data-view-pane]')) {
    pane.hidden = pane.dataset.viewPane !== view;
  }
  const title = document.querySelector('[data-title-primary]');
  if (title) title.textContent = view === 'atlas' ? 'Atlas' : 'Observatory';
}

async function loadAtlas() {
  setStatus('loading', 'fetching');
  try {
    const atlas = await api('/api/v1/atlas');
    state.atlas = atlas;
    renderAtlas(atlas);
    setStatus('ok', 'connected');
  } catch (err) {
    setStatus('error', 'offline');
    showToast(`Atlas failed: ${err.message}`);
  }
}

function bindViewSwitch() {
  for (const btn of $$('.view-switch__btn')) {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      switchView(view);
      if (view === 'atlas') void loadAtlas();
    });
  }
}

// ----- Refresh / load -------------------------------------------------------

async function refresh() {
  setStatus('loading', 'fetching');
  $('#empty-graph').hidden = true;
  try {
    // Snapshot covers the graph + stream tiers; full prefs/facts come from
    // their list endpoints so the inline Records section can show everything,
    // not just the first 15.
    const [snapshot, preferences, facts] = await Promise.all([
      api('/api/v1/snapshot?entity_limit=200&relation_limit=500'),
      api('/api/v1/preferences'),
      api('/api/v1/facts'),
    ]);
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

    renderMessages(snapshot.recent_messages);
    renderTraces(snapshot.recent_traces);
    renderRecordsView(preferences, facts);

    setStatus('ok', 'connected');
  } catch (err) {
    $('#empty-graph').hidden = false;
    setStatus('error', 'offline');
    showToast(err.message);
  }
}

// ----- Init -----------------------------------------------------------------

async function init() {
  graph = new GraphView($('#graph'));
  graph.onSelect = selectEntity;
  bindSettings();
  bindSearch();
  bindTraversal();
  bindViewSwitch();
  bindRecordsSearch();
  bindLogin();
  updateScopeDisplay();
  renderTypeFilters();

  // Gate the rest of init() on a successful auth check
  const auth = await checkAuth();
  if (!auth.authenticated) {
    showLoginVeil();
    return;
  }
  hideLoginVeil();

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
      $('#settings-toggle').setAttribute('aria-expanded', 'false');
    }
  });

  void refresh();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
