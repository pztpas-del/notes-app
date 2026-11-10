// Inside the Android app (Capacitor) calendar reminders are scheduled on the
// phone itself as exact system alarms: they fire at the right minute even when
// the app is closed or the phone was restarted, with no server and no internet.
// In a normal browser this module does nothing.
import { scheduleItems } from './calendar-data.js';

const cap = () => window.Capacitor;
export const isNativeApp = () => Boolean(cap()?.isNativePlatform?.());
const call = (method, options = {}) => cap().nativePromise('LocalNotifications', method, options);

const CHANNEL = 'reminders';
const MAX = 400; // Android keeps at most ~500 alarms per app; the nearest 400 are plenty.
const TEST_ID = 1;

// Stable 31-bit number for a reminder key (Android needs integer ids), never TEST_ID.
const numId = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return Math.max(2, h >>> 1); };

export class NativeReminders {
  constructor(store, onOpen) {
    this.store = store;
    this.onOpen = onOpen;
    this.lastSig = null;
    this.timer = null;
    this.state = { error: '', count: 0, at: null };
  }

  async init() {
    if (!isNativeApp()) return;
    try {
      await call('createChannel', { id: CHANNEL, name: 'Напоминания календаря', description: 'События и список дел на день', importance: 5, visibility: 1, vibration: true, lights: true });
    } catch { /* older Android: no channels */ }
    cap().addListener('LocalNotifications', 'localNotificationActionPerformed', e => {
      const url = e?.notification?.extra?.url;
      if (url) this.onOpen(url);
    });
    this.schedule(true);
  }

  async permission() {
    try { return (await call('checkPermissions')).display; } catch { return 'unknown'; }
  }
  async request() {
    const r = await call('requestPermissions');
    if (r.display === 'granted') await this.schedule(true);
    return r.display;
  }
  async exactAllowed() {
    try { return (await call('checkExactNotificationSetting')).exact_alarm === 'granted'; } catch { return true; }
  }
  async openExactSettings() { try { await call('changeExactNotificationSetting'); } catch { /* not needed on this Android */ } }

  // Puts the reminders of the next 60 days into the phone's alarm list.
  async schedule(force = false) {
    if (!isNativeApp()) return;
    if (await this.permission() !== 'granted') return;
    const now = Date.now();
    const items = scheduleItems(this.store).filter(i => i.at > now + 5000).sort((a, b) => a.at - b.at).slice(0, MAX);
    const sig = JSON.stringify(items.map(i => [i.id, i.at, i.title, i.body]));
    if (!force && sig === this.lastSig) return;
    try {
      // Re-set every reminder alarm; the test notification (id TEST_ID) is left alone.
      const pending = ((await call('getPending')).notifications || []).filter(p => Number(p.id) !== TEST_ID);
      if (pending.length) await call('cancel', { notifications: pending.map(p => ({ id: Number(p.id) })) });
      if (items.length) {
        await call('schedule', { notifications: items.map(i => ({
          id: numId(i.id), title: i.title, body: i.body, largeBody: i.body,
          schedule: { at: new Date(i.at).toISOString(), allowWhileIdle: true },
          channelId: CHANNEL, smallIcon: 'ic_stat_notify', iconColor: '#7a5af5',
          extra: { url: i.url || '#calendar' }, autoCancel: true,
        })) });
      }
      this.lastSig = sig;
      this.state = { error: '', count: items.length, at: new Date(), next: items[0] || null };
    } catch (e) {
      this.state.error = e?.message || String(e);
    }
  }
  scheduleSoon(delay = 2000) { clearTimeout(this.timer); this.timer = setTimeout(() => this.schedule(), delay); }

  // A test reminder in 5 seconds (close the app to see it arrive anyway).
  async test() {
    if (await this.permission() !== 'granted' && await this.request() !== 'granted') throw new Error('Уведомления не разрешены. Разрешите их приложению «Заметки» в настройках телефона.');
    try { await call('createChannel', { id: CHANNEL, name: 'Напоминания календаря', description: 'События и список дел на день', importance: 5, visibility: 1, vibration: true, lights: true }); } catch { /* ignore */ }
    await call('schedule', { notifications: [{ id: TEST_ID, title: 'Проверка', body: 'Так будут приходить напоминания календаря', schedule: { at: new Date(Date.now() + 5000).toISOString(), allowWhileIdle: true }, channelId: CHANNEL, smallIcon: 'ic_stat_notify', iconColor: '#7a5af5', extra: { url: '#calendar' } }] });
  }

  // What Android says about the test notification a few seconds later.
  async diagnose() {
    const out = [];
    const safe = async (m, o) => { try { return await call(m, o); } catch (e) { return { error: e?.message || String(e) }; } };
    const enabled = await safe('areEnabled');
    out.push('уведомления приложения: ' + (enabled.error ? 'ошибка ' + enabled.error : enabled.value ? 'включены' : 'ВЫКЛЮЧЕНЫ'));
    const chans = await safe('listChannels');
    const ch = (chans.channels || []).find(c => c.id === CHANNEL);
    out.push('канал «Напоминания»: ' + (chans.error ? 'ошибка ' + chans.error : ch ? `важность ${ch.importance}` : 'не создан'));
    const exact = await safe('checkExactNotificationSetting');
    out.push('точное время: ' + (exact.error ? 'нет данных' : exact.exact_alarm));
    const pend = await safe('getPending');
    out.push('тест в очереди: ' + ((pend.notifications || []).some(p => Number(p.id) === TEST_ID) ? 'да (ещё не сработал)' : 'нет'));
    const shown = await safe('getDeliveredNotifications');
    out.push('тест показан системой: ' + (shown.error ? 'нет данных' : (shown.notifications || []).some(n => Number(n.id) === TEST_ID) ? 'да' : 'нет'));
    out.push('напоминаний запланировано: ' + this.state.count + (this.state.error ? ', ошибка: ' + this.state.error : ''));
    return out.join('; ');
  }
}
