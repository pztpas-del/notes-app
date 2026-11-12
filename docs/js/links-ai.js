// Finding connections between notes with a small neural network on this device.
// Each note becomes a "meaning vector" (ai-worker.js); notes whose vectors point the
// same way are about the same thing. Vectors are remembered per note and only
// recomputed when the note changes. Nothing is changed in notes without the user.
import { db } from './db.js';
import { basename, stripCode } from './vault.js';

const KEY = 'aiVectors';   // { path: { h: hash of the text, v: [numbers] } }
const HIDDEN = 'aiHidden'; // pairs the user dismissed: ["a\nb"]
export const DEFAULT_MIN = 0.86;

const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); };
const pairKey = (a, b) => (a < b ? a + '\n' + b : b + '\n' + a);
// What the network reads: the title and the text without Markdown marks ("passage:" is how this model expects documents).
const textOf = n => 'passage: ' + basename(n.path) + '\n' + stripCode(n.content)
  .replace(/!\[\[[^\]]*\]\]/g, ' ').replace(/\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_, t, a) => a || t)
  .replace(/<\/?center>|[#>*_~=`|-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500);

export class LinkFinder {
  constructor(vault) {
    this.vault = vault;
    this.vectors = null;
    this.hidden = null;
    this.worker = null;
    this.calls = new Map();
    this.nextId = 1;
    this.running = null;
  }

  async loadCache() {
    if (this.vectors) return;
    this.vectors = (await db.get(KEY)) || {};
    this.hidden = new Set((await db.get(HIDDEN)) || []);
  }
  modelReady() { return Object.keys(this.vectors || {}).length > 0; }

  embed(texts, onProgress) {
    if (!this.worker) {
      this.worker = new Worker(new URL('./ai-worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = e => {
        const m = e.data;
        if (m.type === 'download') { for (const c of this.calls.values()) c.onProgress?.({ stage: 'download', loaded: m.loaded, total: m.total }); return; }
        const c = this.calls.get(m.id);
        if (!c) return;
        if (m.type === 'step') c.onProgress?.({ stage: 'read', done: m.done, total: m.total });
        else if (m.type === 'result') { this.calls.delete(m.id); c.resolve(m.vectors); }
        else if (m.type === 'error') { this.calls.delete(m.id); c.reject(new Error(m.message)); }
      };
      this.worker.onerror = e => { for (const c of this.calls.values()) c.reject(new Error(e.message || 'Нейросеть не запустилась')); this.calls.clear(); this.worker = null; };
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ id, texts });
    });
  }

  // Reads the notes that are new or changed since last time. Returns how many were read.
  update(onProgress) {
    if (!this.running) this.running = this.runUpdate(onProgress).finally(() => { this.running = null; });
    return this.running;
  }
  async runUpdate(onProgress) {
    await this.loadCache();
    const notes = this.vault.notes().filter(n => n.content.trim().length >= 3);
    const alive = new Set(notes.map(n => n.path));
    for (const p of Object.keys(this.vectors)) if (!alive.has(p)) delete this.vectors[p];
    const todo = notes.map(n => ({ path: n.path, text: textOf(n) })).map(t => ({ ...t, h: hash(t.text) }))
      .filter(t => this.vectors[t.path]?.h !== t.h);
    if (todo.length) {
      const vecs = await this.embed(todo.map(t => t.text), onProgress);
      todo.forEach((t, i) => { this.vectors[t.path] = { h: t.h, v: vecs[i].map(x => Math.round(x * 1e4) / 1e4) }; });
    }
    await db.set(KEY, this.vectors);
    return todo.length;
  }

  // Pairs that already have a [[link]] or a flowchart arrow.
  linkedPairs() {
    const set = new Set();
    const i = this.vault.index();
    for (const [from, targets] of i.links) for (const t of targets) { const to = this.vault.resolve(t); if (to && to !== from) set.add(pairKey(from, to)); }
    const s = this.vault.schema();
    const byId = new Map(s.nodes.map(n => [n.id, n.file]));
    for (const e of s.edges) { const a = byId.get(e.fromNode), b = byId.get(e.toNode); if (a && b) set.add(pairKey(a, b)); }
    return set;
  }

  // Suggested connections: [{ a, b, score }], best first. forPath = only for that note.
  suggestions({ min = DEFAULT_MIN, perNote = 3, forPath = null } = {}) {
    if (!this.vectors) return [];
    const linked = this.linkedPairs();
    const paths = Object.keys(this.vectors).filter(p => this.vault.get(p));
    const dot = (x, y) => { let s = 0; for (let k = 0; k < x.length; k++) s += x[k] * y[k]; return s; };
    const best = new Map(); // path -> [{ other, score }]
    for (let i = 0; i < paths.length; i++) {
      for (let j = i + 1; j < paths.length; j++) {
        const a = paths[i], b = paths[j];
        if (forPath && a !== forPath && b !== forPath) continue;
        const key = pairKey(a, b);
        if (linked.has(key) || this.hidden.has(key)) continue;
        const score = dot(this.vectors[a].v, this.vectors[b].v);
        if (score < min) continue;
        for (const [x, y] of [[a, b], [b, a]]) { if (!best.has(x)) best.set(x, []); best.get(x).push({ other: y, score }); }
      }
    }
    // Each note keeps only its closest few, so a long note does not link to everything.
    const out = new Map();
    for (const [x, list] of best) for (const { other, score } of list.sort((p, q) => q.score - p.score).slice(0, perNote)) out.set(pairKey(x, other), { a: x < other ? x : other, b: x < other ? other : x, score });
    return [...out.values()].sort((p, q) => q.score - p.score);
  }

  async hide(a, b) { await this.loadCache(); this.hidden.add(pairKey(a, b)); await db.set(HIDDEN, [...this.hidden]); }
}

// Adds [[b]] to note a, in a "См. также" line at the end (made if missing).
export function addSeeAlso(vault, a, b) {
  const note = vault.get(a);
  if (!note) return;
  const link = `[[${basename(b)}]]`;
  const lines = note.content.replace(/\s+$/, '').split('\n');
  const last = lines[lines.length - 1] || '';
  if (/^См\. также:/.test(last)) lines[lines.length - 1] = last + ', ' + link;
  else lines.push('', 'См. также: ' + link);
  vault.write(a, lines.join('\n').replace(/^\n+/, '') + '\n');
}
