// The vault: every note on this device, plus the link index built from them.
// A file record: { path, content, baseSha, dirty, deleted, mtime }
//   baseSha  - git blob sha of the version last seen on GitHub (null = never synced)
//   dirty    - changed here and not yet sent to GitHub
//   deleted  - deleted here; kept as a marker until GitHub has the deletion
import { db } from './db.js';

const LINK_RE = /\[\[([^\]\n|#]*)(#[^\]\n|]*)?(\|[^\]\n]*)?\]\]/g;
const TAG_RE = /(^|\s)#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu;

export const basename = p => p.split('/').pop().replace(/\.md$/i, '');
export const dirname = p => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
export const stripCode = s => s.replace(/^(```|~~~)[\s\S]*?^\1\s*$/gm, '').replace(/`[^`\n]*`/g, '');

// Cleans a typed title into a safe relative path without the extension.
export function cleanTitle(text) {
  return text.split('/')
    .map(seg => seg.replace(/[\\:*?"<>|#^[\]]/g, '').replace(/\s+/g, ' ').trim())
    .filter(seg => seg && seg !== '.' && seg !== '..')
    .join('/');
}

export class Vault {
  constructor() {
    this.files = new Map();
    this.listeners = new Set();
    this.toSave = new Set();
    this.toRemove = new Set();
    this.saveTimer = null;
    this.idx = null;
  }

  async load() {
    for (const f of await db.allFiles()) this.files.set(f.path, f);
    this.changed();
  }

  onChange(fn) { this.listeners.add(fn); }
  changed() { this.idx = null; for (const fn of this.listeners) fn(); }

  notes() { return [...this.files.values()].filter(f => !f.deleted && /\.md$/i.test(f.path)); }
  get(path) { const f = this.files.get(path); return f && !f.deleted ? f : null; }
  pendingCount() { return [...this.files.values()].filter(f => f.dirty).length; }
  findPath(path) {
    const low = path.toLowerCase();
    return this.notes().find(n => n.path.toLowerCase() === low)?.path || null;
  }
  uniquePath(dir, name) {
    for (let i = 1; ; i++) {
      const p = (dir ? dir + '/' : '') + name + (i > 1 ? ' ' + i : '') + '.md';
      if (!this.findPath(p)) return p;
    }
  }

  // ---------- Saving to this device ----------
  touch(path) {
    this.toRemove.delete(path);
    this.toSave.add(path);
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 300);
  }
  drop(path) {
    this.files.delete(path);
    this.toSave.delete(path);
    this.toRemove.add(path);
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 300);
  }
  async flush() {
    clearTimeout(this.saveTimer);
    const recs = [...this.toSave].map(p => this.files.get(p)).filter(Boolean);
    const removed = [...this.toRemove];
    this.toSave.clear(); this.toRemove.clear();
    if (recs.length || removed.length) await db.saveFiles(recs.map(r => ({ ...r })), removed);
  }

  // ---------- Editing ----------
  write(path, content) {
    const f = this.files.get(path) || { path, baseSha: null };
    if (!f.deleted && f.content === content) return;
    Object.assign(f, { content, dirty: true, deleted: false, mtime: Date.now() });
    this.files.set(path, f);
    this.touch(path);
    this.changed();
  }
  remove(path) {
    const f = this.files.get(path);
    if (!f) return;
    if (f.baseSha) { Object.assign(f, { deleted: true, dirty: true, content: '', mtime: Date.now() }); this.touch(path); }
    else this.drop(path);
    this.changed();
  }
  // Moves a note and rewrites [[links]] that pointed at it. Returns the new path.
  rename(oldPath, newPath) {
    const note = this.get(oldPath);
    if (!note || oldPath === newPath) return oldPath;
    const clash = this.findPath(newPath);
    if (clash && clash !== oldPath) throw new Error('Заметка с таким названием уже есть.');
    const newName = basename(newPath);
    const ambiguous = this.notes().some(n => n.path !== oldPath && basename(n.path).toLowerCase() === newName.toLowerCase());
    const linkName = ambiguous ? newPath.replace(/\.md$/i, '') : newName;
    const rewrites = [];
    for (const n of this.notes()) {
      if (n.path === oldPath) continue;
      const next = n.content.replace(LINK_RE, (m, target, head = '', alias = '') =>
        this.resolve(target) === oldPath ? `[[${linkName}${head}${alias}]]` : m);
      if (next !== n.content) rewrites.push([n.path, next]);
    }
    const content = note.content;
    this.remove(oldPath);
    this.write(newPath, content);
    for (const [p, c] of rewrites) this.write(p, c);
    return newPath;
  }

  // ---------- Used by sync ----------
  setClean(path, content, sha) {
    const f = this.files.get(path) || { path };
    Object.assign(f, { content, baseSha: sha, dirty: false, deleted: false, mtime: Date.now() });
    this.files.set(path, f);
    this.touch(path);
  }
  addConflictCopy(path, content) {
    const d = new Date(), pad = n => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}`;
    const copy = this.uniquePath(dirname(path), `${basename(path)} (конфликт ${stamp})`);
    this.files.set(copy, { path: copy, content, baseSha: null, dirty: true, deleted: false, mtime: Date.now() });
    this.touch(copy);
    return copy;
  }

  // ---------- Links, tags, graph ----------
  index() {
    if (this.idx) return this.idx;
    const byPath = new Map(), byName = new Map(), links = new Map(), tags = new Map();
    const notes = this.notes().sort((a, b) => a.path.length - b.path.length);
    for (const n of notes) {
      byPath.set(n.path.replace(/\.md$/i, '').toLowerCase(), n.path);
      const name = basename(n.path).toLowerCase();
      if (!byName.has(name)) byName.set(name, n.path);
    }
    for (const n of notes) {
      const body = stripCode(n.content);
      links.set(n.path, [...body.matchAll(LINK_RE)].map(m => m[1].trim()).filter(Boolean));
      for (const m of body.matchAll(TAG_RE)) {
        const t = m[2].toLowerCase();
        if (!tags.has(t)) tags.set(t, new Set());
        tags.get(t).add(n.path);
      }
    }
    this.idx = { byPath, byName, links, tags };
    return this.idx;
  }
  resolve(target) {
    const t = String(target).split('#')[0].split('|')[0].trim().replace(/\.md$/i, '').toLowerCase();
    if (!t) return null;
    const i = this.index();
    return i.byPath.get(t) || i.byName.get(t.split('/').pop()) || null;
  }
  backlinks(path) {
    const out = [];
    for (const n of this.notes()) {
      if (n.path === path) continue;
      const lines = n.content.split('\n').filter(line =>
        [...stripCode(line).matchAll(LINK_RE)].some(m => this.resolve(m[1]) === path));
      if (lines.length) out.push({ path: n.path, lines });
    }
    return out.sort((a, b) => basename(a.path).localeCompare(basename(b.path), 'ru'));
  }
  graph(showMissing) {
    const i = this.index();
    const nodes = new Map(this.notes().map(n => [n.path, { id: n.path, label: basename(n.path), exists: true, deg: 0 }]));
    const edges = [], seen = new Set();
    for (const [from, targets] of i.links) {
      for (const t of targets) {
        let to = this.resolve(t);
        if (!to) {
          if (!showMissing) continue;
          to = 'missing:' + t.toLowerCase();
          if (!nodes.has(to)) nodes.set(to, { id: to, label: t, exists: false, deg: 0 });
        }
        const key = from < to ? from + '\n' + to : to + '\n' + from;
        if (from === to || seen.has(key)) continue;
        seen.add(key); edges.push([from, to]);
        nodes.get(from).deg++; nodes.get(to).deg++;
      }
    }
    return { nodes: [...nodes.values()], edges };
  }
}
