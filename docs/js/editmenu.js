// Right-click menu of the note editor, like Obsidian's: cut/copy/paste,
// Format ▸, Paragraph ▸, Insert ▸ and centring of text. All commands only
// change the Markdown text, so notes stay plain .md files.
import { EditorSelection } from '../vendor/codemirror.js';

// ---------- Text commands ----------
const PREFIX_RE = /^(\s*)((?:#{1,6}\s+)|(?:>\s?)|(?:[-*+]\s+\[[ xX]\]\s+)|(?:[-*+]\s+)|(?:\d+[.)]\s+))?/;
const CENTER_RE = /^(\s*(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)?)<center>(.*)<\/center>\s*$/;

function selectedLines(state) {
  const seen = new Set(), out = [];
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    let b = state.doc.lineAt(r.to).number;
    if (b > a && r.to === state.doc.line(b).from) b--; // selection ending at a line start
    for (let n = a; n <= b; n++) if (!seen.has(n)) { seen.add(n); out.push(state.doc.line(n)); }
  }
  return out;
}

// **bold**, *italic*, ~~strike~~, ==highlight==, `code`: wraps the selection or removes the marks.
function toggleWrap(view, mark) {
  const { state } = view;
  const len = mark.length;
  view.dispatch(state.changeByRange(r => {
    const text = state.sliceDoc(r.from, r.to);
    if (text.length >= 2 * len && text.startsWith(mark) && text.endsWith(mark)) {
      const inner = text.slice(len, -len);
      return { changes: { from: r.from, to: r.to, insert: inner }, range: EditorSelection.range(r.from, r.from + inner.length) };
    }
    if (state.sliceDoc(r.from - len, r.from) === mark && state.sliceDoc(r.to, r.to + len) === mark) {
      return { changes: [{ from: r.from - len, to: r.from }, { from: r.to, to: r.to + len }], range: EditorSelection.range(r.from - len, r.to - len) };
    }
    if (r.empty) {
      // No selection: wrap the word under the cursor, or put empty marks to type into.
      const line = state.doc.lineAt(r.from);
      const pos = r.from - line.from;
      const before = line.text.slice(0, pos).match(/[\p{L}\p{N}_]*$/u)[0], after = line.text.slice(pos).match(/^[\p{L}\p{N}_]*/u)[0];
      if (before || after) {
        const from = r.from - before.length, to = r.from + after.length;
        return { changes: [{ from, insert: mark }, { from: to, insert: mark }], range: EditorSelection.cursor(r.from + len) };
      }
      return { changes: { from: r.from, insert: mark + mark }, range: EditorSelection.cursor(r.from + len) };
    }
    return { changes: [{ from: r.from, insert: mark }, { from: r.to, insert: mark }], range: EditorSelection.range(r.from + len, r.to + len) };
  }));
  view.focus();
}

// Changes the start of every selected line: heading, list, task, quote or plain text.
function setLineKind(view, kind) {
  const lines = selectedLines(view.state);
  const changes = [];
  let k = 1;
  const allQuote = lines.every(l => /^\s*>/.test(l.text));
  const allSame = lines.every(l => lineKind(l.text) === kind);
  for (const l of lines) {
    const indent = l.text.match(/^\s*/)[0];
    const at = l.from + indent.length;
    if (kind === 'quote') {
      // A quote goes in front of whatever the line already is; again removes it.
      const q = l.text.slice(indent.length).match(/^>\s?/);
      if (allQuote) changes.push({ from: at, to: at + (q ? q[0].length : 0) });
      else changes.push({ from: at, insert: '> ' });
      continue;
    }
    const old = (l.text.match(PREFIX_RE)[2]) || '';
    let next;
    if (allSame || kind === 'body') next = '';                 // same command again: back to plain text
    else if (kind === 'bullet') next = '- ';
    else if (kind === 'number') next = `${k++}. `;
    else if (kind === 'task') next = '- [ ] ';
    else next = '#'.repeat(Number(kind.slice(1))) + ' ';      // h1 … h6
    changes.push({ from: at, to: at + old.length, insert: next });
  }
  view.dispatch({ changes });
  view.focus();
}
function lineKind(text) {
  const t = text.trimStart();
  const h = t.match(/^(#{1,6})\s/);
  if (h) return 'h' + h[1].length;
  if (/^[-*+]\s+\[[ xX]\]\s/.test(t)) return 'task';
  if (/^[-*+]\s/.test(t)) return 'bullet';
  if (/^\d+[.)]\s/.test(t)) return 'number';
  if (/^>/.test(t)) return 'quote';
  return 'body';
}

// Centres the selected lines (<center>…</center>), or puts them back to the left.
function toggleCenter(view) {
  const lines = selectedLines(view.state).filter(l => l.text.trim());
  if (!lines.length) return;
  const allCentered = lines.every(l => CENTER_RE.test(l.text));
  // Only the tags are added or removed, so the selection stays on the same text.
  const changes = lines.flatMap(l => {
    if (allCentered) {
      const m = l.text.match(CENTER_RE);
      const open = l.from + m[1].length, close = l.from + l.text.lastIndexOf('</center>');
      return [{ from: open, to: open + 8 }, { from: close, to: l.to }];
    }
    if (CENTER_RE.test(l.text)) return [];
    const pre = l.text.match(PREFIX_RE)[0];
    return [{ from: l.from + pre.length, insert: '<center>' }, { from: l.to, insert: '</center>' }];
  });
  view.dispatch({ changes });
  view.focus();
}

// Removes **, *, _, ~~, ==, ` and centring from the selection (or the current line).
function clearFormatting(view) {
  const { state } = view;
  view.dispatch(state.changeByRange(r => {
    const from = r.empty ? state.doc.lineAt(r.from).from : r.from, to = r.empty ? state.doc.lineAt(r.from).to : r.to;
    const text = state.sliceDoc(from, to);
    const clean = text.replace(/<\/?center>/g, '').replace(/(\*\*|__|~~|==)(.+?)\1/g, '$2').replace(/(\*|_)(?!\s)(.+?)(?<!\s)\1/g, '$2').replace(/`([^`]+)`/g, '$1');
    return { changes: { from, to, insert: clean }, range: EditorSelection.range(from, from + clean.length) };
  }));
  view.focus();
}

// Inserts a block on its own lines at the cursor; `caret` marks where the cursor goes.
function insertBlock(view, block) {
  const { state } = view;
  const r = state.selection.main;
  const line = state.doc.lineAt(r.from);
  const selected = state.sliceDoc(r.from, r.to);
  const before = line.text.trim() ? (r.from === line.from ? '' : '\n') : '';
  let text = typeof block === 'function' ? block(selected) : block.replace('§SEL§', selected);
  const caret = text.indexOf('|CARET|');
  text = text.replace('|CARET|', '');
  const insert = before + text + (r.to === state.doc.lineAt(r.to).to ? '' : '\n');
  view.dispatch({ changes: { from: r.from, to: r.to, insert }, selection: { anchor: r.from + before.length + (caret >= 0 ? caret : text.length) } });
  view.focus();
}
function insertInline(view, open, close, placeholder = '') {
  const { state } = view;
  view.dispatch(state.changeByRange(r => {
    const sel = state.sliceDoc(r.from, r.to) || placeholder;
    const insert = open + sel + close;
    return { changes: { from: r.from, to: r.to, insert }, range: EditorSelection.range(r.from + open.length, r.from + open.length + sel.length) };
  }));
  view.focus();
}

async function copy(view, cut) {
  const { state } = view;
  const text = state.selection.ranges.map(r => state.sliceDoc(r.from, r.to)).join('\n');
  if (!text) return;
  try { await navigator.clipboard.writeText(text); } catch { document.execCommand(cut ? 'cut' : 'copy'); return; }
  if (cut) view.dispatch(state.replaceSelection(''));
  view.focus();
}
async function paste(view, plain) {
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch { view.focus(); document.execCommand('paste'); return; }
  if (plain) text = text.replace(/\r\n/g, '\n');
  view.dispatch(view.state.replaceSelection(text));
  view.focus();
}

// ---------- The menu ----------
function menuItems(view) {
  const hasSel = view.state.selection.ranges.some(r => !r.empty);
  const kind = lineKind(view.state.doc.lineAt(view.state.selection.main.from).text);
  const centered = CENTER_RE.test(view.state.doc.lineAt(view.state.selection.main.from).text);
  const head = n => ({ label: `Заголовок ${n}`, on: kind === 'h' + n, run: () => setLineKind(view, 'h' + n) });
  return [
    { label: 'Вырезать', key: 'Ctrl+X', disabled: !hasSel, run: () => copy(view, true) },
    { label: 'Копировать', key: 'Ctrl+C', disabled: !hasSel, run: () => copy(view, false) },
    { label: 'Вставить', key: 'Ctrl+V', run: () => paste(view, false) },
    { label: 'Вставить без форматирования', key: 'Ctrl+Shift+V', run: () => paste(view, true) },
    { label: 'Выделить всё', key: 'Ctrl+A', run: () => { view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } }); view.focus(); } },
    'sep',
    { label: 'Форматирование', icon: 'B', sub: [
      { label: 'Жирный', key: 'Ctrl+B', run: () => toggleWrap(view, '**') },
      { label: 'Курсив', key: 'Ctrl+I', run: () => toggleWrap(view, '*') },
      { label: 'Зачёркнутый', run: () => toggleWrap(view, '~~') },
      { label: 'Выделение маркером', run: () => toggleWrap(view, '==') },
      { label: 'Код', run: () => toggleWrap(view, '`') },
      'sep',
      { label: 'Очистить форматирование', run: () => clearFormatting(view) },
    ] },
    { label: 'Абзац', icon: '¶', sub: [
      { label: 'Маркированный список', on: kind === 'bullet', run: () => setLineKind(view, 'bullet') },
      { label: 'Нумерованный список', on: kind === 'number', run: () => setLineKind(view, 'number') },
      { label: 'Список задач', on: kind === 'task', run: () => setLineKind(view, 'task') },
      'sep',
      head(1), head(2), head(3), head(4), head(5), head(6),
      { label: 'Обычный текст', on: kind === 'body', run: () => setLineKind(view, 'body') },
      'sep',
      { label: 'Цитата', on: kind === 'quote', run: () => setLineKind(view, 'quote') },
      { label: 'По центру', key: 'Ctrl+Shift+E', on: centered, run: () => toggleCenter(view) },
    ] },
    { label: 'Вставить элемент', icon: '+', sub: [
      { label: 'Ссылка на заметку', run: () => insertInline(view, '[[', ']]') },
      { label: 'Внешняя ссылка', key: 'Ctrl+K', run: () => insertInline(view, '[', '](https://)', 'текст') },
      'sep',
      { label: 'Таблица', run: () => insertBlock(view, '| |CARET|Столбец 1 | Столбец 2 |\n| --- | --- |\n|  |  |') },
      { label: 'Выноска', run: () => insertBlock(view, sel => '> [!note] |CARET|Заголовок\n> ' + sel.split('\n').join('\n> ')) },
      { label: 'Блок кода', run: () => insertBlock(view, '```\n|CARET|§SEL§\n```') },
      { label: 'Горизонтальная линия', run: () => insertBlock(view, '---\n|CARET|') },
    ] },
    'sep',
    { label: centered ? 'Убрать выравнивание по центру' : 'Выровнять по центру', icon: '≡', key: 'Ctrl+Shift+E', run: () => toggleCenter(view) },
  ];
}

let openMenus = [];
function closeAll() { for (const m of openMenus) m.remove(); openMenus = []; }

// Narrow screens (phone): a submenu replaces the menu, with "‹ Назад" on top.
const narrow = () => innerWidth < 700;

function buildMenu(items, x, y, level = 0) {
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.setAttribute('role', 'menu');
  for (const it of items) {
    if (it === 'sep') { menu.append(Object.assign(document.createElement('div'), { className: 'ctx-sep' })); continue; }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ctx-item' + (it.on ? ' on' : '') + (it.sub ? ' has-sub' : '');
    b.disabled = Boolean(it.disabled);
    b.setAttribute('role', 'menuitem');
    b.innerHTML = '<span class="ctx-icon"></span><span class="ctx-label"></span><span class="ctx-key"></span>';
    b.querySelector('.ctx-icon').textContent = it.on ? '✓' : it.icon || '';
    b.querySelector('.ctx-label').textContent = it.label;
    b.querySelector('.ctx-key').textContent = it.sub ? '›' : (it.key || '');
    const openSub = () => {
      openMenus.slice(level + 1).forEach(m => m.remove());
      openMenus = openMenus.slice(0, level + 1);
      menu.querySelectorAll('.ctx-item.open').forEach(x => x.classList.remove('open'));
      if (!it.sub) return;
      b.classList.add('open');
      const r = b.getBoundingClientRect();
      buildMenu(it.sub, r.right - 4, r.top - 6, level + 1);
    };
    b.addEventListener('mouseenter', () => { if (!narrow()) openSub(); });
    b.addEventListener('click', e => {
      e.stopPropagation();
      if (it.sub && narrow()) {
        const box = menu.getBoundingClientRect();
        closeAll();
        buildMenu([{ label: 'Назад', icon: '‹', run: () => buildMenu(items, box.left, box.top, level) }, 'sep', ...it.sub], box.left, box.top, level);
        return;
      }
      if (it.sub) { openSub(); return; }
      closeAll();
      it.run();
    });
    menu.append(b);
  }
  document.body.append(menu);
  openMenus.push(menu);
  // Keep the menu on screen; a submenu that does not fit on the right opens to the left.
  const w = menu.offsetWidth, h = menu.offsetHeight;
  let left = x, top = y;
  if (left + w > innerWidth - 8) left = level ? Math.max(8, x - w - (openMenus[level - 1]?.offsetWidth || 0) + 8) : innerWidth - w - 8;
  if (top + h > innerHeight - 8) top = Math.max(8, innerHeight - h - 8);
  menu.style.left = Math.max(8, left) + 'px';
  menu.style.top = Math.max(8, top) + 'px';
  return menu;
}

// The same menu from a button (the "Аа" button in the note's top bar, handy on a phone).
export function openEditMenuAt(view, x, y) {
  closeAll();
  buildMenu(menuItems(view), x, y);
}

// Hooks the menu and the shortcuts into an editor view.
export function attachEditMenu(view) {
  let lastPointer = 'mouse';
  view.dom.addEventListener('pointerdown', e => { lastPointer = e.pointerType; }, true);
  view.dom.addEventListener('contextmenu', e => {
    // On a phone a long press keeps the system's own text menu (selection handles, copy).
    if (lastPointer === 'touch') return;
    e.preventDefault();
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
    // Right-click outside the selection moves the cursor there, like in Obsidian.
    if (pos != null && !view.state.selection.ranges.some(r => pos >= r.from && pos <= r.to)) view.dispatch({ selection: { anchor: pos } });
    closeAll();
    buildMenu(menuItems(view), e.clientX, e.clientY);
  });
  view.dom.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const k = e.key.toLowerCase();
    const run = fn => { e.preventDefault(); e.stopPropagation(); fn(); };
    if (k === 'b' || k === 'и') run(() => toggleWrap(view, '**'));
    else if (k === 'i' || k === 'ш') run(() => toggleWrap(view, '*'));
    else if ((k === 'e' || k === 'у') && e.shiftKey) run(() => toggleCenter(view)); // Ctrl+E alone is the reading mode
    else if ((k === 'k' || k === 'л') && !e.shiftKey) run(() => insertInline(view, '[', '](https://)', 'текст'));
  }, true);
}

let installed = false;
export function installMenuDismiss() {
  if (installed) return;
  installed = true;
  document.addEventListener('pointerdown', e => { if (!e.target.closest('.ctx-menu')) closeAll(); }, true);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAll(); });
  window.addEventListener('blur', closeAll);
  window.addEventListener('resize', closeAll);
  document.addEventListener('scroll', closeAll, true);
}

export const _test = { toggleWrap, setLineKind, toggleCenter, clearFormatting, insertBlock, insertInline, lineKind };
