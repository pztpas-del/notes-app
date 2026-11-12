// The "Цели" screen: today's habits, all habits (streaks, year map), goals with progress.
import { dkey, parse, addDays, startOfDay, isoDow, MONTHS_GEN, WD, WD_LONG, CalendarStore, newId } from './calendar-data.js';
import {
  GoalsStore, AREAS, HABIT_COLORS, markDone, markValue, markShare, isDue, streak, bestStreak, rate, weekCount,
  scheduleText, goalProgress, progressText,
} from './goals-data.js';

const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'style' && typeof v === 'object') { for (const [sk, sv] of Object.entries(v)) { if (sk.startsWith('--')) n.style.setProperty(sk, sv); else n.style[sk] = sv; } }
    else if (k.startsWith('data-') || k === 'role' || k.startsWith('aria-')) n.setAttribute(k, v);
    else n[k] = v;
  }
  n.append(...kids.filter(k => k !== null && k !== undefined && k !== false));
  return n;
};
const btn = (text, fn, cls = '', title = '') => { const b = el('button', { type: 'button', textContent: text, className: cls, title }); b.addEventListener('click', e => { e.stopPropagation(); fn(e); }); return b; };
const pct = x => (x === null || x === undefined ? '—' : Math.round(x * 100) + '%');
const plural = (n, a, b, c) => { const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c; };
const prefsGet = (k, d) => { try { const v = localStorage.getItem('notes.goals.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } };
const prefsSet = (k, v) => { try { localStorage.setItem('notes.goals.' + k, JSON.stringify(v)); } catch { /* ignore */ } };

export class GoalsView {
  constructor(root, { vault, toast, openNote }) {
    this.root = root;
    this.vault = vault;
    this.toast = toast;
    this.openNote = openNote;
    this.store = new GoalsStore(vault);
    this.tab = prefsGet('tab', 'today');
    this.visible = false;
    this.modal = el('div', { className: 'goals-modal', hidden: true });
    this.modal.addEventListener('pointerdown', e => { if (e.target === this.modal) this.closeModal(); });
    this.body = el('div', { className: 'goals-body' });
    this.head = el('div', { className: 'goals-head' });
    root.append(this.head, this.body, this.modal);
    document.addEventListener('keydown', e => { if (this.visible && e.key === 'Escape' && !this.modal.hidden) this.closeModal(); });
  }
  show() { this.visible = true; this.render(); }
  hide() { this.visible = false; this.closeModal(); }
  // Notes changed (sync, another device): redraw unless a dialog is open or a number is being typed.
  refresh() { if (this.visible && this.modal.hidden && !this.root.contains(document.activeElement?.closest?.('input'))) this.render(); }

  render() {
    const tabs = el('div', { className: 'goals-tabs', role: 'tablist' });
    for (const [id, text] of [['today', 'Сегодня'], ['habits', 'Привычки'], ['goals', 'Цели']]) {
      const b = btn(text, () => { this.tab = id; prefsSet('tab', id); this.render(); });
      b.setAttribute('aria-selected', String(this.tab === id));
      tabs.append(b);
    }
    const conf = this.store.conf();
    const inCal = el('input', { type: 'checkbox', checked: conf.habitsInCalendar });
    inCal.addEventListener('change', () => {
      const c = this.store.conf(); c.habitsInCalendar = inCal.checked; this.store.saveConf(c);
      this.toast(inCal.checked ? 'Привычки показываются в календаре: их можно отмечать и там' : 'Привычки живут только в разделе «Цели»');
    });
    this.head.replaceChildren(
      el('h1', { className: 'goals-title', textContent: 'Цели и привычки' }),
      tabs,
      el('label', { className: 'goals-cal-toggle', title: 'Показывать привычки дня в календаре (виды «День», «Неделя», «Месяц», «Расписание»)' }, inCal, ' Привычки в календаре'),
      el('span', { className: 'goals-spacer' }),
      btn('+ Привычка', () => this.editHabit(null)),
      btn('+ Цель', () => this.editGoal(null), 'primary'));
    if (this.tab === 'habits') this.renderHabits();
    else if (this.tab === 'goals') this.renderGoals();
    else this.renderToday();
  }

  // ---------- Today ----------
  renderToday() {
    const today = startOfDay(new Date()), key = dkey(today);
    const habits = this.store.habits().filter(h => !h.archived);
    const due = habits.filter(h => isDue(h, today));
    const box = el('div', { className: 'goals-today' });
    box.append(el('h2', { className: 'goals-date', textContent: `Сегодня, ${today.getDate()} ${MONTHS_GEN[today.getMonth()]}, ${WD_LONG[isoDow(today) - 1]}` }));
    if (!habits.length) box.append(this.emptyHint('Привычек пока нет', 'Нажмите «+ Привычка», например «Зарядка», «Вода — 8 стаканов», «Чтение 30 минут».'));
    else if (!due.length) box.append(el('p', { className: 'muted', textContent: 'На сегодня привычек по расписанию нет.' }));
    const done = due.filter(h => markDone(h, key)).length;
    if (due.length) box.append(el('div', { className: 'goals-daybar' }, el('div', { className: 'goals-daybar-fill', style: { width: (done / due.length * 100) + '%' } })),
      el('p', { className: 'muted small', textContent: `Выполнено ${done} из ${due.length}` }));
    for (const h of due) box.append(this.habitRow(h, today));
    const goals = this.store.goals().filter(g => g.status === 'active');
    if (goals.length) {
      box.append(el('h2', { className: 'goals-sub', textContent: 'Цели в работе' }));
      for (const g of goals) box.append(this.goalMini(g));
    }
    this.body.replaceChildren(box);
  }
  emptyHint(title, text) { return el('div', { className: 'goals-empty' }, el('b', { textContent: title }), el('span', { textContent: text })); }

  // A habit with its check (or number) control for one day.
  habitRow(h, day) {
    const key = dkey(day);
    const st = streak(h, day);
    const weekly = h.schedule?.type === 'weekly';
    const row = el('div', { className: 'habit-row' + (markDone(h, key) ? ' done' : ''), style: { '--hc': h.color || '#3fb27f' } },
      el('span', { className: 'habit-emoji', textContent: h.emoji || '✅' }),
      el('div', { className: 'habit-main' },
        el('b', { textContent: h.name }),
        el('span', { className: 'muted small', textContent: [weekly ? `на этой неделе ${weekCount(h, day)} из ${h.schedule.times || 1}` : null, st.count ? `🔥 ${st.count} ${st.unit} подряд` : null].filter(Boolean).join(' · ') || scheduleText(h) })),
      this.markControl(h, key));
    return row;
  }
  markControl(h, key) {
    if (!h.target) {
      const done = markDone(h, key);
      const b = btn(done ? '✓' : '', () => { this.store.setMark(h.id, key, !done); this.render(); }, 'habit-check' + (done ? ' on' : ''), done ? 'Снять отметку' : 'Отметить');
      b.setAttribute('aria-pressed', String(done));
      return b;
    }
    // A habit with a number: − value +, the value can be typed.
    const v = markValue(h, key), step = h.target.amount >= 20 ? 5 : 1;
    const input = el('input', { type: 'number', min: 0, step: 'any', value: v || '', placeholder: '0', className: 'habit-num', 'aria-label': h.name });
    input.addEventListener('change', () => { this.store.setMark(h.id, key, Math.max(0, Number(input.value) || 0)); this.render(); });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });
    return el('div', { className: 'habit-counter' + (markDone(h, key) ? ' on' : '') },
      btn('−', () => { this.store.setMark(h.id, key, Math.max(0, v - step)); this.render(); }, 'habit-step'),
      el('label', { className: 'habit-num-wrap' }, input, el('span', { className: 'muted small', textContent: `/ ${h.target.amount}${h.target.unit ? ' ' + h.target.unit : ''}` })),
      btn('+', () => { this.store.setMark(h.id, key, v + step); this.render(); }, 'habit-step'));
  }

  // ---------- Habits ----------
  renderHabits() {
    const showArchived = prefsGet('archived', false);
    const all = this.store.habits();
    const list = all.filter(h => showArchived || !h.archived);
    const box = el('div', { className: 'goals-list' });
    if (!list.length) box.append(this.emptyHint('Привычек пока нет', 'Нажмите «+ Привычка». Можно отмечать галочкой или числом: «Вода — 8 стаканов».'));
    const today = startOfDay(new Date());
    for (const h of list) {
      const st = streak(h, today);
      const week = el('div', { className: 'habit-week' });
      for (let i = 6; i >= 0; i--) {
        const d = addDays(today, -i), key = dkey(d);
        const due = isDue(h, d);
        const cell = btn('', () => {
          if (h.target) { this.askNumber(h, d); return; }
          this.store.setMark(h.id, key, !markDone(h, key)); this.render();
        }, 'habit-day' + (markDone(h, key) ? ' on' : '') + (due ? '' : ' off'), `${d.getDate()} ${MONTHS_GEN[d.getMonth()]}${h.target ? `: ${markValue(h, key)} из ${h.target.amount}` : ''}`);
        cell.style.setProperty('--share', markShare(h, key));
        cell.append(el('span', { textContent: WD[isoDow(d) - 1] }), el('b', { textContent: String(d.getDate()) }));
        week.append(cell);
      }
      box.append(el('div', { className: 'habit-card' + (h.archived ? ' archived' : ''), style: { '--hc': h.color || '#3fb27f' } },
        el('div', { className: 'habit-card-head' },
          el('span', { className: 'habit-emoji big', textContent: h.emoji || '✅' }),
          el('div', { className: 'habit-main' },
            el('b', { textContent: h.name + (h.archived ? ' (в архиве)' : '') }),
            el('span', { className: 'muted small', textContent: scheduleText(h) + (h.target ? ` · норма ${h.target.amount}${h.target.unit ? ' ' + h.target.unit : ''}` : '') + (h.reminder ? ` · 🔔 ${h.reminder}` : '') })),
          btn('Изменить', () => this.editHabit(h))),
        el('div', { className: 'habit-stats' },
          this.stat('🔥 Серия', `${st.count} ${st.unit}`), this.stat('Рекорд', `${bestStreak(h)} ${st.unit}`),
          this.stat('7 дней', pct(rate(h, addDays(today, -6), today))), this.stat('30 дней', pct(rate(h, addDays(today, -29), today)))),
        week,
        this.heatmap(h)));
    }
    if (all.some(h => h.archived)) box.append(btn(showArchived ? 'Скрыть архив' : 'Показать архив', () => { prefsSet('archived', !showArchived); this.render(); }, 'goals-link'));
    this.body.replaceChildren(box);
  }
  stat(label, value) { return el('div', { className: 'habit-stat' }, el('b', { textContent: value }), el('span', { className: 'muted small', textContent: label })); }

  // A year of days, like on GitHub: brighter = done (numbers fill partly).
  heatmap(h) {
    const today = startOfDay(new Date());
    const start = addDays(today, -(isoDow(today) - 1) - 7 * 52);
    const grid = el('div', { className: 'heat' });
    for (let w = 0; w < 53; w++) {
      const col = el('div', { className: 'heat-col' });
      for (let i = 0; i < 7; i++) {
        const d = addDays(start, w * 7 + i);
        if (d > today) { col.append(el('i', { className: 'heat-cell future' })); continue; }
        const key = dkey(d), share = markShare(h, key);
        col.append(el('i', { className: 'heat-cell' + (share > 0 ? ' on' : '') + (isDue(h, d) ? '' : ' off'), style: { '--share': share }, title: `${d.getDate()} ${MONTHS_GEN[d.getMonth()]} ${d.getFullYear()}${h.target ? `: ${markValue(h, key)}` : share ? ': выполнено' : ''}` }));
      }
      grid.append(col);
    }
    const wrap = el('div', { className: 'heat-wrap' }, grid);
    requestAnimationFrame(() => { wrap.scrollLeft = wrap.scrollWidth; });
    return wrap;
  }

  askNumber(h, d) {
    const key = dkey(d);
    const input = el('input', { type: 'number', min: 0, step: 'any', value: markValue(h, key) || '' });
    const save = () => { this.store.setMark(h.id, key, Math.max(0, Number(input.value) || 0)); this.closeModal(); this.render(); };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
    this.openModal(el('div', { className: 'ce' },
      el('h2', { textContent: `${h.emoji || ''} ${h.name}, ${d.getDate()} ${MONTHS_GEN[d.getMonth()]}` }),
      el('label', { className: 'ce-row' }, input, el('span', { textContent: `из ${h.target.amount} ${h.target.unit || ''}` })),
      el('div', { className: 'ce-footer' }, el('span', { className: 'spacer' }), btn('Отмена', () => this.closeModal()), btn('Сохранить', save, 'primary'))));
    requestAnimationFrame(() => input.focus());
  }

  editHabit(h) {
    const isNew = !h;
    const d = h ? structuredClone(h) : { name: '', emoji: '✅', color: HABIT_COLORS[this.store.habits().length % HABIT_COLORS.length], schedule: { type: 'daily', days: [1, 2, 3, 4, 5], times: 3 }, target: null, reminder: null, marks: {} };
    const name = el('input', { className: 'ce-title', placeholder: 'Например: Зарядка, Вода, Чтение', value: d.name });
    const emoji = el('input', { className: 'habit-emoji-input', value: d.emoji || '', maxLength: 4, 'aria-label': 'Значок' });
    const type = el('select', {}, ...[['daily', 'Каждый день'], ['days', 'По дням недели'], ['weekly', 'Несколько раз в неделю']].map(([v, t]) => el('option', { value: v, textContent: t, selected: (d.schedule?.type || 'daily') === v })));
    const days = new Set(d.schedule?.days?.length ? d.schedule.days : [1, 2, 3, 4, 5]);
    const dayBox = el('div', { className: 'ce-weekdays' });
    const drawDays = () => dayBox.replaceChildren(...WD.map((w, i) => btn(w, () => { if (days.has(i + 1) && days.size > 1) days.delete(i + 1); else days.add(i + 1); drawDays(); }, days.has(i + 1) ? 'on' : '')));
    drawDays();
    const times = el('input', { type: 'number', min: 1, max: 7, value: d.schedule?.times || 3, style: { width: '70px' } });
    const daysRow = el('div', { className: 'ce-row' }, dayBox), timesRow = el('div', { className: 'ce-row' }, times, el('span', { textContent: 'раз в неделю, в любые дни' }));
    const sync = () => { daysRow.hidden = type.value !== 'days'; timesRow.hidden = type.value !== 'weekly'; };
    type.addEventListener('change', sync); sync();
    const useNum = el('input', { type: 'checkbox', checked: Boolean(d.target) });
    const amount = el('input', { type: 'number', min: 0.1, step: 'any', value: d.target?.amount || 8, style: { width: '90px' } });
    const unit = el('input', { placeholder: 'стаканов, минут, страниц…', value: d.target?.unit || '', style: { width: '190px' } });
    const numRow = el('div', { className: 'ce-row' }, el('span', { textContent: 'Норма в день:' }), amount, unit);
    const syncNum = () => { numRow.hidden = !useNum.checked; };
    useNum.addEventListener('change', syncNum); syncNum();
    const remOn = el('input', { type: 'checkbox', checked: Boolean(d.reminder) });
    const remAt = el('input', { type: 'time', value: d.reminder || '21:00' });
    let color = d.color;
    const colors = el('div', { className: 'ce-colors' });
    const drawColors = () => colors.replaceChildren(...HABIT_COLORS.map(c => { const s = btn('', () => { color = c; drawColors(); }, 'swatch' + (c === color ? ' on' : '')); s.style.background = c; return s; }));
    drawColors();
    const save = () => {
      const n = name.value.trim();
      if (!n) { name.focus(); return; }
      Object.assign(d, { name: n, emoji: emoji.value.trim() || '✅', color, schedule: { type: type.value, days: [...days].sort(), times: Math.min(7, Math.max(1, Number(times.value) || 1)) },
        target: useNum.checked ? { amount: Math.max(0.1, Number(amount.value) || 1), unit: unit.value.trim() } : null, reminder: remOn.checked ? remAt.value || '21:00' : null });
      this.store.saveHabit(d);
      this.closeModal(); this.render();
      this.toast(isNew ? `Привычка «${n}» добавлена` : 'Привычка сохранена');
    };
    this.openModal(el('div', { className: 'ce', role: 'dialog', 'aria-label': isNew ? 'Новая привычка' : 'Привычка' },
      el('h2', { textContent: isNew ? 'Новая привычка' : 'Привычка' }),
      el('div', { className: 'ce-row' }, emoji, name),
      el('div', { className: 'ce-row' }, el('span', { className: 'ce-label', textContent: 'Как часто' }), type),
      daysRow, timesRow,
      el('label', { className: 'ce-check' }, useNum, ' Отмечать числом (например, 8 стаканов воды)'), numRow,
      el('div', { className: 'ce-row' }, el('label', { className: 'ce-check' }, remOn, ' Напоминать в'), remAt),
      el('div', { className: 'ce-row' }, el('span', { className: 'ce-label', textContent: 'Цвет' }), colors),
      el('div', { className: 'ce-footer' },
        isNew ? null : btn(d.archived ? 'Вернуть из архива' : 'В архив', () => { d.archived = !d.archived; this.store.saveHabit(d); this.closeModal(); this.render(); }),
        isNew ? null : btn('Удалить', () => this.confirm(`Удалить привычку «${d.name}» со всеми отметками? Если хотите сохранить историю, лучше отправьте её в архив.`, () => { this.store.deleteHabit(d.id); this.closeModal(); this.render(); this.toast('Привычка удалена'); }), 'danger-text'),
        el('span', { className: 'spacer' }), btn('Отмена', () => this.closeModal()), btn(isNew ? 'Добавить' : 'Сохранить', save, 'primary'))));
    requestAnimationFrame(() => name.focus());
  }

  // ---------- Goals ----------
  renderGoals() {
    const habits = this.store.habits();
    const goals = this.store.goals();
    const box = el('div', { className: 'goals-list' });
    if (!goals.length) box.append(this.emptyHint('Целей пока нет', 'Нажмите «+ Цель». Прогресс можно считать по шагам («сдать сессию»), по числу («прочитать 20 книг») или по привычке.'));
    const order = { active: 0, paused: 1, done: 2 };
    for (const [areaId, areaName, areaColor] of AREAS) {
      const mine = goals.filter(g => (g.area || 'other') === areaId).sort((a, b) => order[a.status || 'active'] - order[b.status || 'active'] || String(a.due || '9').localeCompare(String(b.due || '9')));
      if (!mine.length) continue;
      box.append(el('h2', { className: 'goals-sub', style: { '--hc': areaColor } }, el('span', { className: 'dot' }), ' ' + areaName));
      for (const g of mine) box.append(this.goalCard(g, habits, areaColor));
    }
    this.body.replaceChildren(box);
  }
  dueText(g) {
    if (!g.due) return null;
    const days = Math.round((parse(g.due) - startOfDay(new Date())) / 864e5);
    const d = parse(g.due);
    const when = `${d.getDate()} ${MONTHS_GEN[d.getMonth()]}`;
    if (g.status === 'done') return `срок ${when}`;
    return days < 0 ? `просрочено (${when})` : days === 0 ? 'срок сегодня' : `до ${when} · ${days} ${plural(days, 'день', 'дня', 'дней')}`;
  }
  goalMini(g) {
    const habits = this.store.habits();
    const color = (AREAS.find(a => a[0] === (g.area || 'other')) || AREAS[4])[2];
    const p = goalProgress(g, habits);
    const b = el('button', { type: 'button', className: 'goal-mini', style: { '--hc': color } },
      el('div', { className: 'goal-mini-top' }, el('b', { textContent: g.title }), el('span', { className: 'muted small', textContent: pct(p) })),
      el('div', { className: 'goal-bar' }, el('div', { className: 'goal-bar-fill', style: { width: p * 100 + '%' } })));
    b.addEventListener('click', () => { this.tab = 'goals'; prefsSet('tab', 'goals'); this.render(); });
    return b;
  }
  goalCard(g, habits, color) {
    const p = goalProgress(g, habits);
    const due = this.dueText(g);
    const card = el('div', { className: 'goal-card status-' + (g.status || 'active'), style: { '--hc': color } },
      el('div', { className: 'goal-card-head' },
        el('div', { className: 'habit-main' },
          el('b', { textContent: (g.status === 'done' ? '✓ ' : '') + g.title }),
          el('span', { className: 'muted small' + (due && due.startsWith('просрочено') ? ' late' : ''), textContent: [progressText(g, habits), due, g.status === 'paused' ? 'отложена' : null].filter(Boolean).join(' · ') })),
        btn('Изменить', () => this.editGoal(g))),
      el('div', { className: 'goal-bar' }, el('div', { className: 'goal-bar-fill', style: { width: p * 100 + '%' } })));
    if (g.description) card.append(el('p', { className: 'goal-desc', textContent: g.description }));
    if (g.kind === 'steps') {
      const steps = el('div', { className: 'goal-steps' });
      for (const s of g.steps || []) {
        const box = el('input', { type: 'checkbox', checked: Boolean(s.done) });
        box.addEventListener('change', () => { const x = structuredClone(g); x.steps.find(y => y.id === s.id).done = box.checked; this.finishCheck(x); });
        steps.append(el('div', { className: 'goal-step' + (s.done ? ' done' : '') },
          el('label', {}, box, el('span', { textContent: s.text })),
          btn('→ в дела', () => this.stepToTodo(g, s), 'goals-link small', 'Добавить шаг в «Дела» календаря')));
      }
      card.append(steps);
    } else if (g.kind === 'number') {
      const n = g.number || {};
      const change = delta => { const x = structuredClone(g); x.number.current = Math.max(0, (Number(n.current) || 0) + delta); this.finishCheck(x); };
      card.append(el('div', { className: 'habit-counter' }, btn('−', () => change(-1), 'habit-step'), el('b', { textContent: `${n.current || 0} / ${n.target || 0} ${n.unit || ''}` }), btn('+', () => change(1), 'habit-step')));
    }
    if (g.note && this.vault.get(g.note)) card.append(btn('📄 ' + g.note.split('/').pop().replace(/\.md$/i, ''), () => this.openNote(g.note), 'goals-link'));
    return card;
  }
  // Saves a goal after a tick; when everything is done, offers to close it.
  finishCheck(g) {
    this.store.saveGoal(g);
    if (g.status === 'active' && goalProgress(g, this.store.habits()) >= 1) this.toast(`🎉 Цель «${g.title}» выполнена на 100%! Отметить её выполненной можно в «Изменить».`, 7000);
    this.render();
  }
  stepToTodo(g, s) {
    const cal = new CalendarStore(this.vault);
    const t = cal.todos();
    t.items.push({ id: newId(), list: t.lists[0].id, title: `${s.text} (${g.title})`, due: g.due || null, done: false, order: Date.now() });
    cal.saveTodos(t);
    this.toast(`Шаг «${s.text}» добавлен в «Дела» календаря${g.due ? ' со сроком цели' : ''}`);
  }

  editGoal(g) {
    const isNew = !g;
    const d = g ? structuredClone(g) : { title: '', description: '', area: 'personal', due: null, kind: 'steps', steps: [], number: { current: 0, target: 10, unit: '' }, habitId: null, note: null, status: 'active' };
    const title = el('input', { className: 'ce-title', placeholder: 'Например: Сдать сессию, Прочитать 20 книг', value: d.title });
    const desc = el('textarea', { rows: 2, placeholder: 'Зачем это нужно, как пойму, что готово (необязательно)', value: d.description || '' });
    const area = el('select', {}, ...AREAS.map(([v, t]) => el('option', { value: v, textContent: t, selected: (d.area || 'other') === v })));
    const due = el('input', { type: 'date', value: d.due || '' });
    const kind = el('select', {}, ...[['steps', 'По шагам'], ['number', 'По числу'], ['habit', 'По привычке']].map(([v, t]) => el('option', { value: v, textContent: t, selected: d.kind === v })));
    let steps = (d.steps || []).map(s => ({ ...s }));
    const stepBox = el('div', { className: 'goal-steps edit' });
    const drawSteps = () => {
      stepBox.replaceChildren(...steps.map(s => {
        const inp = el('input', { value: s.text, placeholder: 'Шаг' });
        inp.addEventListener('input', () => { s.text = inp.value; });
        return el('div', { className: 'ce-row' }, inp, btn('×', () => { steps = steps.filter(x => x !== s); drawSteps(); }, 'icon-text', 'Убрать шаг'));
      }));
      const add = el('input', { placeholder: '+ Новый шаг (Enter)' });
      add.addEventListener('keydown', e => { if (e.key === 'Enter' && add.value.trim()) { e.preventDefault(); steps.push({ id: newId(), text: add.value.trim(), done: false }); drawSteps(); stepBox.lastChild.querySelector('input')?.focus(); } });
      stepBox.append(el('div', { className: 'ce-row' }, add));
    };
    drawSteps();
    const cur = el('input', { type: 'number', min: 0, step: 'any', value: d.number?.current ?? 0, style: { width: '90px' } });
    const target = el('input', { type: 'number', min: 1, step: 'any', value: d.number?.target ?? 10, style: { width: '90px' } });
    const unit = el('input', { placeholder: 'книг, км, ₽…', value: d.number?.unit || '', style: { width: '140px' } });
    const numRow = el('div', { className: 'ce-row' }, el('span', { textContent: 'Сейчас' }), cur, el('span', { textContent: 'из' }), target, unit);
    const habits = this.store.habits().filter(h => !h.archived);
    const habitSel = el('select', {}, el('option', { value: '', textContent: habits.length ? 'Выберите привычку' : 'Сначала создайте привычку' }), ...habits.map(h => el('option', { value: h.id, textContent: `${h.emoji || ''} ${h.name}`, selected: d.habitId === h.id })));
    const habitRow = el('div', { className: 'ce-row' }, habitSel, el('span', { className: 'muted small', textContent: 'прогресс = выполнение за 30 дней' }));
    const syncKind = () => { stepBox.hidden = kind.value !== 'steps'; numRow.hidden = kind.value !== 'number'; habitRow.hidden = kind.value !== 'habit'; };
    kind.addEventListener('change', syncKind); syncKind();
    const notes = this.vault.notes().map(n => n.path).sort((a, b) => a.localeCompare(b, 'ru'));
    const note = el('select', {}, el('option', { value: '', textContent: 'Без заметки' }), ...notes.map(p => el('option', { value: p, textContent: p.replace(/\.md$/i, ''), selected: d.note === p })));
    const status = el('select', {}, ...[['active', 'В работе'], ['paused', 'Отложена'], ['done', 'Выполнена']].map(([v, t]) => el('option', { value: v, textContent: t, selected: (d.status || 'active') === v })));
    const save = () => {
      const t = title.value.trim();
      if (!t) { title.focus(); return; }
      Object.assign(d, { title: t, description: desc.value.trim(), area: area.value, due: due.value || null, kind: kind.value,
        steps: steps.filter(s => s.text.trim()), number: { current: Number(cur.value) || 0, target: Math.max(1, Number(target.value) || 1), unit: unit.value.trim() },
        habitId: habitSel.value || null, note: note.value || null, status: status.value });
      this.store.saveGoal(d);
      this.closeModal(); this.tab = 'goals'; prefsSet('tab', 'goals'); this.render();
      this.toast(isNew ? `Цель «${t}» добавлена` : 'Цель сохранена');
    };
    this.openModal(el('div', { className: 'ce', role: 'dialog', 'aria-label': isNew ? 'Новая цель' : 'Цель' },
      el('h2', { textContent: isNew ? 'Новая цель' : 'Цель' }),
      title, desc,
      el('div', { className: 'ce-row' }, el('span', { className: 'ce-label', textContent: 'Сфера' }), area, el('span', { className: 'ce-label', textContent: 'Срок' }), due),
      el('div', { className: 'ce-row' }, el('span', { className: 'ce-label', textContent: 'Прогресс' }), kind),
      stepBox, numRow, habitRow,
      el('div', { className: 'ce-row' }, el('span', { className: 'ce-label', textContent: 'Заметка' }), note),
      el('div', { className: 'ce-row' }, el('span', { className: 'ce-label', textContent: 'Статус' }), status),
      el('div', { className: 'ce-footer' },
        isNew ? null : btn('Удалить', () => this.confirm(`Удалить цель «${d.title}»?`, () => { this.store.deleteGoal(d.id); this.closeModal(); this.render(); this.toast('Цель удалена'); }), 'danger-text'),
        el('span', { className: 'spacer' }), btn('Отмена', () => this.closeModal()), btn(isNew ? 'Добавить' : 'Сохранить', save, 'primary'))));
    requestAnimationFrame(() => title.focus());
  }

  // ---------- Dialogs ----------
  openModal(content) { this.modal.replaceChildren(content); this.modal.hidden = false; }
  closeModal() { this.modal.hidden = true; this.modal.replaceChildren(); }
  confirm(text, yes) {
    const back = this.modal.firstChild;
    this.modal.replaceChildren(el('div', { className: 'ce' }, el('p', { textContent: text }),
      el('div', { className: 'ce-footer' }, el('span', { className: 'spacer' }), btn('Отмена', () => this.modal.replaceChildren(back)), btn('Удалить', yes, 'danger'))));
  }
}
