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
  live: true,
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
  SELF: '#E8D8B0',
  FACT: '#D4A574',
  PREF: '#E8D8B0',
};

// The "You" graph node is a client-side synthetic — it does not exist
// in D1, but anchors the preferences for the current (project, user)
// scope so they live on the graph alongside everything else.
const SELF_NODE_ID = '__you__';

function buildSelfNode() {
  return {
    id: SELF_NODE_ID,
    name: 'You',
    entity_type: 'SELF',
    subtype: null,
    description: `Preferences for ${settings.userId} in ${settings.projectId}. Click to view.`,
    project_id: settings.projectId,
    user_id: settings.userId,
    updated_at: new Date().toISOString(),
    __synthetic: true,
  };
}

function normalizeName(s) {
  return (s ?? '').trim().toLowerCase();
}

// Synthetic diamond nodes representing facts and preferences on the
// graph. Anchored facts get a thin edge to their subject entity;
// unanchored facts float free. Preferences orbit the "You" node.
function buildFactNode(fact) {
  return {
    id: `__fact__${fact.id}`,
    name: fact.object ?? '',
    entity_type: 'FACT',
    subtype: null,
    description: `${fact.subject} · ${fact.predicate} · ${fact.object}`,
    project_id: fact.project_id,
    user_id: fact.user_id,
    updated_at: fact.created_at,
    __synthetic: true,
    __factNode: true,
    __fact: fact,
  };
}

function buildFactEdge(fact, subjectEntityId) {
  return {
    id: `__fact_edge__${fact.id}`,
    source_entity_id: subjectEntityId,
    target_entity_id: `__fact__${fact.id}`,
    relation_type: fact.predicate,
    relation_strength: 0.3,
    __factEdge: true,
  };
}

function buildPrefNode(pref) {
  return {
    id: `__pref__${pref.id}`,
    name: pref.preference ?? '',
    entity_type: 'PREF',
    subtype: pref.category,
    description: pref.preference + (pref.context ? `\n\n${pref.context}` : ''),
    project_id: pref.project_id,
    user_id: pref.user_id,
    updated_at: pref.updated_at,
    __synthetic: true,
    __prefNode: true,
    __pref: pref,
  };
}

function buildPrefEdge(pref) {
  return {
    id: `__pref_edge__${pref.id}`,
    source_entity_id: SELF_NODE_ID,
    target_entity_id: `__pref__${pref.id}`,
    relation_type: pref.category,
    relation_strength: 0.3,
    __prefEdge: true,
  };
}

/**
 * Recompute the full graph node + edge lists from the current state
 * and push them to the GraphView. Called from refresh() after a load
 * and from the overlay toggle — rebuilding is cheap compared to the
 * perception cost of the sim re-settling, and keeps this as the one
 * source of truth for what's on the canvas.
 */
function rebuildGraphFromState() {
  const snapshot = state.snapshot;
  if (!snapshot) return;

  // Decorate entities with a child count so the renderer can draw a
  // small presence indicator without re-querying the fact index.
  const selfCount = state.preferences?.length ?? 0;
  const entities = [{ ...buildSelfNode(), __childCount: selfCount }];
  for (const e of snapshot.entities) {
    const count = state.factIndex?.byEntity.get(e.id)?.length ?? 0;
    entities.push({ ...e, __childCount: count });
  }
  const relations = [...snapshot.relations];

  if (state.showFacts) {
    // Seed diamonds on a ring around their parent so they don't all
    // pile on top and then shove each other apart when the bloom hits.
    const seedOnRing = (parent, index, total) => {
      if (!parent) return {};
      const angle = (index / Math.max(1, total)) * Math.PI * 2;
      const d = 48 + Math.random() * 18;
      return {
        _seedX: parent.x + Math.cos(angle) * d,
        _seedY: parent.y + Math.sin(angle) * d,
      };
    };

    for (const [entityId, entityFacts] of state.factIndex?.byEntity ?? []) {
      const parent = graph?.byId?.get(entityId);
      let i = 0;
      for (const f of entityFacts) {
        entities.push({
          ...buildFactNode(f),
          __bloomsFrom: entityId,
          ...seedOnRing(parent, i, entityFacts.length),
        });
        relations.push(buildFactEdge(f, entityId));
        i++;
      }
    }
    for (const f of state.factIndex?.unanchored ?? []) {
      entities.push({ ...buildFactNode(f), __bloomsFrom: '__unanchored__' });
    }
    const youNode = graph?.byId?.get(SELF_NODE_ID);
    const prefList = state.preferences ?? [];
    let pi = 0;
    for (const p of prefList) {
      entities.push({
        ...buildPrefNode(p),
        __bloomsFrom: SELF_NODE_ID,
        ...seedOnRing(youNode, pi, prefList.length),
      });
      relations.push(buildPrefEdge(p));
      pi++;
    }
  }

  graph.setData(entities, relations);
  graph.alpha = 1;
}

/**
 * Group facts by the entity their `subject` refers to. Subjects are
 * free text in the schema, so we match them to entity names with an
 * exact case-normalized comparison — a fuzzy pass could be added later
 * if the unanchored rate turns out high.
 *
 * Returns { byEntity, unanchored } where byEntity is a Map keyed by
 * entity.id and unanchored holds facts we couldn't place.
 */
