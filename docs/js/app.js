import { Vault, basename, filename, dirname, cleanTitle, isNote, IMAGE_RE, ATTACH_DIR } from './vault.js';
import { render } from './markdown.js';
import { GraphView } from './graph.js';
import { GitHubSync } from './sync.js';
import { createEditor } from './editor.js';
import { SchemaView } from './schema.js';
import { YaDisk } from './yadisk.js';
import { MediaStore } from './media.js';
import { CalendarView } from './calendar.js';
import { PushClient } from './push.js';
import { NativeReminders, isNativeApp } from './native.js';
import { openEditMenuAt, showMenu } from './editmenu.js';
import { LinkFinder, addSeeAlso, DEFAULT_MIN } from './links-ai.js';
import { GoalsView } from './goals.js';

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
// Pictures and files live on Yandex Disk and come down only when shown.
const ya = new YaDisk();
const media = new MediaStore(ya, () => vault.changed());
vault.media = media;
let yaState = { error: '', info: null, moving: false };
let current = null;
let currentFile = null;
let mode = prefs.get('mode', 'edit');
const collapsed = new Set(prefs.get('collapsed', []));
let syncState = { state: 'idle', at: null, error: '' };
let graph = null;
const ed = createEditor($('editor'), {
  onChange(text) {
    if (!current) return;
    vault.write(current, text);
    scheduleSync();
    scheduleAutoLinks(); // only does something in the automatic mode
  },
  resolveNote: t => vault.resolve(t),
  fileUrl: name => vault.fileUrl(name),
  openLink: (target, heading) => openOrCreate(target, heading),
  openFile: name => { const p = vault.resolveFile(name); if (p) navigate(fileHash(p)); },
  openTag: tag => { $('search').value = '#' + tag; renderTree(); openDrawer(); },
  linkTargets(embed) {
    const notes = vault.notes().filter(n => n.path !== current).map(n => {
      const name = basename(n.path);
      const twin = vault.notes().some(o => o !== n && basename(o.path).toLowerCase() === name.toLowerCase());
      return { name, detail: dirname(n.path), insert: twin ? n.path.replace(/\.md$/i, '') : name };
    });
    const files = vault.attachments().map(f => ({ name: filename(f.path), detail: dirname(f.path), insert: filename(f.path), file: true }));
    return embed ? [...files, ...notes] : [...notes, ...files];
  },
  saveFiles: files => saveFiles(files),
});
window.__notes = { vault, sync, ed }; // handy for debugging from the browser console

// ---------- Views and routing ----------
const noteHash = p => '#note=' + encodeURIComponent(p);
const fileHash = p => '#file=' + encodeURIComponent(p);
function navigate(hash) { if (location.hash === hash) route(); else location.hash = hash; }

function showView(id, crumb) {
  for (const v of ['noteView', 'fileView', 'graphView', 'schemaView', 'calendarView', 'goalsView', 'settingsView', 'emptyView']) $(v).hidden = v !== id;
  if (id !== 'goalsView') goals.hide();
  $('openGoals').classList.toggle('on', id === 'goalsView');
  $('modeBtn').hidden = $('moreBtn').hidden = $('attachBtn').hidden = $('panelBtn').hidden = id !== 'noteView';
  $('formatBtn').hidden = id !== 'noteView' || mode === 'read';
  if (id !== 'noteView') current = null;
  if (id !== 'fileView') currentFile = null;
  if (crumb !== undefined) $('crumb').textContent = crumb;
  if (graph) graph.show(id === 'graphView');
  if (schema && id !== 'schemaView') schema.hide();
  if (id !== 'calendarView') calendar.hide();
  $('openCalendar').classList.toggle('on', id === 'calendarView');
  if (id !== 'noteView') renderPanel();
}

function route() {
  closeDrawer(); closeMenu();
  const h = location.hash;
  if (h.startsWith('#note=')) {
    const p = decodeURIComponent(h.slice(6));
    if (vault.get(p)) showNote(p);
    else showEmpty('Такой заметки нет на этом устройстве. Возможно, она ещё не пришла с GitHub.');
  } else if (h.startsWith('#file=')) {
    const p = decodeURIComponent(h.slice(6));
    if (vault.hasFile(p)) showFile(p);
    else showEmpty('Такого файла нет на этом устройстве. Возможно, он ещё не пришёл с GitHub.');
  } else if (h === '#graph') showGraph();
  else if (h === '#schema' || h.startsWith('#schema=')) showSchema(h.startsWith('#schema=') ? decodeURIComponent(h.slice(8)) : null);
  else if (h === '#calendar' || h.startsWith('#calendar=')) showCalendar(h.startsWith('#calendar=') ? decodeURIComponent(h.slice(10)) : null);
  else if (h === '#goals') { showView('goalsView', 'Цели и привычки'); goals.show(); }
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
  renderPanel(switching);
}

function renderNote(switching = false) {
  const note = vault.get(current);
  if (!note) return;
  const title = $('title');
  if (document.activeElement !== title || switching) title.value = basename(current);
  $('crumb').textContent = dirname(current).split('/').join(' / ');
  if (switching) { ed.load(note.content); linkSig = vaultSignature(); }
  else {
    ed.setDoc(note.content);
    const sig = vaultSignature();
    if (sig !== linkSig) { linkSig = sig; ed.refresh(); }
  }
  const reading = mode === 'read';
  $('formatBtn').hidden = reading;
  $('editor').hidden = reading;
  $('preview').hidden = !reading;
  if (reading) $('preview').innerHTML = render(note.content, { resolve: t => vault.resolve(t), fileUrl: n => vault.fileUrl(n) });
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
  const rel = vault.schemaRelations(current);
  if (rel.parents.length || rel.children.length) {
    const row = (label, paths) => {
      if (!paths.length) return null;
      const line = el('div', { className: 'schema-rel' }, el('span', { className: 'muted', textContent: label }));
      for (const p of paths) {
        const a = el('button', { type: 'button', className: 'chip', textContent: basename(p) });
        a.addEventListener('click', () => navigate(noteHash(p)));
        line.append(a);
      }
      return line;
    };
    const open = el('button', { type: 'button', className: 'link-btn', textContent: 'Открыть на схеме' });
    open.addEventListener('click', () => navigate('#schema=' + encodeURIComponent(current)));
    box.append(el('h2', { textContent: 'В блок-схеме' }), ...[row('Выше:', rel.parents), row('Ниже:', rel.children)].filter(Boolean), open);
  }
}

function setMode(next, focus = true) {
  mode = next;
  prefs.set('mode', mode);
  renderNote();
  if (focus && mode === 'edit') ed.focus();
}

