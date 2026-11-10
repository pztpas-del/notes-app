// The note editor: CodeMirror with an Obsidian-style live preview. Markdown
// marks (#, **, [[ ]] …) are hidden everywhere except on the lines being edited,
// links and checkboxes are clickable, and images are shown in place.
import {
  EditorState, EditorView, ViewPlugin, Decoration, WidgetType, Annotation, StateEffect, Transaction, keymap,
  drawSelection, placeholder, dropCursor, defaultKeymap, history, historyKeymap, indentWithTab,
  markdown, markdownLanguage, markdownKeymap, syntaxTree, indentUnit,
  autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap, search, searchKeymap,
} from '../vendor/codemirror.js';
import { attachEditMenu, installMenuDismiss } from './editmenu.js';

const fromOutside = Annotation.define();
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

function buildDecorations(view, opts) {
  const { state } = view;
  const doc = state.doc;
  const active = activeLineNumbers(view);
  const isActive = (from, to = from) => {
    const a = doc.lineAt(from).number, b = doc.lineAt(to).number;
    for (let n = a; n <= b; n++) if (active.has(n)) return true;
    return false;
  };
  const out = [];
  const hide = (from, to) => { if (to > from) out.push(Decoration.replace({}).range(from, to)); };
  const mark = (from, to, cls, attrs) => { if (to > from) out.push(Decoration.mark({ class: cls, attributes: attrs }).range(from, to)); };
  const lineClass = (pos, cls) => out.push(Decoration.line({ class: cls }).range(doc.lineAt(pos).from));
  const replaced = []; // ranges already turned into widgets, so later matches skip them
  const widget = (from, to, w) => { out.push(Decoration.replace({ widget: w }).range(from, to)); replaced.push([from, to]); };
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
          if (isActive(node.from)) return false;
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
          if (isActive(node.from)) { mark(node.from, node.to, 'cm-link-src'); return false; }
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
      if (isActive(a)) { mark(a, b, 'cm-wikilink-src'); continue; }
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
  return Decoration.set(out, true);
}

function livePreview(opts) {
  return ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = buildDecorations(view, opts); }
    update(u) {
      if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged ||
          u.transactions.some(t => t.reconfigured || t.effects.some(e => e.is(redraw)))) {
        this.decorations = buildDecorations(u.view, opts);
      }
    }
  }, { decorations: v => v.decorations });
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
});

// ---------- Public API ----------
export function createEditor(parent, opts) {
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
        placeholder('Начните писать. [[Название]] создаёт ссылку на другую заметку, #тег добавляет тег.'),
        keymap.of([...closeBracketsKeymap, ...completionKeymap, ...markdownKeymap, ...searchKeymap, ...historyKeymap, ...defaultKeymap, indentWithTab]),
        livePreview(opts),
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
  attachEditMenu(view);
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
  };
}
