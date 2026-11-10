// Yandex Disk: where pictures and files live. The app only sees its own folder
// on the user's Disk ("Приложения/Заметки"), addressed as app:/ in the API.
export const YA_CLIENT_ID = '267d75de0eed4d6a933b4bb57f769ad4';
const API = 'https://cloud-api.yandex.net/v1/disk';
const KEY = 'notes.ya';

export class YaError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

function loadToken() {
  try {
    const t = JSON.parse(localStorage.getItem(KEY) || 'null');
    return t && t.token && (!t.expiresAt || t.expiresAt > Date.now()) ? t : null;
  } catch { return null; }
}

export class YaDisk {
  constructor() { this.auth = loadToken(); this.folderReady = false; }

  connected() { return Boolean(this.auth); }
  disconnect() { this.auth = null; this.folderReady = false; try { localStorage.removeItem(KEY); } catch { /* ignore */ } }

  // Sends the user to Yandex to allow access; Yandex returns to this page with the token.
  startLogin() {
    const state = Math.random().toString(36).slice(2);
    try { sessionStorage.setItem('notes.ya.state', state); } catch { /* ignore */ }
    const back = location.origin + location.pathname;
    location.href = `https://oauth.yandex.ru/authorize?response_type=token&client_id=${YA_CLIENT_ID}` +
      `&redirect_uri=${encodeURIComponent(back)}&state=${state}&force_confirm=no`;
  }

  // On return from Yandex the token is in the address (#access_token=…). Takes it,
  // stores it on this device only, and cleans the address. Returns 'ok', 'denied' or null.
  takeTokenFromUrl() {
    const h = location.hash.slice(1);
    if (!/(^|&)(access_token|error)=/.test(h)) return null;
    const p = new URLSearchParams(h);
    let expected = null;
    try { expected = sessionStorage.getItem('notes.ya.state'); sessionStorage.removeItem('notes.ya.state'); } catch { /* ignore */ }
    history.replaceState(null, '', location.pathname + location.search + '#settings');
    if (p.get('error') || !p.get('access_token')) return 'denied';
    if (expected && p.get('state') !== expected) return 'denied';
    const expires = Number(p.get('expires_in')) || 0;
    this.auth = { token: p.get('access_token'), expiresAt: expires ? Date.now() + expires * 1000 : 0 };
    try { localStorage.setItem(KEY, JSON.stringify(this.auth)); } catch { /* ignore */ }
    return 'ok';
  }

  async api(method, path, params = {}) {
    if (!this.auth) throw new YaError('Яндекс Диск не подключён.', 'auth');
    const q = new URLSearchParams(params).toString();
    let res;
    try {
      res = await fetch(`${API}${path}${q ? '?' + q : ''}`, { method, cache: 'no-store', headers: { Authorization: `OAuth ${this.auth.token}`, Accept: 'application/json' } });
    } catch {
      throw new YaError('Нет связи с Яндекс Диском.', 'network');
    }
    if (res.status === 401) { this.disconnect(); throw new YaError('Доступ к Яндекс Диску истёк или отозван. Подключите его заново в настройках.', 'auth'); }
    if (res.status === 204 || res.status === 202 && method === 'DELETE') return null;
    let body = null;
    try { body = await res.json(); } catch { /* empty body */ }
    if (res.ok) return body;
    if (res.status === 404) throw new YaError('Файл на Яндекс Диске не найден.', 'notfound');
    if (res.status === 409) throw new YaError(body?.message || 'Такой файл уже есть.', 'exists');
    if (res.status === 507) throw new YaError('На Яндекс Диске закончилось место.', 'full');
    if (res.status === 429) throw new YaError('Яндекс Диск просит подождать: слишком много запросов.', 'rate');
    throw new YaError(`Яндекс Диск ответил ошибкой ${res.status}. ${body?.message || ''}`.trim(), 'http');
  }

  info() { return this.api('GET', ''); }

  async ensureFolder(dir) {
    if (this.folderReady) return;
    try { await this.api('PUT', '/resources', { path: 'app:/' + dir }); } catch (e) { if (e.code !== 'exists') throw e; }
    this.folderReady = true;
  }

  // Uploads a file. A file that is already there under this name counts as uploaded.
  async upload(path, blob) {
    await this.ensureFolder(path.split('/').slice(0, -1).join('/'));
    let link;
    try {
      link = await this.api('GET', '/resources/upload', { path: 'app:/' + path, overwrite: 'false' });
    } catch (e) {
      if (e.code === 'exists') return 'exists';
      throw e;
    }
    let res;
    try { res = await fetch(link.href, { method: link.method || 'PUT', body: blob }); }
    catch { throw new YaError('Не удалось загрузить файл на Яндекс Диск: нет связи.', 'network'); }
    if (res.status === 507 || res.status === 413) throw new YaError('На Яндекс Диске закончилось место.', 'full');
    if (!res.ok) throw new YaError(`Яндекс Диск не принял файл (ошибка ${res.status}).`, 'http');
    return 'ok';
  }

  // A temporary direct link to the file (valid a few hours).
  async href(path) { return (await this.api('GET', '/resources/download', { path: 'app:/' + path })).href; }

  async download(path) {
    const href = await this.href(path);
    let res;
    try { res = await fetch(href); } catch { throw new YaError('Не удалось скачать файл.', 'cors'); }
    if (!res.ok) throw new YaError(`Яндекс Диск не отдал файл (ошибка ${res.status}).`, 'unavailable');
    const blob = await res.blob();
    // During a Disk outage a page or an error comes back instead of the file.
    if (/^(text\/html|application\/json)/i.test(blob.type)) throw new YaError('Яндекс Диск сейчас не отдаёт этот файл.', 'unavailable');
    return blob;
  }

  // Every file in a folder of the app: [{ path, size, modified }]
  async list(dir) {
    const out = [];
    for (let offset = 0; ; offset += 1000) {
      let r;
      try {
        r = await this.api('GET', '/resources', { path: 'app:/' + dir, limit: '1000', offset: String(offset), fields: '_embedded.items.name,_embedded.items.size,_embedded.items.modified,_embedded.items.type,_embedded.total' });
      } catch (e) {
        if (e.code === 'notfound') return out;
        throw e;
      }
      const items = r?._embedded?.items || [];
      for (const it of items) if (it.type === 'file') out.push({ path: dir + '/' + it.name, size: it.size || 0, modified: it.modified });
      if (items.length < 1000) return out;
    }
  }

  // Moves the file to the Disk's trash (it can be restored there).
  async remove(path) {
    try { await this.api('DELETE', '/resources', { path: 'app:/' + path }); } catch (e) { if (e.code !== 'notfound') throw e; }
  }
}