// Which notes and files exist; when it changes, links and images in the editor are redrawn.
let linkSig = '';
function vaultSignature() {
  return vault.notes().map(n => n.path).sort().join('\n') + '\n|\n' +
    vault.attachments().map(f => f.path + ':' + f.size).sort().join('\n') + '\n' + media.version;
}

// ---------- Attachments ----------
const pad2 = n => String(n).padStart(2, '0');
function stamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}
const blobToBase64 = blob => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1] || '');
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

// Photos from a phone are big: shrink to at most 2000 px and save as JPEG.
// Small PNG screenshots stay PNG so text in them stays sharp.
async function shrinkImage(file) {
  if (!/^image\/(jpeg|png|webp|heic|heif|bmp)$/i.test(file.type)) return null;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    const keepPng = file.type === 'image/png' && file.size < 1.5e6 && scale === 1;
    if (keepPng || (scale === 1 && file.size < 1e6 && file.type === 'image/jpeg')) return null;
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
    return blob ? { blob, ext: 'jpg' } : null;
  } catch {
    return null;
  }
}

// Saves files into the attachments folder and returns ![[...]] lines to insert.
async function saveFiles(files) {
  const out = [];
  for (const file of files) {
    let blob = file;
    let ext = (file.name.match(/\.([^.]+)$/)?.[1] || (file.type.split('/')[1] || 'bin')).toLowerCase().replace('jpeg', 'jpg');
    const shrunk = await shrinkImage(file);
    if (shrunk) { blob = shrunk.blob; ext = shrunk.ext; }
    if (blob.size > 25 * 1024 * 1024) { toast(`Файл «${file.name}» больше 25 МБ, такие не сохраняются.`, 8000); continue; }
    let stem = cleanTitle(file.name.replace(/\.[^.]+$/, '')).replace(/\//g, ' ');
    if (!stem || /^(image|img|photo|screenshot|изображение)$/i.test(stem) || /^(IMG|PXL|DSC)[_-]?\d/i.test(stem)) {
      stem = (file.type.startsWith('image/') ? 'Изображение ' : 'Файл ') + stamp();
    }
    const path = vault.uniquePath(ATTACH_DIR, stem, '.' + ext);
    await media.put(path, blob);
    const twin = vault.attachments().some(f => f.path !== path && filename(f.path).toLowerCase() === filename(path).toLowerCase());
    out.push(`![[${twin ? path : filename(path)}]]`);
  }
  if (out.length) {
    scheduleSync();
    if (!ya.connected()) toast('Файлы сохранены на этом устройстве. Подключите Яндекс Диск в настройках, чтобы они загрузились туда и появились на других устройствах.', 9000);
  }
  return out;
}

let fileViewUrl = null;
function refreshFileView() {
  // The file finished downloading: put it on screen.
  if (vault.fileUrl(currentFile) !== fileViewUrl) showFile(currentFile);
}

function showFile(path) {
  showView('fileView', dirname(path).split('/').join(' / '));
  currentFile = path;
  const info = vault.attachments().find(a => a.path === path) || { size: 0, legacy: true };
  const box = $('fileBody');
  const url = vault.fileUrl(path);
  fileViewUrl = url;
  const size = Math.round(info.size / 1024);
  const name = filename(path);
  const where = info.legacy ? 'в GitHub, ещё не перенесён на Яндекс Диск' : info.dirty ? 'ждёт загрузки на Яндекс Диск' : 'на Яндекс Диске';
  const using = vault.notes().filter(n => n.content.includes(name)).map(n => n.path);
  box.replaceChildren(
    el('h1', { className: 'file-title', textContent: name }),
    el('p', { className: 'muted', textContent: `${size > 1024 ? (size / 1024).toFixed(1) + ' МБ' : size + ' КБ'} · ${where}` }));
  const ready = url && !url.startsWith('data:');
  if (IMAGE_RE.test(path)) box.append(el('img', { className: 'file-preview', src: url || '', alt: name }));
  else if (/\.(mp4|webm)$/i.test(path) && ready) box.append(el('video', { className: 'file-preview', src: url, controls: true }));
  else if (/\.(mp3|m4a|ogg|wav)$/i.test(path) && ready) box.append(el('audio', { src: url, controls: true }));
  else if (ready) box.append(el('p', {}, el('a', { href: url, target: '_blank', rel: 'noopener', textContent: 'Открыть файл' })));
  else box.append(el('p', { className: 'muted', textContent: url ? 'Файл загружается с Яндекс Диска…' : 'Файл недоступен.' }));
  if (using.length) {
    const list = el('div', { className: 'backlinks' }, el('h2', { textContent: 'Используется в заметках' }));
    for (const p of using) {
      const b = el('button', { type: 'button', className: 'item' }, el('b', { textContent: basename(p) }));
      b.addEventListener('click', () => navigate(noteHash(p)));
      list.append(b);
    }
    box.append(list);
  }
  const actions = el('div', { className: 'row file-actions' });
  const del = el('button', { type: 'button', className: 'danger-text', textContent: 'Удалить файл' });
  del.addEventListener('click', () => {
    actions.replaceChildren(
      el('span', { textContent: using.length ? `Файл используется в заметках (${using.length}). Удалить всё равно?` : 'Удалить файл? Он пропадёт на всех устройствах, а на Яндекс Диске попадёт в корзину.' }),
      Object.assign(el('button', { type: 'button', className: 'danger-text', textContent: 'Удалить' }), {
        onclick: async () => {
          try {
            if (info.legacy) vault.remove(path); else await media.remove(path);
            toast(`Файл «${name}» удалён. На Яндекс Диске он лежит в корзине.`);
            scheduleSync();
            history.back();
          } catch (e) { toast(e.message, 7000); }
        },
      }),
      Object.assign(el('button', { type: 'button', textContent: 'Отмена' }), { onclick: () => showFile(path) }));
  });
  actions.append(del);
  box.append(actions);
}


function newNote(name = 'Без названия', dir = '') {
  const p = vault.uniquePath(dir, name);
  vault.write(p, '');
  // A note made in a linked folder goes below that folder on the flowchart.
  if (dir && vault.placeNewNote(p)) toast(`Заметка добавлена на блок-схему под папкой «${dir.split('/').pop()}»`);
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
  requestAnimationFrame(() => ed.focus());
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

// ---------- Sidebar ----------
function renderTree() {
  const box = $('tree');
  const q = $('search').value.trim().toLowerCase();
  const notes = vault.notes();
  box.replaceChildren();
  if (!notes.length && !vault.folderConf().folders.length) { box.append(el('p', { className: 'empty-hint', textContent: 'Заметок пока нет.' })); return; }

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
  const folderOf = parts => {
    let node = root;
    for (const part of parts) {
      if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), notes: [] });
      node = node.folders.get(part);
    }
    return node;
  };
  for (const n of [...notes, ...vault.attachments()]) folderOf(n.path.split('/').slice(0, -1)).notes.push(n);
  for (const f of vault.folderConf().folders) folderOf(f.split('/')); // empty folders made by hand
  const chevron = () => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 12 12'); s.classList.add('chev'); s.innerHTML = '<path d="M4 2.5l3.5 3.5L4 9.5" fill="none" stroke="currentColor" stroke-width="1.5"/>'; return s; };
  const draw = (node, prefix, parent) => {
    const dir = prefix.replace(/\/$/, '');
    const folderNames = vault.sortNames(dir, [...node.folders.keys()]);
    for (const [name, child] of folderNames.map(n => [n, node.folders.get(n)])) {
      const path = prefix + name;
      const open = !collapsed.has(path);
      const kids = el('div', { className: 'kids', hidden: !open });
      if (path === renamingFolder) {
        // Typing a name for a new or renamed folder, right in the list.
        const input = el('input', { className: 'folder-rename', value: name, 'aria-label': 'Название папки' });
        let done = false;
        const finish = ok => { if (done) return; done = true; renamingFolder = null; if (ok) renameFolder(path, input.value); else renderTree(); };
        input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') finish(false); });
        input.addEventListener('blur', () => finish(true));
        parent.append(input, kids);
        requestAnimationFrame(() => { input.focus(); input.select(); });
        draw(child, path + '/', kids);
        continue;
      }
      const linked = path !== ATTACH_DIR && vault.folderLinked(path);
      const b = el('button', { type: 'button', className: 'folder' + (open ? ' open' : ''), title: linked ? 'Новые заметки этой папки встают под ней на блок-схеме' : '' },
        chevron(), el('span', { className: 'name', textContent: name }), linked ? el('span', { className: 'folder-linked', textContent: '⤵', 'aria-label': 'привязана к блок-схеме' }) : '');
      b.setAttribute('aria-expanded', String(open));
      b.addEventListener('click', () => {
        if (collapsed.has(path)) collapsed.delete(path); else collapsed.add(path);
        prefs.set('collapsed', [...collapsed]);
        renderTree();
      });
      if (path !== ATTACH_DIR) {
        b.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); folderMenu(path, e.clientX, e.clientY); });
        Object.assign(b.dataset, { kind: 'folder', path });
        b.draggable = true;
      }
      parent.append(b, kids);
      draw(child, path + '/', kids);
    }
    // Notes in the hand-made order, then pictures and files alphabetically.
    const byName = new Map(node.notes.filter(n => isNote(n.path)).map(n => [filename(n.path), n]));
    const files = node.notes.filter(n => !isNote(n.path)).sort((a, b) => filename(a.path).localeCompare(filename(b.path), 'ru'));
    for (const n of [...vault.sortNames(dir, [...byName.keys()]).map(k => byName.get(k)), ...files]) {
      const note = isNote(n.path);
      const b = el('button', { type: 'button', className: (n.path === current || n.path === currentFile ? 'active' : '') + (note ? '' : ' attachment') },
        el('span', { className: 'name', textContent: note ? basename(n.path) : filename(n.path) }));
      if (n.dirty && sync.configured()) b.append(el('span', { className: 'dot', title: 'Ещё не отправлено на GitHub' }));
      b.addEventListener('click', () => navigate(note ? noteHash(n.path) : fileHash(n.path)));
      if (note) {
        b.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); noteMenu(n.path, e.clientX, e.clientY); });
        Object.assign(b.dataset, { kind: 'note', path: n.path });
        b.draggable = true;
      }
      parent.append(b);
    }
  };
  draw(root, '', box);
}

