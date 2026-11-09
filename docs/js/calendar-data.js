// Calendar data: events, calendars (categories), to-do lists, repeats,
// reminders and .ics import/export. Everything is stored as JSON files in the
// notes repository under "Календарь/" — synced with GitHub, hidden from notes.
export const CAL_DIR = 'Календарь';
const EV_DIR = CAL_DIR + '/События';
const CONF = CAL_DIR + '/календари.json';
const TODO = CAL_DIR + '/Дела.json';

export const pad = n => String(n).padStart(2, '0');
export const dkey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const tkey = d => `${dkey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
export const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
export const parse = s => {
  const [D, T = '00:00'] = String(s).split('T');
  const [y, m, d] = D.split('-').map(Number);
  const [h, mi] = T.split(':').map(Number);
  return new Date(y, m - 1, d, h || 0, mi || 0);
};
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const addMinutes = (d, n) => new Date(d.getTime() + n * 60000);
export const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const sameDay = (a, b) => dkey(a) === dkey(b);
export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

export const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
export const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
export const WD = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
export const WD_LONG = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
export const isoDow = d => (d.getDay() + 6) % 7 + 1; // 1 = Monday … 7 = Sunday
export const COLORS = ['#4c8bf5', '#3fb27f', '#f29d38', '#e5534b', '#a970ff', '#2bb3c0', '#d6a400', '#e06aa8', '#8a8a96'];

export const REMIND_PRESETS = [[0, 'В момент начала'], [5, 'За 5 минут'], [10, 'За 10 минут'], [15, 'За 15 минут'], [30, 'За 30 минут'],
  [60, 'За 1 час'], [120, 'За 2 часа'], [1440, 'За 1 день'], [2880, 'За 2 дня'], [10080, 'За неделю']];
export function reminderLabel(m) {
  const p = REMIND_PRESETS.find(x => x[0] === m);
  if (p) return p[1];
  if (m % 1440 === 0) return `За ${m / 1440} дн.`;
  if (m % 60 === 0) return `За ${m / 60} ч`;
  return `За ${m} мин`;
}

// Public holidays of Russia (fixed dates; yearly day-off transfers are not included).
const HOLIDAYS = {
  '01-01': 'Новый год', '01-02': 'Новогодние каникулы', '01-03': 'Новогодние каникулы', '01-04': 'Новогодние каникулы',
  '01-05': 'Новогодние каникулы', '01-06': 'Новогодние каникулы', '01-07': 'Рождество Христово', '01-08': 'Новогодние каникулы',
  '02-23': 'День защитника Отечества', '03-08': 'Международный женский день', '05-01': 'Праздник Весны и Труда',
  '05-09': 'День Победы', '06-12': 'День России', '11-04': 'День народного единства',
};
export const holiday = d => HOLIDAYS[`${pad(d.getMonth() + 1)}-${pad(d.getDate())}`] || null;

const DEFAULT_CONF = () => ({
  calendars: [
    { id: 'study', name: 'Учёба', color: '#4c8bf5', visible: true, reminders: [15], duration: 60 },
    { id: 'tasks', name: 'Дела', color: '#3fb27f', visible: true, reminders: [15], duration: 60 },
    { id: 'rest', name: 'Отдых', color: '#f29d38', visible: true, reminders: [60], duration: 60 },
  ],
  primary: 'tasks',
  settings: { weekStart: 1, showWeekends: true, workStart: 9, workEnd: 18, holidays: true, digest: '08:00', allDayAt: '09:00' },
});

const json = s => { try { return JSON.parse(s); } catch { return null; } };

export class CalendarStore {
  constructor(vault) { this.vault = vault; this.memo = { rev: -1 }; }

  // ---------- Settings and calendars ----------
  conf() {
    const f = this.vault.get(CONF);
    const c = (f && json(f.content)) || DEFAULT_CONF();
    const d = DEFAULT_CONF();
    c.calendars = Array.isArray(c.calendars) && c.calendars.length ? c.calendars : d.calendars;
    c.settings = { ...d.settings, ...(c.settings || {}) };
    if (!c.calendars.some(x => x.id === c.primary)) c.primary = c.calendars[0].id;
    for (const x of c.calendars) { x.reminders = Array.isArray(x.reminders) ? x.reminders : [15]; x.duration = x.duration || 60; if (x.visible === undefined) x.visible = true; }
    return c;
  }
  saveConf(c) { this.vault.write(CONF, JSON.stringify(c, null, 2) + '\n'); }
  calendar(id) { const c = this.conf(); return c.calendars.find(x => x.id === id) || c.calendars[0]; }

  // ---------- Events ----------
  events() {
    if (this.memo.rev === this.vault.rev && this.memo.events) return this.memo.events;
    const out = [];
    for (const f of this.vault.files.values()) {
      if (f.deleted || !f.path.startsWith(EV_DIR + '/') || !f.path.endsWith('.json') || f.path.includes('(конфликт')) continue;
      const ev = json(f.content);
      if (ev && ev.id && ev.start) out.push(ev);
    }
    this.memo = { rev: this.vault.rev, events: out };
    return out;
  }
  event(id) { return this.events().find(e => e.id === id) || null; }
  saveEvent(ev) {
    ev.updated = new Date().toISOString();
    if (!ev.created) ev.created = ev.updated;
    this.vault.write(`${EV_DIR}/${ev.id}.json`, JSON.stringify(ev, null, 2) + '\n');
  }
  deleteEvent(id) { this.vault.remove(`${EV_DIR}/${id}.json`); }

  // ---------- To-do lists ----------
  todos() {
    const f = this.vault.get(TODO);
    const t = (f && json(f.content)) || {};
    t.lists = Array.isArray(t.lists) && t.lists.length ? t.lists : [{ id: 'main', name: 'Мои дела' }];
    t.items = Array.isArray(t.items) ? t.items : [];
    return t;
  }
  saveTodos(t) { this.vault.write(TODO, JSON.stringify(t, null, 2) + '\n'); }

  // Every occurrence that overlaps [from, to), sorted by start.
  // visibleOnly: skip calendars the user switched off.
  occurrences(from, to, visibleOnly = true) {
    const conf = this.conf();
    const shown = new Set(conf.calendars.filter(c => !visibleOnly || c.visible).map(c => c.id));
    const known = new Set(conf.calendars.map(c => c.id));
    const out = [];
    for (const ev of this.events()) {
      const cal = known.has(ev.calendar) ? ev.calendar : conf.calendars[0].id;
      if (!shown.has(cal)) continue;
      for (const o of expand(ev, from, to)) out.push({ ...o, calendar: cal });
    }
    return out.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  }
}

// ---------- Repeats ----------
// ev.start / ev.end: "YYYY-MM-DDTHH:MM" (all-day: end is the last day, inclusive)
// ev.repeat: { freq: day|week|month|year, interval, byDay: [1..7], monthMode: date|weekday, until, count }
// ev.exceptions: { "YYYY-MM-DD": { deleted } | { start, end, title, … } }
export function eventSpan(ev) {
  const s = parse(ev.start);
  const e = ev.allDay ? addDays(startOfDay(parse(ev.end || ev.start)), 1) : parse(ev.end || ev.start);
  return [s, e > s ? e : addMinutes(s, ev.allDay ? 1440 : 30)];
}

function nthWeekday(year, month, dow, n) { // n: 1..4 or -1 (last)
  if (n > 0) {
    const first = new Date(year, month, 1);
    const shift = (dow - isoDow(first) + 7) % 7;
    const d = new Date(year, month, 1 + shift + (n - 1) * 7);
    return d.getMonth() === month ? d : null;
  }
  const last = new Date(year, month + 1, 0);
  return new Date(year, month, last.getDate() - ((isoDow(last) - dow + 7) % 7));
}
// Which weekday of the month this is: 1..4, or -1 for "the last one" (5th).
export const weekOfMonth = d => { const n = Math.ceil(d.getDate() / 7); return n >= 5 ? -1 : n; };

function* candidates(ev, s0) {
  const r = ev.repeat, iv = Math.max(1, r.interval || 1);
  const at = (base, t) => new Date(base.getFullYear(), base.getMonth(), base.getDate(), t.getHours(), t.getMinutes());
  if (r.freq === 'day') { for (let i = 0; ; i += iv) yield addDays(s0, i); }
  if (r.freq === 'week') {
    const days = (r.byDay && r.byDay.length ? [...r.byDay] : [isoDow(s0)]).sort();
    const monday = addDays(startOfDay(s0), 1 - isoDow(s0));
    for (let w = 0; ; w += iv) for (const dw of days) { const c = at(addDays(monday, w * 7 + dw - 1), s0); if (c >= s0) yield c; }
  }
  if (r.freq === 'month') {
    const n = weekOfMonth(s0), dow = isoDow(s0);
    for (let m = 0; ; m += iv) {
      const y = s0.getFullYear(), mo = s0.getMonth() + m;
      let c;
      if (r.monthMode === 'weekday') { const d = nthWeekday(new Date(y, mo, 1).getFullYear(), new Date(y, mo, 1).getMonth(), dow, n); c = d && at(d, s0); }
      else { const d = new Date(y, mo, s0.getDate()); c = d.getDate() === s0.getDate() ? at(d, s0) : null; }
      if (c) yield c;
      if (m > 12 * 200) return;
    }
  }
  if (r.freq === 'year') {
    for (let k = 0; ; k += iv) { const d = new Date(s0.getFullYear() + k, s0.getMonth(), s0.getDate()); if (d.getMonth() === s0.getMonth()) yield at(d, s0); if (k > 400) return; }
  }
}

export function expand(ev, from, to) {
  const [s0, e0] = eventSpan(ev);
  const dur = e0 - s0;
  const make = (start, key, over) => {
    if (over) {
      const merged = { ...ev, ...over, repeat: ev.repeat };
      const [s, e] = eventSpan({ ...merged, start: over.start || tkey(start), end: over.end || (merged.allDay ? dkey(new Date(start.getTime() + dur - 1)) : tkey(new Date(start.getTime() + dur))) });
      return { ev, data: merged, start: s, end: e, key, moved: true };
    }
    return { ev, data: ev, start, end: new Date(start.getTime() + dur), key };
  };
  if (!ev.repeat) return e0 > from && s0 < to ? [make(s0, dkey(s0), null)] : [];
  const until = ev.repeat.until ? addDays(startOfDay(parse(ev.repeat.until)), 1) : null;
  const out = [];
  let n = 0, guard = 0;
  for (const c of candidates(ev, s0)) {
    if (++guard > 20000) break;
    if (until && c >= until) break;
    n++;
    if (ev.repeat.count && n > ev.repeat.count) break;
    if (c >= to) break;
    const key = dkey(c);
    const ex = ev.exceptions && ev.exceptions[key];
    if (ex && ex.deleted) continue;
    const o = make(c, key, ex);
    if (o.end > from && o.start < to) out.push(o);
  }
  return out;
}

export function repeatLabel(r, start) {
  if (!r) return 'Не повторять';
  const iv = r.interval || 1;
  let t;
  if (r.freq === 'day') t = iv === 1 ? 'Каждый день' : `Каждые ${iv} дн.`;
  else if (r.freq === 'week') {
    const days = (r.byDay && r.byDay.length ? r.byDay : [isoDow(start)]).slice().sort().map(d => WD[d - 1]).join(', ');
    t = (iv === 1 ? 'Каждую неделю' : `Каждые ${iv} нед.`) + ': ' + days;
  } else if (r.freq === 'month') {
    t = iv === 1 ? 'Каждый месяц' : `Каждые ${iv} мес.`;
    if (r.monthMode === 'weekday') { const n = weekOfMonth(start); t += `, ${n === -1 ? 'последний' : n + '-й'} ${WD_LONG[isoDow(start) - 1]}`; }
    else t += `, ${start.getDate()}-го числа`;
  } else t = iv === 1 ? 'Каждый год' : `Каждые ${iv} г.`;
  if (r.until) { const u = parse(r.until); t += `, до ${u.getDate()} ${MONTHS_GEN[u.getMonth()]} ${u.getFullYear()}`; }
  if (r.count) t += `, ${r.count} раз`;
  return t;
}

// ---------- Reminders ----------
// Checks every 30 seconds while the app runs; reminders missed while it was
// closed (up to 6 hours late) are shown on the next start.
export class Reminders {
  constructor(store, notify) {
    this.store = store;
    this.notify = notify;
    this.timer = null;
  }
  fired() { try { return JSON.parse(localStorage.getItem('notes.cal.fired') || 'null'); } catch { return null; } }
  saveFired(f) { try { localStorage.setItem('notes.cal.fired', JSON.stringify(f)); } catch { /* ignore */ } }
  start() {
    clearInterval(this.timer);
    this.check();
    this.timer = setInterval(() => this.check(), 30000);
  }
  check() {
    const now = new Date();
    let fired = this.fired();
    const first = !fired;
    fired = fired || {};
    const conf = this.store.conf();
    const [ah, am] = conf.settings.allDayAt.split(':').map(Number);
    for (const o of this.store.occurrences(addDays(now, -1), addDays(now, 15), false)) {
      const base = o.data.allDay ? new Date(o.start.getFullYear(), o.start.getMonth(), o.start.getDate(), ah || 9, am || 0) : o.start;
      for (const m of o.data.reminders || []) {
        const at = addMinutes(base, -m);
        const key = `${o.ev.id}|${o.key}|${m}`;
        if (fired[key] || at > now) continue;
        fired[key] = Date.now();
        if (first || now - at > 6 * 3600e3 || o.end < now) continue;
        const when = o.data.allDay ? (sameDay(o.start, now) ? 'сегодня, весь день' : `${o.start.getDate()} ${MONTHS_GEN[o.start.getMonth()]}, весь день`)
          : (sameDay(o.start, now) ? 'сегодня в ' : sameDay(o.start, addDays(now, 1)) ? 'завтра в ' : `${o.start.getDate()} ${MONTHS_GEN[o.start.getMonth()]} в `) + hm(o.start);
        this.notify(o.data.title || 'Событие', [when, o.data.place].filter(Boolean).join(' · '), key, '#calendar=' + encodeURIComponent(o.ev.id + '|' + o.key));
      }
    }
    // Morning list of to-dos for today
    const [dh, dm] = conf.settings.digest.split(':').map(Number);
    const digestAt = new Date(now.getFullYear(), now.getMonth(), now.getDate(), dh || 8, dm || 0);
    const dkeyToday = 'digest|' + dkey(now);
    if (now >= digestAt && !fired[dkeyToday]) {
      fired[dkeyToday] = Date.now();
      const t = this.store.todos();
      const today = t.items.filter(i => !i.done && i.due === dkey(now)).length;
      const late = t.items.filter(i => !i.done && i.due && i.due < dkey(now)).length;
      if (!first && (today || late)) this.notify('Дела на сегодня', [today && `запланировано: ${today}`, late && `просрочено: ${late}`].filter(Boolean).join(', '), dkeyToday, '#calendar');
    }
    const cutoff = Date.now() - 20 * 864e5;
    for (const k of Object.keys(fired)) if (fired[k] < cutoff) delete fired[k];
    this.saveFired(fired);
  }
}

// ---------- .ics (iCalendar) import and export ----------
const icsEscape = s => String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
const icsDate = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const icsTime = d => `${icsDate(d)}T${pad(d.getHours())}${pad(d.getMinutes())}00`;
const fold = line => { const out = []; let s = line; while (s.length > 74) { out.push(s.slice(0, 74)); s = ' ' + s.slice(74); } out.push(s); return out.join('\r\n'); };
const RFREQ = { day: 'DAILY', week: 'WEEKLY', month: 'MONTHLY', year: 'YEARLY' };
const RDAY = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

export function toIcs(store) {
  const conf = store.conf();
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Zametki//Calendar//RU', 'CALSCALE:GREGORIAN'];
  for (const ev of store.events()) {
    const [s, e] = eventSpan(ev);
    const cal = conf.calendars.find(c => c.id === ev.calendar);
    lines.push('BEGIN:VEVENT', `UID:${ev.id}@zametki`, `DTSTAMP:${icsTime(new Date())}`);
    if (ev.allDay) lines.push(`DTSTART;VALUE=DATE:${icsDate(s)}`, `DTEND;VALUE=DATE:${icsDate(e)}`);
    else lines.push(`DTSTART:${icsTime(s)}`, `DTEND:${icsTime(e)}`);
    lines.push(`SUMMARY:${icsEscape(ev.title)}`);
    if (ev.description) lines.push(`DESCRIPTION:${icsEscape(ev.description)}`);
    if (ev.place) lines.push(`LOCATION:${icsEscape(ev.place)}`);
    if (cal) lines.push(`CATEGORIES:${icsEscape(cal.name)}`);
    if (ev.repeat) {
      const r = ev.repeat;
      let rule = `RRULE:FREQ=${RFREQ[r.freq]};INTERVAL=${r.interval || 1}`;
      if (r.freq === 'week') rule += ';BYDAY=' + (r.byDay && r.byDay.length ? r.byDay : [isoDow(s)]).map(d => RDAY[d - 1]).join(',');
      if (r.freq === 'month' && r.monthMode === 'weekday') rule += `;BYDAY=${weekOfMonth(s)}${RDAY[isoDow(s) - 1]}`;
      if (r.until) rule += `;UNTIL=${r.until.replace(/-/g, '')}T235959`;
      if (r.count) rule += `;COUNT=${r.count}`;
      lines.push(rule);
      for (const [k, x] of Object.entries(ev.exceptions || {})) if (x.deleted) lines.push(ev.allDay ? `EXDATE;VALUE=DATE:${k.replace(/-/g, '')}` : `EXDATE:${k.replace(/-/g, '')}T${pad(s.getHours())}${pad(s.getMinutes())}00`);
    }
    for (const m of ev.reminders || []) lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(ev.title)}`, `TRIGGER:-PT${m}M`, 'END:VALARM');
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

