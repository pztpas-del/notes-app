// The flowchart: notes as blocks, parent → child arrows drawn by hand.
// Blocks are laid out by levels automatically; a block the user drags keeps
// its place ("pinned"). Everything is saved to Схема.canvas (JSON Canvas).
import { basename, cleanTitle, stripCode } from './vault.js';

const W = 200, H = 64, GAP_X = 36, GAP_Y = 96;
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const easeOut = t => 1 - Math.pow(1 - t, 3);
const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-6);
const el = (tag, props = {}, ...kids) => { const n = document.createElement(tag); Object.assign(n, props); n.append(...kids); return n; };
const svg = (tag, attrs = {}) => { const n = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const k in attrs) n.setAttribute(k, attrs[k]); return n; };

// ---------- Layout by levels ----------
// Each note goes one level below its lowest parent; within a level, blocks are
// ordered by where their parents are, so arrows cross as little as possible.
export function layout(s) {
  const ids = s.nodes.map(n => n.id);
  const kids = new Map(ids.map(i => [i, []])), parents = new Map(ids.map(i => [i, []]));
  for (const e of s.edges) { kids.get(e.fromNode)?.push(e.toNode); parents.get(e.toNode)?.push(e.fromNode); }
  const state = new Map(), back = new Set(), order = [];
  const visit = start => {
    const stack = [[start, 0]];
    state.set(start, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const list = kids.get(top[0]);
      if (top[1] < list.length) {
        const v = list[top[1]++];
        if (state.get(v) === 1) back.add(top[0] + '>' + v);
        else if (!state.get(v)) { state.set(v, 1); stack.push([v, 0]); }
      } else { state.set(top[0], 2); order.push(top[0]); stack.pop(); }
    }
  };
  for (const id of ids) if (!parents.get(id).length && !state.get(id)) visit(id);
  for (const id of ids) if (!state.get(id)) visit(id);
  order.reverse();
  const level = new Map(ids.map(i => [i, 0]));
  for (const u of order) for (const v of kids.get(u)) if (!back.has(u + '>' + v)) level.set(v, Math.max(level.get(v), level.get(u) + 1));
  const rows = [];
  for (const id of order) (rows[level.get(id)] ||= []).push(id);
  const pos = new Map();
  rows.forEach(r => r.forEach((id, i) => pos.set(id, i)));
  for (let sweep = 0; sweep < 4; sweep++) {
    for (let l = 1; l < rows.length; l++) {
      const bary = id => {
        const ps = parents.get(id).filter(p => level.get(p) < l);
        return ps.length ? ps.reduce((a, p) => a + pos.get(p) - (rows[level.get(p)].length - 1) / 2, 0) / ps.length + (rows[l].length - 1) / 2 : pos.get(id);
      };
      const score = new Map(rows[l].map(id => [id, bary(id)]));
      rows[l].sort((a, b) => score.get(a) - score.get(b));
      rows[l].forEach((id, i) => pos.set(id, i));
    }
  }
  // x: the first level is spread evenly; below it, each block aims for the middle
  // of its parents, then blocks are pushed apart so they never overlap.
  const out = new Map(), step = W + GAP_X;
  rows.forEach((r, l) => {
    const want = r.map((id, i) => {
      const ps = l ? parents.get(id).filter(p => level.get(p) < l && out.has(p)) : [];
      return ps.length ? ps.reduce((a, p) => a + out.get(p).x, 0) / ps.length : (i - (r.length - 1) / 2) * step;
    });
    const xs = [];
    want.forEach((w, i) => xs.push(i ? Math.max(w, xs[i - 1] + step) : w));
    const shift = xs.reduce((a, x, i) => a + x - want[i], 0) / xs.length;
    r.forEach((id, i) => out.set(id, { x: xs[i] - shift, y: l * (H + GAP_Y) }));
  });
  return out;
}

function reaches(s, from, to) {
  const seen = new Set([from]), stack = [from];
  while (stack.length) {
    const u = stack.pop();
    if (u === to) return true;
    for (const e of s.edges) if (e.fromNode === u && !seen.has(e.toNode)) { seen.add(e.toNode); stack.push(e.toNode); }
  }
  return false;
}