// ---------- Folders ----------
let renamingFolder = null;
function newFolder(parentDir = '') {
  const taken = new Set(vault.folders().map(f => f.toLowerCase()));
  let path;
  for (let i = 1; ; i++) { path = (parentDir ? parentDir + '/' : '') + 'Новая папка' + (i > 1 ? ' ' + i : ''); if (!taken.has(path.toLowerCase())) break; }
  vault.createFolder(path);
  if (parentDir) { collapsed.delete(parentDir); prefs.set('collapsed', [...collapsed]); }
  renamingFolder = path;
  openDrawer();
  renderTree();
  scheduleSync();
}
function renameFolder(path, typed) {
  const name = cleanTitle(String(typed).replace(/\//g, ' '));
  const parentDir = dirname(path);
  const next = name ? (parentDir ? parentDir + '/' : '') + name : path;
  if (next === path) { renderTree(); return; }
  try { moveFolder(path, next); scheduleSync(); } catch (e) { toast(e.message, 6000); }
  renderTree();
}
// Moves or renames a folder with everything in it; the open note and folded folders follow.
function moveFolder(from, to) {
  vault.renameFolder(from, to);
  if (current && current.startsWith(from + '/')) { current = to + current.slice(from.length); location.replace(noteHash(current)); }
  for (const c of [...collapsed]) if (c === from || c.startsWith(from + '/')) { collapsed.delete(c); collapsed.add(to + c.slice(from.length)); }
  prefs.set('collapsed', [...collapsed]);
}

// ---------- Moving notes and folders (drag and drop, or the menu) ----------
// Names in a folder, as shown: kind 'folder' or 'note'.
function groupNames(dir, kind) {
  if (kind === 'note') return vault.sortNames(dir, vault.notes().filter(n => dirname(n.path) === dir).map(n => filename(n.path)));
  return vault.sortNames(dir, vault.folders().filter(f => dirname(f) === dir).map(f => f.split('/').pop()));
}
// Moves a note or folder into newDir ('' = top level). ref = { name, after }: put it next to that item.
function moveItem(kind, path, newDir, ref = null) {
  const name = path.split('/').pop();
  const oldDir = dirname(path);
  const target = (newDir ? newDir + '/' : '') + name;
  if (kind === 'folder' && (newDir === path || newDir.startsWith(path + '/'))) { toast('Папку нельзя положить в саму себя.'); return; }
  try {
    if (target !== path) {
      if (kind === 'note') {
        const p = vault.rename(path, target);
        if (current === path) { current = p; location.replace(noteHash(p)); }
      } else moveFolder(path, target);
    }
  } catch (e) { toast(e.message, 6000); renderTree(); return; }
  // Its place among the others in that folder.
  const list = groupNames(newDir, kind).filter(n => n !== name);
  let at = list.length;
  if (ref) { const i = list.indexOf(ref.name); if (i >= 0) at = i + (ref.after ? 1 : 0); }
  list.splice(at, 0, name);
  vault.setOrder(newDir, kind === 'note' ? [...groupNames(newDir, 'folder'), ...list] : [...list, ...groupNames(newDir, 'note')]);
  if (newDir && collapsed.has(newDir)) { collapsed.delete(newDir); prefs.set('collapsed', [...collapsed]); }
  if (newDir !== oldDir) toast(`«${kind === 'note' ? basename(path) : name}» перемещена ${newDir ? `в «${newDir.split('/').pop()}»` : 'из папки на верхний уровень'}`);
  renderTree();
  scheduleSync();
}
// One place up (-1) or down (+1) among the notes or folders of the same folder.
function moveStep(kind, path, delta) {
  const dir = dirname(path), name = path.split('/').pop();
  const list = groupNames(dir, kind);
  const i = list.indexOf(name), j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  vault.setOrder(dir, kind === 'note' ? [...groupNames(dir, 'folder'), ...list] : [...list, ...groupNames(dir, 'note')]);
  renderTree();
  scheduleSync();
}
// "Переместить в ▸": the top level and every folder (a folder cannot go into itself).
function moveTargets(kind, path) {
  const here = dirname(path);
  const folders = vault.folders().filter(f => f !== here && !(kind === 'folder' && (f === path || f.startsWith(path + '/'))));
  return [
    here ? { label: 'Без папки (верхний уровень)', icon: '⤒', run: () => moveItem(kind, path, '') } : null,
    ...folders.map(f => ({ label: f.split('/').join(' / '), icon: '📁', run: () => moveItem(kind, path, f) })),
  ].filter(Boolean);
}
function confirmDelete(text, onYes, x, y) {
  showMenu([
    { label: text, disabled: true },
    { label: 'Удалить', icon: '🗑', run: onYes },
    { label: 'Отмена', run: () => {} },
  ], x, y);
}
function noteMenu(path, x, y) {
  const name = basename(path);
  const targets = moveTargets('note', path);
  showMenu([
    { label: 'Открыть', run: () => navigate(noteHash(path)) },
    { label: 'Переименовать', run: () => { navigate(noteHash(path)); requestAnimationFrame(() => { $('title').focus(); $('title').select(); }); } },
    { label: 'Переместить в', icon: '↪', disabled: !targets.length, sub: targets },
    { label: 'Выше', icon: '↑', run: () => moveStep('note', path, -1) },
    { label: 'Ниже', icon: '↓', run: () => moveStep('note', path, 1) },
    'sep',
    { label: 'Показать на графе', run: () => { navigate(noteHash(path)); navigate('#graph'); } },
    { label: 'Показать на блок-схеме', run: () => navigate('#schema=' + encodeURIComponent(path)) },
    'sep',
    { label: 'Удалить…', icon: '🗑', run: () => confirmDelete(`Удалить «${name}»?`, () => deleteNote(path), x, y) },
  ], x, y);
}
function folderMenu(path, x, y) {
  const name = path.split('/').pop();
  const count = vault.notesIn(path).length;
  const linked = vault.folderLinked(path);
  showMenu([
    { label: 'Новая заметка', icon: '+', run: () => newNote('Без названия', path) },
    { label: 'Новая папка', icon: '📁', run: () => newFolder(path) },
    'sep',
    { label: 'Переименовать', run: () => { renamingFolder = path; renderTree(); } },
    { label: 'Переместить в', icon: '↪', disabled: !moveTargets('folder', path).length, sub: moveTargets('folder', path) },
    { label: 'Выше', icon: '↑', run: () => moveStep('folder', path, -1) },
    { label: 'Ниже', icon: '↓', run: () => moveStep('folder', path, 1) },
    { label: 'Удалить папку…', icon: '🗑', run: () => confirmDelete(count ? `Удалить «${name}» и заметок в ней: ${count}?` : `Удалить пустую папку «${name}»?`, () => {
      vault.deleteFolder(path);
      if (current && current.startsWith(path + '/')) navigate('');
      toast(count ? `Папка «${name}» удалена вместе с заметками. На GitHub они останутся в истории изменений.` : `Папка «${name}» удалена`, 7000);
      scheduleSync(); renderTree();
    }, x, y) },
    'sep',
    { label: 'Новые заметки — под папкой на блок-схеме', on: linked, icon: ' ', run: () => {
      vault.setFolderLinked(path, !linked);
      toast(!linked ? `Новые заметки в «${name}» будут вставать под этой папкой на блок-схеме` : `Новые заметки в «${name}» больше не привязываются к папке на блок-схеме`, 6000);
      scheduleSync(); renderTree();
    } },
    { label: 'Показать папку на блок-схеме', run: () => { vault.addFolderToSchema(path); scheduleSync(); navigate('#schema'); } },
    // Only the flowchart changes: the notes stay in the folder.
    { label: `Привязать заметки папки на схеме (${count})`, icon: '⤵', disabled: !count, run: () => {
      const n = vault.attachFolderNotes(path);
      toast(n ? `На блок-схеме под папкой «${name}» теперь заметок: ${n}. В самой папке ничего не изменилось.` : `Все заметки «${name}» уже стоят под папкой на блок-схеме`, 7000);
      scheduleSync();
    } },
    { label: 'Отвязать заметки папки на схеме', icon: '⤴', disabled: !count, run: () => {
      const n = vault.detachFolderNotes(path);
      toast(n ? `Заметки «${name}» отвязаны от папки на блок-схеме (связей убрано: ${n}). Сами заметки остались в папке и на схеме.` : `На блок-схеме заметки «${name}» и так не привязаны к папке`, 7000);
      scheduleSync();
    } },
  ], x, y);
}

// The notes list stays on the left (as in Obsidian) unless the user hides it or the
// screen is phone-sized; then it slides in over the content.
const isPhone = () => matchMedia('(max-width: 520px)').matches;
const listFloats = () => isPhone() || $('app').classList.contains('side-hidden');
function setSidebar(shown) {
  $('app').classList.toggle('side-hidden', !shown);
  prefs.set('sideHidden', !shown);
  closeDrawer();
}
function setSideWidth(px) {
  const w = Math.round(Math.min(420, Math.max(226, px)));
  $('app').style.setProperty('--side-w', w + 'px');
  return w;
}
function openDrawer() { if (!listFloats()) return; $('app').classList.add('drawer'); $('backdrop').hidden = false; }
function closeDrawer() { $('app').classList.remove('drawer'); $('backdrop').hidden = true; }

// ---------- Note menu ----------
function closeMenu() { $('moreMenu').hidden = true; $('moreBtn').setAttribute('aria-expanded', 'false'); }
function deleteNote(p) {
  if (!p || !vault.get(p)) return;
  const name = basename(p);
  vault.remove(p);
  if (p === current) { prefs.set('last', null); navigate(''); }
  toast(`Заметка «${name}» удалена. На GitHub она останется в истории изменений.`);
  renderTree();
  scheduleSync();
}
function openMenu() {
  const menu = $('moreMenu');
  // stopPropagation: a click that swaps the menu's content must not reach the
  // "click outside closes the menu" handler (that is what hid the delete confirmation).
  const item = (text, fn, cls = '') => { const b = el('button', { type: 'button', textContent: text, className: cls }); b.addEventListener('click', e => { e.stopPropagation(); fn(); }); return b; };
  const name = basename(current);
  menu.replaceChildren(
    item('Новая заметка', () => { closeMenu(); newNote(); }),
    item('Показать на графе', () => { closeMenu(); navigate('#graph'); }),
    item('Показать на блок-схеме', () => { closeMenu(); navigate('#schema=' + encodeURIComponent(current)); }),
    item('Удалить заметку', () => {
      menu.replaceChildren(
        el('p', { textContent: `Удалить «${name}»? После синхронизации она удалится и на других устройствах. На GitHub останется в истории изменений.` }),
        item('Удалить', () => { closeMenu(); deleteNote(current); }, 'danger'),
        item('Отмена', closeMenu));
    }, 'danger'));
  menu.hidden = false;
  $('moreBtn').setAttribute('aria-expanded', 'true');
}

// ---------- Graph ----------
// ---------- Right panel: links graph or flowchart next to the open note ----------
const rp = { open: prefs.get('rpOpen', false), tab: prefs.get('rpTab', 'graph'), all: prefs.get('rpAll', false) };
let rpGraph = null, rpSchema = null, rpFor = null;

// The note, the notes it links to and the notes linking to it (or every note).
function localGraph(path, all) {
  const g = vault.graph(false);
  if (all) return g;
  const keep = new Set([path]);
  for (const [a, b] of g.edges) { if (a === path) keep.add(b); if (b === path) keep.add(a); }
  return { nodes: g.nodes.filter(n => keep.has(n.id)), edges: g.edges.filter(([a, b]) => keep.has(a) && keep.has(b)) };
}

function renderPanel(switched = false) {
  const show = rp.open && current && !$('noteView').hidden;
  $('panelBtn').setAttribute('aria-pressed', String(rp.open));
  $('rightPanel').hidden = !show;
  if (!show) { if (rpGraph) rpGraph.show(false); if (rpSchema) rpSchema.hide(); return; }
  const graphTab = rp.tab === 'graph';
  $('rpTabGraph').setAttribute('aria-selected', String(graphTab));
  $('rpTabSchema').setAttribute('aria-selected', String(!graphTab));
  $('rpAllWrap').hidden = !graphTab;
  $('rpAll').checked = rp.all;
  $('rpGraph').hidden = !graphTab;
  $('rpSchema').hidden = graphTab;
  const moved = switched || rpFor !== current;
  if (graphTab) {
    if (rpSchema) rpSchema.hide();
    if (!rpGraph) rpGraph = new GraphView($('rpGraph'), { onOpen: n => (n.exists ? navigate(noteHash(n.id)) : openOrCreate(n.label)) });
    rpGraph.show(true);
    rpGraph.setData(localGraph(current, rp.all), current, moved);
  } else {
    if (rpGraph) rpGraph.show(false);
    if (!rpSchema) {
      rpSchema = new SchemaView($('rpSchema'), {
        vault, compact: true,
        openNote: p => navigate(noteHash(p)),
        openFull: p => navigate(p ? '#schema=' + encodeURIComponent(p) : '#schema'),
        toast: (t, ms) => toast(t, ms),
        onSaved: () => scheduleSync(),
      });
    }
    if (moved || !rpSchema.visible) rpSchema.show(current, { autoAdd: false });
    else rpSchema.refresh();
  }
  rpFor = current;
}

function setPanel(patch) {
  Object.assign(rp, patch);
  prefs.set('rpOpen', rp.open); prefs.set('rpTab', rp.tab); prefs.set('rpAll', rp.all);
  rpFor = null;
  renderPanel(true);
}

// ---------- Flowchart ----------
let schema = null;
// ---------- Calendar ----------
// System notification (through the service worker, so it also shows when the
// app is in the background) plus a message inside the app.
async function notify(title, body, tag, url) {
  toast(`🔔 ${title}: ${body}`, 9000);
  // With push on, the server sends the system notification; the app only shows the message.
  // In the Android app the phone itself shows it (alarms set by native.js).
  if (isNativeApp() || push.onHere()) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const opts = { body, tag, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: { url: url || '#calendar' }, renotify: true, silent: false, vibrate: [250, 120, 250] };
  try {
    const reg = await navigator.serviceWorker?.ready;
    if (reg) await reg.showNotification(title, opts); else new Notification(title, opts);
  } catch { try { new Notification(title, opts); } catch { /* not allowed */ } }
}
const calendar = new CalendarView($('calendarView'), { vault, toast: (t, ms) => toast(t, ms), notify });
const goals = new GoalsView($('goalsView'), { vault, toast: (t, ms) => toast(t, ms), openNote: p => navigate(noteHash(p)) });
const push = new PushClient(vault, calendar.store);
calendar.push = isNativeApp() ? null : push;
const nativeReminders = new NativeReminders(calendar.store, url => { location.hash = url.replace(/^[^#]*/, ''); });
calendar.native = isNativeApp() ? nativeReminders : null;
// Reminders changed: the Android app re-sets its alarms, the browser sends them to the push server.
const remindersChanged = (delay) => { if (isNativeApp()) nativeReminders.scheduleSoon(delay); else push.scheduleUpload(delay); };

function showCalendar(target) {
  showView('calendarView', 'Календарь');
  calendar.show(target);
  if (target) history.replaceState(null, '', '#calendar');
}

function showSchema(focusPath) {
  const focus = focusPath && vault.get(focusPath) ? focusPath : null;
  showView('schemaView', 'Блок-схема');
  if (!schema) {
    schema = new SchemaView($('schemaView'), {
      vault,
      openNote: p => navigate(noteHash(p)),
      toast: (t, ms) => toast(t, ms),
      onSaved: () => scheduleSync(),
    });
  }
  schema.show(focus);
  if (focus) history.replaceState(null, '', '#schema');
}

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

// ---------- Neural network: connections between notes ----------
let finder = null;
const getFinder = () => finder || (finder = new LinkFinder(vault));
const mb = n => (n / 1048576).toFixed(0);
function aiProgressText(p) {
  if (!p) return 'Подождите…';
  if (p.stage === 'download') return p.total ? `Скачиваю нейросеть (один раз): ${mb(p.loaded)} из ${mb(p.total)} МБ…` : 'Скачиваю нейросеть (один раз)…';
  return `Читаю заметки: ${p.done} из ${p.total}…`;
}
// Puts note b under note a on the flowchart (both are added if missing).
function linkOnSchema(a, b) {
  const s = vault.schema();
  const copy = { nodes: s.nodes.map(n => ({ ...n })), edges: s.edges.map(e => ({ ...e })) };
  const node = p => { let n = copy.nodes.find(x => x.file === p); if (!n) { n = { id: 'n' + Math.random().toString(36).slice(2, 10), file: p, x: 0, y: 0, pinned: false }; copy.nodes.push(n); } return n; };
  const na = node(a), nb = node(b);
  const reaches = (x, y) => { const seen = new Set([x]), st = [x]; while (st.length) { const c = st.pop(); if (c === y) return true; for (const e of copy.edges) if (e.fromNode === c && !seen.has(e.toNode)) { seen.add(e.toNode); st.push(e.toNode); } } return false; };
  // No circles on the flowchart: if b is already above a, the arrow goes the other way.
  const [from, to] = reaches(nb.id, na.id) ? [nb, na] : [na, nb];
  if (!copy.edges.some(e => e.fromNode === from.id && e.toNode === to.id)) copy.edges.push({ id: 'e' + Math.random().toString(36).slice(2, 10), fromNode: from.id, toNode: to.id });
  vault.saveSchema(copy);
}
async function openAiPanel() {
  const panel = $('aiPanel');
  panel.hidden = false;
  const status = el('p', { className: 'ai-status', role: 'status', textContent: 'Подождите…' });
  const list = el('div', { className: 'ai-list' });
  const range = el('input', { type: 'range', min: '78', max: '95', step: '1', value: String(Math.round(prefs.get('aiMin', DEFAULT_MIN) * 100)), 'aria-label': 'Насколько похожими должны быть заметки' });
  const close = el('button', { type: 'button', textContent: 'Готово' });
  close.addEventListener('click', () => { panel.hidden = true; });
  panel.replaceChildren(
    el('div', { className: 'ai-head' }, el('b', { textContent: '✨ Связи от нейросети' }), close),
    status,
    el('label', { className: 'ai-range' }, el('span', { textContent: 'Мягче' }), range, el('span', { textContent: 'Строже' })),
    list);
  const f = getFinder();
  const draw = () => {
    const min = Number(range.value) / 100;
    const items = f.suggestions({ min });
    status.textContent = items.length ? `Похожие по смыслу заметки, которые ещё не связаны: ${items.length}. Ничего не меняется, пока вы не нажмёте кнопку.` : 'Новых связей не нашлось. Сдвиньте ползунок к «Мягче», чтобы увидеть менее похожие пары.';
    list.replaceChildren();
    for (const { a, b, score } of items.slice(0, 60)) {
      const name = p => { const x = el('button', { type: 'button', className: 'ai-name', textContent: basename(p), title: p }); x.addEventListener('click', () => navigate(noteHash(p))); return x; };
      const act = (text, title, fn, cls = '') => { const x = el('button', { type: 'button', textContent: text, title, className: cls }); x.addEventListener('click', fn); return x; };
      const row = el('div', { className: 'ai-row' },
        el('div', { className: 'ai-pair' }, name(a), el('span', { className: 'ai-score', textContent: `↔ ${Math.round(score * 100)}%` }), name(b)),
        el('div', { className: 'ai-acts' },
          act('Ссылкой', `Добавить в «${basename(a)}» строку «См. также: [[${basename(b)}]]»`, () => { addSeeAlso(vault, a, b); toast(`В «${basename(a)}» добавлена ссылка на «${basename(b)}»`); scheduleSync(); updateGraph(); draw(); }, 'primary'),
          act('На схеме', `Поставить «${basename(b)}» под «${basename(a)}» на блок-схеме`, () => { linkOnSchema(a, b); toast('Связь добавлена на блок-схему'); scheduleSync(); updateGraph(); draw(); }),
          act('Скрыть', 'Больше не предлагать эту пару', async () => { await f.hide(a, b); draw(); }, 'ai-hide')));
      list.append(row);
    }
  };
  range.addEventListener('input', () => { prefs.set('aiMin', Number(range.value) / 100); draw(); });
  try {
    await f.update(p => { status.textContent = aiProgressText(p); });
    draw();
  } catch (e) {
    status.className = 'ai-status bad';
    status.textContent = 'Нейросеть не запустилась: ' + e.message + (navigator.onLine ? '' : ' Для первого запуска нужен интернет.');
  }
}
// Automatic mode: some time after writing stops, check the open note for similar ones.
let aiTimer = null;
const aiAnnounced = new Set();
function scheduleAutoLinks() {
  if (prefs.get('aiMode', 'button') !== 'auto') return;
  clearTimeout(aiTimer);
  aiTimer = setTimeout(async () => {
    const path = current;
    if (!path || document.hidden) return;
    try {
      const f = getFinder();
      await f.update();
      const fresh = f.suggestions({ min: prefs.get('aiMin', DEFAULT_MIN), forPath: path }).filter(s => !aiAnnounced.has(s.a + '\n' + s.b));
      fresh.forEach(s => aiAnnounced.add(s.a + '\n' + s.b));
      if (fresh.length) {
        const other = fresh.map(s => basename(s.a === path ? s.b : s.a));
        toast(`✨ К «${basename(path)}» по смыслу подходят: ${other.slice(0, 3).join(', ')}${other.length > 3 ? '…' : ''}. Граф → «Найти связи».`, 9000);
        $('openGraph').classList.add('ai-hint');
      }
    } catch { /* stays quiet in automatic mode */ }
  }, 15000);
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
  if (!sync.configured() || !navigator.onLine) { renderSyncStatus(); syncMedia(); return null; }
  syncState = { ...syncState, state: 'syncing' };
  renderSyncStatus();
  try {
    const r = await sync.sync();
    syncState = { state: 'ok', at: new Date(), error: '' };
    syncMedia();
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

// Uploads waiting pictures and files, refreshes the list of files on the Disk.
async function syncMedia() {
  if (!ya.connected() || !navigator.onLine) { renderYa(); return; }
  try {
    await media.flush();
    await media.refresh(ATTACH_DIR);
    yaState.error = '';
  } catch (e) {
    yaState.error = e.message || String(e);
  }
  renderYa();
  renderSyncStatus();
}

// Moves pictures and files that were stored in GitHub over to the Disk.
async function moveLegacyToDisk() {
  const legacy = vault.legacyAttachments();
  if (!legacy.length || !ya.connected() || yaState.moving) return;
  yaState.moving = true;
  renderYa();
  let moved = 0;
  try {
    for (const f of legacy) {
      const bin = atob(f.content);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      await media.put(f.path, new Blob([bytes], { type: 'application/octet-stream' }));
      await media.flush();
      if (media.remote.has(f.path)) { vault.remove(f.path); moved++; }
      if ($('yaStatus')) $('yaStatus').textContent = `Переношу файлы на Яндекс Диск: ${moved} из ${legacy.length}…`;
    }
    toast(`Перенесено на Яндекс Диск: ${moved} ${plural(moved, 'файл', 'файла', 'файлов')}.`);
    scheduleSync(2000);
  } catch (e) {
    yaState.error = e.message || String(e);
  } finally {
    yaState.moving = false;
    renderYa();
  }
}

function renderYa() {
  if (!$('yaStatus')) return;
  const waiting = media.pendingCount();
  const legacy = vault.legacyAttachments().length;
  let text;
  if (!ya.connected()) text = 'Не подключён. Новые картинки и файлы пока хранятся только на этом устройстве и загрузятся на Диск после подключения.';
  else if (yaState.moving) text = 'Переношу файлы на Яндекс Диск…';
  else {
    text = 'Подключён. Файлы лежат на Диске в папке «Приложения/Заметки».';
    const i = yaState.info;
    if (i && i.total_space) text += ` Занято ${(i.used_space / 2 ** 30).toFixed(1)} ГБ из ${(i.total_space / 2 ** 30).toFixed(1)} ГБ.`;
  }
  if (waiting) text += ` Ждут загрузки: ${waiting}.`;
  if (yaState.error) text += ' ' + yaState.error;
  $('yaStatus').textContent = text;
  $('yaStatus').className = 'form-msg' + (yaState.error ? ' bad' : '');
  $('yaConnect').hidden = ya.connected();
  $('yaDisconnect').hidden = !ya.connected();
  $('yaMove').hidden = !ya.connected() || !legacy || yaState.moving;
  $('yaMove').textContent = `Перенести на Диск файлы из GitHub (${legacy})`;
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
  const waiting = media.pendingCount();
  if (waiting) text += ` · файлов ждёт загрузки: ${waiting}`;
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
  renderYa();
  if (ya.connected()) ya.info().then(i => { yaState.info = i; renderYa(); }).catch(() => {});
  $('folderSchemaLink').checked = vault.folderConf().schemaLink;
  $('aiMode').value = prefs.get('aiMode', 'button');
  renderThemePick();
}

// ---------- Theme: as in the system, light or dark (this device only) ----------
function applyTheme(t) {
  const root = document.documentElement;
  if (t === 'light' || t === 'dark') root.dataset.theme = t; else delete root.dataset.theme;
  const dark = t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => { m.content = dark ? '#1e1e22' : '#f6f6f8'; });
  // The graph and the flowchart draw with colours read from the page: redraw them.
  if (graph && !$('graphView').hidden) updateGraph();
  if (rpGraph && rp.open) renderPanel();
}
function renderThemePick() {
  const t = prefs.get('theme', 'system');
  $('themePick').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.themeValue === t)));
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
    if (currentFile && !vault.hasFile(currentFile)) route();
    else if (currentFile) refreshFileView();
    if (!$('graphView').hidden && graph) updateGraph();
    if (schema) schema.refresh();
    calendar.refresh();
    goals.refresh();
    remindersChanged();
    if (current) renderPanel();
  }, 150);
});

function bind() {
  window.addEventListener('hashchange', route);
  $('newNote').addEventListener('click', () => newNote());
  $('newFolder').addEventListener('click', () => newFolder());
  // Drag and drop in the notes list: onto a folder = into it; above/below an item = to that
  // place (and into its folder); onto empty space = to the top level.
  {
    const tree = $('tree');
    let drag = null;
    const clear = () => { tree.classList.remove('drop-root'); tree.querySelectorAll('.drop-into, .drop-before, .drop-after, .dragging').forEach(x => x.classList.remove('drop-into', 'drop-before', 'drop-after', 'dragging')); };
    const zone = e => {
      const row = e.target.closest('[data-kind]');
      if (!row) return { root: true };
      const r = row.getBoundingClientRect(), y = (e.clientY - r.top) / r.height;
      if (row.dataset.kind === 'folder' && y > 0.25 && y < 0.75) return { row, into: true };
      return { row, after: y >= 0.5 };
    };
    tree.addEventListener('dragstart', e => {
      const row = e.target.closest('[data-kind]');
      if (!row) return;
      drag = { kind: row.dataset.kind, path: row.dataset.path };
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', row.dataset.path);
      requestAnimationFrame(() => row.classList.add('dragging'));
    });
    tree.addEventListener('dragover', e => {
      if (!drag) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      tree.classList.remove('drop-root');
      tree.querySelectorAll('.drop-into, .drop-before, .drop-after').forEach(x => x.classList.remove('drop-into', 'drop-before', 'drop-after'));
      const z = zone(e);
      if (z.root) tree.classList.add('drop-root');
      else if (z.row.dataset.path !== drag.path) z.row.classList.add(z.into ? 'drop-into' : z.after ? 'drop-after' : 'drop-before');
    });
    tree.addEventListener('drop', e => {
      if (!drag) return;
      e.preventDefault();
      const d = drag, z = zone(e);
      drag = null;
      clear();
      if (z.root) { moveItem(d.kind, d.path, ''); return; }
      const t = z.row.dataset;
      if (t.path === d.path) return;
      if (z.into) moveItem(d.kind, d.path, t.path);
      else moveItem(d.kind, d.path, dirname(t.path), t.kind === d.kind ? { name: t.path.split('/').pop(), after: z.after } : null);
    });
    tree.addEventListener('dragend', () => { drag = null; clear(); });
  }
  $('aiFind').addEventListener('click', () => { $('openGraph').classList.remove('ai-hint'); openAiPanel(); });
  $('themePick').addEventListener('click', e => {
    const b = e.target.closest('[data-theme-value]');
    if (!b) return;
    prefs.set('theme', b.dataset.themeValue);
    applyTheme(b.dataset.themeValue);
    renderThemePick();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(prefs.get('theme', 'system')));
  $('aiMode').addEventListener('change', e => {
    prefs.set('aiMode', e.target.value);
    toast(e.target.value === 'auto' ? 'Нейросеть будет проверять заметку через 15 секунд после того, как вы перестали писать' : 'Нейросеть ищет связи только по кнопке в графе', 6000);
  });
  // Right-click on empty space of the list: new note or folder at the top level.
  $('tree').addEventListener('contextmenu', e => {
    if (e.target.closest('button, input')) return;
    e.preventDefault();
    showMenu([
      { label: 'Новая заметка', icon: '+', run: () => newNote() },
      { label: 'Новая папка', icon: '📁', run: () => newFolder() },
    ], e.clientX, e.clientY);
  });
  $('openGraph').addEventListener('click', () => navigate('#graph'));
  $('openSchema').addEventListener('click', () => navigate('#schema'));
  $('openCalendar').addEventListener('click', () => navigate('#calendar'));
  $('openGoals').addEventListener('click', () => navigate('#goals'));
  $('openSettings').addEventListener('click', () => navigate('#settings'));
  $('syncStatus').addEventListener('click', () => navigate('#settings'));
  $('menuBtn').addEventListener('click', () => { if (isPhone()) openDrawer(); else setSidebar(true); });
  $('hideSide').addEventListener('click', () => setSidebar(false));
  $('panelBtn').addEventListener('click', () => setPanel({ open: !rp.open }));
  $('rpClose').addEventListener('click', () => setPanel({ open: false }));
  $('rpTabGraph').addEventListener('click', () => setPanel({ tab: 'graph' }));
  $('rpTabSchema').addEventListener('click', () => setPanel({ tab: 'schema' }));
  $('rpAll').addEventListener('change', e => setPanel({ all: e.target.checked }));
  const setPanelWidth = px => { const w = Math.round(Math.min(700, Math.max(240, px))); $('app').style.setProperty('--rp-w', w + 'px'); return w; };
  setPanelWidth(prefs.get('rpWidth', 340));
  const rpGrip = $('rpResize');
  rpGrip.addEventListener('pointerdown', e => {
    e.preventDefault();
    rpGrip.setPointerCapture(e.pointerId);
    rpGrip.classList.add('active');
    const right = () => $('main').getBoundingClientRect().right;
    const move = ev => setPanelWidth(right() - ev.clientX);
    const up = ev => {
      rpGrip.classList.remove('active');
      prefs.set('rpWidth', setPanelWidth(right() - ev.clientX));
      rpGrip.removeEventListener('pointermove', move);
      rpGrip.removeEventListener('pointerup', up);
    };
    rpGrip.addEventListener('pointermove', move);
    rpGrip.addEventListener('pointerup', up);
  });
  $('app').classList.toggle('side-hidden', prefs.get('sideHidden', false));
  setSideWidth(prefs.get('sideWidth', 230));
  const grip = $('sideResize');
  grip.addEventListener('pointerdown', e => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    grip.classList.add('active');
    const move = ev => setSideWidth(ev.clientX - $('app').getBoundingClientRect().left);
    const up = ev => {
      grip.classList.remove('active');
      prefs.set('sideWidth', setSideWidth(ev.clientX - $('app').getBoundingClientRect().left));
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
  });
  grip.addEventListener('dblclick', () => prefs.set('sideWidth', setSideWidth(230)));
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
  $('yaConnect').addEventListener('click', () => ya.startLogin());
  $('yaDisconnect').addEventListener('click', () => { ya.disconnect(); yaState = { error: '', info: null, moving: false }; renderYa(); toast('Яндекс Диск отключён на этом устройстве. Файлы на Диске остались.'); });
  $('yaMove').addEventListener('click', () => moveLegacyToDisk());
  $('folderSchemaLink').addEventListener('change', e => {
    const c = vault.folderConf();
    c.schemaLink = e.target.checked;
    vault.saveFolderConf(c);
    renderTree();
    scheduleSync();
    toast(c.schemaLink ? 'Новые заметки в папках будут вставать на блок-схеме под своей папкой' : 'Новые заметки больше не привязываются к папкам на блок-схеме', 6000);
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
    if (e.key === 'Enter') { e.preventDefault(); renameCurrent(); if (mode === 'edit') ed.focus(); }
    if (e.key === 'Escape') { title.value = basename(current); title.blur(); }
  });

  $('preview').addEventListener('click', e => {
    const box = e.target.closest('input[type="checkbox"][data-line]');
    if (box) { toggleTask(Number(box.dataset.line)); return; }
    const a = e.target.closest('a');
    if (!a) return;
    if (a.classList.contains('wikilink')) { e.preventDefault(); openOrCreate(a.dataset.target, a.dataset.heading); }
    else if (a.classList.contains('file-link')) { e.preventDefault(); const p = vault.resolveFile(a.dataset.file); if (p) navigate(fileHash(p)); }
    else if (a.classList.contains('tag')) { e.preventDefault(); $('search').value = '#' + a.dataset.tag; renderTree(); openDrawer(); }
  });

  $('attachBtn').addEventListener('click', () => $('fileInput').click());
  // "Аа": the editor's right-click menu as a button (on a phone there is no right click).
  $('formatBtn').addEventListener('mousedown', e => e.preventDefault()); // keep the selection in the note
  $('formatBtn').addEventListener('click', e => {
    e.stopPropagation();
    const r = $('formatBtn').getBoundingClientRect();
    openEditMenuAt(ed.view, r.left, r.bottom + 6);
  });
  $('fileInput').addEventListener('change', async e => {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length || !current) return;
    if (mode === 'read') setMode('edit', false);
    await ed.insertFiles(files);
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
}

async function init() {
  const yaBack = ya.takeTokenFromUrl();
  bind();
  try {
    await vault.load();
    await media.init();
  } catch {
    toast('Браузер не дал сохранять заметки на этом устройстве. Проверьте, что сайту разрешено хранить данные.', 10000);
  }
  route();
  renderSyncStatus();
  if (yaBack === 'ok') {
    toast('Яндекс Диск подключён. Картинки и файлы будут храниться там.', 7000);
    syncMedia().then(() => moveLegacyToDisk());
  } else if (yaBack === 'denied') toast('Доступ к Яндекс Диску не выдан.', 7000);
  calendar.startReminders();
  if (isNativeApp()) {
    nativeReminders.init();
    // New days come into the 60-day window: refresh the alarms now and then.
    setInterval(() => nativeReminders.schedule(true), 6 * 3600e3);
  } else {
    push.scheduleUpload(3000);
    setInterval(() => push.upload(true), 6 * 3600e3);
  }
  navigator.serviceWorker?.addEventListener('message', e => { if (e.data?.type === 'open' && e.data.url) location.hash = e.data.url.replace(/^[^#]*/, ''); });
  runSync();
  setInterval(() => { if (document.visibilityState === 'visible') runSync(); }, 60000);
  if ('serviceWorker' in navigator) {
    // A new version of the program was published: reload once to use it.
    const hadController = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || sessionStorage.getItem('notes.swReloaded')) return;
      sessionStorage.setItem('notes.swReloaded', '1');
      vault.flush();
      location.reload();
    });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(reg => reg.update()).catch(() => {});
  }
}
init();
