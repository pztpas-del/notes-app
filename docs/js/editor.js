// The note editor: CodeMirror with an Obsidian-style live preview. Markdown
// marks (#, **, [[ ]] …) are hidden everywhere except on the lines being edited,
// links and checkboxes are clickable, and images are shown in place.
import {
  EditorState, EditorView, EditorSelection, ViewPlugin, Decoration, WidgetType, Annotation, StateEffect, StateField, Transaction, keymap, Prec,
  drawSelection, placeholder, dropCursor, defaultKeymap, history, historyKeymap, indentWithTab,
  markdown, markdownLanguage, markdownKeymap, syntaxTree, indentUnit,
  autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap, search, searchKeymap,
} from '../vendor/codemirror.js';
import { attachEditMenu, installMenuDismiss } from './editmenu.js';

const fromOutside = Annotation.define();

// ---------- Search inside the note (the phone's magnifier button) ----------
// Matches are found in app code and shown here as highlights; ё and е count as the same letter.
export const findNorm = t => t.toLowerCase().replace(/ё/g, 'е');
const setFind = StateEffect.define();
const findField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) if (e.is(setFind)) deco = e.value;
    return deco;
  },
  provide: f => EditorView.decorations.from(f),
});
const findMark = Decoration.mark({ class: 'cm-find' }), findCur = Decoration.mark({ class: 'cm-find cm-find-cur' });
const redraw = StateEffect.define();
const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
const CENTER_RE = /^(\s*(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)?)<center>(.*)<\/center>\s*$/;

// ---------- Widgets ----------
class LinkWidget extends WidgetType {
  constructor(text, target, heading, exists) { super(); Object.assign(this, { text, target, heading, exists }); }
  eq(o) { return o.text === this.text && o.target === this.target && o.heading === this.heading && o.exists === this.exists; }
  toDOM() {
    const a = document.createElement('a');
    a.className = 'cm-wikilink' + (this.exists ? '' : ' unresolved');
    a.textContent = this.text;
    a.dataset.target = this.target;
    if (this.heading) a.dataset.heading = this.heading;
    return a;
  }
  ignoreEvent() { return false; }
}

class ImageWidget extends WidgetType {
  constructor(src, alt) { super(); this.src = src; this.alt = alt; }
  eq(o) { return o.src === this.src && o.alt === this.alt; }
  toDOM(view) {
    const img = document.createElement('img');
    img.className = 'cm-image';
    img.src = this.src;
    img.alt = this.alt;
    img.addEventListener('load', () => view.requestMeasure());
    return img;
  }
  ignoreEvent() { return false; }
}

class MissingFileWidget extends WidgetType {
  constructor(name) { super(); this.name = name; }
  eq(o) { return o.name === this.name; }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-missing-file';
    s.textContent = `Файл «${this.name}» не найден`;
    return s;
  }
}

class FileWidget extends WidgetType {
  constructor(name) { super(); this.name = name; }
  eq(o) { return o.name === this.name; }
  toDOM() {
    const a = document.createElement('a');
    a.className = 'cm-file';
    a.dataset.file = this.name;
    a.textContent = '📎 ' + this.name;
    return a;
  }
  ignoreEvent() { return false; }
}

class CheckboxWidget extends WidgetType {
  constructor(checked) { super(); this.checked = checked; }
  eq(o) { return o.checked === this.checked; }
  toDOM() {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'cm-task';
    box.checked = this.checked;
    box.setAttribute('aria-label', 'Отметить задачу');
    return box;
  }
  ignoreEvent() { return false; }
}

class BulletWidget extends WidgetType {
  eq() { return true; }
  toDOM() { const s = document.createElement('span'); s.className = 'cm-bullet'; s.textContent = '•'; return s; }
}

class RuleWidget extends WidgetType {
  eq() { return true; }
  toDOM() { const s = document.createElement('span'); s.className = 'cm-rule'; return s; }
}