export class SchemaView {
  // compact: the small copy in the right panel next to a note.
  constructor(root, { vault, openNote, toast, onSaved, compact = false, openFull = null }) {
    Object.assign(this, { root, vault, openNote, toast, onSaved, compact, openFull });
    this.s = { nodes: [], edges: [] };
    this.view = { x: 0, y: 80, k: 1 };
    this.sel = null; // { type: 'node' | 'edge', id }
    this.gesture = null;
    this.pointers = new Map();
    this.visible = false;
    this.build();
  }

  // ---------- DOM ----------
  build() {
    const btn = (text, title, fn, cls = '') => {
      const b = el('button', { type: 'button', textContent: text, title, className: cls });
      b.addEventListener('click', e => { e.stopPropagation(); fn(); });
      return b;
    };
    this.stage = el('div', { className: 'schema-stage' });
    this.edgesSvg = svg('svg', { class: 'schema-edges', width: '1', height: '1' });
    const defs = svg('defs');
    const marker = svg('marker', { id: 'schemaArrow', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '8', markerHeight: '8', orient: 'auto-start-reverse' });
    marker.append(svg('path', { d: 'M0 0L10 5L0 10z', class: 'schema-arrow' }));
    const markerSel = svg('marker', { id: 'schemaArrowSel', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '8', markerHeight: '8', orient: 'auto-start-reverse' });
    markerSel.append(svg('path', { d: 'M0 0L10 5L0 10z', class: 'schema-arrow sel' }));
    defs.append(marker, markerSel);
    this.edgesSvg.append(defs);
    this.edgeLayer = svg('g');
    this.tempPath = svg('path', { class: 'schema-edge temp', 'marker-end': 'url(#schemaArrowSel)' });
    this.edgesSvg.append(this.edgeLayer, this.tempPath);
    this.blocks = el('div', { className: 'schema-blocks' });
    this.stage.append(this.edgesSvg, this.blocks);

    this.tools = this.compact
      ? el('div', { className: 'schema-tools' },
        btn('Вписать', 'Показать схему целиком', () => this.smooth(() => this.fit())),
        btn('Открыть целиком', 'Открыть блок-схему на весь экран', () => this.openFull(this.focusPath)))
      : el('div', { className: 'schema-tools' },
        btn('+ Заметки', 'Добавить на схему существующие заметки и папки', () => this.togglePanel()),
        btn('Новая заметка', 'Создать заметку прямо на схеме', () => this.askName(null, null)),
        btn('Выровнять', 'Разложить все блоки по уровням заново', () => this.relayout()),
        btn('Вписать', 'Показать схему целиком', () => this.smooth(() => this.fit())));
    this.notice = el('div', { className: 'schema-notice', hidden: true });
    this.selBar = el('div', { className: 'schema-selbar', hidden: true });
    this.empty = el('div', { className: 'schema-empty' },
      el('b', { textContent: 'Схема пока пустая' }),
      el('span', { textContent: this.compact ? 'Нажмите «Открыть целиком», чтобы добавить заметки и связи.' : 'Добавьте заметки кнопкой «+ Заметки» или создайте новую. Чтобы связать блоки, потяните за кружок внизу блока к другому блоку. Если отпустить на пустом месте, появится новая заметка ниже.' }));
    this.panel = el('div', { className: 'schema-panel', hidden: true });
    this.nameBox = el('form', { className: 'schema-name', hidden: true });
    this.nameInput = el('input', { placeholder: 'Название заметки', autocomplete: 'off' });
    this.nameBox.append(this.nameInput, el('button', { type: 'submit', className: 'primary', textContent: 'Создать' }));
    this.nameBox.addEventListener('submit', e => { e.preventDefault(); this.commitName(); });
    this.nameInput.addEventListener('keydown', e => { if (e.key === 'Escape') this.cancelName(); });
    this.root.append(this.stage, this.tools, this.selBar, this.empty, this.panel, this.nameBox, this.notice);
    this.bindPointer();
  }

