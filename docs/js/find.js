// Search inside the open note: a bar under the top bar with a field, "3 из 12",
// previous / next and close. Works both in the editor and in reading mode.
// On a phone it is opened by the magnifier button (there is no Ctrl+F there).
import { findNorm } from './editor.js';

const $ = id => document.getElementById(id);

export function initFind({ ed, isReading, preview }) {
  const bar = $('findBar'), input = $('findInput'), count = $('findCount');
  let index = 0, total = 0;

  // Reading mode: wrap matches in <mark class="find-hit"> inside the rendered note.
  function clearPreview() {
    for (const m of preview.querySelectorAll('mark.find-hit')) m.replaceWith(...m.childNodes);
    preview.normalize();
  }
  function markPreview(query) {
    clearPreview();
    const q = findNorm(query), hits = [];
    if (!q) return hits;
    const walker = document.createTreeWalker(preview, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const low = findNorm(node.data), at = [];
      for (let i = low.indexOf(q); i >= 0; i = low.indexOf(q, i + q.length)) at.push(i);
      // Split from the end so earlier offsets stay valid.
      const marks = [];
      for (let k = at.length - 1; k >= 0; k--) {
        const hit = node.splitText(at[k]);
        hit.splitText(q.length);
        const m = document.createElement('mark');
        m.className = 'find-hit';
        hit.replaceWith(m);
        m.append(hit);
        marks.unshift(m);
      }
      hits.push(...marks);
    }
    return hits;
  }

  function run(scroll = true) {
    const query = input.value;
    if (isReading()) {
      ed.find('');
      const hits = markPreview(query);
      total = hits.length;
      index = total ? ((index % total) + total) % total : 0;
      if (total) {
        hits[index].classList.add('cur');
        if (scroll) hits[index].scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      }
    } else {
      clearPreview();
      const r = ed.find(query, index, scroll);
      total = r.count;
      index = Math.max(0, r.index);
    }
    count.textContent = !query.trim() ? '' : total ? `${index + 1} из ${total}` : 'Нет';
    count.classList.toggle('none', Boolean(query.trim()) && !total);
    $('findPrev').disabled = $('findNext').disabled = total < 2;
  }

  const open = () => {
    bar.hidden = false;
    $('findBtn').setAttribute('aria-expanded', 'true');
    input.focus();
    input.select();
    if (input.value) run();
  };
  const close = () => {
    if (bar.hidden) return;
    bar.hidden = true;
    $('findBtn').setAttribute('aria-expanded', 'false');
    ed.find('');
    clearPreview();
  };
  const step = d => { index += d; run(); };

  $('findBtn').addEventListener('click', () => (bar.hidden ? open() : close()));
  input.addEventListener('input', () => { index = 0; run(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  $('findPrev').addEventListener('click', () => step(-1));
  $('findNext').addEventListener('click', () => step(1));
  $('findClose').addEventListener('click', close);

  return {
    close,
    // The note was redrawn (sync, switching edit/read): put the highlights back without jumping.
    refresh() { if (!bar.hidden) run(false); },
  };
}