// ---------- Live preview ----------
function activeLineNumbers(view) {
  const set = new Set();
  if (!view.hasFocus && !view.contentDOM.contains(document.activeElement)) return set;
  for (const r of view.state.selection.ranges) {
    const a = view.state.doc.lineAt(r.from).number, b = view.state.doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) set.add(n);
  }
  return set;
}

// Clean mode (a setting): marks stay hidden on the line being edited too. Only a link
// or image the cursor is inside shows its source, so it can still be typed and fixed.
function buildDecorations(view, opts) {
  const { state } = view;
  const doc = state.doc;
  const clean = Boolean(opts.clean?.());
  const active = clean ? new Set() : activeLineNumbers(view);
  const focused = view.hasFocus || view.contentDOM.contains(document.activeElement);
  const isActive = (from, to = from) => {
    const a = doc.lineAt(from).number, b = doc.lineAt(to).number;
    for (let n = a; n <= b; n++) if (active.has(n)) return true;
    return false;
  };
  // For links and images: in clean mode only when the cursor is strictly inside them.
  const isEditing = (from, to) => clean ? focused && state.selection.ranges.some(r => r.from > from && r.to < to) : isActive(from, to);
  const out = [];
  const hidden = []; // { from, to, kind: 'hide' | 'widget' | 'prefix' } — for clean-mode cursor moves and deleting
  const hide = (from, to) => { if (to > from) { out.push(Decoration.replace({}).range(from, to)); hidden.push({ from, to, kind: 'hide' }); } };
  const mark = (from, to, cls, attrs) => { if (to > from) out.push(Decoration.mark({ class: cls, attributes: attrs }).range(from, to)); };
  const lineClass = (pos, cls) => out.push(Decoration.line({ class: cls }).range(doc.lineAt(pos).from));
  const replaced = []; // ranges already turned into widgets, so later matches skip them
  const widget = (from, to, w) => {
    out.push(Decoration.replace({ widget: w }).range(from, to)); replaced.push([from, to]);
    hidden.push({ from, to, kind: w instanceof BulletWidget || w instanceof CheckboxWidget ? 'prefix' : 'widget' });
  };
  const inCode = new Set(); // line numbers inside fenced code

  const tree = syntaxTree(state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from, to,
      enter: node => {
        const n = node.name;
        const h = n.match(/^ATXHeading(\d)$/);
        if (h) { lineClass(node.from, `cm-h cm-h${h[1]}`); return; }
        if (n === 'HeaderMark') {
          if (!isActive(node.from)) hide(node.from, Math.min(node.to + 1, doc.lineAt(node.from).to));
          else mark(node.from, node.to, 'cm-syntax');
          return;
        }
        if (n === 'StrongEmphasis') { mark(node.from, node.to, 'cm-strong'); return; }
        if (n === 'Emphasis') { mark(node.from, node.to, 'cm-em'); return; }
        if (n === 'Strikethrough') { mark(node.from, node.to, 'cm-strike'); return; }
        if (n === 'EmphasisMark' || n === 'StrikethroughMark') {
          if (!isActive(node.from)) hide(node.from, node.to); else mark(node.from, node.to, 'cm-syntax');
          return;
        }
        if (n === 'InlineCode') {
          mark(node.from, node.to, 'cm-inline-code');
          if (!isActive(node.from)) {
            const c = node.node;
            for (let ch = c.firstChild; ch; ch = ch.nextSibling) if (ch.name === 'CodeMark') hide(ch.from, ch.to);
          }
          return false;
        }
        if (n === 'FencedCode') {
          const a = doc.lineAt(node.from).number, b = doc.lineAt(node.to).number;
          for (let k = a; k <= b; k++) { inCode.add(k); lineClass(doc.line(k).from, 'cm-codeblock' + (k === a ? ' cm-codeblock-first' : '') + (k === b ? ' cm-codeblock-last' : '')); }
          return false;
        }
        if (n === 'Blockquote') {
          const a = doc.lineAt(node.from).number, b = doc.lineAt(node.to).number;
          for (let k = a; k <= b; k++) lineClass(doc.line(k).from, 'cm-quote');
          return;
        }
        if (n === 'QuoteMark') {
          if (!isActive(node.from)) hide(node.from, Math.min(node.to + 1, doc.lineAt(node.from).to));
          else mark(node.from, node.to, 'cm-syntax');
          return;
        }
        if (n === 'HorizontalRule') {
          if (!isActive(node.from)) widget(node.from, node.to, new RuleWidget());
          return;
        }
        if (n === 'ListMark') {
          const text = state.sliceDoc(node.from, node.to);
          const item = node.node.parent;
          const task = item && item.getChild('Task');
          if (isActive(node.from)) { mark(node.from, node.to, 'cm-syntax'); return; }
          if (task) hide(node.from, Math.min(node.to + 1, doc.lineAt(node.from).to));
          else if (/^[-*+]$/.test(text)) widget(node.from, node.to, new BulletWidget());
          return;
        }
        if (n === 'TaskMarker') {
          const checked = /x/i.test(state.sliceDoc(node.from, node.to));
          if (checked) mark(node.to, doc.lineAt(node.from).to, 'cm-task-done');
          if (!isActive(node.from)) widget(node.from, node.to, new CheckboxWidget(checked));
          return;
        }
        if (n === 'Image') {
          if (isEditing(node.from, node.to)) return false;
          const url = node.node.getChild('URL');
          const src = url ? state.sliceDoc(url.from, url.to) : '';
          const altText = state.sliceDoc(node.from, node.to).match(/^!\[([^\]]*)\]/)?.[1] || '';
          const local = opts.fileUrl(decodeURIComponent(src));
          if (local || /^https?:/i.test(src)) widget(node.from, node.to, new ImageWidget(local || src, altText));
          return false;
        }
        if (n === 'Link') {
          const url = node.node.getChild('URL');
          const href = url ? state.sliceDoc(url.from, url.to) : '';
          const marks = [];
          for (let ch = node.node.firstChild; ch; ch = ch.nextSibling) if (ch.name === 'LinkMark') marks.push(ch);
          if (marks.length < 2) return false;
          if (isEditing(node.from, node.to)) { mark(node.from, node.to, 'cm-link-src'); return false; }
          hide(marks[0].from, marks[0].to);
          mark(marks[0].to, marks[1].from, 'cm-link', href ? { 'data-href': href } : undefined);
          hide(marks[1].from, node.to);
          return false;
        }
      },
    });
  }

  // Centred lines: <center>…</center> (as in Obsidian). The tags show only while editing the line.
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to;) {
      const line = doc.lineAt(pos);
      pos = line.to + 1;
      if (inCode.has(line.number)) continue;
      const m = line.text.match(CENTER_RE);
      if (!m) continue;
      lineClass(line.from, 'cm-center');
      const open = line.from + m[1].length, close = line.from + line.text.lastIndexOf('</center>');
      const active = isActive(line.from);
      if (active) { mark(open, open + 8, 'cm-syntax'); mark(close, close + 9, 'cm-syntax'); }
      else { hide(open, open + 8); hide(close, close + 9); }
      // A line starting with <center> is raw HTML to the Markdown grammar, so its
      // **bold**, *italic*, ~~strike~~ are drawn here by hand.
      if (m[1].trim()) continue; // after a heading/list mark the grammar handles it
      const inner = line.text.slice(m[1].length + 8, line.text.lastIndexOf('</center>'));
      const base = open + 8;
      for (const [re, cls, len] of [[/\*\*(?!\s)(.+?)(?<!\s)\*\*/g, 'cm-strong', 2], [/~~(.+?)~~/g, 'cm-strike', 2], [/(?<![*\w])\*(?![\s*])(.+?)(?<![\s*])\*(?![*\w])/g, 'cm-em', 1]]) {
        for (const x of inner.matchAll(re)) {
          const a = base + x.index, b = a + x[0].length;
          mark(a + len, b - len, cls);
          if (active) { mark(a, a + len, 'cm-syntax'); mark(b - len, b, 'cm-syntax'); } else { hide(a, a + len); hide(b - len, b); }
        }
      }
    }
  }

  // Things the Markdown grammar does not know: [[links]], ![[embeds]], #tags, ==highlight==.
  for (const { from, to } of view.visibleRanges) {
    const text = state.sliceDoc(from, to);
    const skip = (a, b) => inCode.has(doc.lineAt(a).number) ||
      replaced.some(([x, y]) => a < y && b > x) ||
      ['InlineCode', 'CodeText', 'URL'].includes(tree.resolveInner(a, 1).name);
    for (const m of text.matchAll(/(!?)\[\[([^\]\n]+?)\]\]/g)) {
      const a = from + m.index, b = a + m[0].length;
      if (skip(a, b)) continue;
      const [targetPart, alias] = m[2].split('|');
      const [target, heading = ''] = targetPart.split('#');
      if (isEditing(a, b)) { mark(a, b, 'cm-wikilink-src'); continue; }
      if (m[1]) {
        const name = target.trim();
        const url = opts.fileUrl(name);
        if (url && IMAGE_RE.test(name)) widget(a, b, new ImageWidget(url, name));
        else if (url) widget(a, b, new FileWidget(name));
        else if (IMAGE_RE.test(name)) widget(a, b, new MissingFileWidget(name));
        else widget(a, b, new LinkWidget((alias || targetPart).trim(), target.trim(), heading.trim(), Boolean(opts.resolveNote(target))));
        continue;
      }
      const shown = (alias || (heading && !target.trim() ? heading : targetPart.replace('#', ' › '))).trim();
      widget(a, b, new LinkWidget(shown, target.trim(), heading.trim(), Boolean(opts.resolveNote(target))));
    }
    for (const m of text.matchAll(/(^|\s)#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu)) {
      const a = from + m.index + m[1].length, b = a + m[2].length + 1;
      if (!skip(a, b) && tree.resolveInner(a, 1).name !== 'HeaderMark') mark(a, b, 'cm-tag', { 'data-tag': m[2] });
    }
    for (const m of text.matchAll(/==([^=\n]+)==/g)) {
      const a = from + m.index, b = a + m[0].length;
      if (skip(a, b)) continue;
      mark(a + 2, b - 2, 'cm-highlight');
      if (!isActive(a)) { hide(a, a + 2); hide(b - 2, b); } else { mark(a, a + 2, 'cm-syntax'); mark(b - 2, b, 'cm-syntax'); }
    }
  }
  hidden.sort((x, y) => x.from - y.from);
  const atomic = clean ? Decoration.set(hidden.map(h => Decoration.replace({}).range(h.from, h.to)), true) : Decoration.none;
  return { decorations: Decoration.set(out, true), hidden, atomic };
}