export function fromIcs(text, calendarId) {
  const lines = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
  const unesc = s => s.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
  const toLocal = (v, params) => {
    const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
    if (!m) return null;
    if (!m[4] || /VALUE=DATE/.test(params)) return { date: `${m[1]}-${m[2]}-${m[3]}`, allDay: true };
    const d = m[7] ? new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5])) : new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5]);
    return { time: tkey(d), allDay: false };
  };
  const events = [];
  let cur = null, inAlarm = false;
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const head = line.slice(0, i), value = line.slice(i + 1);
    const [name, ...ps] = head.split(';');
    const params = ps.join(';');
    if (name === 'BEGIN' && value === 'VEVENT') { cur = { id: newId(), calendar: calendarId, reminders: [], title: '' }; continue; }
    if (name === 'BEGIN' && value === 'VALARM') { inAlarm = true; continue; }
    if (name === 'END' && value === 'VALARM') { inAlarm = false; continue; }
    if (name === 'END' && value === 'VEVENT') { if (cur && cur.start) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    if (inAlarm) {
      if (name === 'TRIGGER') { const t = value.match(/^-?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?/); if (t) cur.reminders.push((+(t[1] || 0)) * 10080 + (+(t[2] || 0)) * 1440 + (+(t[3] || 0)) * 60 + (+(t[4] || 0))); }
      continue;
    }
    if (name === 'SUMMARY') cur.title = unesc(value);
    else if (name === 'DESCRIPTION') cur.description = unesc(value);
    else if (name === 'LOCATION') cur.place = unesc(value);
    else if (name === 'DTSTART') { const v = toLocal(value, params); if (v) { cur.allDay = v.allDay; cur.start = v.allDay ? v.date + 'T00:00' : v.time; } }
    else if (name === 'DTEND') { const v = toLocal(value, params); if (v) cur.endRaw = v; }
    else if (name === 'RRULE') {
      const p = Object.fromEntries(value.split(';').map(x => x.split('=')));
      const freq = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' }[p.FREQ];
      if (freq) {
        cur.repeat = { freq, interval: +(p.INTERVAL || 1) };
        if (p.BYDAY && freq === 'week') cur.repeat.byDay = p.BYDAY.split(',').map(d => RDAY.indexOf(d.slice(-2)) + 1).filter(Boolean);
        if (p.BYDAY && freq === 'month') cur.repeat.monthMode = 'weekday';
        if (p.UNTIL) cur.repeat.until = `${p.UNTIL.slice(0, 4)}-${p.UNTIL.slice(4, 6)}-${p.UNTIL.slice(6, 8)}`;
        if (p.COUNT) cur.repeat.count = +p.COUNT;
      }
    }
  }
  for (const ev of events) {
    const e = ev.endRaw;
    delete ev.endRaw;
    if (ev.allDay) ev.end = e && e.date ? dkey(addDays(parse(e.date), -1)) : ev.start.slice(0, 10);
    else ev.end = e && e.time ? e.time : tkey(addMinutes(parse(ev.start), 60));
    if (ev.allDay) ev.start = ev.start.slice(0, 10);
  }
  return events;
}
