// A small Markdown renderer covering what notes use most, plus [[wikilinks]],
// #tags, tasks, callouts and tables. Everything is escaped; only http(s) and
// mailto links are allowed.
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = s => esc(s).replace(/"/g, '&quot;');
const safeUrl = u => /^(https?:|mailto:)/i.test(u);
export const slug = s => s.toLowerCase().trim().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');

function wikilink(inner, ctx) {
  const [targetPart, alias] = inner.split('|');
  const [target, heading = ''] = targetPart.split('#');
  const path = ctx.resolve(target);
  const text = alias?.trim() || (heading && !target.trim() ? heading : targetPart.replace('#', ' › '));
  return `<a class="wikilink${path ? '' : ' unresolved'}" href="#" data-target="${attr(target.trim())}"` +
    `${heading ? ` data-heading="${attr(slug(heading))}"` : ''}>${esc(text.trim())}</a>`;
}

function inline(src, ctx) {
  const slots = [];
  const keep = html => `\u0000${slots.push(html) - 1}\u0000`;
  let s = src
    .replace(/`([^`\n]+)`/g, (_, c) => keep(`<code>${esc(c)}</code>`))
    .replace(/!?\[\[([^\]\n]+?)\]\]/g, (_, inner) => keep(wikilink(inner, ctx)))
    .replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, (m, alt, url) => safeUrl(url) ? keep(`<img alt="${attr(alt)}" src="${attr(url)}" loading="lazy">`) : m)
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, text, url) => safeUrl(url) ? keep(`<a href="${attr(url)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>`) : m)
    .replace(/(^|[\s(])(https?:\/\/[^\s<>()]+[^\s<>().,;:!?])/g, (_, pre, url) => pre + keep(`<a href="${attr(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>`));
  s = esc(s)
    .replace(/(^|\s)#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu, (_, pre, tag) => `${pre}<a class="tag" href="#" data-tag="${tag}">#${tag}</a>`)
    .replace(/\*\*(?=\S)(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(?=\S)(.+?)__/g, '<strong>$1</strong>')
    .replace(/\*(?=\S)(.+?)\*/g, '<em>$1</em>')
    .replace(/(^|[^\p{L}\p{N}_])_(?=\S)(.+?)_(?![\p{L}\p{N}_])/gu, '$1<em>$2</em>')
    .replace(/~~(.+?)~~/g, '<del>$1</del>')
    .replace(/==(.+?)==/g, '<mark>$1</mark>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[Number(i)]);
}

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const isBlockStart = (line, next) =>
  /^(#{1,6})\s/.test(line) || /^(```|~~~)/.test(line) || /^>/.test(line) || LIST_RE.test(line) ||
  /^\s*([-*_])(\s*\1){2,}\s*$/.test(line) || (line.includes('|') && next !== undefined && TABLE_SEP.test(next));

function cells(row) {
  return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
}

// lineOffset: where these lines start in the note, so checkboxes can be toggled.
function blocks(lines, ctx, lineOffset) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    let m;
    if ((m = line.match(/^(```|~~~)\s*([\w-]*)/))) {
      const fence = m[1], body = [];
      i++;
      while (i < lines.length && !lines[i].startsWith(fence)) body.push(lines[i++]);
      i++;
      out.push(`<pre><code${m[2] ? ` data-lang="${attr(m[2])}"` : ''}>${esc(body.join('\n'))}</code></pre>`);
      continue;
    }
    if ((m = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/))) {
      const n = m[1].length;
      out.push(`<h${n} id="${attr(slug(m[2]))}">${inline(m[2], ctx)}</h${n}>`);
      i++; continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (line.startsWith('>')) {
      const body = [];
      while (i < lines.length && lines[i].startsWith('>')) body.push(lines[i++].replace(/^>\s?/, ''));
      const callout = body[0]?.match(/^\[!(\w+)\][+-]?\s*(.*)$/);
      if (callout) {
        const type = callout[1].toLowerCase();
        const title = callout[2] || type.charAt(0).toUpperCase() + type.slice(1);
        out.push(`<div class="callout" data-type="${attr(type)}"><div class="callout-title">${inline(title, ctx)}</div>${blocks(body.slice(1), ctx, null)}</div>`);
      } else out.push(`<blockquote>${blocks(body, ctx, null)}</blockquote>`);
      continue;
    }
    if (LIST_RE.test(line)) {
      const items = [];
      while (i < lines.length) {
        const lm = lines[i].match(LIST_RE);
        if (lm) {
          items.push({ indent: lm[1].replace(/\t/g, '    ').length, ordered: /\d/.test(lm[2]), start: parseInt(lm[2], 10), text: lm[3], line: lineOffset === null ? null : lineOffset + i });
          i++;
        } else if (lines[i].trim() && /^\s+/.test(lines[i]) && items.length) {
          items[items.length - 1].text += '\n' + lines[i].trim(); i++;
        } else break;
      }
      out.push(list(items, ctx));
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const head = cells(line);
      const align = cells(lines[i + 1]).map(c => c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : '');
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      const td = (tag, c, k) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ''}>${inline(c, ctx)}</${tag}>`;
      out.push(`<div class="table-wrap"><table><thead><tr>${head.map((c, k) => td('th', c, k)).join('')}</tr></thead>` +
        `<tbody>${rows.map(r => `<tr>${head.map((_, k) => td('td', r[k] || '', k)).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !(para.length && isBlockStart(lines[i], lines[i + 1]))) para.push(lines[i++]);
    out.push(`<p>${para.map(l => inline(l, ctx)).join('<br>')}</p>`);
  }
  return out.join('\n');
}

function list(items, ctx) {
  let html = '';
  const stack = [];
  for (const it of items) {
    while (stack.length && it.indent < stack[stack.length - 1].indent) html += `</li></${stack.pop().tag}>`;
    const top = stack[stack.length - 1];
    if (!top || it.indent > top.indent) {
      const tag = it.ordered ? 'ol' : 'ul';
      stack.push({ indent: it.indent, tag });
      html += it.ordered && it.start !== 1 ? `<ol start="${it.start}">` : `<${tag}>`;
    } else html += '</li>';
    const task = it.text.match(/^\[( |x|X)\]\s*(.*)$/s);
    const text = task ? task[2] : it.text;
    const body = text.split('\n').map(l => inline(l, ctx)).join('<br>');
    if (task) {
      const done = task[1] !== ' ';
      html += `<li class="task${done ? ' done' : ''}"><input type="checkbox"${done ? ' checked' : ''}` +
        `${it.line === null ? ' disabled' : ` data-line="${it.line}"`} aria-label="Отметить задачу"> ${body}`;
    } else html += `<li>${body}`;
  }
  while (stack.length) html += `</li></${stack.pop().tag}>`;
  return html;
}

// Returns HTML for a note. ctx.resolve(target) gives the note path or null.
export function render(src, ctx) {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  let start = 0, props = '';
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) {
      const rows = lines.slice(1, end).filter(l => l.trim()).map(l => {
        const k = l.indexOf(':');
        return k > 0 ? `<dt>${esc(l.slice(0, k).trim())}</dt><dd>${esc(l.slice(k + 1).trim())}</dd>` : `<dd>${esc(l)}</dd>`;
      });
      if (rows.length) props = `<dl class="props">${rows.join('')}</dl>`;
      start = end + 1;
    }
  }
  return props + blocks(lines.slice(start), ctx, start);
}
