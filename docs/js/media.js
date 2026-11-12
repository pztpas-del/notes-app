// Pictures and files: kept on Yandex Disk, downloaded only when shown.
// On this device: files waiting for upload, and a limited cache of recently
// opened ones (oldest are dropped first). The list of what exists on the Disk
// is remembered so links and the file list work without downloading anything.
import { db } from './db.js';

const CACHE_LIMIT = 300 * 1024 * 1024; // recently opened files kept on the device
const STREAM_FROM = 40 * 1024 * 1024;   // bigger files play straight from the Disk

const placeholder = text => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120" viewBox="0 0 320 120"><rect width="320" height="120" rx="14" fill="#8882"/>` +
  `<text x="160" y="66" text-anchor="middle" font-family="system-ui,sans-serif" font-size="15" fill="#888">${text}</text></svg>`);
export const LOADING = placeholder('Загрузка с Яндекс Диска…');
export const OFFLINE = placeholder('Откроется, когда будет интернет');
export const FAILED = placeholder('Диск пока не отдаёт файл, повторю позже');
const BAD_TYPE = /^(text\/html|application\/json)/i; // an error page saved instead of the file
const RETRY_AFTER = 3 * 60 * 1000; // a failed file is tried again after this

export class MediaStore {
  constructor(ya, onChange) {
    this.ya = ya;
    this.onChange = onChange;
    this.remote = new Map(); // path -> { size, modified } on the Disk
    this.local = new Map();  // path -> { size, pending, at } on this device
    this.urls = new Map();   // path -> URL ready to show
    this.loading = new Set();
    this.failed = new Set();
    this.flushing = null;
    this.version = 0;        // bumps on every change, so views know to redraw
  }

  changed() { this.version++; this.onChange(); }

  async init() {
    for (const f of (await db.get('yaIndex')) || []) this.remote.set(f.path, f);
    for (const m of await db.media.meta()) this.local.set(m.path, m);
    this.changed();
  }
  saveIndex() { return db.set('yaIndex', [...this.remote].map(([path, f]) => ({ path, ...f }))); }

  has(path) { return this.remote.has(path) || this.local.has(path); }
  paths() { return [...new Set([...this.remote.keys(), ...this.local.keys()])]; }
  list() {
    return this.paths().map(path => {
      const l = this.local.get(path), r = this.remote.get(path);
      return { path, size: (r || l).size || 0, dirty: Boolean(l && l.pending), cached: Boolean(l) };
    });
  }
  pendingCount() { return [...this.local.values()].filter(m => m.pending).length; }
  size(path) { return (this.remote.get(path) || this.local.get(path))?.size || 0; }

  // A URL to show the file right now; starts loading it if it is not here yet.
  url(path) {
    if (this.urls.has(path)) return this.urls.get(path);
    if (this.failed.has(path)) return FAILED;
    if (!this.loading.has(path)) {
      if (this.local.has(path)) this.loadLocal(path);
      else if (this.remote.has(path)) {
        if (!this.ya.connected() || !navigator.onLine) return OFFLINE;
        this.loadRemote(path);
      } else return null;
    }
    return LOADING;
  }

  async loadLocal(path) {
    this.loading.add(path);
    try {
      const rec = await db.media.get(path);
      if (rec?.blob && BAD_TYPE.test(rec.blob.type) && !rec.pending) {
        // A broken copy from a Disk outage: drop it and download again.
        await db.media.del(path);
        this.local.delete(path);
        return;
      }
      if (rec?.blob) {
        this.urls.set(path, URL.createObjectURL(rec.blob));
        rec.at = Date.now();
        this.local.set(path, { path, size: rec.size, pending: rec.pending, at: rec.at });
        db.media.put(rec);
      } else this.local.delete(path);
    } finally { this.loading.delete(path); this.changed(); }
  }