function livePreview(opts) {
  return ViewPlugin.fromClass(class {
    constructor(view) { Object.assign(this, buildDecorations(view, opts)); }
    update(u) {
      if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged ||
          u.transactions.some(t => t.reconfigured || t.effects.some(e => e.is(redraw)))) {
        Object.assign(this, buildDecorations(u.view, opts));
      }
    }
  }, { decorations: v => v.decorations });
}

// ---------- Clean mode: editing without visible marks ----------
// The hidden marks can't be seen, so the cursor must never stop where typing or
// deleting would break them: before a line's "# ", "- ", "> ", <center>, or after </center>.
const LINE_PREFIX_RE = /^\s*(?:#{1,6}\s+|(?:>\s?)+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)?/;
const PAIRS = ['**', '__', '~~', '==', '*', '_', '`'];

function cleanTools(plugin, opts, getView) {
  const hiddenOf = view => view?.plugin(plugin)?.hidden || [];
  // Where text may be typed on a line: after the hidden start and before a hidden </center>.
  const bounds = (view, line) => {
    const hs = hiddenOf(view);
    let start = line.from, end = line.to;
    for (let moved = true; moved;) {
      moved = false;
      for (const h of hs) if (h.from === start && h.kind !== 'widget' && h.to <= line.to) { start = h.to; moved = true; }
    }
    if (start > line.from) start = Math.max(start, line.from + line.text.match(LINE_PREFIX_RE)[0].length);
    if (CENTER_RE.test(line.text)) {
      end = line.from + line.text.lastIndexOf('</center>');
      if (start === line.from) start = line.from + line.text.match(CENTER_RE)[1].length + 8;
    }
    return { start: Math.min(start, end), end };
  };
  const centered = line => CENTER_RE.test(line.text);

  // Cursor moves and clicks (no text change): keep the cursor inside the visible text.
  const filter = EditorState.transactionFilter.of(tr => {
    const view = getView();
    if (!view || !opts.clean?.() || tr.docChanged || !tr.selection || tr.selection.ranges.length !== 1 || !tr.selection.main.empty) return tr;
    const doc = tr.newDoc, pos = tr.selection.main.head, old = tr.startState.selection.main.head;
    const line = doc.lineAt(pos), b = bounds(view, line), key = !tr.isUserEvent('select.pointer');
    let to = pos;
    if (pos < b.start) to = key && old === b.start && line.number > 1 && old > pos ? bounds(view, doc.line(line.number - 1)).end : b.start;
    else if (pos > b.end) to = key && old === b.end && line.number < doc.lines && old < pos ? bounds(view, doc.line(line.number + 1)).start : b.end;
    return to === pos ? tr : [tr, { selection: EditorSelection.cursor(to), sequential: true }];
  });

  // Joins line n with the next one: the next line loses its own "# ", "- " etc.,
  // and if the first line is centred the joined text stays inside <center>.
  const joinLines = (view, n) => {
    const doc = view.state.doc, a = doc.line(n), b = doc.line(n + 1);
    let body = b.text.slice(b.text.match(LINE_PREFIX_RE)[0].length);
    if (centered(b)) body = b.text.match(CENTER_RE)[2];
    const ab = bounds(view, a);
    const insert = a.text.slice(0, ab.end - a.from) + body + a.text.slice(ab.end - a.from);
    view.dispatch({ changes: { from: a.from, to: b.to, insert }, selection: { anchor: ab.end }, userEvent: 'delete', scrollIntoView: true });
    return true;
  };
  // After deleting a character: "****" left from an emptied **bold** goes too.
  const dropEmptyPair = (state, at) => {
    for (const m of PAIRS) if (state.sliceDoc(at - m.length, at + m.length) === m + m) return { from: at - m.length, to: at + m.length };
    return null;
  };
  const deleteAt = (view, from, to) => {
    const after = view.state.update({ changes: { from, to } }).state;
    const pair = dropEmptyPair(after, from); // measured after deleting; maps back to [from - n, to + n]
    const n = pair ? from - pair.from : 0;
    view.dispatch({ changes: { from: from - n, to: to + n }, selection: { anchor: from - n }, userEvent: 'delete', scrollIntoView: true });
    return true;
  };
  const single = view => opts.clean?.() && view.state.selection.ranges.length === 1 && view.state.selection.main.empty;
  const charBefore = (doc, p) => (/[\udc00-\udfff]/.test(doc.sliceString(p - 1, p)) ? 2 : 1);

  const backspace = view => {
    if (!single(view)) return false;
    const { doc } = view.state, pos = view.state.selection.main.head, line = doc.lineAt(pos), b = bounds(view, line);
    if (pos <= b.start) {
      const pre = line.text.match(LINE_PREFIX_RE)[0];
      // At the start of a heading, list item or quote: the line becomes plain text.
      if (pre.length) { view.dispatch({ changes: { from: line.from, to: line.from + pre.length }, userEvent: 'delete' }); return true; }
      if (centered(line)) { // a plain centred line: stop centring it
        const open = line.from + line.text.match(CENTER_RE)[1].length, close = line.from + line.text.lastIndexOf('</center>');
        view.dispatch({ changes: [{ from: open, to: open + 8 }, { from: close, to: line.to }], userEvent: 'delete' });
        return true;
      }
      return line.number > 1 ? joinLines(view, line.number - 1) : true;
    }
    let p = pos;
    const hs = hiddenOf(view);
    for (let moved = true; moved;) { moved = false; for (const h of hs) if (h.to === p && h.kind === 'hide' && h.from >= b.start) { p = h.from; moved = true; } }
    const w = hs.find(h => h.to === p && h.kind === 'widget');
    if (w) return deleteAt(view, w.from, w.to);
    if (p <= b.start) return true;
    return deleteAt(view, p - charBefore(doc, p), p);
  };
  const del = view => {
    if (!single(view)) return false;
    const { doc } = view.state, pos = view.state.selection.main.head, line = doc.lineAt(pos), b = bounds(view, line);
    if (pos >= b.end) return line.number < doc.lines ? joinLines(view, line.number) : true;
    let p = pos;
    const hs = hiddenOf(view);
    for (let moved = true; moved;) { moved = false; for (const h of hs) if (h.from === p && h.kind === 'hide' && h.to <= b.end) { p = h.to; moved = true; } }
    const w = hs.find(h => h.from === p && h.kind === 'widget');
    if (w) return deleteAt(view, w.from, w.to);
    if (p >= b.end) return true;
    return deleteAt(view, p, p + (/[\ud800-\udbff]/.test(doc.sliceString(p, p + 1)) ? 2 : 1));
  };
  // Enter inside a centred line: both halves stay centred.
  const enter = view => {
    if (!single(view)) return false;
    const pos = view.state.selection.main.head, line = view.state.doc.lineAt(pos);
    if (!centered(line)) return false;
    const insert = '</center>\n<center>';
    view.dispatch({ changes: { from: pos, insert }, selection: { anchor: pos + insert.length }, userEvent: 'input', scrollIntoView: true });
    return true;
  };
  return [
    EditorView.atomicRanges.of(view => view.plugin(plugin)?.atomic || Decoration.none),
    Prec.high(keymap.of([{ key: 'Backspace', run: backspace }, { key: 'Delete', run: del }, { key: 'Enter', run: enter }])),
    filter,
  ];
}

// ---------- [[ completion ----------
function linkCompletion(opts) {
  return ctx => {
    const m = ctx.matchBefore(/!?\[\[[^[\]\n|#]*$/);
    if (!m) return null;
    const embed = m.text.startsWith('!');
    const from = m.from + (embed ? 3 : 2);
    return {
      from,
      validFor: /^[^[\]\n|#]*$/,
      options: opts.linkTargets(embed).map(t => ({
        label: t.name,
        detail: t.detail || undefined,
        type: t.file ? 'file' : 'text',
        apply: (view, _c, a, b) => {
          const closing = view.state.sliceDoc(b, b + 2) === ']]';
          const insert = t.insert + (closing ? '' : ']]');
          view.dispatch({ changes: { from: a, to: b, insert }, selection: { anchor: a + insert.length + (closing ? 2 : 0) } });
        },
      })),
    };
  };
}

// ---------- Theme ----------
const theme = EditorView.theme({
  '&': { color: 'var(--text)', backgroundColor: 'transparent', fontSize: '16px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font)', lineHeight: '1.65', overflow: 'visible' },
  '.cm-content': { padding: '0 0 40vh', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0' },
  '.cm-line.cm-center': { textAlign: 'center' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--selection) !important' },
  '.cm-placeholder': { color: 'var(--text-muted)' },
  '.cm-tooltip': { background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '12px', boxShadow: '0 10px 30px rgb(0 0 0 / .2)', animation: 'pop-in .16s var(--ease)' },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font)', maxHeight: '16em' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '4px 10px !important' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { background: 'var(--accent)', color: 'var(--accent-text)' },
  '.cm-completionDetail': { color: 'inherit', opacity: '.7', fontStyle: 'normal', marginLeft: '8px' },
  '.cm-panels': { background: 'var(--side)', color: 'var(--text)', borderColor: 'var(--border)' },
  '.cm-search input, .cm-search button': { font: 'inherit', fontSize: '14px' },
  '.cm-searchMatch': { backgroundColor: 'var(--mark)' },
  '.cm-find': { backgroundColor: 'var(--mark)', borderRadius: '2px' },
  '.cm-find-cur': { backgroundColor: 'var(--accent)', color: 'var(--bg)' },
});

// ---------- Public API ----------
export function createEditor(parent, opts) {
  const preview = livePreview(opts);
  let viewRef = null;
  const extensions = [
        history(),
        drawSelection(),
        dropCursor(),
        EditorView.lineWrapping,
        indentUnit.of('    '),
        EditorState.tabSize.of(4),
        markdown({ base: markdownLanguage, addKeymap: true }),
        closeBrackets(),
        autocompletion({ override: [linkCompletion(opts)], icons: false, activateOnTyping: true }),
        search({ top: true }),
        findField,
        placeholder('Начните писать. [[Название]] создаёт ссылку на другую заметку, #тег добавляет тег.'),
        keymap.of([...closeBracketsKeymap, ...completionKeymap, ...markdownKeymap, ...searchKeymap, ...historyKeymap, ...defaultKeymap, indentWithTab]),
        preview,
        cleanTools(preview, opts, () => viewRef),
        theme,
        EditorView.contentAttributes.of({ spellcheck: 'true', autocapitalize: 'sentences', 'aria-label': 'Текст заметки' }),
        EditorView.updateListener.of(u => {
          if (u.docChanged && !u.transactions.some(t => t.annotation(fromOutside))) opts.onChange(u.state.doc.toString());
        }),
        EditorView.domEventHandlers({
          mousedown(e, v) {
            const link = e.target.closest('.cm-wikilink');
            if (link) { e.preventDefault(); opts.openLink(link.dataset.target, link.dataset.heading || ''); return true; }
            const file = e.target.closest('.cm-file');
            if (file) { e.preventDefault(); opts.openFile(file.dataset.file); return true; }
            const box = e.target.closest('.cm-task');
            if (box) {
              e.preventDefault();
              const pos = v.posAtDOM(box);
              const cur = v.state.sliceDoc(pos, pos + 3);
              if (/^\[[ xX]\]$/.test(cur)) v.dispatch({ changes: { from: pos, to: pos + 3, insert: cur === '[ ]' ? '[x]' : '[ ]' } });
              return true;
            }
            const ext = e.target.closest('.cm-link[data-href]');
            if (ext && (e.ctrlKey || e.metaKey || !v.hasFocus)) { e.preventDefault(); window.open(ext.dataset.href, '_blank', 'noopener'); return true; }
            const tag = e.target.closest('.cm-tag');
            if (tag && (e.ctrlKey || e.metaKey)) { e.preventDefault(); opts.openTag(tag.dataset.tag); return true; }
            if (e.ctrlKey || e.metaKey) {
              const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
              if (pos != null) {
                const line = v.state.doc.lineAt(pos);
                for (const m of line.text.matchAll(/\[\[([^\]\n]+?)\]\]/g)) {
                  if (pos >= line.from + m.index && pos <= line.from + m.index + m[0].length) {
                    const [t, h = ''] = m[1].split('|')[0].split('#');
                    e.preventDefault(); opts.openLink(t.trim(), h.trim()); return true;
                  }
                }
              }
            }
            return false;
          },
          paste(e, v) {
            const files = [...(e.clipboardData?.files || [])];
            if (!files.length) return false;
            e.preventDefault();
            insertFiles(v, files, v.state.selection.main.from);
            return true;
          },
          drop(e, v) {
            const files = [...(e.dataTransfer?.files || [])];
            if (!files.length) return false;
            e.preventDefault();
            const pos = v.posAtCoords({ x: e.clientX, y: e.clientY }) ?? v.state.selection.main.from;
            insertFiles(v, files, pos);
            return true;
          },
        }),
  ];
  const view = new EditorView({ parent, state: EditorState.create({ doc: '', extensions }) });
  viewRef = view;
  // "Insert picture, video or file" from the menu: goes exactly where the menu was opened.
  const picker = Object.assign(document.createElement('input'), { type: 'file', multiple: true, hidden: true,
    accept: 'image/*,video/*,audio/*,application/pdf,.txt,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip' });
  document.body.append(picker);
  let pickAt = null;
  picker.addEventListener('change', async () => {
    const files = [...picker.files];
    picker.value = '';
    if (!files.length || pickAt === null) return;
    const snippets = await opts.saveFiles(files);
    if (!snippets.length) return;
    const pos = Math.min(pickAt, view.state.doc.length);
    const insert = snippets.join('\n');
    view.dispatch({ changes: { from: pos, insert }, selection: { anchor: pos + insert.length } });
    view.focus();
  });
  attachEditMenu(view, { insertMedia: pos => { pickAt = pos; picker.click(); } });
  installMenuDismiss();

  async function insertFiles(v, files, pos) {
    const snippets = await opts.saveFiles(files);
    if (!snippets.length) return;
    const line = v.state.doc.lineAt(pos);
    const before = pos > line.from ? '\n' : '';
    const insert = before + snippets.join('\n') + '\n';
    v.dispatch({ changes: { from: pos, insert }, selection: { anchor: pos + insert.length } });
    v.focus();
  }

  return {
    view,
    getDoc: () => view.state.doc.toString(),
    // Open another note: new text, cursor at the start, its own undo history.
    load(text) {
      view.setState(EditorState.create({ doc: text, extensions }));
    },
    // The same note changed elsewhere (sync): replace the text without reporting it
    // as an edit and without putting it into undo history; keep the cursor near.
    setDoc(text) {
      const cur = view.state.doc.toString();
      if (cur === text) return;
      const sel = view.state.selection.main;
      view.dispatch({
        changes: { from: 0, to: cur.length, insert: text },
        selection: { anchor: Math.min(sel.anchor, text.length), head: Math.min(sel.head, text.length) },
        annotations: [fromOutside.of(true), Transaction.addToHistory.of(false)],
      });
    },
    focus() { view.focus(); },
    insertAtCursor(text) {
      const { from, to } = view.state.selection.main;
      view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
      view.focus();
    },
    insertFiles: files => insertFiles(view, files, view.state.selection.main.from),
    // Links or files changed elsewhere: redraw link colours and images.
    refresh() { view.dispatch({ effects: redraw.of(null) }); },
    // The clean-mode setting changed: redraw marks (opts.clean is read on every redraw).
    setClean() { view.dispatch({ effects: redraw.of(null) }); },
    // Highlights every match of query and scrolls to match number index; returns how many there are.
    find(query, index = 0, scroll = true) {
      const q = findNorm(query), hits = [];
      if (q) {
        const low = findNorm(view.state.doc.toString());
        for (let i = low.indexOf(q); i >= 0 && hits.length < 5000; i = low.indexOf(q, i + q.length)) hits.push(i);
      }
      const cur = hits.length ? ((index % hits.length) + hits.length) % hits.length : -1;
      const deco = Decoration.set(hits.map((h, i) => (i === cur ? findCur : findMark).range(h, h + q.length)));
      view.dispatch({ effects: cur >= 0 && scroll ? [setFind.of(deco), EditorView.scrollIntoView(hits[cur], { y: 'center' })] : [setFind.of(deco)] });
      return { count: hits.length, index: cur };
    },
  };
}
