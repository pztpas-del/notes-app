// Goals and habits: data and counting. Each habit and each goal is one JSON file
// in the notes repository ("Цели/Привычки/<id>.json", "Цели/Цели/<id>.json"), so
// marks made on the phone and on the computer rarely touch the same file.
// They are hidden from the notes list and synced like everything else.
import { dkey, parse, addDays, startOfDay, isoDow, newId } from './calendar-data.js';

export const GOALS_DIR = 'Цели';
const HABIT_DIR = GOALS_DIR + '/Привычки';
const GOAL_DIR = GOALS_DIR + '/Цели';
const CONF = GOALS_DIR + '/настройки.json';

export const AREAS = [['study', 'Учёба', '#4c8bf5'], ['health', 'Здоровье', '#3fb27f'], ['work', 'Работа', '#f29d38'], ['personal', 'Личное', '#a970ff'], ['other', 'Другое', '#8a8a96']];
export const HABIT_COLORS = ['#3fb27f', '#4c8bf5', '#f29d38', '#e5534b', '#a970ff', '#2bb3c0', '#d6a400', '#e06aa8'];

const json = s => { try { return JSON.parse(s); } catch { return null; } };

// ---------- Habits ----------
// habit = { id, name, emoji, color, schedule: { type: 'daily' | 'days' | 'weekly', days: [1..7], times },
//           target: null | { amount, unit }, reminder: null | 'HH:MM', marks: { 'YYYY-MM-DD': true | number },
//           archived, created }
// A day counts as done when marked (or the number reaches the target).
export function markDone(h, key) {
  const m = h.marks?.[key];
  if (h.target) return typeof m === 'number' && m >= h.target.amount;
  return Boolean(m);
}
export function markValue(h, key) { const m = h.marks?.[key]; return typeof m === 'number' ? m : m ? 1 : 0; }
// How much of the day is done, 0…1 (numbers count partly).
export function markShare(h, key) {
  if (!h.target) return markDone(h, key) ? 1 : 0;
  return Math.min(1, markValue(h, key) / (h.target.amount || 1));
}
// Is the habit planned for this day? ("N times a week" habits can be done on any day.)
export function isDue(h, d) {
  const s = h.schedule || { type: 'daily' };
  if (s.type === 'days') return (s.days || []).includes(isoDow(d));
  return true;
}
const weekStartOf = d => addDays(startOfDay(d), -(isoDow(d) - 1));

