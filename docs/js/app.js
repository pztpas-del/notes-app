import { Vault, basename, dirname, cleanTitle } from './vault.js';
import { render, slug } from './markdown.js';
import { GraphView } from './graph.js';
import { GitHubSync } from './sync.js';

const $ = id => document.getElementById(id);
const prefs = {
  get(key, fallback) {
    try { const v = localStorage.getItem('notes.' + key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) { try { localStorage.setItem('notes.' + key, JSON.stringify(value)); } catch { /* storage blocked */ } },
};
const el = (tag, props = {}, ...kids) => { const n = document.createElement(tag); Object.assign(n, props); n.append(...kids); return n; };
const plural = (n, one, few, many) => {
  const m = n % 10, h = n % 100;
  return m === 1 && h !== 11 ? one : m >= 2 && m <= 4 && (h < 12 || h > 14) ? few : many;
};

const vault = new Vault();
let settings = prefs.get('sync', {});
const sync = new GitHubSync(vault, () => settings);
let current = null;
let mode = prefs.get('mode', 'edit');
const collapsed = new Set(prefs.get('collapsed', []));
let syncState = { state: 'idle', at: null, error: '' };
let graph = null;
window.__notes = { vault, sync }; // handy for debugging from the browser console

// ---------- Views and routing ----------
const noteHash = p => '#note=' + encodeURIComponent(p);
function navigate(hash) { if (location.hash === hash) route(); else location.hash = hash; }

function showView(id, crumb) {
  for (const v of ['noteView', 'graphView', 'settingsView', 'emptyView']) $(v).hidden = v !== id;
  $('modeBtn').hidden = $('moreBtn').hidden = id !== 'noteView';
  if (id !== 'noteView') { current = null; closeSuggest(); }
  if (crumb !== undefined) $('crumb').textContent = crumb;
  if (graph) graph.show(id === 'graphView');
}

function route() {
  closeDrawer(); closeMenu();
  const h = location.hash;
  if (h.startsWith('#note=')) {
    const p = decodeURIComponent(h.slice(6));
    if (vault.get(p)) showNote(p);
    else showEmpty('Такой заметки нет на этом устройстве. Возможно, она ещё не пришла с GitHub.');
  } else if (h === '#graph') showGraph();
  else if (h === '#settings') showSettings();
  else {
    const last = prefs.get('last', null);
    if (last && vault.get(last)) location.replace(noteHash(last));
    else showEmpty();
  }
  renderTree();
}

function showEmpty(text) {
  showView('emptyView', '');
  $('emptyText').textContent = text || (vault.notes().length
    ? 'Выберите заметку в списке или создайте новую.'
    : 'Заметок пока нет. Создайте первую или подключите GitHub, чтобы получить заметки с других устройств.');
  $('emptySync').hidden = sync.configured();
}

// ---------- Note ----------
function showNote(path) {
  const switching = current !== path;
  showView('noteView');
  current = path;
  prefs.set('last', path);
  if (switching) { $('titleError').hidden = true; $('main').querySelector('#noteView').scrollTop = 0; }
  renderNote(switching);
}

function renderNote(switching = false) {
  const note = vault.get(current);
  if (!note) return;
  const title = $('title'), editor = $('editor');
  if (document.activeElement !== title || switching) title.value = basename(current);
  $('crumb').textContent = dirname(current).split('/').join(' / ');
  if (editor.value !== note.content) {
    const { selectionStart: s, selectionEnd: e } = editor;
    editor.value = note.content;
    if (!switching) editor.setSelectionRange(Math.min(s, note.content.length), Math.min(e, note.content.length));
  }
  const reading = mode === 'read';
  editor.parentElement.hidden = reading;
  $('preview').hidden = !reading;
  if (reading) $('preview').innerHTML = render(note.content, { resolve: t => vault.resolve(t) });
  else autosize();
  const btn = $('modeBtn');
  btn.title = reading ? 'Редактировать (Ctrl+E)' : 'Режим чтения (Ctrl+E)';
  btn.setAttribute('aria-label', btn.title);
  btn.innerHTML = reading
    ? '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M3 5.5C5.5 4 9 4 12 6c3-2 6.5-2 9-.5V19c-2.5-1.5-6-1.5-9 .5-3-2-6.5-2-9-.5z"/><path d="M12 6v13.5"/></svg>';
  renderBacklinks();
}

function renderBacklinks() {
  const box = $('backlinks');
  const list = vault.backlinks(current);
  box.replaceChildren(el('h2', { textContent: list.length ? `Ссылаются на эту заметку: ${list.length}` : 'На эту заметку пока никто не ссылается' }));
  for (const b of list) {
    const item = el('button', { type: 'button', className: 'item' },
      el('b', { textContent: basename(b.path) }),
      el('span', { textContent: b.lines[0].trim().replace(/^[-*+>#]+\s*/, '') }));
    item.addEventListener('click', () => navigate(noteHash(b.path)));
    box.append(item);
  }
}

function setMode(next, focus = true) {
  mode = next;
  prefs.set('mode', mode);
  renderNote();
  if (focus && mode === 'edit') $('editor').focus();
}

function autosize() {
  const ed = $('editor'), view = $('noteView');
  const keep = view.scrollTop;
  ed.style.height = 'auto';
  ed.style.height = ed.scrollHeight + 'px';
  view.scrollTop = keep;
}

function newNote(name = 'Без названия') {
  const p = vault.uniquePath('', name);
  vault.write(p, '');
  mode = 'edit'; prefs.set('mode', mode);
  navigate(noteHash(p));
  requestAnimationFrame(() => { $('title').focus(); $('title').select(); });
  scheduleSync();
}

function openOrCreate(target, heading) {
  if (!target) { scrollToHeading(heading); return; }
  const p = vault.resolve(target);
  if (p) {
    navigate(noteHash(p));
    if (heading) requestAnimationFrame(() => scrollToHeading(heading));
    return;
  }
  const clean = cleanTitle(target);
  if (!clean) return;
  const path = clean + '.md';
  vault.write(path, '');
  mode = 'edit'; prefs.set('mode', mode);
  navigate(noteHash(path));
  requestAnimationFrame(() => $('editor').focus());
  toast(`Создана заметка «${basename(path)}»`);
  scheduleSync();
}

function scrollToHeading(id) {
  if (!id) return;
  const target = $('preview').querySelector(`[id="${CSS.escape(id)}"]`);
  if (target && mode === 'read') target.scrollIntoView({ block: 'start' });
}

function renameCurrent() {
  if (!current) return;
  const title = $('title'), err = $('titleError');
  const clean = cleanTitle(title.value);
  if (!clean) { title.value = basename(current); return; }
  const next = clean.includes('/') ? clean + '.md' : (dirname(current) ? dirname(current) + '/' : '') + clean + '.md';
  if (next === current) { title.value = basename(current); return; }
  try {
    const p = vault.rename(current, next);
    err.hidden = true;
    current = p;
    location.replace(noteHash(p));
    scheduleSync();
  } catch (e) {
    err.textContent = e.message; err.hidden = false;
  }
}

function toggleTask(line) {
  const note = vault.get(current);
  if (!note) return;
  const lines = note.content.split('\n');
  if (lines[line] === undefined) return;
  lines[line] = lines[line].replace(/\[( |x|X)\]/, m => (m === '[ ]' ? '[x]' : '[ ]'));
  vault.write(current, lines.join('\n'));
  renderNote();
  scheduleSync();
}

// ---------- [[ suggestions and list editing ----------
let sug = { items: [], sel: 0, start: 0 };

function caretCoords(ta, pos) {
  const cs = getComputedStyle(ta);
  const div = document.createElement('div');
  for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'paddingTop', 'paddingLeft', 'paddingRight', 'tabSize']) div.style[p] = cs[p];
  Object.assign(div.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', width: ta.clientWidth + 'px', top: '0', left: '-9999px' });
  div.textContent = ta.value.slice(0, pos);
  const mark = el('span', { textContent: '​' });
  div.append(mark);
  document.body.append(div);
  const out = { top: mark.offsetTop, left: mark.offsetLeft, lh: parseFloat(cs.lineHeight) || 24 };
  div.remove();
  return out;
}

function updateSuggest() {
  const ed = $('editor');
  const pos = ed.selectionStart;
  if (pos !== ed.selectionEnd) return closeSuggest();
  const m = ed.value.slice(Math.max(0, pos - 120), pos).match(/\[\[([^[\]\n|#]*)$/);
  if (!m) return closeSuggest();
  const q = m[1].trim().toLowerCase();
  const names = vault.notes().filter(n => n.path !== current).map(n => ({ path: n.path, name: basename(n.path) }));
  let items = names.filter(x => x.name.toLowerCase().includes(q) || x.path.toLowerCase().includes(q))
    .sort((a, b) => (b.name.toLowerCase().startsWith(q) - a.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name, 'ru'))
    .slice(0, 8);
  if (q && !names.some(x => x.name.toLowerCase() === q)) items.push({ create: true, name: m[1].trim() });
  if (!items.length) return closeSuggest();
  sug = { items, sel: 0, start: pos - m[1].length };
  const list = $('suggest');
  list.replaceChildren(...items.map((it, i) => {
    const li = el('li', { role: 'option' }, it.create ? `Создать «${it.name}»` : it.name);
    if (!it.create && dirname(it.path)) li.append(el('small', { textContent: dirname(it.path) }));
    li.setAttribute('aria-selected', String(i === 0));
    li.addEventListener('mousedown', e => { e.preventDefault(); pickSuggest(i); });
    return li;
  }));
  const c = caretCoords(ed, pos);
  list.hidden = false;
  list.style.top = c.top + c.lh + 4 + 'px';
  list.style.left = Math.max(0, Math.min(c.left, ed.clientWidth - list.offsetWidth)) + 'px';
}
function closeSuggest() { $('suggest').hidden = true; sug.items = []; }
function moveSuggest(d) {
  sug.sel = (sug.sel + d + sug.items.length) % sug.items.length;
  [...$('suggest').children].forEach((li, i) => li.setAttribute('aria-selected', String(i === sug.sel)));
}
function pickSuggest(i) {
  const ed = $('editor'), it = sug.items[i];
  if (!it) return;
  let name = it.name;
  if (!it.create && vault.notes().filter(n => basename(n.path).toLowerCase() === name.toLowerCase()).length > 1) name = it.path.replace(/\.md$/i, '');
  const pos = ed.selectionStart;
  const hasClose = ed.value.slice(pos).startsWith(']]');
  ed.setRangeText(name + (hasClose ? '' : ']]'), sug.start, pos, 'end');
  if (hasClose) ed.selectionStart = ed.selectionEnd = ed.selectionEnd + 2;
  closeSuggest();
  ed.dispatchEvent(new Event('input'));
}

// Enter inside a list continues it; Enter on an empty item ends the list.
function continueList(ed) {
  const pos = ed.selectionStart;
  if (pos !== ed.selectionEnd) return false;
  const lineStart = ed.value.lastIndexOf('\n', pos - 1) + 1;
  const line = ed.value.slice(lineStart, pos);
  const m = line.match(/^(\s*)([-*+]|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?(.*)$/);
  if (!m) return false;
  if (!m[7].trim() && ed.value.slice(pos, ed.value.indexOf('\n', pos) === -1 ? undefined : ed.value.indexOf('\n', pos)).trim() === '') {
    ed.setRangeText('', lineStart, pos, 'end');
    return true;
  }
  const marker = m[3] ? `${Number(m[3]) + 1}${m[4]}` : m[2];
  ed.setRangeText(`\n${m[1]}${marker}${m[5]}${m[6] ? '[ ] ' : ''}`, pos, pos, 'end');
  return true;
}

function linkAtCaret(ed) {
  const pos = ed.selectionStart;
  const start = ed.value.lastIndexOf('\n', pos - 1) + 1;
  const end = ed.value.indexOf('\n', pos);
  const line = ed.value.slice(start, end === -1 ? undefined : end);
  for (const m of line.matchAll(/\[\[([^\]\n]+?)\]\]/g)) {
    if (pos >= start + m.index && pos <= start + m.index + m[0].length) return m[1];
  }
  return null;
}

// ---------- Sidebar ----------
function renderTree() {
  const box = $('tree');
  const q = $('search').value.trim().toLowerCase();
  const notes = vault.notes();
  box.replaceChildren();
  if (!notes.length) { box.append(el('p', { className: 'empty-hint', textContent: 'Заметок пока нет.' })); return; }

  if (q) {
    let hits;
    if (q.startsWith('#') && q.length > 1) {
      const set = vault.index().tags.get(q.slice(1));
      hits = notes.filter(n => set && set.has(n.path));
    } else hits = notes.filter(n => n.path.toLowerCase().includes(q) || n.content.toLowerCase().includes(q));
    hits.sort((a, b) => basename(a.path).localeCompare(basename(b.path), 'ru'));
    if (!hits.length) { box.append(el('p', { className: 'empty-hint', textContent: 'Ничего не найдено.' })); return; }
    for (const n of hits) {
      const at = n.content.toLowerCase().indexOf(q);
      const snippet = at >= 0 ? n.content.slice(Math.max(0, at - 30), at + 60).replace(/\s+/g, ' ') : dirname(n.path);
      const b = el('button', { type: 'button', className: 'hit' + (n.path === current ? ' active' : '') },
        el('span', { className: 'name', textContent: basename(n.path) }), el('small', { textContent: snippet }));
      b.addEventListener('click', () => navigate(noteHash(n.path)));
      box.append(b);
    }
    return;
  }

  const root = { folders: new Map(), notes: [] };
  for (const n of notes) {
    const parts = n.path.split('/');
    parts.pop();
    let node = root;
    for (const part of parts) {
      if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), notes: [] });
      node = node.folders.get(part);
    }
    node.notes.push(n);
  }
  const chevron = () => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 12 12'); s.classList.add('chev'); s.innerHTML = '<path d="M4 2.5l3.5 3.5L4 9.5" fill="none" stroke="currentColor" stroke-width="1.5"/>'; return s; };
  const draw = (node, prefix, parent) => {
    for (const [name, child] of [...node.folders].sort((a, b) => a[0].localeCompare(b[0], 'ru'))) {
      const path = prefix + name;
      const open = !collapsed.has(path);
      const b = el('button', { type: 'button', className: 'folder' + (open ? ' open' : '') }, chevron(), el('span', { className: 'name', textContent: name }));
      b.setAttribute('aria-expanded', String(open));
      const kids = el('div', { className: 'kids', hidden: !open });
      b.addEventListener('click', () => {
        if (collapsed.has(path)) collapsed.delete(path); else collapsed.add(path);
        prefs.set('collapsed', [...collapsed]);
        renderTree();
      });
      parent.append(b, kids);
      draw(child, path + '/', kids);
    }
    for (const n of node.notes.sort((a, b) => basename(a.path).localeCompare(basename(b.path), 'ru'))) {
      const b = el('button', { type: 'button', className: n.path === current ? 'active' : '' }, el('span', { className: 'name', textContent: basename(n.path) }));
      if (n.dirty && sync.configured()) b.append(el('span', { className: 'dot', title: 'Ещё не отправлено на GitHub' }));
      b.addEventListener('click', () => navigate(noteHash(n.path)));
      parent.append(b);
    }
  };
  draw(root, '', box);
}

function openDrawer() { $('app').classList.add('drawer'); $('backdrop').hidden = false; }
function closeDrawer() { $('app').classList.remove('drawer'); $('backdrop').hidden = true; }

// ---------- Note menu ----------
function closeMenu() { $('moreMenu').hidden = true; $('moreBtn').setAttribute('aria-expanded', 'false'); }
function openMenu() {
  const menu = $('moreMenu');
  const item = (text, fn, cls = '') => { const b = el('button', { type: 'button', textContent: text, className: cls }); b.addEventListener('click', fn); return b; };
  const name = basename(current);
  menu.replaceChildren(
    item('Новая заметка', () => { closeMenu(); newNote(); }),
    item('Показать на графе', () => { closeMenu(); navigate('#graph'); }),
    item('Удалить заметку', () => {
      menu.replaceChildren(
        el('p', { textContent: `Удалить «${name}»? После синхронизации она удалится и на других устройствах. На GitHub останется в истории изменений.` }),
        item('Удалить', () => {
          const p = current;
          closeMenu();
          vault.remove(p);
          prefs.set('last', null);
          navigate('');
          toast(`Заметка «${name}» удалена`);
          scheduleSync();
        }, 'danger'),
        item('Отмена', closeMenu));
    }, 'danger'));
  menu.hidden = false;
  $('moreBtn').setAttribute('aria-expanded', 'true');
}

// ---------- Graph ----------
function showGraph() {
  const focus = current || prefs.get('last', null);
  showView('graphView', 'Граф связей');
  if (!graph) graph = new GraphView($('graph'), { onOpen: n => (n.exists ? navigate(noteHash(n.id)) : openOrCreate(n.label)) });
  graph.show(true);
  updateGraph(focus);
}
function updateGraph(focus = prefs.get('last', null)) {
  const data = vault.graph($('showMissing').checked);
  graph.setData(data, focus);
  const n = data.nodes.filter(x => x.exists).length, e = data.edges.length;
  $('graphCount').textContent = `${n} ${plural(n, 'заметка', 'заметки', 'заметок')}, ${e} ${plural(e, 'связь', 'связи', 'связей')}`;
}

// ---------- Sync ----------
let syncTimer = null;
function scheduleSync(delay = 8000) {
  if (!sync.configured()) { renderSyncStatus(); return; }
  clearTimeout(syncTimer);
  syncTimer = setTimeout(runSync, delay);
}

async function runSync() {
  clearTimeout(syncTimer);
  if (!sync.configured() || !navigator.onLine) { renderSyncStatus(); return null; }
  syncState = { ...syncState, state: 'syncing' };
  renderSyncStatus();
  try {
    const r = await sync.sync();
    syncState = { state: 'ok', at: new Date(), error: '' };
    if (r.conflicts.length) {
      toast(`Заметку изменили и здесь, и на другом устройстве. Версия с другого устройства сохранена рядом: ${r.conflicts.map(basename).join(', ')}`, 10000);
    }
    return r;
  } catch (e) {
    syncState = { state: 'error', at: syncState.at, error: e.message || String(e) };
    return null;
  } finally {
    renderSyncStatus();
    renderTree();
  }
}

function renderSyncStatus() {
  const b = $('syncStatus');
  const pending = vault.pendingCount();
  let state = syncState.state, text;
  if (!sync.configured()) { state = 'off'; text = 'Синхронизация не настроена'; }
  else if (state === 'syncing') text = 'Синхронизация…';
  else if (state === 'error') text = 'Ошибка синхронизации';
  else if (!navigator.onLine) { state = 'off'; text = 'Нет сети'; }
  else if (syncState.at) text = 'Синхронизировано в ' + syncState.at.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  else text = 'Ждёт синхронизации';
  if (pending && sync.configured() && state !== 'syncing') text += ` · не отправлено: ${pending}`;
  b.dataset.state = state;
  b.textContent = text;
  b.title = syncState.error || 'Открыть настройки синхронизации';
}

// ---------- Settings ----------
function showSettings() {
  showView('settingsView', 'Настройки');
  $('sOwner').value = settings.owner || '';
  $('sRepo').value = settings.repo || '';
  $('sBranch').value = settings.branch || '';
  $('sToken').value = settings.token || '';
  $('sApi').value = settings.api || '';
  const msg = $('settingsMsg');
  if (syncState.state === 'error') { msg.textContent = syncState.error; msg.className = 'form-msg bad'; }
  else { msg.textContent = sync.configured() ? 'Синхронизация включена.' : ''; msg.className = 'form-msg'; }
}

function readForm() {
  let owner = $('sOwner').value.trim(), repo = $('sRepo').value.trim();
  const m = repo.match(/(?:github\.com\/)?([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  if (m && repo.includes('/')) { owner = owner || m[1]; repo = m[2]; }
  return { owner, repo, branch: $('sBranch').value.trim() || 'main', token: $('sToken').value.trim(), api: $('sApi').value.trim() };
}

async function saveSettings(e) {
  e.preventDefault();
  const msg = $('settingsMsg');
  const next = readForm();
  if (!next.owner || !next.repo || !next.token) {
    msg.textContent = 'Заполните имя пользователя, хранилище и токен.'; msg.className = 'form-msg bad'; return;
  }
  if (!next.api && !/^(github_pat_|gh[pousr]_)[A-Za-z0-9_]+$/.test(next.token)) {
    msg.textContent = 'В поле токена вставлено что-то другое. Токен начинается с github_pat_ и состоит из латинских букв и цифр. Скопируйте его на GitHub кнопкой копирования рядом с ним.';
    msg.className = 'form-msg bad';
    return;
  }
  const previous = settings;
  settings = next;
  msg.textContent = 'Проверяю подключение…'; msg.className = 'form-msg';
  try {
    await sync.test();
  } catch (err) {
    settings = previous;
    msg.textContent = err.message; msg.className = 'form-msg bad';
    return;
  }
  prefs.set('sync', settings);
  msg.textContent = 'Подключено. Синхронизирую…';
  await syncAndReport();
}

async function syncAndReport() {
  const msg = $('settingsMsg');
  const r = await runSync();
  if (!r) { msg.textContent = syncState.error || 'Нет сети.'; msg.className = 'form-msg bad'; return; }
  msg.className = 'form-msg';
  msg.textContent = `Готово. Получено изменений: ${r.pulled}, отправлено: ${r.pushed}.` +
    (r.conflicts.length ? ` Конфликтов: ${r.conflicts.length}, копии сохранены рядом с заметками.` : '');
}

// ---------- Misc ----------
let toastTimer = null;
function toast(text, ms = 5000) {
  const t = $('toast');
  t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

let refreshTimer = null;
vault.onChange(() => {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    renderTree();
    renderSyncStatus();
    if (current) {
      if (!vault.get(current)) route();
      else renderNote();
    }
    if (!$('graphView').hidden && graph) updateGraph();
  }, 150);
});

function bind() {
  window.addEventListener('hashchange', route);
  $('newNote').addEventListener('click', () => newNote());
  $('openGraph').addEventListener('click', () => navigate('#graph'));
  $('openSettings').addEventListener('click', () => navigate('#settings'));
  $('syncStatus').addEventListener('click', () => navigate('#settings'));
  $('menuBtn').addEventListener('click', openDrawer);
  $('backdrop').addEventListener('click', closeDrawer);
  $('emptyNew').addEventListener('click', () => newNote());
  $('emptySync').addEventListener('click', () => navigate('#settings'));
  $('search').addEventListener('input', renderTree);
  $('modeBtn').addEventListener('click', () => setMode(mode === 'read' ? 'edit' : 'read'));
  $('moreBtn').addEventListener('click', e => { e.stopPropagation(); if ($('moreMenu').hidden) openMenu(); else closeMenu(); });
  document.addEventListener('click', e => { if (!e.target.closest('.menu-wrap')) closeMenu(); });
  $('showMissing').addEventListener('change', () => updateGraph());
  $('syncForm').addEventListener('submit', saveSettings);
  $('syncNow').addEventListener('click', () => {
    if (!sync.configured()) { $('settingsMsg').textContent = 'Сначала сохраните настройки.'; $('settingsMsg').className = 'form-msg bad'; return; }
    $('settingsMsg').textContent = 'Синхронизирую…'; $('settingsMsg').className = 'form-msg';
    syncAndReport();
  });
  $('disconnect').addEventListener('click', () => {
    settings = {}; prefs.set('sync', {});
    syncState = { state: 'idle', at: null, error: '' };
    showSettings();
    $('settingsMsg').textContent = 'Синхронизация отключена. Заметки остались на этом устройстве.';
    renderSyncStatus(); renderTree();
  });

  const title = $('title');
  title.addEventListener('change', renameCurrent);
  title.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); renameCurrent(); if (mode === 'edit') $('editor').focus(); }
    if (e.key === 'Escape') { title.value = basename(current); title.blur(); }
  });

  const ed = $('editor');
  ed.addEventListener('input', () => {
    if (!current) return;
    vault.write(current, ed.value);
    autosize();
    updateSuggest();
    scheduleSync();
  });
  ed.addEventListener('keydown', e => {
    if (sug.items.length && !$('suggest').hidden) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveSuggest(1); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); moveSuggest(-1); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickSuggest(sug.sel); return; }
      if (e.key === 'Escape') { e.preventDefault(); closeSuggest(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && !e.isComposing) {
      if (continueList(ed)) { e.preventDefault(); ed.dispatchEvent(new Event('input')); }
    } else if (e.key === 'Tab' && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      ed.setRangeText('\t', ed.selectionStart, ed.selectionEnd, 'end');
      ed.dispatchEvent(new Event('input'));
    }
  });
  ed.addEventListener('click', e => {
    if (e.ctrlKey || e.metaKey) {
      const link = linkAtCaret(ed);
      if (link) { const [t, h] = link.split('|')[0].split('#'); openOrCreate(t.trim(), h ? slug(h) : ''); }
    }
    updateSuggest();
  });
  ed.addEventListener('blur', () => setTimeout(closeSuggest, 100));

  $('preview').addEventListener('click', e => {
    const box = e.target.closest('input[type="checkbox"][data-line]');
    if (box) { toggleTask(Number(box.dataset.line)); return; }
    const a = e.target.closest('a');
    if (!a) return;
    if (a.classList.contains('wikilink')) { e.preventDefault(); openOrCreate(a.dataset.target, a.dataset.heading); }
    else if (a.classList.contains('tag')) { e.preventDefault(); $('search').value = '#' + a.dataset.tag; renderTree(); openDrawer(); }
  });

  document.addEventListener('keydown', e => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'e' && current) { e.preventDefault(); setMode(mode === 'read' ? 'edit' : 'read'); }
    else if (mod && e.key.toLowerCase() === 'g') { e.preventDefault(); navigate('#graph'); }
    else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); runSync(); }
    else if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); openDrawer(); $('search').focus(); $('search').select(); }
    else if (e.altKey && e.key.toLowerCase() === 'n') { e.preventDefault(); newNote(); }
  });

  window.addEventListener('online', () => runSync());
  window.addEventListener('offline', renderSyncStatus);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') runSync();
    else { vault.flush(); if (vault.pendingCount()) runSync(); }
  });
  window.addEventListener('pagehide', () => vault.flush());
  window.addEventListener('resize', () => { if (current && mode === 'edit') autosize(); });
}

async function init() {
  bind();
  try {
    await vault.load();
  } catch {
    toast('Браузер не дал сохранять заметки на этом устройстве. Проверьте, что сайту разрешено хранить данные.', 10000);
  }
  route();
  renderSyncStatus();
  runSync();
  setInterval(() => { if (document.visibilityState === 'visible') runSync(); }, 60000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
init();
