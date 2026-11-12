// The vault: every note on this device, plus the link index built from them.
// A file record: { path, content, baseSha, dirty, deleted, mtime }
//   content  - the text of a note, or base64 bytes of an attachment (image, PDF…)
//   baseSha  - git blob sha of the version last seen on GitHub (null = never synced)
//   dirty    - changed here and not yet sent to GitHub
//   deleted  - deleted here; kept as a marker until GitHub has the deletion
import { db } from './db.js';

const LINK_RE = /\[\[([^\]\n|#]*)(#[^\]\n|]*)?(\|[^\]\n]*)?\]\]/g;
const TAG_RE = /(^|\s)#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu;

export const basename = p => p.split('/').pop().replace(/\.md$/i, '');
export const filename = p => p.split('/').pop();
export const dirname = p => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
export const isNote = p => /\.md$/i.test(p);
// Text files are stored as text; everything else (attachments) as base64.
export const isText = p => /\.(md|canvas|json)$/i.test(p);
export const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
// Files that travel through sync: notes, the flowchart, common attachment types.
export const isSynced = p => /\.(md|canvas|json|png|jpe?g|gif|webp|svg|bmp|avif|pdf|txt|mp3|m4a|ogg|wav|mp4|webm|docx?|xlsx?|pptx?|zip)$/i.test(p);
// The flowchart lives in one JSON Canvas file (jsoncanvas.org), readable by other apps.
export const SCHEMA_PATH = 'Схема.canvas';

// Folders: the list of folders (also empty ones) and how they sit on the flowchart.
// { folders: [paths], schemaLink: bool (new notes go under their folder on the
//   flowchart), overrides: { folderPath: bool } (per-folder on/off) }
export const FOLDERS_PATH = 'Настройки папок.json';

// Parses the flowchart file into nodes (one per note or folder) and parent→child edges.
// A folder is a text node with an extra "folder" field, so other canvas apps show it as text.
export function parseSchema(text) {
  try {
    const j = JSON.parse(text || '{}');
    const nodes = (Array.isArray(j.nodes) ? j.nodes : [])
      .filter(n => n && n.id && ((n.type === 'file' && typeof n.file === 'string') || (n.type === 'text' && typeof n.folder === 'string')))
      .map(n => ({ id: String(n.id), ...(n.type === 'file' ? { file: n.file } : { folder: n.folder }), x: Number(n.x) || 0, y: Number(n.y) || 0, pinned: Boolean(n.pinned) }));
    const ids = new Set(nodes.map(n => n.id));
    const edges = (Array.isArray(j.edges) ? j.edges : [])
      .filter(e => e && ids.has(e.fromNode) && ids.has(e.toNode) && e.fromNode !== e.toNode)
      .map(e => ({ id: String(e.id || Math.random().toString(36).slice(2)), fromNode: e.fromNode, toNode: e.toNode }));
    return { nodes, edges };
  } catch {
    return { nodes: [], edges: [] };
  }
}
export function serializeSchema(s) {
  return JSON.stringify({
    nodes: s.nodes.map(n => ({ id: n.id, ...(n.folder !== undefined ? { type: 'text', text: '📁 ' + n.folder.split('/').pop(), folder: n.folder } : { type: 'file', file: n.file }),
      x: Math.round(n.x), y: Math.round(n.y), width: 200, height: 64, ...(n.pinned ? { pinned: true } : {}) })),
    edges: s.edges.map(e => ({ id: e.id, fromNode: e.fromNode, fromSide: 'bottom', toNode: e.toNode, toSide: 'top', toEnd: 'arrow' })),
  }, null, '\t') + '\n';
}
export const ATTACH_DIR = 'Вложения';
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif', pdf: 'application/pdf', mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm', txt: 'text/plain' };
export const mimeOf = p => MIME[(p.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';
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
    this.urls = new Map(); // path -> { content, url } object URLs for attachments
    this.media = null;     // MediaStore: pictures and files on Yandex Disk
  }

  async load() {
    for (const f of await db.allFiles()) this.files.set(f.path, f);
    this.changed();
  }

  onChange(fn) { this.listeners.add(fn); }
  changed() { this.idx = null; this.rev = (this.rev || 0) + 1; for (const fn of this.listeners) fn(); }

  notes() { return [...this.files.values()].filter(f => !f.deleted && /\.md$/i.test(f.path)); }
  get(path) { const f = this.files.get(path); return f && !f.deleted ? f : null; }
  pendingCount() { return [...this.files.values()].filter(f => f.dirty).length; }
  findPath(path) {
    const low = path.toLowerCase();
    return this.notes().find(n => n.path.toLowerCase() === low)?.path || null;
  }
  // Old-style attachments stored in GitHub (before Yandex Disk); moved over on connect.
  legacyAttachments() { return [...this.files.values()].filter(f => !f.deleted && !isText(f.path)); }
  // Every picture and file, wherever it is kept: [{ path, size, dirty, legacy }]
  attachments() {
    const out = new Map();
    for (const f of this.legacyAttachments()) out.set(f.path, { path: f.path, size: Math.round(f.content.length * 0.75), dirty: Boolean(f.dirty), legacy: true });
    if (this.media) for (const m of this.media.list()) if (!out.has(m.path)) out.set(m.path, { ...m, legacy: false });
    return [...out.values()];
  }
  hasFile(path) { return Boolean(this.get(path)) || Boolean(this.media && this.media.has(path)); }

  // ---------- Flowchart ----------
  schema() {
    const f = this.get(SCHEMA_PATH);
    const text = f ? f.content : '';
    if (!this.schemaCache || this.schemaCache.text !== text) this.schemaCache = { text, data: parseSchema(text) };
    return this.schemaCache.data;
  }
  saveSchema(s) { this.write(SCHEMA_PATH, serializeSchema(s)); }
  // Parent and child notes of a note in the flowchart.
  schemaRelations(path) {
    const s = this.schema();
    const byId = new Map(s.nodes.map(n => [n.id, n.file]));
    const mine = new Set(s.nodes.filter(n => n.file === path).map(n => n.id));
    const parents = [], children = [];
    for (const e of s.edges) {
      if (mine.has(e.toNode)) parents.push(byId.get(e.fromNode));
      if (mine.has(e.fromNode)) children.push(byId.get(e.toNode));
    }
    const uniq = a => [...new Set(a)].filter(p => p && this.get(p));
    return { parents: uniq(parents), children: uniq(children) };
  }
  // Keeps the flowchart in step when a note is renamed (to = new path) or deleted (to = null).
  updateSchemaNote(from, to) {
    const s = this.schema();
    if (!s.nodes.some(n => n.file === from)) return;
    if (to) s.nodes.forEach(n => { if (n.file === from) n.file = to; });
    else {
      const gone = new Set(s.nodes.filter(n => n.file === from).map(n => n.id));
      s.nodes = s.nodes.filter(n => !gone.has(n.id));
      s.edges = s.edges.filter(e => !gone.has(e.fromNode) && !gone.has(e.toNode));
    }
    this.saveSchema(s);
  }
  // ---------- Folders ----------
  folderConf() {
    let c = {};
    try { c = JSON.parse(this.get(FOLDERS_PATH)?.content || '{}') || {}; } catch { c = {}; }
    return { folders: Array.isArray(c.folders) ? c.folders : [], schemaLink: Boolean(c.schemaLink), overrides: c.overrides && typeof c.overrides === 'object' ? c.overrides : {} };
  }
  saveFolderConf(c) {
    c.folders = [...new Set(c.folders)].sort((a, b) => a.localeCompare(b, 'ru'));
    this.write(FOLDERS_PATH, JSON.stringify(c, null, 2) + '\n');
  }
  // Every folder: the ones that hold notes or files, their parents, and empty ones made by hand.
  folders() {
    const out = new Set();
    const add = p => { for (let d = dirname(p); d; d = dirname(d)) out.add(d); };
    for (const n of this.notes()) add(n.path);
    for (const a of this.attachments()) add(a.path);
    for (const f of this.folderConf().folders) { out.add(f); add(f); }
    out.delete(ATTACH_DIR);
    return [...out].sort((a, b) => a.localeCompare(b, 'ru'));
  }
  // Is "new notes go under this folder on the flowchart" on for this folder?
  folderLinked(dir) {
    const c = this.folderConf();
    return dir in c.overrides ? Boolean(c.overrides[dir]) : c.schemaLink;
  }
  setFolderLinked(dir, on) {
    const c = this.folderConf();
    if (on === c.schemaLink) delete c.overrides[dir]; else c.overrides[dir] = on;
    this.saveFolderConf(c);
  }
  createFolder(dir) {
    const c = this.folderConf();
    c.folders.push(dir);
    this.saveFolderConf(c);
  }
  notesIn(dir) { return this.notes().filter(n => n.path.startsWith(dir + '/')); }
  // Renames a folder: moves its notes (links are rewritten), keeps settings and the flowchart.
  renameFolder(from, to) {
    if (from === to) return;
    if (this.folders().some(f => f.toLowerCase() === to.toLowerCase())) throw new Error('Папка с таким названием уже есть.');
    for (const n of this.notesIn(from)) this.rename(n.path, to + n.path.slice(from.length));
    const move = p => (p === from || p.startsWith(from + '/') ? to + p.slice(from.length) : p);
    const c = this.folderConf();
    c.folders = c.folders.map(move);
    c.overrides = Object.fromEntries(Object.entries(c.overrides).map(([k, v]) => [move(k), v]));
    this.saveFolderConf(c);
    const s = this.schema();
    if (s.nodes.some(n => n.folder !== undefined && move(n.folder) !== n.folder)) {
      s.nodes.forEach(n => { if (n.folder !== undefined) n.folder = move(n.folder); });
      this.saveSchema(s);
    }
  }
  // Deletes a folder with the notes in it (they stay in the GitHub history).
  deleteFolder(dir) {
    for (const n of this.notesIn(dir)) this.remove(n.path);
    const inside = p => p === dir || p.startsWith(dir + '/');
    const c = this.folderConf();
    c.folders = c.folders.filter(f => !inside(f));
    for (const k of Object.keys(c.overrides)) if (inside(k)) delete c.overrides[k];
    this.saveFolderConf(c);
    const s = this.schema();
    const gone = new Set(s.nodes.filter(n => n.folder !== undefined && inside(n.folder)).map(n => n.id));
    if (gone.size) {
      s.nodes = s.nodes.filter(n => !gone.has(n.id));
      s.edges = s.edges.filter(e => !gone.has(e.fromNode) && !gone.has(e.toNode));
      this.saveSchema(s);
    }
  }
  // A folder's block on the flowchart; made if missing, and put under its parent folder
  // when that one is linked too.
  folderNode(s, dir) {
    let n = s.nodes.find(x => x.folder === dir);
    if (!n) { n = { id: 'f' + Math.random().toString(36).slice(2, 10), folder: dir, x: 0, y: 0, pinned: false }; s.nodes.push(n); }
    const parent = dirname(dir);
    if (parent && this.folderLinked(parent)) {
      const p = this.folderNode(s, parent);
      if (!s.edges.some(e => e.toNode === n.id)) s.edges.push({ id: 'e' + Math.random().toString(36).slice(2, 10), fromNode: p.id, toNode: n.id });
    }
    return n;
  }
  // Shows a folder on the flowchart (from its menu).
  addFolderToSchema(dir) {
    const s = this.schema();
    const copy = { nodes: s.nodes.map(n => ({ ...n })), edges: s.edges.map(e => ({ ...e })) };
    this.folderNode(copy, dir);
    this.saveSchema(copy);
  }
  // A new note in a linked folder appears on the flowchart below its folder.
  placeNewNote(path) {
    const dir = dirname(path);
    if (!dir || !this.folderLinked(dir)) return false;
    const s = this.schema();
    const copy = { nodes: s.nodes.map(n => ({ ...n })), edges: s.edges.map(e => ({ ...e })) };
    const f = this.folderNode(copy, dir);
    let n = copy.nodes.find(x => x.file === path);
    if (!n) { n = { id: 'n' + Math.random().toString(36).slice(2, 10), file: path, x: 0, y: 0, pinned: false }; copy.nodes.push(n); }
    if (!copy.edges.some(e => e.fromNode === f.id && e.toNode === n.id)) copy.edges.push({ id: 'e' + Math.random().toString(36).slice(2, 10), fromNode: f.id, toNode: n.id });
    this.saveSchema(copy);
    return true;
  }

  uniquePath(dir, name, ext = '.md') {
    const taken = new Set([...this.files.values()].filter(f => !f.deleted).map(f => f.path.toLowerCase()));
    if (this.media) for (const p of this.media.paths()) taken.add(p.toLowerCase());
    for (let i = 1; ; i++) {
      const p = (dir ? dir + '/' : '') + name + (i > 1 ? ' ' + i : '') + ext;
      if (!taken.has(p.toLowerCase())) return p;
    }
  }

  // ---------- Attachments ----------
  // Finds an attachment by its path or by its file name, as ![[name.png]] does.
  resolveFile(name) {
    const t = String(name).trim().replace(/^\.?\//, '').toLowerCase();
    if (!t) return null;
    const files = this.attachments();
    return (files.find(f => f.path.toLowerCase() === t) || files.find(f => filename(f.path).toLowerCase() === t.split('/').pop()))?.path || null;
  }
  // An object URL for showing an attachment; reused until the file changes.
  fileUrl(name) {
    const path = this.resolveFile(name);
    if (!path) return null;
    const f = this.get(path);
    if (!f) return this.media ? this.media.url(path) : null;
    const cached = this.urls.get(path);
    if (cached && cached.content === f.content) return cached.url;
    if (cached) URL.revokeObjectURL(cached.url);
    const bin = atob(f.content);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: mimeOf(path) }));
    this.urls.set(path, { content: f.content, url });
    return url;
  }
  writeFile(path, base64) {
    const f = this.files.get(path) || { path, baseSha: null };
    Object.assign(f, { content: base64, dirty: true, deleted: false, mtime: Date.now() });
    this.files.set(path, f);
    this.touch(path);
    this.changed();
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
  remove(path, keepInSchema = false) {
    const f = this.files.get(path);
    if (!f) return;
    if (f.baseSha) { Object.assign(f, { deleted: true, dirty: true, content: '', mtime: Date.now() }); this.touch(path); }
    else this.drop(path);
    if (isNote(path) && !keepInSchema) this.updateSchemaNote(path, null);
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
    this.remove(oldPath, true);
    this.write(newPath, content);
    for (const [p, c] of rewrites) this.write(p, c);
    this.updateSchemaNote(oldPath, newPath);
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
    const name = filename(path);
    const dot = name.lastIndexOf('.');
    const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
    const copy = this.uniquePath(dirname(path), `${stem} (конфликт ${stamp})`, ext);
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
    // Connections drawn in the flowchart count as links too.
    const s = this.schema();
    const byId = new Map(s.nodes.map(n => [n.id, n.file]));
    for (const e of s.edges) {
      const from = byId.get(e.fromNode), to = byId.get(e.toNode);
      if (!nodes.has(from) || !nodes.has(to) || from === to) continue;
      const key = from < to ? from + '\n' + to : to + '\n' + from;
      if (seen.has(key)) continue;
      seen.add(key); edges.push([from, to]);
      nodes.get(from).deg++; nodes.get(to).deg++;
    }
    return { nodes: [...nodes.values()], edges };
  }
}
