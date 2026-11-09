// Two-way sync between this device and a GitHub repository of .md files.
// Each sync: read the branch, take in what changed there, then send local
// changes as one commit. If another device pushed in between, start over.
// Never loses text: when both sides changed a note, the GitHub version is kept
// next to it as "<name> (конфликт <date>).md".
import { isText, isSynced } from './vault.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

async function gitBlobSha(text) {
  const body = enc.encode(text);
  const head = enc.encode(`blob ${body.length}\0`);
  const buf = new Uint8Array(head.length + body.length);
  buf.set(head); buf.set(body, head.length);
  const hash = await crypto.subtle.digest('SHA-1', buf);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function fromBase64(s) {
  const bin = atob(s.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return dec.decode(bytes);
}
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

export class SyncError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

export class GitHubSync {
  constructor(vault, getSettings) {
    this.vault = vault;
    this.getSettings = getSettings;
    this.running = null;
  }

  configured() { const s = this.getSettings(); return Boolean(s.owner && s.repo && s.token); }
  branch() { return this.getSettings().branch || 'main'; }

  async api(method, path, body, cache = 'no-store') {
    const s = this.getSettings();
    const base = (s.api || 'https://api.github.com').replace(/\/+$/, '');
    let res;
    try {
      res = await fetch(`${base}/repos/${encodeURIComponent(s.owner)}/${encodeURIComponent(s.repo)}${path}`, {
        method, cache,
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${s.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new SyncError('Нет связи с GitHub. Проверьте интернет.', 'network');
    }
    if (res.ok) return res.status === 204 ? null : res.json();
    let msg = '';
    try { msg = (await res.json()).message || ''; } catch { /* no body */ }
    if (res.status === 401) throw new SyncError('GitHub не принял токен: он неверный или истёк.', 'auth');
    if (res.status === 403 && /rate limit/i.test(msg)) throw new SyncError('GitHub временно ограничил запросы. Попробуйте через несколько минут.', 'rate');
    if (res.status === 403) throw new SyncError('У токена нет права менять это хранилище. Дайте ему доступ Contents: Read and write.', 'forbidden');
    if (res.status === 404) throw new SyncError('Хранилище или ветка не найдены, или у токена нет к ним доступа.', 'notfound');
    if (res.status === 409) throw new SyncError('Хранилище пустое. Добавьте в него любой файл, например README, и повторите.', 'empty');
    if (res.status === 422) throw new SyncError(msg || 'GitHub отклонил изменение.', 'rejected');
    throw new SyncError(`GitHub ответил ошибкой ${res.status}. ${msg}`.trim(), 'http');
  }

  // Checks the settings: the repository and branch exist and are reachable.
  async test() {
    const repo = await this.api('GET', '');
    await this.api('GET', `/git/ref/heads/${this.branch()}`);
    if (repo.permissions && repo.permissions.push === false) {
      throw new SyncError('Токен может только читать хранилище. Дайте ему доступ Contents: Read and write.', 'forbidden');
    }
    return repo;
  }

  sync() {
    if (!this.running) this.running = this.run().finally(() => { this.running = null; });
    return this.running;
  }

  async run() {
    const result = { pulled: 0, pushed: 0, conflicts: [] };
    for (let attempt = 0; attempt < 4; attempt++) {
      const ref = await this.api('GET', `/git/ref/heads/${this.branch()}`);
      const headSha = ref.object.sha;
      const commit = await this.api('GET', `/git/commits/${headSha}`, null, 'default');
      const tree = await this.api('GET', `/git/trees/${commit.tree.sha}?recursive=1`, null, 'default');
      if (tree.truncated) throw new SyncError('В хранилище слишком много файлов для синхронизации.', 'toolarge');
      const remote = new Map();
      for (const e of tree.tree) if (e.type === 'blob' && isSynced(e.path)) remote.set(e.path, e.sha);

      await this.pull(remote, result);
      const pushed = await this.push(headSha, commit.tree.sha, result);
      await this.vault.flush();
      if (pushed !== 'retry') return result;
    }
    throw new SyncError('Не удалось отправить изменения: хранилище всё время меняется. Повторите позже.', 'race');
  }

  async pull(remote, result) {
    const v = this.vault;
    const fetches = [];
    for (const p of new Set([...remote.keys(), ...v.files.keys()])) {
      if (!isSynced(p)) continue;
      const L = v.files.get(p), R = remote.get(p);
      if (!L) { fetches.push({ p, R }); continue; }
      if (L.deleted) {
        if (!R) v.drop(p);                         // gone on both sides
        else if (R !== L.baseSha) fetches.push({ p, R }); // edited elsewhere: keep their version
        continue;
      }
      if (!R) {
        if (!L.baseSha) continue;                  // new here, will be sent
        if (L.dirty) { L.baseSha = null; v.touch(p); } // deleted there, edited here: keep it
        else { v.drop(p); result.pulled++; }      // deleted there
        continue;
      }
      if (R !== L.baseSha) fetches.push({ p, R });
    }
    const texts = await mapLimit(fetches, 6, async f => {
      const raw = (await this.api('GET', `/git/blobs/${f.R}`, null, 'default')).content;
      return isText(f.p) ? fromBase64(raw) : raw.replace(/\s/g, '');
    });
    fetches.forEach(({ p, R }, i) => {
      const text = texts[i];
      const L = v.files.get(p); // re-read: the note may have been edited while downloading
      if (!L || L.deleted || !L.dirty || L.content === text) { v.setClean(p, text, R); result.pulled++; return; }
      L.baseSha = R; v.touch(p);
      result.conflicts.push(v.addConflictCopy(p, text));
    });
    if (fetches.length || result.pulled) v.changed();
  }

  async push(headSha, treeSha, result) {
    const v = this.vault;
    const snap = [...v.files.values()].filter(f => f.dirty)
      .map(f => ({ path: f.path, deleted: Boolean(f.deleted), content: f.content, baseSha: f.baseSha }));
    for (const s of snap) if (s.deleted && !s.baseSha) v.drop(s.path);
    const sending = snap.filter(s => !s.deleted || s.baseSha);
    if (!sending.length) return 'done';
    // Attachments are uploaded as blobs first (base64); notes go inline as text.
    const blobShas = new Map();
    await mapLimit(sending.filter(s => !s.deleted && !isText(s.path)), 3, async s => {
      const blob = await this.api('POST', '/git/blobs', { content: s.content, encoding: 'base64' });
      blobShas.set(s.path, blob.sha);
    });
    const entries = sending.map(s => s.deleted
      ? { path: s.path, mode: '100644', type: 'blob', sha: null }
      : blobShas.has(s.path)
        ? { path: s.path, mode: '100644', type: 'blob', sha: blobShas.get(s.path) }
        : { path: s.path, mode: '100644', type: 'blob', content: s.content });

    const names = entries.map(e => e.path.split('/').pop().replace(/\.md$/i, ''));
    const message = `Заметки: ${names.slice(0, 5).join(', ')}${names.length > 5 ? ` и ещё ${names.length - 5}` : ''}`;
    const tree = await this.api('POST', '/git/trees', { base_tree: treeSha, tree: entries });
    const commit = await this.api('POST', '/git/commits', { message, tree: tree.sha, parents: [headSha] });
    try {
      await this.api('PATCH', `/git/refs/heads/${this.branch()}`, { sha: commit.sha, force: false });
    } catch (e) {
      if (e.code === 'rejected') return 'retry';
      throw e;
    }
    for (const s of snap) {
      const f = v.files.get(s.path);
      if (!f) continue;
      if (s.deleted) { if (f.deleted) v.drop(s.path); continue; }
      f.baseSha = blobShas.get(s.path) || await gitBlobSha(s.content);
      if (!f.deleted && f.content === s.content) f.dirty = false;
      v.touch(s.path);
    }
    result.pushed += entries.length;
    v.changed();
    return 'done';
  }
}
