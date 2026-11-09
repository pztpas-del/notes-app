// Push notifications for calendar reminders, delivered by the user's own
// Cloudflare worker (push-server/) even when the app is closed.
// Shared settings (server address and access key) live in the private notes
// repository, so every device of the user uses the same server.
import { scheduleItems } from './calendar-data.js';

const CONF = 'Календарь/уведомления.json';
export const DEFAULT_PUSH_URL = 'https://notes-push.notes-push.workers.dev';

const b64uToBytes = s => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, c => c.charCodeAt(0));
};
const randomKey = () => {
  const a = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const deviceName = () => {
  const ua = navigator.userAgent;
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iOS' : /Windows/i.test(ua) ? 'Windows' : /Mac OS/i.test(ua) ? 'Mac' : /Linux/i.test(ua) ? 'Linux' : 'Устройство';
  const br = /YaBrowser/i.test(ua) ? 'Яндекс Браузер' : /Edg\//i.test(ua) ? 'Edge' : /Firefox/i.test(ua) ? 'Firefox' : /Chrome/i.test(ua) ? 'Chrome' : 'браузер';
  return `${os}, ${br}`;
};

export class PushClient {
  constructor(vault, store) {
    this.vault = vault;
    this.store = store;
    this.lastSig = null;
    this.timer = null;
    this.state = { error: '', uploadedAt: null, items: 0 };
  }

  conf() { try { return JSON.parse(this.vault.get(CONF)?.content || '{}'); } catch { return {}; } }
  saveConf(c) { this.vault.write(CONF, JSON.stringify(c, null, 2) + '\n'); }
  url() { return (this.conf().url || DEFAULT_PUSH_URL).replace(/\/+$/, ''); }
  ready() { const c = this.conf(); return Boolean(this.url() && c.key); }
  supported() { return 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined'; }
  // Push is switched on for this device (the app then shows only in-app messages itself).
  onHere() { try { return localStorage.getItem('notes.push.on') === '1' && Notification.permission === 'granted'; } catch { return false; } }

  async api(path, method = 'GET', body = null, auth = true) {
    const headers = { 'content-type': 'application/json' };
    if (auth) headers.authorization = 'Bearer ' + this.conf().key;
    let res;
    try { res = await fetch(this.url() + path, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' }); }
    catch { throw new Error('Сервер уведомлений недоступен. Проверьте интернет.'); }
    const data = await res.json().catch(() => ({}));
    if (res.status === 403) throw new Error('Этот сервер уже привязан к другому ключу.');
    if (res.status === 401) throw new Error('Сервер уведомлений не принял ключ.');
    if (!res.ok) throw new Error(`Сервер уведомлений ответил ошибкой ${res.status}. ${data.error || ''}`.trim());
    return data;
  }

  // Turns push on for this device: asks permission, subscribes, sends the schedule.
  async enable(serverUrl) {
    if (!this.supported()) throw new Error('Этот браузер не поддерживает push-уведомления. На Android откройте программу в Chrome.');
    const c = this.conf();
    if (serverUrl) c.url = serverUrl.trim().replace(/\/+$/, '');
    if (!c.url && DEFAULT_PUSH_URL) c.url = DEFAULT_PUSH_URL;
    if (!c.url) throw new Error('Укажите адрес сервера уведомлений.');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('Уведомления не разрешены. Разрешите их для этого сайта в настройках браузера.');
    if (!c.key) c.key = randomKey();
    this.saveConf(c);
    await this.api('/claim', 'POST', { key: c.key }, false);
    const { publicKey } = await this.api('/vapid', 'GET', null, false);
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    const want = b64uToBytes(publicKey);
    if (sub) {
      const have = sub.options?.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
      if (!have || have.length !== want.length || have.some((b, i) => b !== want[i])) { await sub.unsubscribe(); sub = null; }
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: want });
    await this.api('/subscribe', 'POST', { subscription: sub.toJSON(), device: deviceName() });
    try { localStorage.setItem('notes.push.on', '1'); } catch { /* ignore */ }
    await this.upload(true);
  }

  async disable() {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) { if (this.ready()) await this.api('/unsubscribe', 'POST', { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); }
    } finally {
      try { localStorage.removeItem('notes.push.on'); } catch { /* ignore */ }
    }
  }

  async test() {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return this.api('/test', 'POST', { endpoint: sub ? sub.endpoint : undefined });
  }
  status() { return this.api('/status'); }

  // Sends the reminders of the next 60 days to the server. Any device can do it,
  // so events added on the computer reach the phone without opening the app there.
  async upload(force = false) {
    if (!this.ready() || !navigator.onLine) return;
    const items = scheduleItems(this.store);
    const sig = JSON.stringify(items);
    if (!force && sig === this.lastSig) return;
    try {
      await this.api('/schedule', 'PUT', { items });
      this.lastSig = sig;
      this.state = { error: '', uploadedAt: new Date(), items: items.length };
    } catch (e) {
      this.state.error = e.message;
    }
  }
  scheduleUpload(delay = 6000) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.upload(), delay);
  }
}