  async loadRemote(path) {
    this.loading.add(path);
    try {
      if (this.size(path) > STREAM_FROM) { this.urls.set(path, await this.ya.href(path)); return; }
      const blob = await this.ya.download(path);
      this.urls.set(path, URL.createObjectURL(blob));
      const rec = { path, blob, size: blob.size, pending: false, at: Date.now() };
      await db.media.put(rec);
      this.local.set(path, { path, size: rec.size, pending: false, at: rec.at });
      this.evict();
    } catch (e) {
      if (e.code === 'cors') {
        // Cannot keep a copy here; show it straight from the Disk instead.
        try { this.urls.set(path, await this.ya.href(path)); return; } catch { /* fall through */ }
      }
      if (e.code === 'network') { setTimeout(() => this.changed(), 15000); return; }
      // The Disk may be having trouble: show a clear message and try again later.
      this.failed.add(path);
      setTimeout(() => { this.failed.delete(path); this.changed(); }, RETRY_AFTER);
    } finally { this.loading.delete(path); this.changed(); }
  }

  // A new picture or file: kept here at once, uploaded to the Disk in the background.
  async put(path, blob) {
    const rec = { path, blob, size: blob.size, pending: true, at: Date.now() };
    await db.media.put(rec);
    this.local.set(path, { path, size: rec.size, pending: true, at: rec.at });
    this.urls.set(path, URL.createObjectURL(blob));
    this.failed.delete(path);
    this.changed();
    this.flush().catch(() => {});
  }

  // Uploads everything waiting. Returns the error that stopped it, if any.
  flush() {
    if (!this.flushing) this.flushing = this.runFlush().finally(() => { this.flushing = null; });
    return this.flushing;
  }
  async runFlush() {
    if (!this.ya.connected() || !navigator.onLine) return null;
    let firstError = null;
    for (const m of [...this.local.values()].filter(x => x.pending)) {
      const rec = await db.media.get(m.path);
      if (!rec) { this.local.delete(m.path); continue; }
      try {
        await this.ya.upload(rec.path, rec.blob);
      } catch (e) {
        this.changed();
        // No connection or no access: the other files would fail the same way, stop here.
        if (e.code === 'network' || e.code === 'auth' || e.code === 'full') throw e;
        // A problem with this one file: report it, but still upload the rest.
        firstError = firstError || new Error(`Файл «${rec.path.split('/').pop()}» не загрузился: ${e.message}`);
        continue;
      }
      rec.pending = false;
      await db.media.put(rec);
      this.local.set(rec.path, { path: rec.path, size: rec.size, pending: false, at: rec.at });
      this.remote.set(rec.path, { size: rec.size, modified: new Date().toISOString() });
      await this.saveIndex();
      this.changed();
    }
    this.evict();
    if (firstError) throw firstError;
    return null;
  }

  // Refreshes the list of files on the Disk (new ones from other devices appear).
  async refresh(dir) {
    if (!this.ya.connected() || !navigator.onLine) return;
    const items = await this.ya.list(dir);
    const next = new Map(items.map(f => [f.path, { size: f.size, modified: f.modified }]));
    const same = next.size === this.remote.size && [...next].every(([p, f]) => this.remote.get(p)?.size === f.size);
    if (same) return;
    // A file changed on the Disk: forget the old copy here.
    for (const [p, f] of next) {
      const old = this.remote.get(p);
      if (old && old.size !== f.size && !this.local.get(p)?.pending) this.forgetLocal(p);
    }
    this.remote = next;
    await this.saveIndex();
    this.failed.clear();
    this.changed();
  }

  async forgetLocal(path) {
    const u = this.urls.get(path);
    if (u && u.startsWith('blob:')) URL.revokeObjectURL(u);
    this.urls.delete(path);
    this.local.delete(path);
    await db.media.del(path);
  }

  // Deletes the file: from the Disk (into its trash) and from this device.
  async remove(path) {
    if (this.remote.has(path)) await this.ya.remove(path);
    this.remote.delete(path);
    await this.forgetLocal(path);
    await this.saveIndex();
    this.changed();
  }

  // Keeps the device cache under the limit, dropping the longest-unused files first.
  async evict() {
    const kept = [...this.local.values()].filter(m => !m.pending).sort((a, b) => a.at - b.at);
    let total = kept.reduce((s, m) => s + (m.size || 0), 0);
    for (const m of kept) {
      if (total <= CACHE_LIMIT) break;
      total -= m.size || 0;
      await this.forgetLocal(m.path);
    }
  }
}
