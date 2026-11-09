// The calendar screen: day / week / month / schedule views, events with repeats,
// categories (calendars), reminders, to-do lists, search, .ics import/export.
import {
  CalendarStore, Reminders, expand, eventSpan, repeatLabel, reminderLabel, holiday, toIcs, fromIcs,
  pad, dkey, tkey, hm, parse, addDays, addMinutes, startOfDay, sameDay, newId, isoDow, weekOfMonth,
  MONTHS, MONTHS_GEN, WD, WD_LONG, COLORS, REMIND_PRESETS, DAY_KEEP,
} from './calendar-data.js';

const HOUR = 48; // pixels per hour in day/week views
const SNAP = 15; // minutes
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
// replaceChildren that skips empty (null/false) parts.
const rc = (node, ...parts) => node.replaceChildren(...parts.filter(p => p !== null && p !== undefined && p !== false));
const btn = (text, fn, cls = '', title = '') => { const b = el('button', { type: 'button', textContent: text, className: cls, title }); b.addEventListener('click', e => { e.stopPropagation(); fn(e); }); return b; };
const prefsGet = (k, d) => { try { const v = localStorage.getItem('notes.cal.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } };
const prefsSet = (k, v) => { try { localStorage.setItem('notes.cal.' + k, JSON.stringify(v)); } catch { /* ignore */ } };
const dayTitle = d => `${d.getDate()} ${MONTHS_GEN[d.getMonth()]}, ${WD_LONG[isoDow(d) - 1]}`;
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const minutesOf = d => d.getHours() * 60 + d.getMinutes();

export class CalendarView {
  constructor(root, { vault, toast, notify, push = null }) {
    this.push = push;
    this.root = root;
    this.vault = vault;
    this.toast = toast;
    this.store = new CalendarStore(vault);
    this.reminders = new Reminders(this.store, notify);
    this.view = prefsGet('view', 'week');
    this.anchor = startOfDay(new Date());
    this.visible = false;
    this.todoOpen = prefsGet('todoOpen', false);
    this.sideOpen = false;
    this.agendaDays = 60;
    this.build();
  }

  startReminders() { this.reminders.start(); }

  // ---------- Skeleton ----------
  build() {
    this.side = el('aside', { className: 'cal-side' });
    this.toolbar = el('div', { className: 'cal-toolbar' });
    this.body = el('div', { className: 'cal-body' });
    this.results = el('div', { className: 'cal-results', hidden: true });
    this.todoPane = el('aside', { className: 'cal-todo', hidden: !this.todoOpen });
    this.pop = el('div', { className: 'cal-pop', hidden: true });
    this.modal = el('div', { className: 'cal-modal', hidden: true });
    this.modal.addEventListener('pointerdown', e => { if (e.target === this.modal) this.closeModal(); });
    const main = el('div', { className: 'cal-main' }, this.toolbar, this.results, this.body);
    // On narrow screens the side panel and to-dos slide over the grid; a tap on
    // the dimmed area around them closes them.
    this.backdrop = el('div', { className: 'cal-backdrop' });
    this.backdrop.addEventListener('click', () => { this.setSide(false); this.setTodo(false); });
    this.menu = el('div', { className: 'cal-menu', hidden: true });
    this.root.append(this.side, main, this.todoPane, this.backdrop, this.menu, this.pop, this.modal);
    this.root.classList.toggle('todo-open', Boolean(this.todoOpen));
    this.root.addEventListener('pointerdown', e => {
      if (!this.menu.hidden && !e.target.closest('.cal-menu, .cal-repeat-btn, .cal-repeat-side')) this.menu.hidden = true;
      if (!this.pop.hidden && !e.target.closest('.cal-pop, .ev-block, .ev-chip')) this.closePop();
      if (!this.results.hidden && !e.target.closest('.cal-results, .cal-search')) this.results.hidden = true;
    });
    document.addEventListener('keydown', e => {
      if (!this.visible) return;
      if (e.key === 'Escape') { if (!this.modal.hidden) this.closeModal(); else if (!this.menu.hidden) this.menu.hidden = true; else if (this.sideOpen) this.setSide(false); else this.closePop(); }
      if (e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (e.key === 't' || e.key === 'е') this.go(new Date());
      if (e.key === 'ArrowLeft' && this.modal.hidden) this.step(-1);
      if (e.key === 'ArrowRight' && this.modal.hidden) this.step(1);
    });
    setInterval(() => { if (this.visible && (this.view === 'week' || this.view === 'day')) this.drawNowLine(); }, 60000);
  }

  // ---------- Showing ----------
  show(target) {
    this.visible = true;
    this.render();
    if (target) {
      const [id, key] = target.split('|');
      const ev = this.store.event(id);
      if (ev) {
        const day = key ? parse(key) : eventSpan(ev)[0];
        this.go(day);
        const occ = expand(ev, startOfDay(day), addDays(startOfDay(day), 1))[0];
        if (occ) requestAnimationFrame(() => this.openCard(occ, this.body.querySelector(`[data-occ="${CSS.escape(ev.id + '|' + occ.key)}"]`)));
      }
    }
  }
  hide() { this.visible = false; this.closePop(); this.closeModal(); }
  // Not while the day note is being typed: redrawing would take the cursor away.
  refresh() { if (this.visible && this.modal.hidden && !this.gesture && !document.activeElement?.closest?.('.day-note')) this.render(); }

  go(date) { this.anchor = startOfDay(date); this.render(); }
  step(dir) {
    const a = this.anchor;
    if (this.view === 'day') this.anchor = addDays(a, dir);
    else if (this.view === 'week') this.anchor = addDays(a, 7 * dir);
    else if (this.view === 'month') this.anchor = new Date(a.getFullYear(), a.getMonth() + dir, 1);
    else this.anchor = addDays(a, this.agendaDays * dir);
    this.render();
  }
  setView(v) { this.view = v; prefsSet('view', v); this.render(); }
  setSide(open) { this.sideOpen = open; this.root.classList.toggle('side-open', open); }
  setTodo(open) {
    if (this.todoOpen === open) return;
    this.todoOpen = open; prefsSet('todoOpen', open);
    this.todoPane.hidden = !open;
    this.root.classList.toggle('todo-open', open);
    this.toolbar.querySelector('.cal-todo-btn')?.classList.toggle('on', open);
    this.renderTodos();
  }

  // Menu of the "repeating event" button: a new event that repeats every day, week, month or year.
  openRepeatMenu(anchor) {
    if (!this.menu.hidden) { this.menu.hidden = true; return; }
    const start = this.defaultStart();
    const item = (text, repeat, allDay = false) => btn(text, () => {
      this.menu.hidden = true;
      this.setSide(false);
      this.newEvent(allDay ? startOfDay(start) : start, { allDay, repeat });
    });
    rc(this.menu,
      el('div', { className: 'cal-menu-head', textContent: 'Повторяющееся событие' }),
      item('Каждый день', { freq: 'day', interval: 1 }),
      item(`Каждую неделю (${WD_LONG[isoDow(start) - 1]})`, { freq: 'week', interval: 1, byDay: [isoDow(start)] }),
      item(`Каждый месяц (${start.getDate()}-го)`, { freq: 'month', interval: 1, monthMode: 'date' }),
      item(`Каждый год (${start.getDate()} ${MONTHS_GEN[start.getMonth()]})`, { freq: 'year', interval: 1 }, true));
    const box = anchor.getBoundingClientRect(), host = this.root.getBoundingClientRect();
    this.menu.hidden = false;
    const w = this.menu.offsetWidth, h = this.menu.offsetHeight;
    const left = Math.max(8, Math.min(box.left - host.left, host.width - w - 8));
    const below = box.bottom - host.top + 6;
    this.menu.style.left = left + 'px';
    this.menu.style.top = (below + h > host.height - 8 ? Math.max(8, box.top - host.top - h - 6) : below) + 'px';
  }

  weekStart(d) {
    const ws = this.store.conf().settings.weekStart === 7 ? 7 : 1;
    const back = ws === 1 ? isoDow(d) - 1 : isoDow(d) % 7;
    return addDays(startOfDay(d), -back);
  }
  visibleDays() {
    if (this.view === 'day') return [this.anchor];
    const s = this.store.conf().settings;
    const start = this.weekStart(this.anchor);
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
    return s.showWeekends ? days : days.filter(d => isoDow(d) <= 5);
  }

  render() {
    try { this.store.cleanupDayNotes(); } catch { /* keep showing the calendar */ }
    this.closePop();
    this.renderToolbar();
    this.renderSide();
    if (this.view === 'month') this.renderMonth();
    else if (this.view === 'agenda') this.renderAgenda();
    else this.renderGrid();
    this.renderTodos();
    this.root.classList.toggle('side-open', this.sideOpen);
  }

  // ---------- Toolbar ----------
  renderToolbar() {
    const a = this.anchor;
    let title;
    if (this.view === 'day') title = cap(dayTitle(a));
    else if (this.view === 'week') {
      const days = this.visibleDays(), f = days[0], l = days[days.length - 1];
      title = f.getMonth() === l.getMonth() ? `${f.getDate()}–${l.getDate()} ${MONTHS_GEN[l.getMonth()]} ${l.getFullYear()}`
        : `${f.getDate()} ${MONTHS_GEN[f.getMonth()]} – ${l.getDate()} ${MONTHS_GEN[l.getMonth()]} ${l.getFullYear()}`;
    } else if (this.view === 'month') title = `${cap(MONTHS[a.getMonth()])} ${a.getFullYear()}`;
    else title = `С ${a.getDate()} ${MONTHS_GEN[a.getMonth()]}`;
    const views = el('div', { className: 'cal-views', role: 'tablist' });
    for (const [v, t] of [['day', 'День'], ['week', 'Неделя'], ['month', 'Месяц'], ['agenda', 'Расписание']]) {
      const b = btn(t, () => this.setView(v));
      b.setAttribute('aria-selected', String(this.view === v));
      views.append(b);
    }
    const search = el('input', { type: 'search', className: 'cal-search', placeholder: 'Найти событие', value: this.query || '', autocomplete: 'off' });
    search.addEventListener('input', () => { this.query = search.value; this.renderResults(); });
    search.addEventListener('focus', () => { if (this.query) this.renderResults(); });
    const todoCount = this.store.todos().items.filter(i => !i.done && i.due && i.due <= dkey(new Date())).length;
    const searchBtn = btn('🔍', () => {
      const on = !this.toolbar.classList.contains('searching');
      this.toolbar.classList.toggle('searching', on);
      if (on) search.focus(); else { search.value = ''; this.query = ''; this.results.hidden = true; }
    }, 'icon-text cal-search-btn', 'Найти событие');
    if (this.query) this.toolbar.classList.add('searching');
    const repeatBtn = btn('↻ Повторяющееся', () => this.openRepeatMenu(repeatBtn), 'cal-repeat-btn', 'Событие, которое повторяется каждый день, неделю, месяц или год');
    rc(this.toolbar,
      btn('☰', () => this.setSide(!this.sideOpen), 'icon-text cal-side-btn', 'Календари и мини-календарь'),
      btn('Сегодня', () => this.go(new Date())),
      btn('‹', () => this.step(-1), 'icon-text', 'Назад'),
      btn('›', () => this.step(1), 'icon-text', 'Вперёд'),
      el('h1', { className: 'cal-title', textContent: title }),
      views,
      searchBtn,
      search,
      btn(todoCount ? `Дела · ${todoCount}` : 'Дела', () => this.setTodo(!this.todoOpen), 'cal-todo-btn' + (this.todoOpen ? ' on' : '')),
      el('span', { className: 'cal-create' },
        btn('+ Событие', () => this.newEvent(this.defaultStart()), 'primary'),
        repeatBtn),
    );
  }

  defaultStart() {
    const now = new Date();
    const base = sameDay(this.anchor, now) || this.view !== 'day' && this.visibleDays().some(d => sameDay(d, now)) ? now : new Date(this.anchor.getFullYear(), this.anchor.getMonth(), this.anchor.getDate(), 9, 0);
    const m = Math.ceil((minutesOf(base) + 1) / 30) * 30;
    return new Date(base.getFullYear(), base.getMonth(), base.getDate(), 0, m);
  }

  // ---------- Side panel: mini month, calendars, tools ----------
  renderSide() {
    const conf = this.store.conf();
    const mm = this.miniMonth || new Date(this.anchor.getFullYear(), this.anchor.getMonth(), 1);
    this.miniMonth = mm;
    const grid = el('div', { className: 'mini-grid' });
    const ws = this.weekStart(new Date(mm));
    for (let i = 0; i < 7; i++) grid.append(el('span', { className: 'mini-wd', textContent: WD[isoDow(addDays(ws, i)) - 1] }));
    const vis = new Set(this.visibleDays().map(dkey));
    const busy = new Set(this.store.occurrences(ws, addDays(ws, 42)).map(o => dkey(o.start)));
    for (let i = 0; i < 42; i++) {
      const d = addDays(ws, i);
      const b = btn(String(d.getDate()), () => { this.go(d); this.setSide(false); },
        'mini-day' + (d.getMonth() !== mm.getMonth() ? ' other' : '') + (sameDay(d, new Date()) ? ' today' : '') +
        ((this.view === 'week' || this.view === 'day') && vis.has(dkey(d)) ? ' in-view' : '') + (busy.has(dkey(d)) ? ' busy' : '') +
        (conf.settings.holidays && holiday(d) || isoDow(d) >= 6 ? ' off' : ''));
      grid.append(b);
    }
    const cals = el('div', { className: 'cal-list' });
    for (const c of conf.calendars) {
      const box = el('input', { type: 'checkbox', checked: c.visible !== false });
      box.style.accentColor = c.color;
      box.addEventListener('change', () => { const cf = this.store.conf(); cf.calendars.find(x => x.id === c.id).visible = box.checked; this.store.saveConf(cf); this.render(); });
      cals.append(el('div', { className: 'cal-item' },
        el('label', {}, box, el('span', { className: 'dot', style: { background: c.color } }), el('span', { className: 'name', textContent: c.name + (conf.primary === c.id ? ' ★' : '') })),
        btn('⚙', () => this.openCalSettings(c.id), 'icon-text', 'Настройки календаря')));
    }
    const importInput = el('input', { type: 'file', accept: '.ics,text/calendar', hidden: true });
    importInput.addEventListener('change', () => this.importIcs(importInput));
    const keepSel = el('select', { className: 'side-select', title: 'Что делать со старыми заметками дней' },
      ...DAY_KEEP.map(([v, t]) => el('option', { value: v, textContent: t, selected: conf.settings.dayNotesKeep === v })));
    keepSel.addEventListener('change', () => {
      const v = keepSel.value;
      const cf = this.store.conf();
      const cut = this.store.dayNotesCutoff(v, new Date(), cf.settings.weekStart);
      const doomed = cut ? this.store.dayNoteKeys().filter(k => k < cut).length : 0;
      if (doomed && !confirm(`Сразу удалятся старые заметки дней: ${doomed}. Продолжить?`)) { keepSel.value = cf.settings.dayNotesKeep; return; }
      cf.settings.dayNotesKeep = v;
      this.store.saveConf(cf);
      const n = this.store.cleanupDayNotes();
      this.toast(n ? `Настройка сохранена, удалено старых заметок: ${n}` : 'Настройка сохранена');
      this.render();
    });
    const sideRepeat = btn('↻ Повторяющееся событие', () => this.openRepeatMenu(sideRepeat), 'cal-repeat-side');
    rc(this.side,
      el('div', { className: 'cal-side-top' }, el('b', { textContent: 'Календарь' }), btn('✕', () => this.setSide(false), 'icon-text', 'Закрыть')),
      el('div', { className: 'side-create' },
        btn('+ Новое событие', () => { this.setSide(false); this.newEvent(this.defaultStart()); }, 'primary'),
        sideRepeat),
      el('div', { className: 'mini' },
        el('div', { className: 'mini-head' },
          btn('‹', () => { this.miniMonth = new Date(mm.getFullYear(), mm.getMonth() - 1, 1); this.renderSide(); }, 'icon-text'),
          el('b', { textContent: `${cap(MONTHS[mm.getMonth()])} ${mm.getFullYear()}` }),
          btn('›', () => { this.miniMonth = new Date(mm.getFullYear(), mm.getMonth() + 1, 1); this.renderSide(); }, 'icon-text')),
        grid),
      el('div', { className: 'side-sec' }, el('div', { className: 'side-sec-head' }, el('b', { textContent: 'Календари' }), btn('+', () => this.openCalSettings(null), 'icon-text', 'Новый календарь')), cals),
      el('div', { className: 'side-sec side-daynotes' },
        el('b', { textContent: 'Заметки дней' }),
        keepSel,
        btn('Стереть заметки…', () => { this.setSide(false); this.openClearDayNotes(); }, 'danger-text')),
      el('div', { className: 'side-sec side-tools' },
        btn('Настройки календаря', () => this.openSettings()),
        btn('Импорт из .ics', () => importInput.click()),
        btn('Экспорт в .ics', () => this.exportIcs()),
        importInput));
  }

  // ---------- Day / week grid ----------
  renderGrid() {
    const days = this.visibleDays();
    const from = days[0], to = addDays(days[days.length - 1], 1);
    const conf = this.store.conf();
    const occ = this.store.occurrences(from, to);
    const todos = this.store.todos().items.filter(i => i.due && !i.done);
    const head = el('div', { className: 'cal-grid-head', style: { gridTemplateColumns: `52px repeat(${days.length}, minmax(0, 1fr))` } }, el('div'));
    const allday = el('div', { className: 'cal-allday', style: { gridTemplateColumns: `52px repeat(${days.length}, minmax(0, 1fr))` } }, el('div', { className: 'gutter-label', textContent: 'весь день' }));
    for (const d of days) {
      const h = conf.settings.holidays && holiday(d);
      const dh = el('button', { type: 'button', className: 'day-head' + (sameDay(d, new Date()) ? ' today' : '') + (h || isoDow(d) >= 6 ? ' off' : ''), title: h || '' },
        el('span', { textContent: WD[isoDow(d) - 1] }), el('b', { textContent: String(d.getDate()) }));
      dh.addEventListener('click', () => { this.anchor = d; this.setView('day'); });
      head.append(dh);
      const cell = el('div', { className: 'allday-cell' });
      cell.dataset.day = dkey(d);
      if (h) cell.append(el('div', { className: 'holiday', textContent: h }));
      for (const o of occ.filter(o => (o.data.allDay || o.end - o.start >= 864e5) && o.start < addDays(d, 1) && o.end > d)) cell.append(this.chip(o, conf));
      for (const t of todos.filter(t => t.due === dkey(d))) cell.append(this.todoChip(t));
      cell.addEventListener('dblclick', e => { if (e.target === cell) this.newEvent(d, { allDay: true }); });
      allday.append(cell);
    }
    const body = el('div', { className: 'cal-grid', style: { gridTemplateColumns: `52px repeat(${days.length}, minmax(0, 1fr))` } });
    const gutter = el('div', { className: 'gutter' });
    for (let h = 0; h < 24; h++) gutter.append(el('div', { className: 'hour-label', style: { top: h * HOUR + 'px' }, textContent: h ? `${pad(h)}:00` : '' }));
    body.append(gutter);
    const { workStart, workEnd } = conf.settings;
    for (const d of days) {
      const col = el('div', { className: 'cal-col' + (isoDow(d) >= 6 ? ' weekend' : '') });
      col.dataset.day = dkey(d);
      col.append(el('div', { className: 'off-hours', style: { top: 0, height: workStart * HOUR + 'px' } }), el('div', { className: 'off-hours', style: { top: workEnd * HOUR + 'px', height: (24 - workEnd) * HOUR + 'px' } }));
      const segs = [];
      for (const o of occ) {
        if (o.data.allDay || o.end - o.start >= 864e5) continue;
        const s = o.start < d ? d : o.start, e = o.end > addDays(d, 1) ? addDays(d, 1) : o.end;
        if (e <= d || s >= addDays(d, 1)) continue;
        segs.push({ o, s: (s - d) / 60000, e: Math.max((e - d) / 60000, (s - d) / 60000 + 20) });
      }
      layoutColumns(segs);
      for (const sg of segs) col.append(this.block(sg, conf));
      body.append(col);
    }
    const scroller = el('div', { className: 'cal-scroll' }, body);
    // Day note: a text field above the schedule in the day view, a row of short notes in the week view.
    let notes;
    if (this.view === 'day') notes = this.dayNoteBox(days[0]);
    else {
      notes = el('div', { className: 'cal-daynotes', style: { gridTemplateColumns: `52px repeat(${days.length}, minmax(0, 1fr))` } }, el('div', { className: 'gutter-label', textContent: '📝' }));
      for (const d of days) {
        const text = this.store.dayNote(dkey(d));
        const cell = el('button', { type: 'button', className: 'daynote-cell' + (text ? ' has' : ''), title: text || 'Добавить заметку к дню' },
          text ? text.split('\n').filter(Boolean).slice(0, 2).join(' · ') : '+');
        cell.addEventListener('click', () => this.openDayNote(d));
        notes.append(cell);
      }
    }
    rc(this.body, el('div', { className: 'cal-week', style: { '--days': days.length } }, head, allday, notes, scroller));
    this.bindGrid(body);
    this.drawNowLine();
    const target = this.scrollTop ?? Math.max(0, (Math.min(workStart, new Date().getHours()) - 1) * HOUR);
    requestAnimationFrame(() => { scroller.scrollTop = target; });
    scroller.addEventListener('scroll', () => { this.scrollTop = scroller.scrollTop; });
  }

  // ---------- Day notes ----------
  // The note field of the day view: saved as you type.
  dayNoteBox(d) {
    const key = dkey(d);
    const ta = el('textarea', { className: 'day-note-text', placeholder: 'Заметка к этому дню: дела, мысли, что не забыть…', value: this.store.dayNote(key), rows: 2 });
    const state = el('span', { className: 'day-note-state' });
    const fit = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight + 2, Math.max(90, this.root.clientHeight * 0.3)) + 'px'; };
    let timer = null;
    const save = () => { clearTimeout(timer); this.store.saveDayNote(key, ta.value); state.textContent = ta.value.trim() ? 'Сохранено' : ''; };
    ta.addEventListener('input', () => { fit(); state.textContent = ''; clearTimeout(timer); timer = setTimeout(save, 600); });
    ta.addEventListener('blur', () => { save(); setTimeout(() => this.refresh(), 0); });
    requestAnimationFrame(fit);
    return el('div', { className: 'day-note' }, el('div', { className: 'day-note-head' }, el('b', { textContent: '📝 Заметка дня' }), state), ta);
  }

  // A dialog for the note of any day (week and month views, schedule).
  openDayNote(d) {
    const key = dkey(d);
    const old = this.store.dayNote(key);
    const ta = el('textarea', { className: 'day-note-text', placeholder: 'Заметка к этому дню: дела, мысли, что не забыть…', value: old, rows: 8 });
    const save = () => { this.store.saveDayNote(key, ta.value); this.closeModal(); this.render(); };
    ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save(); });
    this.openModal(el('div', { className: 'ce', role: 'dialog', 'aria-label': 'Заметка дня' },
      el('h2', { textContent: `📝 ${cap(dayTitle(d))}` }),
      ta,
      el('div', { className: 'ce-footer' },
        old ? btn('Удалить', () => { this.store.saveDayNote(key, ''); this.closeModal(); this.render(); this.toast('Заметка дня удалена'); }, 'danger-text') : null,
        btn('Открыть день', () => { this.store.saveDayNote(key, ta.value); this.closeModal(); this.anchor = startOfDay(d); this.setView('day'); }),
        el('span', { className: 'spacer' }),
        btn('Отмена', () => this.closeModal()),
        btn('Сохранить', save, 'primary'))));
    requestAnimationFrame(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); });
  }

  // Deleting the notes of a period: the day, week, month or year shown now, or all of them.
  openClearDayNotes() {
    const a = this.anchor;
    const ws = this.weekStart(a);
    const periods = [
      ['day', `За день: ${a.getDate()} ${MONTHS_GEN[a.getMonth()]}`, dkey(a), dkey(a)],
      ['week', `За неделю: ${ws.getDate()} ${MONTHS_GEN[ws.getMonth()]} – ${addDays(ws, 6).getDate()} ${MONTHS_GEN[addDays(ws, 6).getMonth()]}`, dkey(ws), dkey(addDays(ws, 6))],
      ['month', `За месяц: ${MONTHS[a.getMonth()]} ${a.getFullYear()}`, dkey(new Date(a.getFullYear(), a.getMonth(), 1)), dkey(new Date(a.getFullYear(), a.getMonth() + 1, 0))],
      ['year', `За год: ${a.getFullYear()}`, `${a.getFullYear()}-01-01`, `${a.getFullYear()}-12-31`],
      ['all', 'Все заметки дней', null, null],
    ];
    const keys = this.store.dayNoteKeys();
    const count = (f, t) => keys.filter(k => (!f || k >= f) && (!t || k <= t)).length;
    let pick = 'day';
    const list = el('div', { className: 'clear-list' });
    const go = btn('', () => {
      const p = periods.find(x => x[0] === pick);
      const n = this.store.clearDayNotes(p[2], p[3]);
      this.closeModal(); this.render();
      this.toast(n ? `Стёрто заметок: ${n}` : 'Стирать было нечего');
    }, 'danger');
    const draw = () => {
      rc(list, ...periods.map(([id, text, f, t]) => {
        const r = el('input', { type: 'radio', name: 'clearPeriod', checked: id === pick });
        r.addEventListener('change', () => { pick = id; draw(); });
        return el('label', { className: 'ce-check' }, r, el('span', { textContent: `${text} (${count(f, t)})` }));
      }));
      const p = periods.find(x => x[0] === pick);
      const n = count(p[2], p[3]);
      go.textContent = n ? `Стереть (${n})` : 'Стереть';
      go.disabled = !n;
    };
    draw();
    this.openModal(el('div', { className: 'ce', role: 'dialog', 'aria-label': 'Стереть заметки дней' },
      el('h2', { textContent: 'Стереть заметки дней' }),
      el('p', { className: 'muted small', textContent: 'Период считается от даты, которая сейчас открыта в календаре. Стёртые заметки не вернуть.' }),
      list,
      el('div', { className: 'ce-footer' }, el('span', { className: 'spacer' }), btn('Отмена', () => this.closeModal()), go)));
  }

  drawNowLine() {
    const now = new Date();
    this.body.querySelectorAll('.now-line').forEach(n => n.remove());
    const col = this.body.querySelector(`.cal-col[data-day="${dkey(now)}"]`);
    if (col) col.append(el('div', { className: 'now-line', style: { top: minutesOf(now) * HOUR / 60 + 'px' } }));
  }

  color(o, conf) { return o.data.color || (conf.calendars.find(c => c.id === o.calendar) || conf.calendars[0]).color; }

  block(sg, conf) {
    const o = sg.o;
    const color = this.color(o, conf);
    const short = sg.e - sg.s < 45;
    const b = el('div', {
      className: 'ev-block' + (short ? ' short' : '') + (o.end < new Date() ? ' past' : ''),
      style: { top: sg.s * HOUR / 60 + 'px', height: Math.max(18, (sg.e - sg.s) * HOUR / 60 - 2) + 'px', left: `calc(${sg.col / sg.cols * 100}% + 2px)`, width: `calc(${100 / sg.cols}% - 4px)`, '--ev': color },
      title: `${o.data.title || 'Без названия'}, ${hm(o.start)}–${hm(o.end)}`,
    },
    el('div', { className: 'ev-title', textContent: (o.data.label ? `[${o.data.label}] ` : '') + (o.data.title || 'Без названия') }),
    short ? null : el('div', { className: 'ev-time', textContent: `${hm(o.start)}–${hm(o.end)}${o.data.place ? ' · ' + o.data.place : ''}` }),
    el('div', { className: 'ev-resize' }));
    b.dataset.occ = o.ev.id + '|' + o.key;
    b.occ = o;
    return b;
  }

  chip(o, conf) {
    const color = this.color(o, conf);
    const c = el('div', { className: 'ev-chip' + (o.data.allDay || o.end - o.start >= 864e5 ? ' allday' : '') + (o.end < new Date() ? ' past' : ''), style: { '--ev': color },
      textContent: (o.data.allDay || o.end - o.start >= 864e5 ? '' : hm(o.start) + ' ') + (o.data.label ? `[${o.data.label}] ` : '') + (o.data.title || 'Без названия') });
    c.dataset.occ = o.ev.id + '|' + o.key;
    c.addEventListener('click', e => { e.stopPropagation(); this.openCard(o, c); });
    return c;
  }

  todoChip(t) {
    const box = el('input', { type: 'checkbox', checked: Boolean(t.done) });
    box.addEventListener('change', () => this.toggleTodo(t.id, box.checked));
    const c = el('label', { className: 'todo-chip' + (t.due < dkey(new Date()) ? ' late' : '') }, box, el('span', { textContent: t.title }));
    c.addEventListener('click', e => e.stopPropagation());
    return c;
  }

  // Mouse: drag on empty space to create, drag an event to move it, drag its
  // bottom edge to change the end. Touch: tap to create or open (scrolling stays free).
  bindGrid(grid) {
    const minuteAt = (col, y) => Math.max(0, Math.min(1440, Math.round(((y - col.getBoundingClientRect().top) * 60 / HOUR) / SNAP) * SNAP));
    const colAt = (x, y) => document.elementFromPoint(x, y)?.closest('.cal-col');
    grid.addEventListener('pointerdown', e => {
      const col = e.target.closest('.cal-col');
      if (!col || e.button > 0) return;
      const blockEl = e.target.closest('.ev-block');
      const touch = e.pointerType !== 'mouse';
      this.gesture = { touch, x: e.clientX, y: e.clientY, moved: false, col, blockEl,
        type: blockEl ? (e.target.closest('.ev-resize') && !touch ? 'resize' : 'move') : 'create',
        startMin: minuteAt(col, e.clientY) };
      if (!touch) { grid.setPointerCapture(e.pointerId); e.preventDefault(); }
    });
    grid.addEventListener('pointermove', e => {
      const g = this.gesture;
      if (!g) return;
      if (Math.hypot(e.clientX - g.x, e.clientY - g.y) > 6) g.moved = true;
      if (!g.moved || g.touch) return;
      const col = colAt(e.clientX, e.clientY) || g.col;
      const m = minuteAt(g.col, e.clientY);
      if (g.type === 'create') {
        const a = Math.min(g.startMin, m), b = Math.max(g.startMin, m, g.startMin + SNAP);
        if (!g.ghost) { g.ghost = el('div', { className: 'ev-ghost' }); g.col.append(g.ghost); }
        Object.assign(g.ghost.style, { top: a * HOUR / 60 + 'px', height: (b - a) * HOUR / 60 + 'px' });
        g.ghost.textContent = `${pad(Math.floor(a / 60))}:${pad(a % 60)}–${pad(Math.floor(b / 60))}:${pad(b % 60)}`;
        g.range = [a, b];
      } else if (g.type === 'move') {
        const o = g.blockEl.occ;
        const dayShift = Math.round((parse(col.dataset.day) - parse(g.col.dataset.day)) / 864e5);
        const delta = Math.round(((e.clientY - g.y) * 60 / HOUR) / SNAP) * SNAP;
        g.shift = dayShift * 1440 + delta;
        g.blockEl.classList.add('dragging');
        g.blockEl.style.transform = `translate(${(col.getBoundingClientRect().left - g.col.getBoundingClientRect().left)}px, ${delta * HOUR / 60}px)`;
        g.blockEl.querySelector('.ev-time')?.replaceChildren(`${hm(addMinutes(o.start, g.shift))}–${hm(addMinutes(o.end, g.shift))}`);
      } else if (g.type === 'resize') {
        const o = g.blockEl.occ;
        const newEnd = Math.max(minutesOf(o.start) + SNAP, m);
        g.newEnd = newEnd;
        g.blockEl.style.height = (newEnd - minutesOf(o.start)) * HOUR / 60 - 2 + 'px';
      }
    });
    const end = e => {
      const g = this.gesture;
      this.gesture = null;
      // A finger that starts scrolling cancels the pointer. Redrawing here would
      // replace the scrolling element under the finger and stop the scroll.
      if (!g || e.type === 'pointercancel') { g?.ghost?.remove(); if (g?.moved && !g.touch) this.render(); return; }
      const day = parse(g.col.dataset.day);
      if (g.type === 'create') {
        g.ghost?.remove();
        if (g.touch && g.moved) return;
        if (g.range && g.moved) this.newEvent(addMinutes(day, g.range[0]), { end: addMinutes(day, g.range[1]) });
        else this.newEvent(addMinutes(day, Math.floor(minutesOf(addMinutes(day, g.startMin)) / 30) * 30));
        return;
      }
      const o = g.blockEl.occ;
      if (!g.moved || g.touch) { if (!g.moved) this.openCard(o, g.blockEl); return; }
      if (g.type === 'move' && g.shift) this.moveOccurrence(o, addMinutes(o.start, g.shift), addMinutes(o.end, g.shift));
      else if (g.type === 'resize' && g.newEnd) this.moveOccurrence(o, o.start, addMinutes(startOfDay(o.start), g.newEnd));
      else this.render();
    };
    grid.addEventListener('pointerup', end);
    grid.addEventListener('pointercancel', end);
  }

  // ---------- Month ----------
  renderMonth() {
    const conf = this.store.conf();
    const first = new Date(this.anchor.getFullYear(), this.anchor.getMonth(), 1);
    const start = this.weekStart(first);
    const weeks = Math.ceil(((first - start) / 864e5 + new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()) / 7);
    const occ = this.store.occurrences(start, addDays(start, weeks * 7));
    const todos = this.store.todos().items.filter(i => i.due && !i.done);
    const grid = el('div', { className: 'cal-month', style: { gridTemplateRows: `auto repeat(${weeks}, minmax(0, 1fr))` } });
    for (let i = 0; i < 7; i++) grid.append(el('div', { className: 'month-wd', textContent: WD[isoDow(addDays(start, i)) - 1] }));
    for (let i = 0; i < weeks * 7; i++) {
      const d = addDays(start, i);
      const h = conf.settings.holidays && holiday(d);
      const num = btn(String(d.getDate()), () => { this.anchor = d; this.setView('day'); }, 'month-num');
      const note = this.store.dayNote(dkey(d));
      const noteBtn = btn('📝', () => this.openDayNote(d), 'month-note' + (note ? ' has' : ''), note || 'Заметка к дню');
      const cell = el('div', { className: 'month-cell' + (d.getMonth() !== first.getMonth() ? ' other' : '') + (sameDay(d, new Date()) ? ' today' : '') + (h || isoDow(d) >= 6 ? ' off' : ''), title: h || '' },
        el('div', { className: 'month-top' }, num, noteBtn));
      if (note) cell.append(el('div', { className: 'month-note-text', textContent: note.split('\n').find(Boolean) || '' }));
      if (h) cell.append(el('div', { className: 'holiday', textContent: h }));
      const list = occ.filter(o => o.start < addDays(d, 1) && o.end > d);
      const items = [...list.map(o => this.chip(o, conf)), ...todos.filter(t => t.due === dkey(d)).map(t => this.todoChip(t))];
      const maxShown = 3;
      items.slice(0, maxShown).forEach(x => cell.append(x));
      if (items.length > maxShown) cell.append(btn(`ещё ${items.length - maxShown}`, () => { this.anchor = d; this.setView('day'); }, 'month-more'));
      cell.addEventListener('click', e => { if (e.target === cell) this.newEvent(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 9, 0)); });
      grid.append(cell);
    }
    rc(this.body, grid);
  }

  // ---------- Schedule (list) ----------
  renderAgenda() {
    const conf = this.store.conf();
    const from = this.anchor, to = addDays(from, this.agendaDays);
    const occ = this.store.occurrences(from, to);
    const list = el('div', { className: 'cal-agenda' });
    let shown = 0;
    for (let d = from; d < to; d = addDays(d, 1)) {
      const items = occ.filter(o => o.start < addDays(d, 1) && o.end > d);
      const note = this.store.dayNote(dkey(d));
      if (!items.length && !note) continue;
      shown++;
      const rel = sameDay(d, new Date()) ? 'Сегодня, ' : sameDay(d, addDays(new Date(), 1)) ? 'Завтра, ' : '';
      list.append(el('h2', { className: 'agenda-day' + (sameDay(d, new Date()) ? ' today' : ''), textContent: rel + dayTitle(d) }));
      if (note) {
        const day = d;
        const n = el('button', { type: 'button', className: 'agenda-note', textContent: '📝 ' + note });
        n.addEventListener('click', () => this.openDayNote(day));
        list.append(n);
      }
      for (const o of items) {
        const row = el('button', { type: 'button', className: 'agenda-row', style: { '--ev': this.color(o, conf) } },
          el('span', { className: 'agenda-time', textContent: o.data.allDay || o.end - o.start >= 864e5 ? 'весь день' : `${hm(o.start)}–${hm(o.end)}` }),
          el('span', { className: 'dot' }),
          el('span', { className: 'agenda-title', textContent: (o.data.label ? `[${o.data.label}] ` : '') + (o.data.title || 'Без названия') }),
          o.data.place ? el('span', { className: 'agenda-place', textContent: o.data.place }) : null);
        row.addEventListener('click', e => { e.stopPropagation(); this.openCard(o, row); });
        list.append(row);
      }
    }
    if (!shown) list.append(el('p', { className: 'muted agenda-empty', textContent: `С ${from.getDate()} ${MONTHS_GEN[from.getMonth()]} на ${this.agendaDays} дней вперёд событий нет.` }));
    list.append(btn(`Показать ещё ${this.agendaDays} дней`, () => { this.agendaDays += 60; this.renderAgenda(); }, 'agenda-more'));
    rc(this.body, list);
  }

  // ---------- Search ----------
  renderResults() {
    const q = (this.query || '').trim().toLowerCase();
    if (!q) { this.results.hidden = true; return; }
    const now = new Date();
    const conf = this.store.conf();
    const week0 = this.weekStart(now), week1 = addDays(week0, 7);
    const groups = { 'Раньше': [], 'На этой неделе': [], 'Позже': [] };
    for (const ev of this.store.events()) {
      const text = [ev.title, ev.description, ev.place, ev.label].join(' ').toLowerCase();
      if (!text.includes(q)) continue;
      const occ = expand(ev, addDays(now, -366), addDays(now, 366));
      if (!occ.length) continue;
      const o = occ.find(x => x.end >= now) || occ[occ.length - 1];
      groups[o.start < week0 ? 'Раньше' : o.start < week1 ? 'На этой неделе' : 'Позже'].push(o);
    }
    rc(this.results, );
    let any = false;
    for (const [name, list] of Object.entries(groups)) {
      if (!list.length) continue;
      any = true;
      this.results.append(el('div', { className: 'res-group', textContent: name }));
      for (const o of list.sort((a, b) => a.start - b.start)) {
        const r = el('button', { type: 'button', className: 'agenda-row', style: { '--ev': this.color(o, conf) } },
          el('span', { className: 'agenda-time', textContent: `${o.start.getDate()} ${MONTHS_GEN[o.start.getMonth()]}${o.data.allDay ? '' : ', ' + hm(o.start)}` }),
          el('span', { className: 'dot' }), el('span', { className: 'agenda-title', textContent: o.data.title || 'Без названия' }));
        r.addEventListener('click', () => { this.results.hidden = true; this.go(o.start); requestAnimationFrame(() => this.openCard(o, this.body.querySelector(`[data-occ="${CSS.escape(o.ev.id + '|' + o.key)}"]`))); });
        this.results.append(r);
      }
    }
    if (!any) this.results.append(el('p', { className: 'muted', textContent: 'Ничего не найдено.' }));
    this.results.hidden = false;
  }

  // ---------- Event card ----------
  openCard(o, anchorEl) {
    const conf = this.store.conf();
    const cal = conf.calendars.find(c => c.id === o.calendar) || conf.calendars[0];
    const d = o.data;
    const when = d.allDay ? (sameDay(o.start, addMinutes(o.end, -1)) ? cap(dayTitle(o.start)) + ', весь день' : `${o.start.getDate()} ${MONTHS_GEN[o.start.getMonth()]} – ${addMinutes(o.end, -1).getDate()} ${MONTHS_GEN[addMinutes(o.end, -1).getMonth()]}, весь день`)
      : sameDay(o.start, o.end) || minutesOf(o.end) === 0 && sameDay(o.start, addMinutes(o.end, -1)) ? `${cap(dayTitle(o.start))}, ${hm(o.start)}–${hm(o.end)}`
        : `${o.start.getDate()} ${MONTHS_GEN[o.start.getMonth()]} ${hm(o.start)} – ${o.end.getDate()} ${MONTHS_GEN[o.end.getMonth()]} ${hm(o.end)}`;
    const actions = el('div', { className: 'pop-actions' },
      btn('Изменить', () => { this.closePop(); this.openEditor(o.ev, o); }, 'primary'),
      btn('Копировать', () => { this.closePop(); this.copyEvent(o); }),
      btn('Удалить', () => this.askDelete(o, actions), 'danger-text'));
    rc(this.pop, 
      el('div', { className: 'pop-head' }, el('span', { className: 'dot big', style: { background: this.color(o, conf) } }), el('h2', { textContent: d.title || 'Без названия' }), btn('×', () => this.closePop(), 'icon-text', 'Закрыть')),
      el('p', { textContent: when }),
      o.ev.repeat ? el('p', { className: 'muted', textContent: '↻ ' + repeatLabel(o.ev.repeat, eventSpan(o.ev)[0]) + (o.moved ? ' (это событие изменено отдельно)' : '') }) : null,
      d.place ? el('p', { textContent: '📍 ' + d.place }) : null,
      d.description ? el('p', { className: 'pop-desc', textContent: d.description }) : null,
      el('p', { className: 'muted', textContent: `Календарь: ${cal.name}` + (d.label ? ` · метка «${d.label}»` : '') }),
      (d.reminders || []).length ? el('p', { className: 'muted', textContent: '🔔 ' + d.reminders.slice().sort((a, b) => a - b).map(reminderLabel).join(', ').toLowerCase() }) : el('p', { className: 'muted', textContent: '🔕 Без напоминаний' }),
      actions);
    this.pop.hidden = false;
    const r = (anchorEl || this.body).getBoundingClientRect(), host = this.root.getBoundingClientRect();
    const w = Math.min(340, host.width - 24);
    let left = r.right - host.left + 8;
    if (left + w > host.width - 12) left = Math.max(12, r.left - host.left - w - 8);
    if (left < 12 || host.width < 600) left = (host.width - w) / 2;
    const top = Math.min(Math.max(12, r.top - host.top), Math.max(12, host.height - this.pop.offsetHeight - 12));
    Object.assign(this.pop.style, { left: left + 'px', top: top + 'px', width: w + 'px' });
  }
  closePop() { this.pop.hidden = true; }

  askDelete(o, actions) {
    const del = mode => {
      if (mode === 'one') {
        const ev = structuredClone(o.ev);
        ev.exceptions = { ...(ev.exceptions || {}), [o.key]: { deleted: true } };
        this.store.saveEvent(ev);
      } else this.store.deleteEvent(o.ev.id);
      this.closePop();
      this.toast(mode === 'one' ? 'Удалено это событие серии' : 'Событие удалено');
      this.render();
    };
    if (o.ev.repeat) rc(actions, el('span', { textContent: 'Удалить:' }), btn('Только это', () => del('one'), 'danger-text'), btn('Всю серию', () => del('all'), 'danger-text'), btn('Отмена', () => this.openCard(o, null)));
    else rc(actions, el('span', { textContent: 'Удалить событие?' }), btn('Удалить', () => del('all'), 'danger-text'), btn('Отмена', () => this.openCard(o, null)));
  }

  copyEvent(o) {
    const ev = structuredClone(o.data);
    delete ev.exceptions;
    ev.id = newId();
    ev.title = (ev.title || 'Без названия') + ' (копия)';
    ev.start = o.data.allDay ? dkey(o.start) : tkey(o.start);
    ev.end = o.data.allDay ? dkey(addMinutes(o.end, -1)) : tkey(o.end);
    delete ev.created;
    this.openEditor(ev, null, true);
  }

  // Dragging in the grid: a single event moves; for a repeating one only this occurrence.
  moveOccurrence(o, start, end) {
    const ev = structuredClone(o.ev);
    if (ev.repeat) {
      ev.exceptions = { ...(ev.exceptions || {}), [o.key]: { ...((ev.exceptions || {})[o.key] || {}), start: tkey(start), end: tkey(end) } };
      this.toast('Изменено только это событие серии');
    } else { ev.start = tkey(start); ev.end = tkey(end); }
    this.store.saveEvent(ev);
    this.render();
  }

  newEvent(start, { end = null, allDay = false, repeat = null } = {}) {
    const conf = this.store.conf();
    const cal = conf.calendars.find(c => c.id === conf.primary) || conf.calendars[0];
    const e = end || addMinutes(start, cal.duration || 60);
    const base = { id: newId(), title: '', calendar: cal.id, allDay, start: allDay ? dkey(start) : tkey(start), end: allDay ? dkey(start) : tkey(e), reminders: [...cal.reminders] };
    if (repeat) base.repeat = repeat;
    this.openEditor(base, null, true);
  }

  // ---------- Event editor ----------
  openEditor(base, occ, isNew = false) {
    const conf = this.store.conf();
    const d = occ ? structuredClone(occ.data) : structuredClone(base);
    const [s0, e0] = occ ? [occ.start, occ.end] : eventSpan(d);
    const lastDay = d.allDay ? addMinutes(e0, -1) : e0;
    const repeat = structuredClone(base.repeat || null);
    let reminders = [...(d.reminders || [])];
    let remindersTouched = !isNew;
    let color = d.color || null;

    const f = {
      title: el('input', { id: 'ceTitle', className: 'ce-title', placeholder: 'Название события', value: d.title || '', autocomplete: 'off' }),
      cal: el('select', { id: 'ceCal' }, ...conf.calendars.map(c => el('option', { value: c.id, textContent: c.name, selected: c.id === (d.calendar || conf.primary) }))),
      allDay: el('input', { type: 'checkbox', id: 'ceAllDay', checked: Boolean(d.allDay) }),
      sd: el('input', { type: 'date', id: 'ceStartD', value: dkey(s0) }),
      st: el('input', { type: 'time', id: 'ceStartT', value: hm(s0), step: 300 }),
      ed: el('input', { type: 'date', id: 'ceEndD', value: dkey(lastDay) }),
      et: el('input', { type: 'time', id: 'ceEndT', value: hm(e0), step: 300 }),
      place: el('input', { id: 'cePlace', placeholder: 'Место', value: d.place || '', autocomplete: 'off' }),
      desc: el('textarea', { id: 'ceDesc', placeholder: 'Описание', value: d.description || '', rows: 3 }),
      label: el('input', { id: 'ceLabel', placeholder: 'Метка, например «важно»', value: d.label || '', autocomplete: 'off', maxLength: 30 }),
      repeat: el('select', { id: 'ceRepeat' }),
      interval: el('input', { type: 'number', id: 'ceInterval', min: 1, max: 99, value: repeat?.interval || 1 }),
      freq: el('select', { id: 'ceFreq' }, ...[['day', 'дн.'], ['week', 'нед.'], ['month', 'мес.'], ['year', 'г.']].map(([v, t]) => el('option', { value: v, textContent: t, selected: repeat ? repeat.freq === v : v === 'week' }))),
      monthMode: el('select', { id: 'ceMonthMode' }),
      endMode: el('select', { id: 'ceEndMode' }, ...[['never', 'никогда'], ['until', 'в дату'], ['count', 'после N раз']].map(([v, t]) => el('option', { value: v, textContent: t, selected: repeat ? (repeat.until ? v === 'until' : repeat.count ? v === 'count' : v === 'never') : v === 'never' }))),
      until: el('input', { type: 'date', id: 'ceUntil', value: repeat?.until || dkey(addDays(s0, 30)) }),
      count: el('input', { type: 'number', id: 'ceCount', min: 1, max: 999, value: repeat?.count || 10 }),
    };
    const weekdays = el('div', { className: 'ce-weekdays' });
    let byDay = new Set(repeat?.byDay?.length ? repeat.byDay : [isoDow(s0)]);
    let weekdaysTouched = Boolean(repeat?.byDay?.length);
    const drawWeekdays = () => {
      rc(weekdays, ...WD.map((w, i) => {
        const b = btn(w, () => { weekdaysTouched = true; if (byDay.has(i + 1) && byDay.size > 1) byDay.delete(i + 1); else byDay.add(i + 1); drawWeekdays(); }, byDay.has(i + 1) ? 'on' : '');
        b.setAttribute('aria-pressed', String(byDay.has(i + 1)));
        return b;
      }));
    };
    drawWeekdays();
    const custom = el('div', { className: 'ce-custom', hidden: true },
      el('div', { className: 'ce-row' }, el('span', { textContent: 'Каждые' }), f.interval, f.freq),
      el('div', { className: 'ce-row ce-week-row' }, weekdays),
      el('div', { className: 'ce-row ce-month-row' }, f.monthMode),
      el('div', { className: 'ce-row' }, el('span', { textContent: 'Закончить' }), f.endMode, f.until, f.count));

    const startDate = () => parse(f.sd.value + 'T' + (f.allDay.checked ? '00:00' : f.st.value || '00:00'));
    const fillRepeat = () => {
      const sd = startDate(), n = weekOfMonth(sd), wdName = WD_LONG[isoDow(sd) - 1];
      const presets = [['none', 'Не повторять'], ['day', 'Каждый день'], ['workdays', 'По будням (пн–пт)'], ['week', `Каждую неделю (${wdName})`],
        ['month', `Каждый месяц (${sd.getDate()}-го числа)`], ['monthday', `Каждый месяц (${n === -1 ? 'последний' : n + '-й'} ${wdName})`], ['year', `Каждый год (${sd.getDate()} ${MONTHS_GEN[sd.getMonth()]})`], ['custom', 'Настроить…']];
      const cur = f.repeat.value || presetOf(repeat);
      rc(f.repeat, ...presets.map(([v, t]) => el('option', { value: v, textContent: t, selected: v === cur })));
      rc(f.monthMode, el('option', { value: 'date', textContent: `по числу: ${sd.getDate()}-го`, selected: repeat?.monthMode !== 'weekday' }),
        el('option', { value: 'weekday', textContent: `по дню недели: ${n === -1 ? 'последний' : n + '-й'} ${wdName}`, selected: repeat?.monthMode === 'weekday' }));
    };
    const presetOf = r => {
      if (!r) return 'none';
      const plain = (r.interval || 1) === 1 && !r.until && !r.count;
      if (!plain) return 'custom';
      if (r.freq === 'day') return 'day';
      if (r.freq === 'week') { const b = (r.byDay || []).slice().sort().join(); if (b === '1,2,3,4,5') return 'workdays'; return !r.byDay || r.byDay.length <= 1 ? 'week' : 'custom'; }
      if (r.freq === 'month') return r.monthMode === 'weekday' ? 'monthday' : 'month';
      return 'year';
    };
    const syncCustom = () => {
      custom.hidden = f.repeat.value !== 'custom';
      custom.querySelector('.ce-week-row').hidden = f.freq.value !== 'week';
      custom.querySelector('.ce-month-row').hidden = f.freq.value !== 'month';
      f.until.hidden = f.endMode.value !== 'until';
      f.count.hidden = f.endMode.value !== 'count';
    };
    const syncAllDay = () => { f.st.hidden = f.et.hidden = f.allDay.checked; };
    fillRepeat(); syncCustom(); syncAllDay();
    f.repeat.addEventListener('change', syncCustom);
    f.freq.addEventListener('change', syncCustom);
    f.endMode.addEventListener('change', syncCustom);
    f.allDay.addEventListener('change', syncAllDay);
    f.sd.addEventListener('change', () => {
      // Keep the duration when the start date moves.
      const dur = parse(f.ed.value) - parse(dkey(s0));
      if (f.sd.value) f.ed.value = dkey(new Date(parse(f.sd.value).getTime() + Math.max(0, dur)));
      if (f.sd.value) s0.setTime(parse(f.sd.value + 'T' + hm(s0)).getTime());
      // The weekday follows the new start date until the user picks days by hand.
      if (!weekdaysTouched && f.sd.value) { byDay = new Set([isoDow(parse(f.sd.value))]); drawWeekdays(); }
      fillRepeat();
    });
    f.st.addEventListener('change', () => {
      const oldS = parse(dkey(s0) + 'T' + hm(s0)), oldE = parse(f.ed.value + 'T' + f.et.value);
      const dur = Math.max(15, (oldE - oldS) / 60000);
      const ns = startDate();
      const ne = addMinutes(ns, dur);
      f.ed.value = dkey(ne); f.et.value = hm(ne);
      s0.setTime(ns.getTime());
    });
    f.cal.addEventListener('change', () => {
      if (!remindersTouched) { reminders = [...this.store.calendar(f.cal.value).reminders]; drawReminders(); }
      drawColors();
    });

    // Reminders
    const remList = el('div', { className: 'ce-rem-list' });
    const remAdd = el('select', { id: 'ceRemAdd' });
    const remNum = el('input', { type: 'number', id: 'ceRemNum', min: 1, max: 999, value: 3, hidden: true });
    const remUnit = el('select', { id: 'ceRemUnit', hidden: true }, el('option', { value: '1', textContent: 'минут' }), el('option', { value: '60', textContent: 'часов' }), el('option', { value: '1440', textContent: 'дней', selected: true }), el('option', { value: '10080', textContent: 'недель' }));
    const remOk = btn('Добавить', () => { const m = Math.round(+remNum.value * +remUnit.value); if (m >= 0) addRem(m); remNum.hidden = remUnit.hidden = remOk.hidden = true; remAdd.value = ''; }, '', '');
    remOk.hidden = true;
    const addRem = m => { if (!reminders.includes(m)) reminders.push(m); remindersTouched = true; drawReminders(); };
    const drawReminders = () => {
      rc(remList, ...reminders.slice().sort((a, b) => a - b).map(m => el('span', { className: 'ce-rem' }, '🔔 ' + reminderLabel(m), btn('×', () => { reminders = reminders.filter(x => x !== m); remindersTouched = true; drawReminders(); }, 'icon-text', 'Убрать напоминание'))));
      if (!reminders.length) remList.append(el('span', { className: 'muted', textContent: 'Без напоминаний' }));
      rc(remAdd, el('option', { value: '', textContent: '+ Добавить напоминание' }), ...REMIND_PRESETS.filter(([m]) => !reminders.includes(m)).map(([m, t]) => el('option', { value: String(m), textContent: t })), el('option', { value: 'custom', textContent: 'Своё время…' }));
    };
    remAdd.addEventListener('change', () => {
      if (remAdd.value === 'custom') { remNum.hidden = remUnit.hidden = remOk.hidden = false; remNum.focus(); return; }
      if (remAdd.value !== '') addRem(+remAdd.value);
    });
    drawReminders();

    // Colour label
    const colors = el('div', { className: 'ce-colors' });
    const drawColors = () => {
      const calColor = this.store.calendar(f.cal.value).color;
      rc(colors, 
        btn('', () => { color = null; drawColors(); }, 'swatch' + (!color ? ' on' : ''), 'Цвет календаря'),
        ...COLORS.map(c => { const b = btn('', () => { color = c; drawColors(); }, 'swatch' + (color === c ? ' on' : ''), 'Цветная метка'); b.style.background = c; return b; }));
      colors.firstChild.style.background = calColor;
      colors.firstChild.textContent = '∅';
    };
    drawColors();

    const msg = el('p', { className: 'form-msg bad', hidden: true });
    const footer = el('div', { className: 'ce-footer' });
    // The repeat rule chosen in the form, in the same shape as stored.
    const normRepeat = r => {
      if (!r) return null;
      const o = { freq: r.freq, interval: r.interval || 1 };
      if (r.freq === 'week') o.byDay = (r.byDay && r.byDay.length ? r.byDay : []).slice().sort();
      if (r.freq === 'month') o.monthMode = r.monthMode === 'weekday' ? 'weekday' : 'date';
      if (r.until) o.until = r.until;
      if (r.count) o.count = r.count;
      return o;
    };
    const readRepeat = s => {
      const p = f.repeat.value;
      let rep = null;
      if (p === 'day') rep = { freq: 'day', interval: 1 };
      else if (p === 'workdays') rep = { freq: 'week', interval: 1, byDay: [1, 2, 3, 4, 5] };
      else if (p === 'week') rep = { freq: 'week', interval: 1, byDay: [isoDow(s)] };
      else if (p === 'month') rep = { freq: 'month', interval: 1, monthMode: 'date' };
      else if (p === 'monthday') rep = { freq: 'month', interval: 1, monthMode: 'weekday' };
      else if (p === 'year') rep = { freq: 'year', interval: 1 };
      else if (p === 'custom') {
        rep = { freq: f.freq.value, interval: Math.max(1, +f.interval.value || 1) };
        if (rep.freq === 'week') rep.byDay = [...byDay].sort();
        if (rep.freq === 'month') rep.monthMode = f.monthMode.value;
        if (f.endMode.value === 'until' && f.until.value) rep.until = f.until.value;
        if (f.endMode.value === 'count') rep.count = Math.max(1, +f.count.value || 1);
      }
      return normRepeat(rep);
    };
    const repeatChanged = () => {
      // Moving one occurrence to another weekday is not a change of the rule.
      const was = normRepeat(base.repeat);
      const now = readRepeat(occ ? occ.start : startDate());
      return JSON.stringify(was) !== JSON.stringify(now);
    };
    const save = scope => {
      const title = f.title.value.trim() || 'Без названия';
      const allDay = f.allDay.checked;
      let s = parse(f.sd.value + 'T' + (allDay ? '00:00' : f.st.value || '00:00'));
      let e = parse(f.ed.value + 'T' + (allDay ? '00:00' : f.et.value || '00:00'));
      if (!f.sd.value || !f.ed.value || isNaN(s) || isNaN(e)) { msg.textContent = 'Укажите дату начала и окончания.'; msg.hidden = false; return; }
      if (!allDay && e <= s) e = addMinutes(s, 30);
      if (allDay && e < s) e = s;
      // For "the whole series" the rule is read against the series' own first date.
      const rep = readRepeat(scope === 'all' ? eventSpan(base)[0] : s);
      const fields = { title, calendar: f.cal.value, allDay, place: f.place.value.trim(), description: f.desc.value.trim(), label: f.label.value.trim(), color, reminders: reminders.slice().sort((a, b) => a - b) };
      for (const k of ['place', 'description', 'label']) if (!fields[k]) delete fields[k];
      if (!fields.color) delete fields.color;
      const startStr = allDay ? dkey(s) : tkey(s), endStr = allDay ? dkey(e) : tkey(e);
      if (scope === 'one') {
        const ev = structuredClone(base);
        // Keep only what differs from the series, so later series edits still apply.
        const over = { start: startStr, end: endStr };
        const prev = (ev.exceptions || {})[occ.key] || {};
        for (const k of ['title', 'allDay', 'place', 'description', 'label', 'color', 'reminders']) {
          const v = fields[k] === undefined ? null : fields[k];
          const b = base[k] === undefined ? null : base[k];
          if (JSON.stringify(v) !== JSON.stringify(b) || k in prev) over[k] = fields[k] === undefined ? null : fields[k];
        }
        ev.exceptions = { ...(ev.exceptions || {}), [occ.key]: over };
        this.store.saveEvent(ev);
        this.toast('Изменено только это событие серии');
      } else if (scope === 'all') {
        const ev = structuredClone(base);
        const [bs, be] = eventSpan(base);
        // Move the series by the same shift as this occurrence, keep its first date.
        const shift = s - occ.start, dur = e - s;
        const ns = new Date(bs.getTime() + shift);
        Object.assign(ev, fields, { repeat: rep, start: allDay ? dkey(ns) : tkey(ns), end: allDay ? dkey(new Date(ns.getTime() + dur)) : tkey(new Date(ns.getTime() + dur)) });
        if (!rep) delete ev.repeat;
        if (be && !ev.repeat) delete ev.exceptions;
        this.store.saveEvent(ev);
        this.toast('Изменения применены ко всей серии');
      } else {
        const ev = { ...structuredClone(base), ...fields, start: startStr, end: endStr };
        if (rep) ev.repeat = rep; else delete ev.repeat;
        if (!ev.color) delete ev.color;
        this.store.saveEvent(ev);
        this.toast(isNew ? 'Событие создано' : 'Событие сохранено');
      }
      this.closeModal();
      this.render();
    };
    const drawFooter = () => {
      const deleteBtn = !isNew ? btn('Удалить', () => { this.closeModal(); this.askDeleteFromEditor(base, occ); }, 'danger-text') : null;
      if (occ && base.repeat) {
        rc(footer, deleteBtn, el('span', { className: 'spacer' }), btn('Отмена', () => this.closeModal()),
          btn('Сохранить…', () => {
            const changed = repeatChanged();
            rc(footer, el('span', { textContent: changed ? 'Повтор изменён — применится ко всей серии.' : 'Применить изменения:' }), el('span', { className: 'spacer' }),
              changed ? null : btn('Только к этому', () => save('one')), btn('Ко всей серии', () => save('all'), 'primary'), btn('Назад', drawFooter));
          }, 'primary'));
      } else rc(footer, deleteBtn, el('span', { className: 'spacer' }), btn('Отмена', () => this.closeModal()), btn(isNew ? 'Создать' : 'Сохранить', () => save('plain'), 'primary'));
    };
    drawFooter();

    const form = el('div', { className: 'ce', role: 'dialog', 'aria-label': isNew ? 'Новое событие' : 'Изменить событие' },
      f.title,
      el('div', { className: 'ce-row' }, el('label', { className: 'ce-check' }, f.allDay, ' Весь день'), el('label', { className: 'ce-inline' }, 'Календарь ', f.cal)),
      el('div', { className: 'ce-row ce-when' }, f.sd, f.st, el('span', { textContent: '—' }), f.ed, f.et),
      el('div', { className: 'ce-row' }, el('span', { className: 'ce-label', textContent: 'Повтор' }), f.repeat),
      custom,
      el('div', { className: 'ce-block' }, el('span', { className: 'ce-label', textContent: 'Напоминания' }), remList, el('div', { className: 'ce-row' }, remAdd, remNum, remUnit, remOk)),
      f.place, f.desc,
      el('div', { className: 'ce-row' }, el('span', { className: 'ce-label', textContent: 'Цвет' }), colors),
      f.label,
      msg, footer);
    this.openModal(form);
    if (isNew) f.title.focus();
    f.title.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); footer.querySelector('.primary')?.click(); } });
  }

  askDeleteFromEditor(base, occ) {
    if (occ) { this.openCard(occ, this.body.querySelector(`[data-occ="${CSS.escape(base.id + '|' + occ.key)}"]`)); this.askDelete(occ, this.pop.querySelector('.pop-actions')); }
    else { this.store.deleteEvent(base.id); this.toast('Событие удалено'); this.render(); }
  }

  openModal(content) { rc(this.modal, content); this.modal.hidden = false; }
  closeModal() { this.modal.hidden = true; rc(this.modal, ); }

  // ---------- Calendar (category) settings ----------
  openCalSettings(id) {
    const conf = this.store.conf();
    const isNew = !id;
    const cal = isNew ? { id: newId(), name: '', color: COLORS[conf.calendars.length % COLORS.length], visible: true, reminders: [15], duration: 60 } : structuredClone(conf.calendars.find(c => c.id === id));
    const name = el('input', { id: 'ccName', placeholder: 'Название, например «Спорт»', value: cal.name, autocomplete: 'off' });
    const colors = el('div', { className: 'ce-colors' });
    const drawColors = () => rc(colors, ...COLORS.map(c => { const b = btn('', () => { cal.color = c; drawColors(); }, 'swatch' + (cal.color === c ? ' on' : '')); b.style.background = c; return b; }));
    drawColors();
    const dur = el('select', { id: 'ccDur' }, ...[[15, '15 минут'], [30, '30 минут'], [45, '45 минут'], [60, '1 час'], [90, '1,5 часа'], [120, '2 часа'], [180, '3 часа']].map(([v, t]) => el('option', { value: v, textContent: t, selected: cal.duration === v })));
    const primary = el('input', { type: 'checkbox', id: 'ccPrimary', checked: conf.primary === cal.id });
    const remList = el('div', { className: 'ce-rem-list' });
    const remAdd = el('select', { id: 'ccRemAdd' });
    const draw = () => {
      rc(remList, ...cal.reminders.slice().sort((a, b) => a - b).map(m => el('span', { className: 'ce-rem' }, '🔔 ' + reminderLabel(m), btn('×', () => { cal.reminders = cal.reminders.filter(x => x !== m); draw(); }, 'icon-text'))));
      if (!cal.reminders.length) remList.append(el('span', { className: 'muted', textContent: 'Без напоминаний' }));
      rc(remAdd, el('option', { value: '', textContent: '+ Добавить напоминание' }), ...REMIND_PRESETS.filter(([m]) => !cal.reminders.includes(m)).map(([m, t]) => el('option', { value: m, textContent: t })));
    };
    remAdd.addEventListener('change', () => { if (remAdd.value !== '') { cal.reminders.push(+remAdd.value); draw(); } });
    draw();
    const footer = el('div', { className: 'ce-footer' });
    const saveCal = () => {
      cal.name = name.value.trim() || 'Календарь';
      cal.duration = +dur.value;
      const cf = this.store.conf();
      const i = cf.calendars.findIndex(c => c.id === cal.id);
      if (i >= 0) cf.calendars[i] = cal; else cf.calendars.push(cal);
      if (primary.checked) cf.primary = cal.id;
      this.store.saveConf(cf);
      this.closeModal();
      this.render();
    };
    const drawFooter = () => rc(footer, 
      !isNew && conf.calendars.length > 1 ? btn('Удалить календарь', () => {
        const count = this.store.events().filter(e => e.calendar === cal.id).length;
        rc(footer, el('span', { textContent: count ? `Удалить календарь и его события (${count})?` : 'Удалить календарь?' }), el('span', { className: 'spacer' }),
          btn('Удалить', () => {
            for (const e of this.store.events().filter(x => x.calendar === cal.id)) this.store.deleteEvent(e.id);
            const cf = this.store.conf();
            cf.calendars = cf.calendars.filter(c => c.id !== cal.id);
            if (cf.primary === cal.id) cf.primary = cf.calendars[0].id;
            this.store.saveConf(cf);
            this.closeModal(); this.render();
            this.toast('Календарь удалён');
          }, 'danger-text'), btn('Отмена', drawFooter));
      }, 'danger-text') : null,
      el('span', { className: 'spacer' }), btn('Отмена', () => this.closeModal()), btn(isNew ? 'Создать' : 'Сохранить', saveCal, 'primary'));
    drawFooter();
    this.openModal(el('div', { className: 'ce', role: 'dialog', 'aria-label': 'Календарь' },
      el('h2', { textContent: isNew ? 'Новый календарь' : 'Настройки календаря' }),
      name,
      el('div', { className: 'ce-row' }, el('span', { className: 'ce-label', textContent: 'Цвет' }), colors),
      el('div', { className: 'ce-block' }, el('span', { className: 'ce-label', textContent: 'Напоминания для новых событий' }), remList, remAdd),
      el('div', { className: 'ce-row' }, el('span', { className: 'ce-label', textContent: 'Длительность нового события' }), dur),
      el('label', { className: 'ce-check' }, primary, ' Основной: новые события создаются в нём'),
      footer));
    name.focus();
  }

  // ---------- General settings ----------
  openSettings() {
    const conf = this.store.conf();
    const s = conf.settings;
    const weekStart = el('select', { id: 'csWeek' }, el('option', { value: 1, textContent: 'понедельника', selected: s.weekStart !== 7 }), el('option', { value: 7, textContent: 'воскресенья', selected: s.weekStart === 7 }));
    const weekends = el('input', { type: 'checkbox', id: 'csWeekends', checked: s.showWeekends });
    const hol = el('input', { type: 'checkbox', id: 'csHol', checked: s.holidays });
    const ws = el('input', { type: 'number', id: 'csWs', min: 0, max: 23, value: s.workStart });
    const we = el('input', { type: 'number', id: 'csWe', min: 1, max: 24, value: s.workEnd });
    const digest = el('input', { type: 'time', id: 'csDigest', value: s.digest });
    const allDayAt = el('input', { type: 'time', id: 'csAllDay', value: s.allDayAt });
    const perm = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
    const push = this.push;
    const pushOn = push && push.onHere();
    const notifStatus = el('p', { className: 'muted', textContent:
      pushOn ? 'Включены на этом устройстве: напоминания придут, даже если программа закрыта.'
        : perm === 'denied' ? 'Уведомления запрещены в настройках браузера для этого сайта. Разрешите их там, затем включите здесь.'
          : perm === 'unsupported' ? 'Этот браузер не умеет показывать уведомления.'
            : 'На этом устройстве уведомления выключены: напоминания приходят, только пока программа открыта.' });
    const pushMsg = el('p', { className: 'form-msg', role: 'status' });
    const serverInput = el('input', { id: 'csPushUrl', placeholder: 'https://notes-push.….workers.dev', value: push ? push.url() : '', autocomplete: 'off', spellcheck: false });
    const busy = async (b, fn) => {
      b.disabled = true; pushMsg.className = 'form-msg'; pushMsg.textContent = 'Подождите…';
      try { const r = await fn(); pushMsg.textContent = r || 'Готово.'; }
      catch (e) { pushMsg.className = 'form-msg bad'; pushMsg.textContent = e.message || String(e); }
      finally { b.disabled = false; }
    };
    const notifRow = el('div', { className: 'row' },
      push && !pushOn && perm !== 'unsupported' ? btn('Включить на этом устройстве', e => busy(e.currentTarget, async () => { await push.enable(serverInput.value); this.openSettings(); return null; }), 'primary') : null,
      pushOn ? btn('Проверить', e => busy(e.currentTarget, async () => { const r = await push.test(); return r.results?.some(x => x === 201) ? 'Отправлено. Уведомление должно прийти через несколько секунд.' : 'Сервер не смог отправить уведомление: ' + JSON.stringify(r.results); })) : null,
      pushOn ? btn('Выключить на этом устройстве', e => busy(e.currentTarget, async () => { await push.disable(); this.openSettings(); return null; }), 'danger-text') : null,
      !push && perm === 'default' ? btn('Разрешить уведомления', async () => { await Notification.requestPermission(); this.openSettings(); }, 'primary') : null);
    const serverRow = push && !push.url() ? el('label', { className: 'ce-block' }, el('span', { className: 'ce-label', textContent: 'Адрес сервера уведомлений' }), serverInput) : null;
    if (pushOn) push.status().then(st => { if (!pushMsg.textContent) pushMsg.textContent = `Устройств с уведомлениями: ${st.devices.length}. Запланировано напоминаний: ${st.scheduled}.` + (st.next ? ` Ближайшее: «${st.next.title}», ${new Date(st.next.at).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}.` : ''); }).catch(e => { pushMsg.className = 'form-msg bad'; pushMsg.textContent = e.message; });
    this.openModal(el('div', { className: 'ce', role: 'dialog', 'aria-label': 'Настройки календаря' },
      el('h2', { textContent: 'Настройки календаря' }),
      el('div', { className: 'ce-row' }, el('span', { className: 'ce-label', textContent: 'Неделя начинается с' }), weekStart),
      el('label', { className: 'ce-check' }, weekends, ' Показывать выходные в виде «Неделя»'),
      el('label', { className: 'ce-check' }, hol, ' Отмечать праздники России'),
      el('div', { className: 'ce-row' }, el('span', { className: 'ce-label', textContent: 'Рабочие часы' }), ws, el('span', { textContent: '—' }), we),
      el('div', { className: 'ce-row' }, el('span', { className: 'ce-label', textContent: 'Список дел на день приходит в' }), digest),
      el('div', { className: 'ce-row' }, el('span', { className: 'ce-label', textContent: 'Напоминания о событиях «весь день» считаются от' }), allDayAt),
      el('h2', { textContent: 'Уведомления' }),
      notifStatus,
      el('p', { className: 'muted small', textContent: 'Включите на каждом устройстве, где хотите получать напоминания (на Android — в программе, установленной на главный экран). Расписание обновляется с любого устройства, где вы меняете календарь.' }),
      serverRow,
      notifRow,
      pushMsg,
      el('div', { className: 'ce-footer' }, el('span', { className: 'spacer' }), btn('Отмена', () => this.closeModal()), btn('Сохранить', () => {
        const cf = this.store.conf();
        Object.assign(cf.settings, { weekStart: +weekStart.value, showWeekends: weekends.checked, holidays: hol.checked,
          workStart: Math.min(23, Math.max(0, +ws.value || 0)), workEnd: Math.min(24, Math.max(1, +we.value || 18)), digest: digest.value || '08:00', allDayAt: allDayAt.value || '09:00' });
        if (cf.settings.workEnd <= cf.settings.workStart) cf.settings.workEnd = Math.min(24, cf.settings.workStart + 1);
        this.store.saveConf(cf);
        this.closeModal(); this.render();
      }, 'primary'))));
  }

  // ---------- To-do lists ----------
  toggleTodo(id, done) {
    const t = this.store.todos();
    const it = t.items.find(i => i.id === id);
    if (!it) return;
    it.done = done;
    if (done) it.doneAt = new Date().toISOString(); else delete it.doneAt;
    this.store.saveTodos(t);
    this.render();
  }

  renderTodos() {
    this.todoPane.hidden = !this.todoOpen;
    if (!this.todoOpen) return;
    const t = this.store.todos();
    const today = dkey(new Date());
    const tab = this.todoTab || 'active';
    const tabs = el('div', { className: 'rp-tabs' }, ...[['active', 'Активные'], ['late', 'Просрочены'], ['done', 'Выполнены']].map(([k, n]) => {
      const count = k === 'late' ? t.items.filter(i => !i.done && i.due && i.due < today).length : 0;
      const b = btn(n + (count ? ` · ${count}` : ''), () => { this.todoTab = k; this.renderTodos(); });
      b.setAttribute('aria-selected', String(tab === k));
      return b;
    }));
    const wrap = el('div', { className: 'todo-lists' });
    for (const list of t.lists) {
      const items = t.items.filter(i => i.list === list.id && (tab === 'done' ? i.done : tab === 'late' ? !i.done && i.due && i.due < today : !i.done))
        .sort((a, b) => (a.due || '9999') < (b.due || '9999') ? -1 : (a.due || '9999') > (b.due || '9999') ? 1 : (a.order || 0) - (b.order || 0));
      const nameInput = el('input', { className: 'todo-list-name', value: list.name, 'aria-label': 'Название списка' });
      nameInput.addEventListener('change', () => { const tt = this.store.todos(); const l = tt.lists.find(x => x.id === list.id); if (l) { l.name = nameInput.value.trim() || 'Список'; this.store.saveTodos(tt); } });
      const head = el('div', { className: 'todo-list-head' }, nameInput,
        t.lists.length > 1 ? btn('🗑', () => {
          rc(head, el('span', { textContent: `Удалить «${list.name}» с делами?` }), btn('Удалить', () => { const tt = this.store.todos(); tt.lists = tt.lists.filter(l => l.id !== list.id); tt.items = tt.items.filter(i => i.list !== list.id); this.store.saveTodos(tt); this.renderTodos(); }, 'danger-text'), btn('Отмена', () => this.renderTodos()));
        }, 'icon-text', 'Удалить список') : null);
      const ul = el('div', { className: 'todo-items' });
      for (const it of items) {
        const box = el('input', { type: 'checkbox', checked: Boolean(it.done), 'aria-label': 'Выполнено' });
        box.addEventListener('change', () => this.toggleTodo(it.id, box.checked));
        const title = el('input', { className: 'todo-title', value: it.title, 'aria-label': 'Дело' });
        title.addEventListener('change', () => { const tt = this.store.todos(); const x = tt.items.find(i => i.id === it.id); if (x) { x.title = title.value.trim() || x.title; this.store.saveTodos(tt); } });
        const due = el('input', { type: 'date', className: 'todo-due' + (!it.done && it.due && it.due < today ? ' late' : ''), value: it.due || '', 'aria-label': 'Срок' });
        due.addEventListener('change', () => { const tt = this.store.todos(); const x = tt.items.find(i => i.id === it.id); if (x) { x.due = due.value || null; this.store.saveTodos(tt); this.render(); } });
        ul.append(el('div', { className: 'todo-item' + (it.done ? ' done' : '') }, box, title, due,
          btn('×', () => { const tt = this.store.todos(); tt.items = tt.items.filter(i => i.id !== it.id); this.store.saveTodos(tt); this.render(); }, 'icon-text', 'Удалить дело')));
      }
      if (!items.length) ul.append(el('p', { className: 'muted small', textContent: tab === 'done' ? 'Выполненных пока нет.' : tab === 'late' ? 'Просроченных нет.' : 'Дел нет.' }));
      const addTitle = el('input', { placeholder: 'Добавить дело…', className: 'todo-add', autocomplete: 'off' });
      const addDue = el('input', { type: 'date', className: 'todo-due', value: '' });
      const add = () => {
        const title = addTitle.value.trim();
        if (!title) return;
        const tt = this.store.todos();
        tt.items.push({ id: newId(), list: list.id, title, due: addDue.value || null, done: false, order: Date.now() });
        this.store.saveTodos(tt);
        this.render();
        requestAnimationFrame(() => this.todoPane.querySelector(`[data-list="${list.id}"] .todo-add`)?.focus());
      };
      addTitle.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
      const section = el('section', { className: 'todo-list' }, head, ul, tab === 'active' ? el('div', { className: 'todo-new' }, addTitle, addDue, btn('+', add, 'icon-text', 'Добавить')) : null);
      section.dataset.list = list.id;
      wrap.append(section);
    }
    rc(this.todoPane, 
      el('div', { className: 'todo-head' }, el('b', { textContent: 'Дела' }), btn('×', () => { this.todoOpen = false; prefsSet('todoOpen', false); this.render(); }, 'icon-text', 'Закрыть')),
      tabs, wrap,
      btn('+ Новый список', () => { const tt = this.store.todos(); tt.lists.push({ id: newId(), name: 'Новый список' }); this.store.saveTodos(tt); this.renderTodos(); }, 'todo-newlist'));
  }

  // ---------- .ics ----------
  exportIcs() {
    const blob = new Blob([toIcs(this.store)], { type: 'text/calendar;charset=utf-8' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `Календарь ${dkey(new Date())}.ics` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    this.toast('Календарь выгружен в файл .ics — его можно импортировать в Яндекс или Google Календарь.');
  }
  async importIcs(input) {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    const conf = this.store.conf();
    const events = fromIcs(await file.text(), conf.primary);
    if (!events.length) { this.toast('В файле не найдено событий.'); return; }
    for (const ev of events) this.store.saveEvent(ev);
    this.toast(`Импортировано событий: ${events.length} (в календарь «${this.store.calendar(conf.primary).name}»).`, 7000);
    this.render();
  }
}

// Side-by-side columns for overlapping events within one day.
function layoutColumns(segs) {
  segs.sort((a, b) => a.s - b.s || b.e - a.e);
  let cluster = [], colsEnd = [], clusterEnd = -1;
  const flush = () => { const n = colsEnd.length; for (const s of cluster) s.cols = n; };
  for (const s of segs) {
    if (s.s >= clusterEnd && cluster.length) { flush(); cluster = []; colsEnd = []; }
    let c = colsEnd.findIndex(e => e <= s.s);
    if (c < 0) { c = colsEnd.length; colsEnd.push(0); }
    colsEnd[c] = s.e;
    s.col = c;
    cluster.push(s);
    clusterEnd = Math.max(clusterEnd, s.e);
  }
  if (cluster.length) flush();
}