  // ---------- Data ----------
  load() {
    const src = this.vault.schema();
    this.s = { nodes: src.nodes.map(n => ({ ...n })), edges: src.edges.map(e => ({ ...e })) };
    this.autoPlace();
    if (this.sel && !(this.sel.type === 'node' ? this.node(this.sel.id) : this.s.edges.find(e => e.id === this.sel.id))) this.sel = null;
  }
  node(id) { return this.s.nodes.find(n => n.id === id); }
  nodeFor(path) { return this.s.nodes.find(n => n.file === path); }
  autoPlace() {
    const pos = layout(this.s);
    for (const n of this.s.nodes) if (!n.pinned && pos.has(n.id)) Object.assign(n, pos.get(n.id));
  }
  save() {
    this.saving = true;
    this.vault.saveSchema(this.s);
    this.saving = false;
    this.onSaved();
  }

  addNote(path, { parent = null } = {}) {
    const prev = this.snapshot();
    let n = this.nodeFor(path);
    if (!n) { n = { id: newId(), file: path, x: 0, y: 0, pinned: false }; this.s.nodes.push(n); }
    if (parent) this.connect(parent, n.id, true);
    this.autoPlace();
    this.save();
    this.render();
    this.tween(prev);
    return n;
  }
  // A folder block; it goes under its parent folder or above its subfolders if those are on the schema.
  addFolder(dir) {
    const prev = this.snapshot();
    let n = this.s.nodes.find(x => x.folder === dir);
    if (!n) {
      n = { id: newId(), folder: dir, x: 0, y: 0, pinned: false };
      this.s.nodes.push(n);
      const parent = this.s.nodes.find(x => x.folder !== undefined && dir.startsWith(x.folder + '/') && !dir.slice(x.folder.length + 1).includes('/'));
      if (parent) this.connect(parent.id, n.id, true);
      for (const sub of this.s.nodes.filter(x => x.folder !== undefined && x.folder.startsWith(dir + '/') && !x.folder.slice(dir.length + 1).includes('/'))) {
        if (!this.s.edges.some(e => e.toNode === sub.id)) this.connect(n.id, sub.id, true);
      }
    }
    this.autoPlace();
    this.save();
    this.render();
    this.tween(prev);
    return n;
  }
  connect(fromId, toId, quiet = false) {
    if (fromId === toId) return false;
    if (this.s.edges.some(e => e.fromNode === fromId && e.toNode === toId)) return false;
    if (reaches(this.s, toId, fromId)) {
      if (!quiet) this.toast(`Так получится замкнутый круг: «${this.title(this.node(fromId))}» уже находится ниже «${this.title(this.node(toId))}».`, 7000);
      return false;
    }
    const prev = this.snapshot();
    this.s.edges.push({ id: newId(), fromNode: fromId, toNode: toId });
    if (!quiet) { this.autoPlace(); this.save(); this.render(); this.tween(prev); }
    return true;
  }
  removeSelected() {
    if (!this.sel) return;
    const prev = this.snapshot();
    if (this.sel.type === 'edge') this.s.edges = this.s.edges.filter(e => e.id !== this.sel.id);
    else {
      const id = this.sel.id;
      this.s.nodes = this.s.nodes.filter(n => n.id !== id);
      this.s.edges = this.s.edges.filter(e => e.fromNode !== id && e.toNode !== id);
    }
    this.sel = null;
    this.autoPlace(); this.save(); this.render(); this.tween(prev);
  }
  relayout() {
    const prev = this.snapshot();
    for (const n of this.s.nodes) n.pinned = false;
    this.autoPlace(); this.save(); this.render(); this.tween(prev); this.smooth(() => this.fit());
  }
  title(n) { return !n ? '' : n.folder !== undefined ? n.folder.split('/').pop() : basename(n.file); }