// Days (or weeks, for "N times a week") in a row that are done, ending today.
// Today does not break the streak until it is over.
export function streak(h, today = new Date()) {
  const s = h.schedule || { type: 'daily' };
  if (s.type === 'weekly') {
    let n = 0;
    for (let w = weekStartOf(today), first = true; ; w = addDays(w, -7), first = false) {
      const done = Array.from({ length: 7 }, (_, i) => addDays(w, i)).filter(d => markDone(h, dkey(d))).length;
      if (done >= (s.times || 1)) n++;
      else if (!first) break;
      if (n > 520) break;
    }
    return { count: n, unit: 'нед.' };
  }
  let n = 0;
  const start = parse(dkey(new Date(h.created || today)));
  for (let d = startOfDay(today), first = true; d >= start; d = addDays(d, -1), first = false) {
    if (!isDue(h, d)) continue;
    if (markDone(h, dkey(d))) n++;
    else if (!first) break;
  }
  return { count: n, unit: 'дн.' };
}
// Longest streak ever (days or weeks).
export function bestStreak(h) {
  const keys = Object.keys(h.marks || {}).filter(k => markDone(h, k)).sort();
  if (!keys.length) return 0;
  const s = h.schedule || { type: 'daily' };
  if (s.type === 'weekly') {
    const weeks = new Map();
    for (const k of keys) { const w = dkey(weekStartOf(parse(k))); weeks.set(w, (weeks.get(w) || 0) + 1); }
    let best = 0, run = 0, prev = null;
    for (const w of [...weeks.keys()].sort()) {
      if (weeks.get(w) >= (s.times || 1)) { run = prev && dkey(addDays(parse(prev), 7)) === w ? run + 1 : 1; prev = w; best = Math.max(best, run); }
      else { run = 0; prev = null; }
    }
    return best;
  }
  let best = 0, run = 0;
  for (let d = parse(keys[0]), end = parse(keys[keys.length - 1]); d <= end; d = addDays(d, 1)) {
    if (!isDue(h, d)) continue;
    if (markDone(h, dkey(d))) { run++; best = Math.max(best, run); } else run = 0;
  }
  return best;
}
// Share of planned days done in [from, to] (not before the habit was made).
export function rate(h, from, to) {
  const s = h.schedule || { type: 'daily' };
  const created = parse(dkey(new Date(h.created || from)));
  const a = from < created ? created : startOfDay(from);
  if (a > to) return null;
  if (s.type === 'weekly') {
    let need = 0, got = 0;
    for (let w = weekStartOf(a); w <= to; w = addDays(w, 7)) {
      need += s.times || 1;
      got += Math.min(s.times || 1, Array.from({ length: 7 }, (_, i) => addDays(w, i)).filter(d => d >= a && d <= to && markDone(h, dkey(d))).length);
    }
    return need ? got / need : null;
  }
  let need = 0, got = 0;
  for (let d = a; d <= to; d = addDays(d, 1)) if (isDue(h, d)) { need++; if (markDone(h, dkey(d))) got++; }
  return need ? got / need : null;
}
// How many times done this week (for "N times a week").
export function weekCount(h, d = new Date()) {
  const w = weekStartOf(d);
  return Array.from({ length: 7 }, (_, i) => addDays(w, i)).filter(x => markDone(h, dkey(x))).length;
}
export function scheduleText(h) {
  const s = h.schedule || { type: 'daily' };
  if (s.type === 'days') return (s.days || []).slice().sort().map(n => ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'][n - 1]).join(', ') || 'дни не выбраны';
  if (s.type === 'weekly') return `${s.times || 1} раз в неделю`;
  return 'каждый день';
}

// ---------- Goals ----------
// goal = { id, title, description, area, due: null | 'YYYY-MM-DD', kind: 'steps' | 'number' | 'habit',
//          steps: [{ id, text, done }], number: { current, target, unit }, habitId, note: null | path,
//          status: 'active' | 'done' | 'paused', created }
export function goalProgress(g, habits = []) {
  if (g.status === 'done') return 1;
  if (g.kind === 'steps') { const s = g.steps || []; return s.length ? s.filter(x => x.done).length / s.length : 0; }
  if (g.kind === 'number') { const n = g.number || {}; return n.target ? Math.max(0, Math.min(1, (n.current || 0) / n.target)) : 0; }
  if (g.kind === 'habit') {
    const h = habits.find(x => x.id === g.habitId);
    if (!h) return 0;
    const today = new Date();
    return rate(h, addDays(today, -29), today) || 0;
  }
  return 0;
}
export function progressText(g, habits = []) {
  if (g.kind === 'steps') { const s = g.steps || []; return `шагов: ${s.filter(x => x.done).length} из ${s.length}`; }
  if (g.kind === 'number') { const n = g.number || {}; return `${n.current || 0} из ${n.target || 0}${n.unit ? ' ' + n.unit : ''}`; }
  const h = habits.find(x => x.id === g.habitId);
  return h ? `«${h.name}» за 30 дней: ${Math.round(goalProgress(g, habits) * 100)}%` : 'привычка не выбрана';
}

// ---------- Storage ----------
export class GoalsStore {
  constructor(vault) { this.vault = vault; this.memo = { rev: -1 }; }
  list(dir) {
    const out = [];
    for (const f of this.vault.files.values()) {
      if (f.deleted || !f.path.startsWith(dir + '/') || !f.path.endsWith('.json') || f.path.includes('(конфликт')) continue;
      const x = json(f.content);
      if (x && x.id) out.push(x);
    }
    return out;
  }
  load() {
    if (this.memo.rev !== this.vault.rev) {
      this.memo = { rev: this.vault.rev,
        habits: this.list(HABIT_DIR).sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || String(a.created).localeCompare(String(b.created))),
        goals: this.list(GOAL_DIR).sort((a, b) => String(a.created).localeCompare(String(b.created))) };
    }
    return this.memo;
  }
  habits() { return this.load().habits; }
  goals() { return this.load().goals; }
  habit(id) { return this.habits().find(h => h.id === id) || null; }
  goal(id) { return this.goals().find(g => g.id === id) || null; }
  saveHabit(h) {
    if (!h.id) h.id = newId();
    if (!h.created) h.created = new Date().toISOString();
    h.marks = h.marks || {};
    this.vault.write(`${HABIT_DIR}/${h.id}.json`, JSON.stringify(h, null, 2) + '\n');
    return h;
  }
  deleteHabit(id) { this.vault.remove(`${HABIT_DIR}/${id}.json`); }
  saveGoal(g) {
    if (!g.id) g.id = newId();
    if (!g.created) g.created = new Date().toISOString();
    this.vault.write(`${GOAL_DIR}/${g.id}.json`, JSON.stringify(g, null, 2) + '\n');
    return g;
  }
  deleteGoal(id) { this.vault.remove(`${GOAL_DIR}/${id}.json`); }
  // Marks a day: true/false for a plain habit, a number for a habit with a target.
  setMark(id, key, value) {
    const h = structuredClone(this.habit(id));
    if (!h) return;
    h.marks = h.marks || {};
    if (value === false || value === 0 || value === null) delete h.marks[key]; else h.marks[key] = value;
    this.saveHabit(h);
  }
  conf() { return { habitsInCalendar: false, ...(json(this.vault.get(CONF)?.content || '') || {}) }; }
  saveConf(c) { this.vault.write(CONF, JSON.stringify(c, null, 2) + '\n'); }
}

// Reminders for habits that are due and not done yet, for the phone's alarms / push.
export function habitReminderItems(vault, days = 60, now = new Date()) {
  const store = new GoalsStore(vault);
  const out = [];
  for (const h of store.habits()) {
    if (h.archived || !h.reminder) continue;
    const [hh, mm] = h.reminder.split(':').map(Number);
    for (let i = 0; i < days; i++) {
      const d = addDays(startOfDay(now), i);
      if (!isDue(h, d) || markDone(h, dkey(d))) continue;
      if (h.schedule?.type === 'weekly' && weekCount(h, d) >= (h.schedule.times || 1)) continue;
      const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh || 0, mm || 0);
      if (at <= now) continue;
      out.push({ id: `habit|${h.id}|${dkey(d)}`, at: at.getTime(), title: `${h.emoji || '✅'} ${h.name}`,
        body: h.target ? `Сегодня: ${h.target.amount} ${h.target.unit || ''}`.trim() : 'Пора выполнить привычку', url: '#goals' });
    }
  }
  return out;
}