function buildFactIndex(facts, entities) {
  const byName = new Map();
  for (const e of entities) {
    if (e.__synthetic) continue;
    byName.set(normalizeName(e.name), e.id);
  }
  const byEntity = new Map();
  const unanchored = [];
  for (const f of facts ?? []) {
    const hit = byName.get(normalizeName(f.subject));
    if (hit) {
      if (!byEntity.has(hit)) byEntity.set(hit, []);
      byEntity.get(hit).push(f);
    } else {
      unanchored.push(f);
    }
  }
  return { byEntity, unanchored };
}

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
    this.showFacts = false;
    this.asOfMs = null;
    this.dpr = window.devicePixelRatio || 1;
    this.fit();
    window.addEventListener('resize', () => this.fit());
    // window.resize misses layout-driven resizes — e.g. the detail rail
    // populating and pushing the chart row taller. Observe the canvas
    // itself so the backing store re-fits on any container size change.
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObserver = new ResizeObserver(() => this.fit());
      this._resizeObserver.observe(this.canvas);
    }
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
        x: old?.x ?? e._seedX ?? cx + Math.cos(angle) * r * (0.6 + Math.random() * 0.4),
        y: old?.y ?? e._seedY ?? cy + Math.sin(angle) * r * (0.6 + Math.random() * 0.4),
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
    // Tiny re-heat — the diamonds are ring-seeded near their parent so
    // the sim really only needs a gentle push to settle.
    this.alpha = Math.max(this.alpha, 0.14);
  }

  setShowFacts(on) {
    this.showFacts = !!on;
    this.alpha = Math.max(this.alpha, 0.12);
  }

  setAsOfMs(ms) {
    this.asOfMs = ms;
    this.alpha = Math.max(this.alpha, 0.12);
  }

  _isVisible(n) {
    if (!this._passesAsOf(n)) return false;
    // Diamond bloom gating: a fact/pref diamond only materialises when
    // its bloom source is the current selection's anchor (or for
    // unanchored facts, always).
    if (n.__bloomsFrom !== undefined) {
      if (n.__bloomsFrom === '__unanchored__') return true;
      return n.__bloomsFrom === this._bloomAnchor();
    }
    if (n.__synthetic) return true;
    return this.typeFilter.has(n.entity_type);
  }

  _passesAsOf(n) {
    if (this.asOfMs == null) return true;
    // The synthetic You node has no real creation time — it represents
    // the user scope and should always be present when the overlay is on.
    if (n.entity_type === 'SELF') return true;
    const created = this._nodeCreatedMs(n);
    if (created == null) return true;
    return created <= this.asOfMs;
  }

  _nodeCreatedMs(n) {
    if (n.__factNode && n.__fact) return Date.parse(n.__fact.created_at);
    if (n.__prefNode && n.__pref) return Date.parse(n.__pref.created_at);
    if (n.created_at) return Date.parse(n.created_at);
    return null;
  }

  _bloomAnchor() {
    if (!this.selectedId) return null;
    const sel = this.byId.get(this.selectedId);
    if (!sel) return null;
    // If a diamond is selected, the bloom stays anchored to its parent
    // entity — clicking a fact doesn't hide the other facts beside it.
    if (sel.__bloomsFrom !== undefined) return sel.__bloomsFrom;
    return sel.id;
  }

  _step() {
    const nodes = this.nodes.filter((n) => this._isVisible(n));
    if (!nodes.length) return;

    const REPULSION = 7000;
    const LINK_DIST = 100;
    const LINK_K = 0.06;
    const CENTER_K = 0.008;
    const FRICTION = 0.78;
    // Brownian noise — scaled so there's always a faint ambient drift
    // even when alpha floors, giving the graph a sense of life without
    // the larger post-bloom swings.
    const NOISE = 0.9;

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

    // Integrate (with ambient jitter so equilibrium isn't dead-still).
    for (const n of nodes) {
      if (n === this.dragNode) continue;
      n.vx += (Math.random() - 0.5) * NOISE;
      n.vy += (Math.random() - 0.5) * NOISE;
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

    // Decay toward a gentle floor so bloom kicks fade but ambient
    // drift never completely stops.
    this.alpha = Math.max(0.045, this.alpha * 0.955);
  }

  _radius(n) {
    if (n.__factNode || n.__prefNode) return 4;
    return 5 + Math.min(12, Math.sqrt(n.degree) * 2.5);
  }

  _draw() {
    const { ctx } = this;
    ctx.clearRect(0, 0, this.width, this.height);

    const now = performance.now();
    const FADE_MS = 380;
    // Track per-node visibility epoch so newly-visible nodes (and
    // their edges) ease in from opacity 0 instead of popping.
    for (const n of this.nodes) {
      const vis = this._isVisible(n);
      if (vis) {
        if (n._visibleSinceT == null) n._visibleSinceT = now;
      } else {
        n._visibleSinceT = null;
      }
    }
    const fadeOf = (n) => {
      if (n._visibleSinceT == null) return 0;
      return Math.min(1, (now - n._visibleSinceT) / FADE_MS);
    };

    const visible = this.nodes.filter((n) => this._isVisible(n));
    const hasHover = !!this.hoverNode;
    const hasSelected = !!this.selectedId;
    const focusId = this.hoverNode?.id ?? this.selectedId ?? null;
    const focusedNeighbours = focusId ? this._neighbourSet(focusId) : null;

    // Edges
    for (const e of this.edges) {
      if (!this._isVisible(e.a) || !this._isVisible(e.b)) continue;
      const edgeFade = Math.min(fadeOf(e.a), fadeOf(e.b));
      ctx.globalAlpha = edgeFade;
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

    ctx.globalAlpha = 1;

    // Nodes
    for (const n of visible) {
      const fade = fadeOf(n);
      ctx.globalAlpha = fade;
      const r = this._radius(n);
      const isHover = this.hoverNode === n;
      const isSelected = this.selectedId === n.id;
      const isHighlighted = this.searchHighlight.has(n.id);
      const dimmed = focusId && focusId !== n.id && focusedNeighbours && !focusedNeighbours.has(n.id);
      const color = TYPE_COLORS[n.entity_type] || '#8B8170';
      const isDiamond = !!(n.__factNode || n.__prefNode);

      // Halo for selected / hovered / highlighted
      if (isSelected || isHover || isHighlighted) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, r + 6, 0, Math.PI * 2);
        ctx.fillStyle = isSelected ? 'rgba(232, 185, 106, 0.18)' : `${color}33`;
        ctx.fill();
      }

      if (isDiamond) {
        // Diamond (rotated square) for fact and preference nodes.
        const rr = r + 1.5;
        ctx.beginPath();
        ctx.moveTo(n.x, n.y - rr);
        ctx.lineTo(n.x + rr, n.y);
        ctx.lineTo(n.x, n.y + rr);
        ctx.lineTo(n.x - rr, n.y);
        ctx.closePath();
        ctx.strokeStyle = dimmed ? 'rgba(60, 56, 46, 0.4)' : 'rgba(14, 17, 18, 0.9)';
        ctx.lineWidth = 1.25;
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(n.x, n.y - r);
        ctx.lineTo(n.x + r, n.y);
        ctx.lineTo(n.x, n.y + r);
        ctx.lineTo(n.x - r, n.y);
        ctx.closePath();
        ctx.fillStyle = dimmed ? this._dim(color) : color;
        ctx.fill();
      } else {
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

        // Presence indicator — a small brass dot telling the user this
        // entity has facts (or preferences for the You node). Hidden
        // when the entity is already the bloom anchor, since its
        // diamonds are already visible.
        if (this.showFacts && n.__childCount > 0 && this._bloomAnchor() !== n.id) {
          ctx.beginPath();
          ctx.arc(n.x + r * 0.72, n.y - r * 0.72, 2.4, 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(212, 165, 116, 0.85)';
          ctx.fill();
        }
      }

      // Label (only for hovered, selected, or large nodes).
      if (isHover || isSelected || (!isDiamond && n.degree >= 3 && !focusId)) {
        ctx.font = `italic 12px "Fraunces", "Cormorant Garamond", serif`;
        const raw = n.name || '';
        const text = raw.length > 48 ? raw.slice(0, 47) + '…' : raw;
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

    ctx.globalAlpha = 1;
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
      this.hoverNode = hit?.kind === 'node' ? hit.node : null;
      this.hoverEdge = hit?.kind === 'edge' ? hit.edge : null;
      // Hover doesn't change graph structure; the rAF loop redraws
      // every frame regardless of alpha, so there's no need to
      // re-heat the sim on mousemove.

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
      } else if (!hit && this.onDeselect) {
        this.onDeselect();
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

// ----- Timeline view --------------------------------------------------------
//
// One horizontal band with three lanes (long/short/proc), each entry plotted
// at its created_at. Traces draw as a bar from started_at to completed_at.
// A draggable cursor filters the rest of the view to an "as-of-time" slice.

const TL_PAD_LEFT = 16;
const TL_PAD_RIGHT = 16;
// Lane y-coordinates (canvas is 90px tall; axis labels at bottom).
const TL_LANE_Y = { long: 20, short: 38, proc: 56 };
const TL_AXIS_Y = 72;
const TL_TIER_COLOR = { long: '#D4A574', short: '#8FB892', proc: '#A87C9F' };

class TimelineView {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.items = [];
    this.domainStart = 0;
    this.domainEnd = 0;
    this.cursorMs = null;
    this.hoverItem = null;
    this.dpr = window.devicePixelRatio || 1;
    this.onPickItem = null;
    this.onCursorChange = null;
    this._scrubbing = false;
    this.fit();
    this._wire();
    window.addEventListener('resize', () => { this.fit(); this._draw(); });
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => { this.fit(); this._draw(); });
      this._ro.observe(this.canvas);
    }
  }

  fit() {
    const rect = this.canvas.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;
    this.canvas.width = rect.width * this.dpr;
    this.canvas.height = rect.height * this.dpr;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  setItems(items) {
    this.items = items;
    if (items.length) {
      const now = Date.now();
      const times = items.flatMap((i) => [i.timestampMs, i.endMs ?? i.timestampMs]);
      const earliest = Math.min(...times);
      const latest = Math.max(now, ...times);
      const span = Math.max(60_000, latest - earliest); // at least 1 min wide
      this.domainStart = earliest - span * 0.04;
      this.domainEnd = latest + span * 0.02;
    } else {
      this.domainEnd = Date.now();
      this.domainStart = this.domainEnd - 86_400_000;
    }
    this._draw();
  }

  setCursor(ms) {
    this.cursorMs = ms;
    this._draw();
  }

  xForMs(ms) {
    const span = this.domainEnd - this.domainStart;
    if (span <= 0) return TL_PAD_LEFT;
    const inner = this.width - TL_PAD_LEFT - TL_PAD_RIGHT;
    return ((ms - this.domainStart) / span) * inner + TL_PAD_LEFT;
  }
  msForX(x) {
    const inner = this.width - TL_PAD_LEFT - TL_PAD_RIGHT;
    if (inner <= 0) return this.domainEnd;
    const t = Math.max(0, Math.min(1, (x - TL_PAD_LEFT) / inner));
    return this.domainStart + t * (this.domainEnd - this.domainStart);
  }

  _draw() {
    const { ctx } = this;
    ctx.clearRect(0, 0, this.width, this.height);

    // Lane separators (faint dashed lines across the canvas).
    ctx.strokeStyle = 'rgba(212, 165, 116, 0.08)';
    ctx.lineWidth = 1;
    for (const y of Object.values(TL_LANE_Y)) {
      ctx.beginPath();
      ctx.moveTo(TL_PAD_LEFT, y);
      ctx.lineTo(this.width - TL_PAD_RIGHT, y);
      ctx.stroke();
    }

    // Axis
    ctx.strokeStyle = 'rgba(212, 165, 116, 0.2)';
    ctx.beginPath();
    ctx.moveTo(TL_PAD_LEFT, TL_AXIS_Y);
    ctx.lineTo(this.width - TL_PAD_RIGHT, TL_AXIS_Y);
    ctx.stroke();

    // Ticks
    this._drawTicks();

    // Items
    const cursor = this.cursorMs;
    for (const it of this.items) {
      const faded = cursor != null && it.timestampMs > cursor;
      this._drawItem(it, faded);
    }

    // Scrubber — always draw a small "now" marker at the right edge,
    // and the user-draggable cursor when set.
    if (cursor != null) {
      this._drawCursor(this.xForMs(cursor), '#E8C08A', 2);
    }
  }

  _drawTicks() {
    const { ctx } = this;
    const span = this.domainEnd - this.domainStart;
    if (span <= 0) return;
    // Pick a tick step that gives roughly 4-8 labels across the axis.
    const steps = [
      60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000, 3 * 3600_000, 6 * 3600_000,
      12 * 3600_000, 86_400_000, 3 * 86_400_000, 7 * 86_400_000, 14 * 86_400_000,
      30 * 86_400_000, 90 * 86_400_000,
    ];
    const target = span / 6;
    let step = steps[0];
    for (const s of steps) if (s <= target) step = s;

    ctx.font = '10px "IBM Plex Mono", monospace';
    ctx.fillStyle = 'rgba(139, 129, 112, 0.8)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    const first = Math.ceil(this.domainStart / step) * step;
    for (let t = first; t <= this.domainEnd; t += step) {
      const x = this.xForMs(t);
      ctx.strokeStyle = 'rgba(212, 165, 116, 0.12)';
      ctx.beginPath();
      ctx.moveTo(x, TL_AXIS_Y - 3);
      ctx.lineTo(x, TL_AXIS_Y + 3);
      ctx.stroke();
      ctx.fillText(formatTickLabel(t, step), x, TL_AXIS_Y + 6);
    }
  }

  _drawItem(it, faded) {
    const { ctx } = this;
    const x = this.xForMs(it.timestampMs);
    const y = TL_LANE_Y[it.tier] ?? TL_LANE_Y.long;
    const color = TL_TIER_COLOR[it.tier] ?? TL_TIER_COLOR.long;
    const alpha = faded ? 0.18 : 0.85;
    ctx.globalAlpha = alpha;

    if (it.endMs != null) {
      // Bar (trace duration)
      const x2 = this.xForMs(it.endMs);
      const barH = 5;
      ctx.fillStyle = color;
      ctx.fillRect(x, y - barH / 2, Math.max(2, x2 - x), barH);
      if (this.hoverItem === it) {
        ctx.strokeStyle = '#F0E8D2';
        ctx.lineWidth = 1;
        ctx.strokeRect(x - 0.5, y - barH / 2 - 0.5, Math.max(2, x2 - x) + 1, barH + 1);
      }
    } else {
      // Dot
      const r = this.hoverItem === it ? 4 : 3;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      if (this.hoverItem === it) {
        ctx.strokeStyle = '#F0E8D2';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  _drawCursor(x, color, width) {
    const { ctx } = this;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(x, 4);
    ctx.lineTo(x, TL_AXIS_Y);
    ctx.stroke();

    // Handle at top
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x - 5, 2);
    ctx.lineTo(x + 5, 2);
    ctx.lineTo(x, 10);
    ctx.closePath();
    ctx.fill();
  }

  _hitItem(x, y) {
    // Look for the closest item within a pixel threshold, prioritising
    // the lane whose y is nearest the cursor.
    let best = null;
    let bestDist = Infinity;
    for (const it of this.items) {
      const ix = this.xForMs(it.timestampMs);
      const iy = TL_LANE_Y[it.tier] ?? TL_LANE_Y.long;
      let dx = 0;
      if (it.endMs != null) {
        const ix2 = this.xForMs(it.endMs);
        if (x < ix) dx = ix - x;
        else if (x > ix2) dx = x - ix2;
        else dx = 0;
      } else {
        dx = Math.abs(x - ix);
      }
      const dy = Math.abs(y - iy);
      if (dx <= 4 && dy <= 8) {
        const d = dx * dx + dy * dy;
        if (d < bestDist) { best = it; bestDist = d; }
      }
    }
    return best;
  }

  _wire() {
    const c = this.canvas;
    const tooltip = $('#timeline-tooltip');

    c.addEventListener('mousedown', (e) => {
      const rect = c.getBoundingClientRect();
      const x = e.clientX - rect.left;
      this._scrubbing = true;
      const ms = this.msForX(x);
      this.setCursor(ms);
      if (this.onCursorChange) this.onCursorChange(ms);
    });

    window.addEventListener('mousemove', (e) => {
      if (!this._scrubbing) return;
      const rect = c.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const ms = this.msForX(x);
      this.setCursor(ms);
      if (this.onCursorChange) this.onCursorChange(ms);
    });

    window.addEventListener('mouseup', () => {
      this._scrubbing = false;
    });

    c.addEventListener('mousemove', (e) => {
      if (this._scrubbing) return;
      const rect = c.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const prev = this.hoverItem;
      this.hoverItem = this._hitItem(x, y);
      if (prev !== this.hoverItem) this._draw();
      if (this.hoverItem && tooltip) {
        tooltip.hidden = false;
        tooltip.innerHTML =
          `<strong>${escapeHtml(this.hoverItem.label)}</strong> · ${fmtTime(new Date(this.hoverItem.timestampMs).toISOString())}`;
        tooltip.style.left = `${x}px`;
        tooltip.style.top = `${y}px`;
      } else if (tooltip) {
        tooltip.hidden = true;
      }
    });

    c.addEventListener('mouseleave', () => {
      this.hoverItem = null;
      if (tooltip) tooltip.hidden = true;
      this._draw();
    });

    c.addEventListener('click', () => {
      if (!this.hoverItem || !this.onPickItem) return;
      this.onPickItem(this.hoverItem);
    });
  }
}

function formatTickLabel(ms, step) {
  const d = new Date(ms);
  if (step < 86_400_000) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/**
 * Collect every timestamped entry in the current scope into a flat list
 * suitable for plotting on the timeline.
 */
function buildTimelineItems() {
  const items = [];
  const snap = state.snapshot;
  if (!snap) return items;

  for (const e of snap.entities) {
    items.push({
      id: e.id,
      tier: 'long',
      kind: 'entity',
      timestampMs: Date.parse(e.created_at),
      label: `${e.entity_type} · ${e.name}`,
      source: e,
    });
  }
  for (const r of snap.relations) {
    items.push({
      id: r.id,
      tier: 'long',
      kind: 'relation',
      timestampMs: Date.parse(r.created_at),
      label: `relation · ${r.relation_type}`,
      source: r,
    });
  }
  for (const p of state.preferences ?? []) {
    items.push({
      id: p.id,
      tier: 'long',
      kind: 'pref',
      timestampMs: Date.parse(p.created_at),
      label: `pref · ${p.category}`,
      source: p,
    });
  }
  for (const f of state.facts ?? []) {
    items.push({
      id: f.id,
      tier: 'long',
      kind: 'fact',
      timestampMs: Date.parse(f.created_at),
      label: `fact · ${f.subject} ${f.predicate}`,
      source: f,
    });
  }
  for (const m of snap.recent_messages ?? []) {
    items.push({
      id: m.id,
      tier: 'short',
      kind: 'message',
      timestampMs: Date.parse(m.created_at),
      label: `${m.role}: ${(m.content || '').slice(0, 48)}`,
      source: m,
    });
  }
  for (const t of snap.recent_traces ?? []) {
    const start = Date.parse(t.started_at);
    const end = t.completed_at ? Date.parse(t.completed_at) : null;
    items.push({
      id: t.id,
      tier: 'proc',
      kind: 'trace',
      timestampMs: start,
      endMs: end,
      label: `trace · ${t.task}`,
      source: t,
    });
  }
  return items;
}

// ----- App state ------------------------------------------------------------

const state = {
  snapshot: null,
  atlas: null,
  view: 'observatory',
  typeCounts: {},
  enabledTypes: new Set(ENTITY_TYPES),
  traversal: { depth: 2, direction: 'both' },
  preferences: [],
  facts: [],
  factIndex: { byEntity: new Map(), unanchored: [] },
  showFacts: false,
  // Timeline scrubber — null means "as of now" (no filter).
  asOfMs: null,
};

let timeline;

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
    const liveBox = $('#setting-live');
    if (liveBox) liveBox.checked = settings.live;
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
    const prevScope = `${settings.projectId}:${settings.userId}`;
    const prevLive = settings.live;
    settings = {
      baseUrl: $('#setting-base-url').value.trim().replace(/\/$/, ''),
      projectId: $('#setting-project').value.trim() || 'default',
      userId: $('#setting-user').value.trim() || 'default',
      token: $('#setting-token').value,
      live: $('#setting-live')?.checked ?? settings.live,
    };
    saveSettings(settings);
    updateScopeDisplay();
    close();

    // Reconnect live events when scope changed or toggle flipped.
    const scopeChanged = `${settings.projectId}:${settings.userId}` !== prevScope;
    if (scopeChanged || settings.live !== prevLive) {
      disconnectLiveEvents();
      if (settings.live) connectLiveEvents();
    }

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

// ----- Stat card collapse ---------------------------------------------------

const STATS_COLLAPSE_KEY = 'observatory.stats.collapse.v1';

function loadStatsCollapse() {
  try {
    const raw = localStorage.getItem(STATS_COLLAPSE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveStatsCollapse(s) {
  try { localStorage.setItem(STATS_COLLAPSE_KEY, JSON.stringify(s)); } catch {}
}

function bindStatsCollapse() {
  const saved = loadStatsCollapse();
  for (const card of $$('.stat')) {
    const tier = card.dataset.tier;
    // Default: expanded. Only collapse if the saved state explicitly says so.
    const expanded = saved[tier] !== false;
    card.setAttribute('aria-expanded', String(expanded));

    const head = card.querySelector('.stat__head');
    head?.addEventListener('click', () => {
      const next = card.getAttribute('aria-expanded') !== 'true';
      card.setAttribute('aria-expanded', String(next));
      const current = loadStatsCollapse();
      current[tier] = next;
      saveStatsCollapse(current);
    });
  }
}

// ----- Streams (messages & traces) ------------------------------------------

function freshClass(id) {
  return liveState.freshIds.has(id) ? ' is-fresh' : '';
}

/**
 * Filter messages + traces by the timeline cursor and re-render both
 * strips. Called by refresh() after a load and by the scrubber whenever
 * the cursor moves.
 */
function renderStreamsForAsOf() {
  const ms = state.asOfMs;
  const passesMsg = (m) => ms == null || Date.parse(m.created_at) <= ms;
  const passesTrace = (t) => ms == null || Date.parse(t.started_at) <= ms;
  renderMessages((state.messages ?? []).filter(passesMsg));
  renderTraces((state.traces ?? []).filter(passesTrace));
}

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
      el('li', { class: 'message' + freshClass(m.id) }, [
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
      el('li', {
        class: 'trace trace--clickable' + freshClass(t.id),
        role: 'button',
        tabindex: '0',
        title: 'Open trace inspector',
        onClick: () => openTraceInspector(t.id),
        onKeydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openTraceInspector(t.id);
          }
        },
      }, [
        el('span', { class: 'trace__time' }, fmtTime(t.started_at)),
        el('span', { class: 'trace__bullet', dataset: { success: successKey } }),
        el('span', { class: 'trace__task' }, t.task),
        el('span', { class: 'trace__duration' }, fmtDuration(t.duration_ms)),
      ])
    );
  }
}

// ----- Detail panel ---------------------------------------------------------

function deselectEntity() {
  graph.setSelected(null);
  graph.alpha = Math.max(graph.alpha, 0.1);
  renderDetailPlaceholder();
}

async function selectEntity(node) {
  graph.setSelected(node.id);
  const detail = $('#detail');
  detail.innerHTML = '';

  // Synthetic diamond nodes — not in D1, bypass the relations/traverse
  // fetch and render their row directly.
  if (node.__factNode) {
    renderFactDetail(detail, node.__fact);
    return;
  }
  if (node.__prefNode) {
    renderPrefDetail(detail, node.__pref);
    return;
  }
  if (node.__synthetic && node.entity_type === 'SELF') {
    renderSelfDetail(detail, node);
    return;
  }

  const card = el('div', { class: 'detail-card' });

  const color = TYPE_COLORS[node.entity_type] || '#8B8170';
  card.append(
    el('div', { class: 'detail-card__head' }, [
      el('div', { class: 'detail-card__type', style: `--type: ${color}` }, node.entity_type),
      el('div', { class: 'record-card__actions' }, [
        el('button', {
          type: 'button',
          class: 'record-card__edit record-card__action--expand',
          title: `Fold ${state.traversal.direction}/${state.traversal.depth}-hop neighbourhood into the chart`,
          onClick: () => expandEntitySubgraph(node),
        }, '+ expand'),
        promoteButton('entity', node.id),
        el('button', {
          type: 'button',
          class: 'record-card__edit',
          onClick: () => openEntityEdit(card, node),
        }, 'edit'),
      ]),
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

  // Facts whose subject name matches this entity, grouped client-side.
  const matchedFacts = state.factIndex?.byEntity.get(node.id) ?? [];
  card.append(renderEntityFactsSection(matchedFacts));

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

function bindFactsToggle() {
  const btn = $('#toggle-facts');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const next = btn.getAttribute('aria-pressed') !== 'true';
    btn.setAttribute('aria-pressed', String(next));
    btn.textContent = next ? 'on' : 'off';
    state.showFacts = next;
    graph.setShowFacts(next);
    rebuildGraphFromState();
  });
}

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
//
// Facts attach to their subject entity; preferences attach to the
// synthetic "You" node. The old standalone records section is gone.

function matchesQuery(query, haystack) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const tokens = q.split(/\s+/);
  return tokens.every((t) => haystack.includes(t));
}

/**
 * Render the detail panel for the synthetic "You" node — lists the
 * current scope's preferences in the same visual slot that a real
 * entity's relations/facts would occupy.
 */
function renderSelfDetail(detail, node) {
  const card = el('div', { class: 'detail-card' });
  card.append(
    el('div', { class: 'detail-card__head' }, [
      el('div', { class: 'detail-card__type', style: `--type: ${TYPE_COLORS.SELF}` }, 'SELF'),
    ])
  );
  card.append(el('h2', { class: 'detail-card__name' }, 'You'));

  const meta = el('dl', { class: 'detail-card__meta' });
  meta.append(el('dt', {}, 'project'));
  meta.append(el('dd', {}, node.project_id));
  meta.append(el('dt', {}, 'user'));
  meta.append(el('dd', {}, node.user_id));
  card.append(meta);
  card.append(el('p', { class: 'detail-card__desc' }, node.description));

  const prefs = state.preferences ?? [];
  const section = el('section', { class: 'detail-section' });
  section.append(el('h4', { class: 'detail-section__title' }, [
    'Preferences',
    el('span', { class: 'count' }, String(prefs.length)),
  ]));
  if (!prefs.length) {
    section.append(el('p', { class: 'detail-section__empty' }, 'No preferences in this scope yet.'));
  } else {
    const list = el('ul', { class: 'detail-section__list' });
    for (const p of prefs) list.append(renderPreferenceCard(p));
    section.append(list);
  }
  card.append(section);
  detail.append(card);
}

/**
 * Detail panel for a fact diamond — wraps the existing fact card
 * renderer in a detail-card shell so the layout matches entity panels.
 */
function renderFactDetail(detail, fact) {
  const card = el('div', { class: 'detail-card' });
  card.append(
    el('div', { class: 'detail-card__head' }, [
      el('div', { class: 'detail-card__type', style: `--type: ${TYPE_COLORS.FACT}` }, 'FACT'),
    ])
  );
  const list = el('ul', { class: 'detail-section__list' });
  list.append(renderFactCard(fact));
  card.append(list);
  detail.append(card);
}

/**
 * Detail panel for a preference diamond.
 */
function renderPrefDetail(detail, pref) {
  const card = el('div', { class: 'detail-card' });
  card.append(
    el('div', { class: 'detail-card__head' }, [
      el('div', { class: 'detail-card__type', style: `--type: ${TYPE_COLORS.PREF}` }, 'PREF'),
    ])
  );
  const list = el('ul', { class: 'detail-section__list' });
  list.append(renderPreferenceCard(pref));
  card.append(list);
  detail.append(card);
}

/**
 * Build the "Facts" detail section for a real entity. Shows a short
 * empty line rather than being omitted so the user sees "no facts
 * yet" on entities they care about.
 */
function renderEntityFactsSection(facts) {
  const section = el('section', { class: 'detail-section' });
  section.append(el('h4', { class: 'detail-section__title' }, [
    'Facts',
    el('span', { class: 'count' }, String(facts.length)),
  ]));
  if (!facts.length) {
    section.append(el('p', { class: 'detail-section__empty' }, 'No facts mention this entity by name.'));
    return section;
  }
  const list = el('ul', { class: 'detail-section__list' });
  for (const f of facts) list.append(renderFactCard(f));
  section.append(list);
  return section;
}

/**
 * Populate the detail panel's idle state (nothing selected). Keeps the
 * original "pick a node" hint. Unanchored facts now render as free-
 * floating diamonds on the graph when the chip overlay toggle is on,
 * so the drawer that used to live here is gone.
 */
function renderDetailPlaceholder() {
  const detail = $('#detail');
  detail.innerHTML = '';
  detail.append(
    el('div', { class: 'detail__placeholder' }, [
      el('p', { class: 'detail__placeholder-line' }, 'No selection.'),
      el('p', { class: 'detail__placeholder-sub' }, 'Pick a node from the chart. Toggle "chips on graph" to surface facts and preferences as diamonds.'),
    ])
  );
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
  const card = el('li', { class: 'record-card' + freshClass(p.id), dataset: { flavor: 'pref', id: p.id } });
  card._render = () => {
    card.innerHTML = '';
    card.append(
      el('div', { class: 'record-card__head' }, [
        el('span', { class: 'record-card__category' }, p.category),
        el('div', { class: 'record-card__actions' }, [
          promoteButton('preference', p.id, p.promoted_from),
          el('button', {
            class: 'record-card__edit',
            type: 'button',
            onClick: () => openPreferenceEdit(card, p),
          }, 'edit'),
        ]),
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
  const card = el('li', { class: 'record-card' + freshClass(f.id), dataset: { flavor: 'fact', id: f.id } });
  card._render = () => {
    card.innerHTML = '';
    card.append(
      el('div', { class: 'record-card__head' }, [
        el('span', { class: 'record-card__category' }, 'fact'),
        el('div', { class: 'record-card__actions' }, [
          promoteButton('fact', f.id, f.promoted_from),
          el('button', {
            class: 'record-card__edit',
            type: 'button',
            onClick: () => openFactEdit(card, f),
          }, 'edit'),
        ]),
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
    const isReserved = p.id === 'default' || p.id === 'global';
    const cls = [
      'card',
      total === 0 ? 'is-empty' : '',
      isActive ? 'is-active' : '',
      p.archived ? 'is-archived' : '',
    ].filter(Boolean).join(' ');

    const item = el('li', { class: cls, dataset: { flavor } }, [
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

    if (!isReserved) {
      const actions = el('div', { class: 'card__actions' });
      const archiveBtn = el(
        'button',
        { type: 'button', class: 'card__action' },
        p.archived ? 'unarchive' : 'archive'
      );
      archiveBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        void toggleProjectArchived(p);
      });
      actions.append(archiveBtn);

      if (total === 0) {
        const deleteBtn = el('button', { type: 'button', class: 'card__action' }, 'delete');
        deleteBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          void deleteProject(p);
        });
        actions.append(deleteBtn);
      }
      item.append(actions);
    }

    // Click anywhere on the card body to set just the project (keeps current user)
    item.addEventListener('click', (e) => {
      // Ignore clicks that originated on a chip or action button
      if (e.target instanceof HTMLElement && e.target.closest('.chip, .card__action')) return;
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

async function toggleProjectArchived(p) {
  try {
    await api(`/api/v1/projects/${encodeURIComponent(p.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ archived: !p.archived }),
    });
    showToast(`${p.id} ${p.archived ? 'unarchived' : 'archived'}`, 'success');
    await loadAtlas();
  } catch (err) {
    showToast(err.message);
  }
}

async function deleteProject(p) {
  if (!confirm(`Delete project '${p.id}'? This is irreversible.`)) return;
  try {
    await api(`/api/v1/projects/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
    showToast(`${p.id} deleted`, 'success');
    await loadAtlas();
  } catch (err) {
    showToast(err.message);
  }
}

async function registerProject(id, displayName) {
  try {
    await api('/api/v1/projects', {
      method: 'POST',
      body: JSON.stringify({ id, display_name: displayName || undefined }),
    });
    showToast(`registered ${id}`, 'success');
    await loadAtlas();
  } catch (err) {
    showToast(err.message);
    throw err;
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
    const showArchived = $('#atlas-show-archived')?.checked;
    const qs = showArchived ? '?include_archived=true' : '';
    const atlas = await api('/api/v1/atlas' + qs);
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

function bindAtlasControls() {
  const form = $('#atlas-register-form');
  const btn = $('#atlas-register-btn');
  const cancel = $('#atlas-register-cancel');
  const idInput = $('#atlas-register-id');
  const nameInput = $('#atlas-register-name');
  const showArchived = $('#atlas-show-archived');

  if (btn && form) {
    btn.addEventListener('click', () => {
      form.hidden = !form.hidden;
      if (!form.hidden) idInput?.focus();
    });
  }
  if (cancel && form) {
    cancel.addEventListener('click', () => {
      form.hidden = true;
      if (idInput) idInput.value = '';
      if (nameInput) nameInput.value = '';
    });
  }
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = idInput?.value.trim();
      const name = nameInput?.value.trim();
      if (!id) return;
      try {
        await registerProject(id, name);
        form.hidden = true;
        if (idInput) idInput.value = '';
        if (nameInput) nameInput.value = '';
      } catch {
        // toast already shown
      }
    });
  }
  if (showArchived) {
    showArchived.addEventListener('change', () => void loadAtlas());
  }
}

// ----- Live events (WebSocket) ----------------------------------------------

/**
 * Hold the WebSocket for `/api/v1/events`. One per scope. Auto-reconnects
 * with exponential backoff up to 30s. Emits memory events to onMemoryEvent,
 * which debounces a refresh and flashes new list items.
 */
const liveState = {
  ws: null,
  reconnectAttempts: 0,
  reconnectTimer: null,
  refreshTimer: null,
  freshIds: new Set(),
  manualClose: false,
};

function wsUrl(path) {
  const base = settings.baseUrl || window.location.origin;
  // Native WebSocket API can't send custom headers, so we pass scope via
  // query params. The scope middleware reads project_id/user_id as a
  // header fallback.
  const params = new URLSearchParams({
    project_id: settings.projectId,
    user_id: settings.userId,
  });
  const sep = path.includes('?') ? '&' : '?';
  return base.replace(/^http/, 'ws') + path + sep + params.toString();
}

function updateLiveIndicator(state) {
  const dot = $('#live-indicator');
  if (!dot) return;
  dot.dataset.state = state;
  const label = {
    connected: 'live',
    connecting: 'connecting…',
    disconnected: 'paused',
    off: 'off',
  }[state] || state;
  dot.setAttribute('title', `Live events: ${label}`);
  dot.setAttribute('aria-label', `Live events: ${label}`);
}

function connectLiveEvents() {
  if (!settings.live) {
    updateLiveIndicator('off');
    return;
  }
  if (liveState.ws) return;
  liveState.manualClose = false;
  updateLiveIndicator('connecting');

  let ws;
  try {
    ws = new WebSocket(wsUrl('/api/v1/events'));
  } catch (err) {
    console.error('[live] WebSocket construction failed:', err);
    scheduleLiveReconnect();
    return;
  }
  liveState.ws = ws;

  ws.addEventListener('open', () => {
    liveState.reconnectAttempts = 0;
    updateLiveIndicator('connected');
  });

  ws.addEventListener('message', (msg) => {
    let evt;
    try {
      evt = JSON.parse(msg.data);
    } catch {
      return;
    }
    if (evt.type === 'hello' || evt.type === 'pong') return;
    onMemoryEvent(evt);
  });

  ws.addEventListener('close', () => {
    liveState.ws = null;
    if (liveState.manualClose) {
      updateLiveIndicator('off');
      return;
    }
    updateLiveIndicator('disconnected');
    scheduleLiveReconnect();
  });

  ws.addEventListener('error', () => {
    // Close handler fires next and drives reconnect.
  });
}

function disconnectLiveEvents() {
  liveState.manualClose = true;
  if (liveState.reconnectTimer) {
    clearTimeout(liveState.reconnectTimer);
    liveState.reconnectTimer = null;
  }
  if (liveState.ws) {
    try { liveState.ws.close(1000, 'user toggled off'); } catch {}
    liveState.ws = null;
  }
  updateLiveIndicator('off');
}

function scheduleLiveReconnect() {
  if (!settings.live || liveState.manualClose) return;
  if (liveState.reconnectTimer) return;
  const attempt = ++liveState.reconnectAttempts;
  const delay = Math.min(30_000, 1000 * Math.pow(1.6, Math.min(attempt, 10)));
  liveState.reconnectTimer = setTimeout(() => {
    liveState.reconnectTimer = null;
    connectLiveEvents();
  }, delay);
}

/**
 * React to a single server-pushed event: flash-mark the new id so the
 * renderer can highlight it, and schedule a debounced refresh so the
 * full UI converges on the server's state without per-event hand-rolled
 * update logic for every panel.
 */
function onMemoryEvent(evt) {
  const id = evt.payload?.id;
  if (id) {
    liveState.freshIds.add(id);
    // Clear freshness tag after the flash animation duration.
    setTimeout(() => liveState.freshIds.delete(id), 3500);
  }
  if (liveState.refreshTimer) return;
  liveState.refreshTimer = setTimeout(() => {
    liveState.refreshTimer = null;
    void refresh({ silent: true });
  }, 250);
}

function bindLiveToggle() {
  const checkbox = $('#setting-live');
  if (!checkbox) return;
  checkbox.checked = settings.live;
}

// ----- Graph traversal: click-to-expand into the canvas ---------------------

/**
 * Pull the {direction, depth}-hop subgraph for `entity` and fold the returned
 * entities + edges into the chart. Existing nodes keep their positions; new
 * nodes get seeded near the root so the spring sim visibly tugs them in.
 */
async function expandEntitySubgraph(entity) {
  const prevEntityIds = new Set(graph.nodes.map((n) => n.id));
  const prevRelIds = new Set(graph.edges.map((e) => e.id));
  const root = graph.byId.get(entity.id);

  try {
    const data = await api(
      `/api/v1/entities/${encodeURIComponent(entity.id)}/subgraph`,
      {
        method: 'POST',
        body: JSON.stringify({
          max_depth: state.traversal.depth,
          direction: state.traversal.direction,
        }),
      }
    );

    // Seed new nodes near the root so they're visible in the existing viewport.
    const seededNew = data.entities
      .filter((e) => !prevEntityIds.has(e.id))
      .map((e) => ({
        ...e,
        _seedX: root ? root.x + (Math.random() - 0.5) * 60 : undefined,
        _seedY: root ? root.y + (Math.random() - 0.5) * 60 : undefined,
      }));

    const mergedEntities = [...graph.nodes, ...seededNew];
    const newRelations = data.relations.filter((r) => !prevRelIds.has(r.id));
    const mergedRelations = [...graph.edges, ...newRelations];

    graph.setData(mergedEntities, mergedRelations);
    graph.setSelected(entity.id);
    graph.alpha = 1; // re-heat the sim so the new block settles

    // Refresh the type filter counts to account for the new entities.
    const counts = {};
    for (const e of mergedEntities) {
      counts[e.entity_type] = (counts[e.entity_type] ?? 0) + 1;
    }
    state.typeCounts = counts;
    renderTypeFilters();

    if (seededNew.length || newRelations.length) {
      showToast(
        `expanded: +${seededNew.length} entit${seededNew.length === 1 ? 'y' : 'ies'}, +${newRelations.length} edge${newRelations.length === 1 ? '' : 's'}`,
        'info'
      );
    } else {
      showToast('no new neighbours within depth', 'info');
    }
  } catch (err) {
    showToast(`Expand failed: ${err.message}`);
  }
}

// ----- Trace inspector ------------------------------------------------------

async function openTraceInspector(traceId) {
  const ins = $('#trace-inspector');
  const body = $('#ti-body');
  const title = $('#ti-title');
  title.textContent = 'loading trace…';
  body.innerHTML = '';
  body.append(el('div', { class: 'ti-loading' }, 'Loading steps + tool calls…'));
  ins.hidden = false;
  document.body.classList.add('has-inspector');
  try {
    const detail = await api(`/api/v1/traces/${encodeURIComponent(traceId)}`);
    renderTraceDetail(body, title, detail);
  } catch (err) {
    title.textContent = 'Failed';
    body.innerHTML = '';
    body.append(el('p', { class: 'ti-error' }, err.message));
  }
}

function closeTraceInspector() {
  $('#trace-inspector').hidden = true;
  document.body.classList.remove('has-inspector');
}

function renderTraceDetail(container, titleNode, detail) {
  const { trace, steps } = detail;
  titleNode.textContent = trace.task;
  container.innerHTML = '';

  const start = Date.parse(trace.started_at);
  const end = trace.completed_at
    ? Date.parse(trace.completed_at)
    : Math.max(start + 1, Date.now());
  const totalMs = Math.max(1, end - start);

  // --- Summary strip -------------------------------------------------------
  const summary = el('dl', { class: 'ti-summary' });
  const successLabel =
    trace.success === 1 ? 'success' : trace.success === 0 ? 'failure' : 'in-flight';
  const successTone =
    trace.success === 1 ? 'ok' : trace.success === 0 ? 'fail' : 'pending';
  summary.append(
    el('dt', {}, 'status'),
    el('dd', { class: `ti-status ti-status--${successTone}` }, successLabel),
    el('dt', {}, 'started'),
    el('dd', {}, fmtTime(trace.started_at)),
    el('dt', {}, 'completed'),
    el('dd', {}, trace.completed_at ? fmtTime(trace.completed_at) : '—'),
    el('dt', {}, 'duration'),
    el('dd', {}, fmtDuration(trace.duration_ms)),
    el('dt', {}, 'steps'),
    el('dd', {}, String(steps.length)),
    el('dt', {}, 'tool calls'),
    el('dd', {}, String(steps.reduce((n, s) => n + s.tool_calls.length, 0))),
  );
  if (trace.outcome) {
    summary.append(
      el('dt', {}, 'outcome'),
      el('dd', { class: 'ti-outcome' }, trace.outcome)
    );
  }
  container.append(summary);

  // --- Timeline scale ------------------------------------------------------
  const scale = el('div', { class: 'ti-scale' }, [
    el('span', {}, '0'),
    el('span', {}, fmtDuration(Math.round(totalMs / 2))),
    el('span', {}, fmtDuration(totalMs)),
  ]);
  container.append(scale);

  if (!steps.length) {
    container.append(
      el('p', { class: 'ti-empty' }, 'No steps recorded for this trace.')
    );
    return;
  }

  // --- Steps list ----------------------------------------------------------
  const list = el('ol', { class: 'ti-steps' });
  for (const step of steps) {
    // Steps don't have completed_at; treat each step as an instant at created_at
    // and infer "width" from its tool calls' durations.
    const stepStart = Date.parse(step.created_at);
    const stepOffset = Math.max(0, stepStart - start);
    const offsetPct = Math.min(99, (stepOffset / totalMs) * 100);
    const toolsDuration = step.tool_calls.reduce(
      (n, c) => n + (c.duration_ms ?? 0),
      0
    );
    const widthPct = Math.max(
      2,
      Math.min(100 - offsetPct, (toolsDuration / totalMs) * 100)
    );

    const item = el('li', { class: 'ti-step' });
    item.append(
      el('div', { class: 'ti-step__head' }, [
        el('span', { class: 'ti-step__n' }, `#${step.step_number}`),
        el('span', { class: 'ti-step__time' }, fmtTime(step.created_at)),
      ]),
      el('div', { class: 'ti-step__bar' }, [
        el('div', {
          class: 'ti-step__bar-fill',
          style: `left: ${offsetPct.toFixed(2)}%; width: ${widthPct.toFixed(2)}%;`,
          title: `${fmtDuration(stepOffset)} offset · ${fmtDuration(toolsDuration)} of tool work`,
        }),
      ])
    );

    if (step.thought) {
      item.append(el('p', { class: 'ti-step__thought' }, step.thought));
    }
    if (step.action) {
      item.append(
        el('p', { class: 'ti-step__action' }, [
          el('span', { class: 'ti-step__label' }, 'action'),
          step.action,
        ])
      );
    }
    if (step.observation) {
      item.append(
        el('p', { class: 'ti-step__observation' }, [
          el('span', { class: 'ti-step__label' }, 'observation'),
          step.observation,
        ])
      );
    }

    if (step.tool_calls.length) {
      const calls = el('ul', { class: 'ti-tools' });
      for (const call of step.tool_calls) {
        const statusTone =
          call.status === 'success' ? 'ok' : call.status === 'failure' ? 'fail' : 'pending';
        calls.append(
          el('li', { class: `ti-tool ti-tool--${statusTone}` }, [
            el('span', { class: 'ti-tool__name' }, call.tool_name),
            el('span', { class: 'ti-tool__status' }, call.status),
            el('span', { class: 'ti-tool__duration' }, fmtDuration(call.duration_ms)),
          ])
        );
      }
      item.append(calls);
    }

    list.append(item);
  }
  container.append(list);
}

// ----- Unified global search -----------------------------------------------

let globalSearchTimer = null;
let globalSearchSeq = 0;

function bindGlobalSearch() {
  const input = $('#global-search');
  const dropdown = $('#global-search-dropdown');
  if (!input || !dropdown) return;

  input.addEventListener('input', () => {
    clearTimeout(globalSearchTimer);
    const q = input.value.trim();
    if (!q) {
      dropdown.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      return;
    }
    globalSearchTimer = setTimeout(() => runGlobalSearch(q), 220);
  });

  input.addEventListener('focus', () => {
    if (input.value.trim()) dropdown.hidden = false;
  });

  document.addEventListener('click', (e) => {
    const wrap = $('#global-search-wrap');
    if (wrap && !wrap.contains(e.target)) {
      dropdown.hidden = true;
      input.setAttribute('aria-expanded', 'false');
    }
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      input.value = '';
      dropdown.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.blur();
    }
  });
}

async function runGlobalSearch(query) {
  const dropdown = $('#global-search-dropdown');
  const input = $('#global-search');
  const seq = ++globalSearchSeq;
  dropdown.hidden = false;
  input.setAttribute('aria-expanded', 'true');
  dropdown.innerHTML = '';
  dropdown.append(
    el('div', { class: 'gs-loading' }, `searching "${query}"…`)
  );

  const body = JSON.stringify({ query, limit: 6 });
  const endpoints = [
    ['entities', '/api/v1/entities/search'],
    ['preferences', '/api/v1/preferences/search'],
    ['facts', '/api/v1/facts/search'],
    ['traces', '/api/v1/traces/search'],
    ['messages', '/api/v1/messages/search'],
  ];

  const results = await Promise.all(
    endpoints.map(async ([kind, path]) => {
      try {
        const r = await api(path, { method: 'POST', body });
        return { kind, rows: r };
      } catch (err) {
        return { kind, rows: [], error: err.message };
      }
    })
  );

  // Ignore stale responses
  if (seq !== globalSearchSeq) return;

  dropdown.innerHTML = '';
  const total = results.reduce((n, r) => n + r.rows.length, 0);
  if (total === 0) {
    dropdown.append(
      el('div', { class: 'gs-empty' }, [
        `No matches for `,
        el('code', {}, query),
        ` in ${settings.projectId} / ${settings.userId}.`,
      ])
    );
    return;
  }

  for (const group of results) {
    if (!group.rows.length) continue;
    const section = el('div', { class: 'gs-group' });
    section.append(
      el('div', { class: 'gs-group__head' }, [
        el('span', { class: 'gs-group__kind', dataset: { kind: group.kind } }, group.kind),
        el('span', { class: 'gs-group__count' }, String(group.rows.length)),
      ])
    );
    for (const row of group.rows) {
      section.append(renderGlobalSearchHit(group.kind, row));
    }
    dropdown.append(section);
  }
}

function renderGlobalSearchHit(kind, row) {
  const meta = row.metadata ?? {};
  const score = typeof row.score === 'number' ? row.score.toFixed(2) : '—';
  const scope = resolveHitScope(row);
  let title = '';
  let sub = '';

  switch (kind) {
    case 'entities':
      title = meta.name ?? row.id;
      sub = meta.entity_type ?? '';
      break;
    case 'preferences':
      title = meta.category ? `[${meta.category}]` : 'preference';
      sub = row.id;
      break;
    case 'facts':
      title = [meta.subject, meta.predicate].filter(Boolean).join(' · ') || 'fact';
      sub = row.id;
      break;
    case 'traces':
      title = meta.task ?? 'trace';
      sub = meta.success === 'true' ? 'success' : meta.success === 'false' ? 'failure' : '—';
      break;
    case 'messages':
      title = meta.role ? `${meta.role}:` : 'message';
      sub = meta.content_preview ?? row.id;
      break;
    default:
      title = row.id;
  }

  const hit = el('button', {
    type: 'button',
    class: 'gs-hit',
    dataset: { kind, id: row.id },
    onClick: () => onGlobalHitClick(kind, row),
  }, [
    el('span', { class: 'gs-hit__title' }, String(title)),
    el('span', { class: 'gs-hit__sub' }, String(sub)),
    el('span', { class: `gs-hit__scope gs-hit__scope--${scope}` }, scope),
    el('span', { class: 'gs-hit__score' }, score),
  ]);
  return hit;
}

function resolveHitScope(row) {
  // scopeLevel from cascadingSearch: 0 = project+user, 1 = user, 2 = project, 3 = global.
  if (row.scopeLevel === undefined) return 'scope';
  if (row.scopeLevel === 0) return 'project·user';
  if (row.scopeLevel === 1) return 'user';
  if (row.scopeLevel === 2) return 'project';
  return 'global';
}

async function onGlobalHitClick(kind, row) {
  closeGlobalSearchDropdown();
  if (kind === 'entities') {
    const local = graph.byId.get(row.id);
    if (local) {
      selectEntity(local);
      return;
    }
    // Entity is out of current snapshot — pull it + expand it into the graph
    try {
      const ent = await api(`/api/v1/entities/${encodeURIComponent(row.id)}`);
      graph.setData([...graph.nodes, ent], graph.edges);
      const local2 = graph.byId.get(ent.id);
      if (local2) selectEntity(local2);
    } catch (err) {
      showToast(`Failed to load entity: ${err.message}`);
    }
    return;
  }
  if (kind === 'traces') {
    openTraceInspector(row.id);
    return;
  }
  if (kind === 'facts') {
    const fact = (state.facts || []).find((f) => f.id === row.id);
    if (fact) {
      const detail = $('#detail');
      detail.innerHTML = '';
      renderFactDetail(detail, fact);
    } else {
      showToast(`Fact ${row.id.slice(0, 8)}… not in current scope`, 'info');
    }
    return;
  }
  if (kind === 'preferences') {
    const pref = (state.preferences || []).find((p) => p.id === row.id);
    if (pref) {
      const detail = $('#detail');
      detail.innerHTML = '';
      renderPrefDetail(detail, pref);
    } else {
      showToast(`Preference ${row.id.slice(0, 8)}… not in current scope`, 'info');
    }
    return;
  }
  // Messages: no dedicated surface yet — toast so the id is copyable.
  showToast(`${kind} ${row.id.slice(0, 8)}…`, 'info');
}

function closeGlobalSearchDropdown() {
  const dropdown = $('#global-search-dropdown');
  if (dropdown) dropdown.hidden = true;
  $('#global-search')?.setAttribute('aria-expanded', 'false');
}

// ----- Tool stats panel -----------------------------------------------------

async function loadToolStats() {
  try {
    const stats = await api('/api/v1/tool-stats');
    renderToolStats(stats);
  } catch (err) {
    renderToolStats([]);
    showToast(`Tool stats failed: ${err.message}`);
  }
}

function renderToolStats(stats) {
  const body = $('#tool-stats-body');
  const countEl = $('#tool-stats-count');
  if (!body || !countEl) return;
  countEl.textContent = stats.length;
  body.innerHTML = '';
  if (!stats.length) {
    body.append(
      el('p', { class: 'tool-stats__empty' }, [
        'No tool calls recorded in ',
        el('code', { style: 'color: var(--proc);' }, settings.projectId),
        ' / ',
        el('code', { style: 'color: var(--proc);' }, settings.userId),
        '.',
      ])
    );
    return;
  }

  const table = el('table', { class: 'tool-stats__table' });
  const thead = el('thead', {}, [
    el('tr', {}, [
      el('th', {}, 'tool'),
      el('th', { class: 'num' }, 'calls'),
      el('th', { class: 'num' }, 'success'),
      el('th', { class: 'num' }, 'avg'),
      el('th', { class: 'num' }, 'total'),
      el('th', {}, 'last used'),
    ]),
  ]);
  const tbody = el('tbody', {});
  for (const s of stats) {
    const total = s.total_calls ?? 0;
    const succ = s.success_count ?? 0;
    const rate = total > 0 ? Math.round((succ / total) * 100) : 0;
    const avg = total > 0 ? Math.round((s.total_duration_ms ?? 0) / total) : null;
    const tone = rate >= 95 ? 'ok' : rate >= 75 ? 'warn' : 'fail';
    tbody.append(
      el('tr', {}, [
        el('td', { class: 'tool-stats__name' }, s.tool_name),
        el('td', { class: 'num' }, String(total)),
        el('td', { class: `num tool-stats__rate tool-stats__rate--${tone}` }, `${rate}%`),
        el('td', { class: 'num' }, avg == null ? '—' : fmtDuration(avg)),
        el('td', { class: 'num' }, fmtDuration(s.total_duration_ms ?? 0)),
        el('td', {}, fmtTime(s.last_used_at)),
      ])
    );
  }
  table.append(thead, tbody);
  body.append(table);
}

// ----- Promotion UI ---------------------------------------------------------

/**
 * Build a "⇡ promote" button. If the record was already promoted (has
 * promoted_from set), the button renders as disabled with a "promoted" label
 * so we don't mint duplicates.
 */
function promoteButton(type, id, promotedFrom) {
  const alreadyPromoted = promotedFrom != null && promotedFrom !== '';
  if (alreadyPromoted) {
    return el('span', {
      class: 'record-card__promote record-card__promote--done',
      title: `already promoted from ${promotedFrom}`,
    }, 'promoted');
  }
  return el('button', {
    type: 'button',
    class: 'record-card__promote',
    title: `Promote this ${type} to global scope`,
    onClick: (e) => {
      const card = e.currentTarget.closest('.record-card, .detail-card');
      openPromoteForm(card, type, id);
    },
  }, '⇡ promote');
}

function openPromoteForm(card, type, id) {
  if (!card) return;
  // Avoid stacking multiple forms
  card.querySelectorAll('.promote-form').forEach((f) => f.remove());
  const form = el('form', {
    class: 'promote-form',
    onSubmit: async (e) => {
      e.preventDefault();
      const reason = form.reason.value.trim();
      if (!reason) {
        form.reason.focus();
        return;
      }
      const target = form.target.value;
      await doPromote(type, id, reason, target, form);
    },
  });
  form.append(
    el('div', { class: 'promote-form__row' }, [
      el('label', {}, [
        'reason',
        el('input', {
          name: 'reason',
          placeholder: 'why is this global-worthy?',
          required: 'true',
        }),
      ]),
      el('label', {}, [
        'target',
        (() => {
          const sel = el('select', { name: 'target' });
          sel.append(
            el('option', { value: 'global' }, 'global'),
            el('option', { value: 'user' }, 'user')
          );
          return sel;
        })(),
      ]),
    ]),
    el('div', { class: 'promote-form__actions' }, [
      el('button', {
        type: 'button',
        class: 'btn btn--ghost',
        onClick: () => form.remove(),
      }, 'cancel'),
      el('button', { type: 'submit', class: 'btn btn--primary' }, 'promote'),
    ])
  );
  card.append(form);
  form.reason.focus();
}

async function doPromote(type, id, reason, target, form) {
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  submit.textContent = 'promoting…';
  try {
    const res = await api('/api/v1/promote', {
      method: 'POST',
      body: JSON.stringify({ type, id, reason, target }),
    });
    const promotedId = res.promotedId ?? res.globalId;
    showToast(
      `promoted to ${target} · ${promotedId ? promotedId.slice(0, 8) : 'ok'}`,
      'success'
    );
    form.remove();
    // Refresh so the "promoted" badge renders on the original card too.
    void refresh();
  } catch (err) {
    submit.disabled = false;
    submit.textContent = 'promote';
    showToast(err.message);
  }
}

// ----- Keyboard navigation (j/k across visible entities) --------------------

function moveSelection(delta) {
  // Alphabetical order among currently-visible entities so j/k is predictable.
  const visible = graph.nodes
    .filter((n) => n.__synthetic || graph.typeFilter.has(n.entity_type))
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!visible.length) return;
  const currentIdx = visible.findIndex((n) => n.id === graph.selectedId);
  const nextIdx =
    currentIdx < 0
      ? (delta > 0 ? 0 : visible.length - 1)
      : (currentIdx + delta + visible.length) % visible.length;
  selectEntity(visible[nextIdx]);
}

// ----- Refresh / load -------------------------------------------------------

async function refresh(opts = {}) {
  if (!opts.silent) setStatus('loading', 'fetching');
  $('#empty-graph').hidden = true;
  try {
    // Snapshot covers the graph + stream tiers; full prefs/facts come from
    // their list endpoints so the inline Records section can show everything,
    // not just the first 15.
    const [snapshot, preferences, facts, toolStats] = await Promise.all([
      api('/api/v1/snapshot?entity_limit=200&relation_limit=500&message_limit=200&trace_limit=200'),
      api('/api/v1/preferences'),
      api('/api/v1/facts'),
      api('/api/v1/tool-stats').catch(() => []),
    ]);
    state.snapshot = snapshot;

    const counts = {};
    for (const e of snapshot.entities) {
      counts[e.entity_type] = (counts[e.entity_type] ?? 0) + 1;
    }
    state.typeCounts = counts;

    renderStats(snapshot.stats);
    renderTypeFilters();

    state.preferences = preferences;
    state.facts = facts;
    state.factIndex = buildFactIndex(facts, snapshot.entities);
    state.messages = snapshot.recent_messages ?? [];
    state.traces = snapshot.recent_traces ?? [];

    rebuildGraphFromState();
    $('#empty-graph').hidden = snapshot.entities.length > 0;

    renderStreamsForAsOf();
    renderToolStats(toolStats);
    renderDetailPlaceholder();
    timeline?.setItems(buildTimelineItems());

    setStatus('ok', 'connected');
  } catch (err) {
    $('#empty-graph').hidden = false;
    setStatus('error', 'offline');
    showToast(err.message);
  }
}

// ----- Timeline scrubber ----------------------------------------------------

function applyAsOfCursor(ms) {
  state.asOfMs = ms;
  graph.setAsOfMs(ms);
  renderStreamsForAsOf();
  updateCursorReadout();
}

function resetAsOfCursor() {
  state.asOfMs = null;
  graph.setAsOfMs(null);
  timeline?.setCursor(null);
  renderStreamsForAsOf();
  updateCursorReadout();
}

function updateCursorReadout() {
  const label = $('#timeline-cursor-label');
  const reset = $('#timeline-reset');
  if (!label) return;
  if (state.asOfMs == null) {
    label.textContent = 'now';
    label.dataset.scrubbing = 'false';
    if (reset) reset.hidden = true;
  } else {
    label.textContent = fmtTime(new Date(state.asOfMs).toISOString());
    label.dataset.scrubbing = 'true';
    if (reset) reset.hidden = false;
  }
}

function bindTimelineReset() {
  const btn = $('#timeline-reset');
  if (!btn) return;
  btn.addEventListener('click', resetAsOfCursor);
}

function onTimelinePick(item) {
  // Route timeline clicks to the same surfaces a direct click in the
  // main view would hit.
  if (item.kind === 'entity') {
    const local = graph.byId.get(item.id);
    if (local) selectEntity(local);
  } else if (item.kind === 'fact') {
    const detail = $('#detail');
    detail.innerHTML = '';
    renderFactDetail(detail, item.source);
  } else if (item.kind === 'pref') {
    const detail = $('#detail');
    detail.innerHTML = '';
    renderPrefDetail(detail, item.source);
  } else if (item.kind === 'trace') {
    openTraceInspector(item.id);
  } else if (item.kind === 'relation') {
    // Select the source entity so the user can see where the edge lives.
    const local = graph.byId.get(item.source.source_entity_id);
    if (local) selectEntity(local);
  }
  // Messages have no detail surface yet — fall through silently.
}

// ----- Init -----------------------------------------------------------------

async function init() {
  graph = new GraphView($('#graph'));
  graph.onSelect = selectEntity;
  graph.onDeselect = deselectEntity;
  timeline = new TimelineView($('#timeline'));
  timeline.onCursorChange = applyAsOfCursor;
  timeline.onPickItem = onTimelinePick;
  bindTimelineReset();
  bindStatsCollapse();
  bindSettings();
  bindSearch();
  bindTraversal();
  bindFactsToggle();
  bindViewSwitch();
  bindAtlasControls();
  bindLogin();
  bindGlobalSearch();
  bindTraceInspector();
  updateScopeDisplay();
  renderTypeFilters();

  // Gate the rest of init() on a successful auth check
  const auth = await checkAuth();
  if (!auth.authenticated) {
    showLoginVeil();
    return;
  }
  hideLoginVeil();

  bindLiveToggle();
  updateLiveIndicator(settings.live ? 'connecting' : 'off');
  connectLiveEvents();

  $('#refresh').addEventListener('click', () => void refresh());

  document.addEventListener('keydown', (e) => {
    const onBody = document.activeElement === document.body;
    if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      $('#global-search').focus();
    } else if (e.key === '/' && onBody) {
      e.preventDefault();
      $('#global-search').focus();
    } else if (e.key === 'r' && !e.metaKey && !e.ctrlKey && onBody) {
      void refresh();
    } else if (e.key === 's' && !e.metaKey && !e.ctrlKey && onBody) {
      $('#settings-toggle').click();
    } else if ((e.key === 'j' || e.key === 'J') && !e.metaKey && !e.ctrlKey && onBody && $('#trace-inspector').hidden) {
      e.preventDefault();
      moveSelection(1);
    } else if ((e.key === 'k' || e.key === 'K') && !e.metaKey && !e.ctrlKey && onBody && $('#trace-inspector').hidden) {
      e.preventDefault();
      moveSelection(-1);
    } else if (e.key === 'e' && !e.metaKey && !e.ctrlKey && onBody && graph.selectedId) {
      const node = graph.byId.get(graph.selectedId);
      if (node) {
        const card = $('#detail').querySelector('.detail-card');
        if (card) openEntityEdit(card, node);
      }
    } else if (e.key === 'x' && !e.metaKey && !e.ctrlKey && onBody && graph.selectedId) {
      const node = graph.byId.get(graph.selectedId);
      if (node) void expandEntitySubgraph(node);
    } else if (e.key === 'Escape') {
      if (!$('#trace-inspector').hidden) {
        closeTraceInspector();
      } else if (!$('#global-search-dropdown').hidden) {
        closeGlobalSearchDropdown();
      } else if (graph.selectedId) {
        deselectEntity();
      } else {
        $('#drawer').hidden = true;
        $('#settings-toggle').setAttribute('aria-expanded', 'false');
      }
    }
  });

  void refresh();
}

function bindTraceInspector() {
  $('#ti-close')?.addEventListener('click', closeTraceInspector);
  $('#ti-backdrop')?.addEventListener('click', closeTraceInspector);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