  // ---------- Showing ----------
  show(focusPath, { autoAdd = true } = {}) {
    this.visible = true;
    this.focusPath = focusPath;
    this.load();
    this.notice.hidden = true;
    const has = focusPath && this.vault.get(focusPath);
    if (has && !this.nodeFor(focusPath) && !autoAdd) {
      // The panel never changes the schema by itself: offer to add the note.
      const add = el('button', { type: 'button', className: 'primary', textContent: 'Добавить на схему' });
      add.addEventListener('click', () => this.show(focusPath));
      this.notice.replaceChildren(el('span', { textContent: `«${basename(focusPath)}» пока нет на блок-схеме.` }), add);
      this.notice.hidden = false;
      this.render();
      if (!this.positioned) this.fit();
      this.positioned = true;
      this.applyView();
      return;
    }
    if (has) {
      const n = this.nodeFor(focusPath) || this.addNote(focusPath);
      // In the side panel the open note is only highlighted, so no buttons cover the schema.
      this.sel = this.compact ? null : { type: 'node', id: n.id };
      this.render();
      if (this.positioned) { this.smooth(() => this.centerOn(n)); return; }
      this.centerOn(n);
    } else {
      this.render();
      if (!this.positioned) this.fit();
    }
    this.positioned = true;
    this.applyView();
  }
  hide() { this.visible = false; this.cancelName(); this.panel.hidden = true; }
  // Called when notes or the schema changed elsewhere (sync, rename, delete).
  refresh() {
    if (!this.visible || this.gesture || this.saving) return;
    const prev = this.snapshot();
    this.load();
    this.render();
    this.tween(prev);
  }

  // ---------- Smooth motion ----------
  snapshot() { return new Map(this.s.nodes.map(n => [n.id, { x: n.x, y: n.y }])); }
  blockEl(id) { return this.blocks.querySelector(`[data-id="${CSS.escape(id)}"]`); }
  // Blocks glide from where they were to where the layout put them; new ones pop in.
  tween(prev, ms = 320) {
    this.finishTween();
    for (const n of this.s.nodes) if (!prev.has(n.id)) this.blockEl(n.id)?.classList.add('appear');
    if (reducedMotion()) return;
    const moves = this.s.nodes.filter(n => prev.has(n.id) && (Math.abs(prev.get(n.id).x - n.x) > 0.5 || Math.abs(prev.get(n.id).y - n.y) > 0.5))
      .map(n => ({ n, fx: prev.get(n.id).x, fy: prev.get(n.id).y, tx: n.x, ty: n.y }));
    if (!moves.length) return;
    const t0 = performance.now();
    const place = e => {
      for (const m of moves) {
        m.n.x = m.fx + (m.tx - m.fx) * e;
        m.n.y = m.fy + (m.ty - m.fy) * e;
        const b = this.blockEl(m.n.id);
        if (b) { b.style.left = (m.n.x - W / 2) + 'px'; b.style.top = m.n.y + 'px'; }
      }
      this.renderEdges();
    };
    this.tweening = { moves, place };
    const step = now => {
      const t = Math.min(1, (now - t0) / ms);
      place(easeOut(t));
      if (t < 1) this.tweenRaf = requestAnimationFrame(step); else this.tweening = null;
    };
    place(0);
    this.tweenRaf = requestAnimationFrame(step);
  }
  finishTween() {
    if (!this.tweening) return;
    cancelAnimationFrame(this.tweenRaf);
    this.tweening.place(1);
    this.tweening = null;
  }
  // Runs fn (which moves the view), then animates from the old view to the new one.
  smooth(fn, ms = 360) {
    const from = { ...this.view };
    fn();
    const to = { ...this.view };
    if (reducedMotion() || !this.positioned) { this.applyView(); return; }
    this.view = from;
    cancelAnimationFrame(this.viewRaf);
    this.zoomGoal = null;
    const t0 = performance.now();
    const step = now => {
      const e = easeOut(Math.min(1, (now - t0) / ms));
      this.view = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, k: from.k + (to.k - from.k) * e };
      this.applyView();
      if (e < 1) this.viewRaf = requestAnimationFrame(step);
    };
    this.viewRaf = requestAnimationFrame(step);
  }

  render() {
    this.blocks.replaceChildren();
    for (const n of this.s.nodes) {
      const isFolder = n.folder !== undefined;
      const note = isFolder ? null : this.vault.get(n.file);
      const count = isFolder ? this.vault.notesIn(n.folder).length : 0;
      const first = isFolder ? `Папка · заметок: ${count}`
        : note ? stripCode(note.content).split('\n').map(l => l.replace(/^[#>*\-+\s]+|\[[ xX]\]\s*/g, '').trim()).find(Boolean) || '' : 'Заметка удалена или ещё не пришла';
      const b = el('div', { className: 'sblock' + (isFolder ? ' folder' : note ? '' : ' missing') + (this.sel?.type === 'node' && this.sel.id === n.id ? ' selected' : '') + (this.compact && n.file && n.file === this.focusPath ? ' current' : '') },
        el('div', { className: 'sblock-title', textContent: (isFolder ? '📁 ' : '') + this.title(n) }),
        el('div', { className: 'sblock-sub', textContent: first.replace(/\[\[([^\]|]+\|)?([^\]]+)\]\]/g, '$2').slice(0, 80) }),
        el('div', { className: 'sblock-handle', title: 'Потяните к другому блоку, чтобы связать' }));
      b.dataset.id = n.id;
      b.style.left = (n.x - W / 2) + 'px';
      b.style.top = n.y + 'px';
      this.blocks.append(b);
    }
    this.renderEdges();
    this.renderSelBar();
    this.empty.hidden = this.s.nodes.length > 0;
  }

  edgePath(a, b) {
    const x1 = a.x, y1 = a.y + H, x2 = b.x, y2 = b.y;
    const dy = Math.max(40, Math.abs(y2 - y1) / 2);
    return `M${x1} ${y1} C${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2 - 2}`;
  }
  renderEdges() {
    this.edgeLayer.replaceChildren();
    for (const e of this.s.edges) {
      const a = this.node(e.fromNode), b = this.node(e.toNode);
      if (!a || !b) continue;
      const d = this.edgePath(a, b);
      const selected = this.sel?.type === 'edge' && this.sel.id === e.id;
      const hit = svg('path', { d, class: 'schema-edge-hit' });
      hit.dataset.id = e.id;
      this.edgeLayer.append(svg('path', { d, class: 'schema-edge' + (selected ? ' selected' : ''), 'marker-end': selected ? 'url(#schemaArrowSel)' : 'url(#schemaArrow)' }), hit);
    }
  }
  renderSelBar() {
    const bar = this.selBar;
    bar.replaceChildren();
    const btn = (text, fn, cls = '') => { const b = el('button', { type: 'button', textContent: text, className: cls }); b.addEventListener('click', e => { e.stopPropagation(); fn(); }); return b; };
    if (!this.sel) { bar.hidden = true; return; }
    if (this.sel.type === 'node') {
      const n = this.node(this.sel.id);
      if (!n) { bar.hidden = true; return; }
      if (!this.compact) bar.append(el('span', { className: 'schema-selname', textContent: this.title(n) }));
      if (n.file && this.vault.get(n.file) && !(this.compact && n.file === this.focusPath)) bar.append(btn('Открыть', () => this.openNote(n.file), 'primary'));
      bar.append(btn(n.folder !== undefined ? 'Новая заметка в папке' : 'Добавить ниже', () => this.askName(n.id, null)), btn('Убрать со схемы', () => this.removeSelected(), 'danger-text'));
    } else {
      const e = this.s.edges.find(x => x.id === this.sel.id);
      if (!e) { bar.hidden = true; return; }
      bar.append(el('span', { className: 'schema-selname', textContent: `${this.title(this.node(e.fromNode))} → ${this.title(this.node(e.toNode))}` }),
        btn('Удалить связь', () => this.removeSelected(), 'danger-text'));
    }
    bar.hidden = false;
  }
  select(sel) { this.sel = sel; this.render(); }

  // ---------- Panel: add existing notes ----------
  togglePanel() {
    if (!this.panel.hidden) { this.panel.hidden = true; return; }
    this.cancelName();
    const search = el('input', { type: 'search', placeholder: 'Найти заметку или папку', autocomplete: 'off' });
    const list = el('div', { className: 'schema-panel-list' });
    const fill = () => {
      const q = search.value.trim().toLowerCase();
      const onSchema = new Set(this.s.nodes.map(n => n.file));
      const free = this.vault.notes().filter(n => !onSchema.has(n.path) && n.path.toLowerCase().includes(q))
        .sort((a, b) => basename(a.path).localeCompare(basename(b.path), 'ru'));
      // Folders too: a folder goes on the schema as a 📁 block.
      const foldersOn = new Set(this.s.nodes.filter(n => n.folder !== undefined).map(n => n.folder));
      const freeFolders = this.vault.folders().filter(f => !foldersOn.has(f) && f.toLowerCase().includes(q));
      list.replaceChildren();
      if (!free.length && !freeFolders.length) list.append(el('p', { className: 'muted', textContent: q ? 'Ничего не найдено.' : 'Все заметки и папки уже на схеме.' }));
      if (freeFolders.length) list.append(el('div', { className: 'schema-panel-group', textContent: 'Папки' }));
      for (const f of freeFolders) {
        const b = el('button', { type: 'button', className: 'schema-panel-folder', textContent: '📁 ' + f.split('/').pop(), title: f });
        if (f.includes('/')) b.append(el('small', { textContent: ' ' + f.slice(0, f.lastIndexOf('/')) }));
        b.addEventListener('click', () => { const node = this.addFolder(f); this.sel = { type: 'node', id: node.id }; this.render(); this.smooth(() => this.centerOn(node)); fill(); });
        list.append(b);
      }
      if (freeFolders.length && free.length) list.append(el('div', { className: 'schema-panel-group', textContent: 'Заметки' }));
      for (const n of free) {
        const b = el('button', { type: 'button', textContent: basename(n.path) });
        b.addEventListener('click', () => { const node = this.addNote(n.path); this.sel = { type: 'node', id: node.id }; this.render(); this.blockEl(node.id)?.classList.add('appear'); this.smooth(() => this.centerOn(node)); fill(); });
        list.append(b);
      }
      addAll.hidden = free.length < 2 || Boolean(q);
    };
    const addAll = el('button', { type: 'button', className: 'primary', textContent: 'Добавить все' });
    addAll.addEventListener('click', () => {
      const onSchema = new Set(this.s.nodes.map(n => n.file));
      for (const n of this.vault.notes()) if (!onSchema.has(n.path)) this.s.nodes.push({ id: newId(), file: n.path, x: 0, y: 0, pinned: false });
      const prev = this.snapshot();
      this.autoPlace(); this.save(); this.render(); this.tween(prev); this.smooth(() => this.fit()); fill();
    });
    const close = el('button', { type: 'button', textContent: 'Готово' });
    close.addEventListener('click', () => { this.panel.hidden = true; });
    search.addEventListener('input', fill);
    this.panel.replaceChildren(el('div', { className: 'schema-panel-head' }, el('b', { textContent: 'Добавить на схему' }), close), search, list, addAll);
    fill();
    this.panel.hidden = false;
    search.focus();
  }

  // ---------- New note right on the schema ----------
  askName(parentId, at) {
    this.panel.hidden = true;
    this.pendingParent = parentId;
    const r = this.root.getBoundingClientRect();
    let left = r.width / 2 - 150, top = 70;
    if (at) { left = Math.min(Math.max(8, at.x - 150), r.width - 308); top = Math.min(Math.max(60, at.y - 20), r.height - 60); }
    Object.assign(this.nameBox.style, { left: left + 'px', top: top + 'px' });
    this.nameBox.hidden = false;
    this.nameInput.value = '';
    this.nameInput.placeholder = parentId ? `Новая заметка ниже «${this.title(this.node(parentId))}»` : 'Название новой заметки';
    this.nameInput.focus();
  }
  cancelName() { this.nameBox.hidden = true; this.pendingParent = null; }
  commitName() {
    const name = cleanTitle(this.nameInput.value);
    if (!name) { this.nameInput.focus(); return; }
    const parent = this.pendingParent;
    // "Добавить ниже" on a folder makes the note inside that folder.
    const dir = this.node(parent)?.folder;
    let path = dir !== undefined ? null : this.vault.findPath(name + '.md') || this.vault.resolve(name);
    if (!path) { path = this.vault.uniquePath(dir || '', name); this.vault.write(path, ''); }
    this.cancelName();
    const n = this.addNote(path, { parent });
    this.sel = { type: 'node', id: n.id };
    this.render();
    this.smooth(() => this.centerOn(n, true));
  }

  // ---------- View transform ----------
  applyView() { this.stage.style.transform = `translate(${this.view.x}px, ${this.view.y}px) scale(${this.view.k})`; }
  toWorld(cx, cy) {
    const r = this.root.getBoundingClientRect();
    return { x: (cx - r.left - this.view.x) / this.view.k, y: (cy - r.top - this.view.y) / this.view.k };
  }
  fit() {
    const r = this.root.getBoundingClientRect();
    if (!this.s.nodes.length || !r.width) { this.view = { x: r.width / 2 || 300, y: 90, k: 1 }; return; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of this.s.nodes) { x0 = Math.min(x0, n.x - W / 2); x1 = Math.max(x1, n.x + W / 2); y0 = Math.min(y0, n.y); y1 = Math.max(y1, n.y + H); }
    const k = Math.min(1.2, (r.width - 40) / (x1 - x0), (r.height - 150) / (y1 - y0));
    this.view.k = Math.max(0.2, k);
    this.view.x = r.width / 2 - ((x0 + x1) / 2) * this.view.k;
    this.view.y = 80 + (r.height - 120 - (y1 - y0) * this.view.k) / 2 - y0 * this.view.k;
  }
  centerOn(n, onlyIfHidden = false) {
    const r = this.root.getBoundingClientRect();
    const sx = this.view.x + n.x * this.view.k, sy = this.view.y + (n.y + H / 2) * this.view.k;
    if (onlyIfHidden && sx > 40 && sx < r.width - 40 && sy > 80 && sy < r.height - 40) return;
    this.view.x = r.width / 2 - n.x * this.view.k;
    this.view.y = r.height / 2 - (n.y + H / 2) * this.view.k;
  }
  easeZoom(k, cx, cy) {
    cancelAnimationFrame(this.viewRaf);
    this.zoomGoal = { k: Math.min(2.5, Math.max(0.2, k)), cx, cy };
    if (reducedMotion()) { this.zoomAt(this.zoomGoal.k, cx, cy); this.zoomGoal = null; return; }
    if (this.zoomRaf) return;
    const step = () => {
      const g = this.zoomGoal;
      if (!g) { this.zoomRaf = 0; return; }
      const k = this.view.k + (g.k - this.view.k) * 0.22;
      if (Math.abs(g.k - k) < 0.0005) { this.zoomAt(g.k, g.cx, g.cy); this.zoomGoal = null; this.zoomRaf = 0; return; }
      this.zoomAt(k, g.cx, g.cy);
      this.zoomRaf = requestAnimationFrame(step);
    };
    this.zoomRaf = requestAnimationFrame(step);
  }
  zoomAt(k, cx, cy) {
    const r = this.root.getBoundingClientRect();
    const w = this.toWorld(cx, cy);
    this.view.k = Math.min(2.5, Math.max(0.2, k));
    this.view.x = cx - r.left - w.x * this.view.k;
    this.view.y = cy - r.top - w.y * this.view.k;
    this.applyView();
  }

  // ---------- Mouse and touch ----------
  bindPointer() {
    const root = this.root;
    root.addEventListener('pointerdown', e => {
      if (e.target.closest('.schema-tools, .schema-selbar, .schema-panel, .schema-name, .schema-empty')) return;
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      this.finishTween();
      cancelAnimationFrame(this.viewRaf);
      this.zoomGoal = null;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      root.setPointerCapture(e.pointerId);
      if (this.pointers.size === 2) {
        const [a, b] = [...this.pointers.values()];
        this.gesture = { type: 'pinch', dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, k: this.view.k };
        this.tempPath.setAttribute('d', '');
        return;
      }
      const start = { x: e.clientX, y: e.clientY };
      const handle = e.target.closest('.sblock-handle');
      const block = e.target.closest('.sblock');
      const edge = e.target.closest('.schema-edge-hit');
      if (handle) this.gesture = { type: 'connect', from: block.dataset.id, start, moved: false };
      else if (block) { const n = this.node(block.dataset.id); this.gesture = { type: 'drag', id: n.id, start, ox: n.x, oy: n.y, moved: false, el: block }; }
      else if (edge) { this.gesture = null; this.select({ type: 'edge', id: edge.dataset.id }); }
      else this.gesture = { type: 'pan', start, vx: this.view.x, vy: this.view.y, moved: false };
      if (handle || block) e.preventDefault();
    });
    root.addEventListener('pointermove', e => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const g = this.gesture;
      if (!g) return;
      if (g.type === 'pinch') {
        if (this.pointers.size < 2) return;
        const [a, b] = [...this.pointers.values()];
        this.zoomAt(g.k * Math.hypot(a.x - b.x, a.y - b.y) / g.dist, (a.x + b.x) / 2, (a.y + b.y) / 2);
        return;
      }
      if (Math.hypot(e.clientX - g.start.x, e.clientY - g.start.y) > 5) g.moved = true;
      if (!g.moved) return;
      if (g.type === 'pan') {
        this.view.x = g.vx + e.clientX - g.start.x; this.view.y = g.vy + e.clientY - g.start.y; this.applyView();
      } else if (g.type === 'drag') {
        const n = this.node(g.id);
        n.x = g.ox + (e.clientX - g.start.x) / this.view.k;
        n.y = g.oy + (e.clientY - g.start.y) / this.view.k;
        g.el.style.left = (n.x - W / 2) + 'px';
        g.el.style.top = n.y + 'px';
        g.el.classList.add('dragging');
        this.renderEdges();
      } else if (g.type === 'connect') {
        const a = this.node(g.from), p = this.toWorld(e.clientX, e.clientY);
        this.tempPath.setAttribute('d', this.edgePath(a, { x: p.x, y: p.y }));
        const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('.sblock');
        this.blocks.querySelectorAll('.sblock.target').forEach(b => b.classList.remove('target'));
        if (over && over.dataset.id !== g.from) over.classList.add('target');
      }
    });
    const end = e => {
      if (!this.pointers.has(e.pointerId)) return;
      this.pointers.delete(e.pointerId);
      const g = this.gesture;
      if (!g || (g.type === 'pinch' && this.pointers.size)) return;
      this.gesture = null;
      this.tempPath.setAttribute('d', '');
      this.blocks.querySelectorAll('.sblock.target').forEach(b => b.classList.remove('target'));
      if (e.type === 'pointercancel') { this.render(); return; }
      if (g.type === 'pan' && !g.moved) { if (this.sel) this.select(null); this.cancelName(); }
      if (g.type === 'drag') {
        const n = this.node(g.id);
        if (g.moved) { n.pinned = true; this.save(); this.render(); }
        else if (this.sel?.type === 'node' && this.sel.id === g.id && e.pointerType !== 'mouse' && n.file) this.openNote(n.file);
        else this.select({ type: 'node', id: g.id });
      }
      if (g.type === 'connect') {
        const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('.sblock');
        if (over && over.dataset.id !== g.from) this.connect(g.from, over.dataset.id);
        else if (g.moved && !over) { this.select({ type: 'node', id: g.from }); this.askName(g.from, { x: e.clientX - this.root.getBoundingClientRect().left, y: e.clientY - this.root.getBoundingClientRect().top }); }
        else this.select({ type: 'node', id: g.from });
      }
    };
    root.addEventListener('pointerup', end);
    root.addEventListener('pointercancel', end);
    root.addEventListener('dblclick', e => {
      const block = e.target.closest('.sblock');
      if (!block) return;
      const n = this.node(block.dataset.id);
      if (n && this.vault.get(n.file)) this.openNote(n.file);
    });
    root.addEventListener('wheel', e => {
      if (e.target.closest('.schema-panel')) return;
      e.preventDefault();
      if (e.ctrlKey || e.metaKey || e.deltaMode === 1 || Math.abs(e.deltaY) > 40 && !e.deltaX) this.easeZoom((this.zoomGoal ? this.zoomGoal.k : this.view.k) * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
      else { this.view.x -= e.deltaX; this.view.y -= e.deltaY; this.applyView(); }
    }, { passive: false });
    document.addEventListener('keydown', e => {
      if (!this.visible || e.target.closest('input, textarea, [contenteditable="true"]')) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.sel) { e.preventDefault(); this.removeSelected(); }
      else if (e.key === 'Enter' && this.sel?.type === 'node') { const n = this.node(this.sel.id); if (n && this.vault.get(n.file)) this.openNote(n.file); }
      else if (e.key === 'Escape') { this.select(null); this.cancelName(); this.panel.hidden = true; }
    });
  }
}
