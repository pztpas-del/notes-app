// Force-directed graph of notes on a canvas: drag nodes, pan, zoom (wheel or
// pinch), hover to highlight neighbours, click to open.
export class GraphView {
  constructor(canvas, { onOpen }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onOpen = onOpen;
    this.nodes = []; this.edges = []; this.adj = [];
    this.view = { x: 0, y: 0, k: 1 };
    this.alpha = 0; this.raf = 0; this.active = false;
    this.hover = -1; this.current = null;
    this.pointers = new Map(); this.drag = null;
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.bindPointer();
  }

  // refit: settle the layout and fit it to the view (used when the set of notes changes).
  setData({ nodes, edges }, current, refit = false) {
    const old = new Map(this.nodes.map(n => [n.id, n]));
    const fresh = !this.nodes.length || refit;
    const sig = nodes.map(n => n.id).join('\n') + '|' + edges.map(e => e.join('>')).join('\n');
    const same = sig === this.sig;
    this.sig = sig;
    if (same && !fresh) { // nothing moved: just repaint (e.g. while typing in the note)
      const idx = this.nodes.findIndex(n => n.id === current);
      this.current = idx;
      this.draw();
      return;
    }
    this.nodes = nodes.map((n, i) => {
      const o = old.get(n.id);
      const a = i * 2.39996, r = 12 * Math.sqrt(i + 1);
      return { ...n, x: o ? o.x : Math.cos(a) * r, y: o ? o.y : Math.sin(a) * r, vx: 0, vy: 0, fixed: false };
    });
    const index = new Map(this.nodes.map((n, i) => [n.id, i]));
    this.edges = edges.map(([a, b]) => [index.get(a), index.get(b)]).filter(([a, b]) => a !== undefined && b !== undefined);
    this.adj = this.nodes.map(() => new Set());
    for (const [a, b] of this.edges) { this.adj[a].add(b); this.adj[b].add(a); }
    this.current = index.has(current) ? index.get(current) : -1;
    this.hover = -1;
    this.alpha = 1;
    if (fresh || old.size === 0) {
      for (let i = 0; i < 160 && this.alpha > 0.03; i++) this.tick();
      this.fit();
    }
    this.start();
  }

  show(on) { this.active = on; if (on) { this.resize(); this.start(); } }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.w = r.width; this.h = r.height;
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.draw();
  }

  fit() {
    if (!this.nodes.length || !this.w) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of this.nodes) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y); }
    const k = Math.min(2, (this.w - 80) / Math.max(x1 - x0, 1), (this.h - 80) / Math.max(y1 - y0, 1));
    this.view = { k: Math.max(0.2, k), x: -((x0 + x1) / 2) * Math.max(0.2, k), y: -((y0 + y1) / 2) * Math.max(0.2, k) };
  }

  start() {
    if (!this.active || this.raf) return;
    const loop = () => {
      this.raf = 0;
      if (!this.active) return;
      if (this.alpha > 0.005 || this.drag) this.tick();
      this.draw();
      if (this.alpha > 0.005 || this.drag || this.pointers.size) this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  tick() {
    const N = this.nodes, a = this.alpha;
    for (let i = 0; i < N.length; i++) {
      const p = N[i];
      for (let j = i + 1; j < N.length; j++) {
        const q = N[j];
        let dx = p.x - q.x, dy = p.y - q.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
        if (d2 > 160000) continue;
        const f = (1400 / d2) * a;
        const d = Math.sqrt(d2);
        p.vx += dx / d * f; p.vy += dy / d * f;
        q.vx -= dx / d * f; q.vy -= dy / d * f;
      }
    }
    for (const [i, j] of this.edges) {
      const p = N[i], q = N[j];
      const dx = q.x - p.x, dy = q.y - p.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - 70) * 0.05 * a;
      p.vx += dx / d * f; p.vy += dy / d * f;
      q.vx -= dx / d * f; q.vy -= dy / d * f;
    }
    for (const n of N) {
      n.vx -= n.x * 0.006 * a; n.vy -= n.y * 0.006 * a;
      if (n.fixed) { n.vx = 0; n.vy = 0; continue; }
      n.vx *= 0.55; n.vy *= 0.55;
      n.x += n.vx; n.y += n.vy;
    }
    this.alpha *= 0.985;
  }

  radius(n) { return 4 + Math.min(8, Math.sqrt(n.deg) * 1.8); }
  toWorld(sx, sy) { return { x: (sx - this.w / 2 - this.view.x) / this.view.k, y: (sy - this.h / 2 - this.view.y) / this.view.k }; }
  hit(sx, sy) {
    const p = this.toWorld(sx, sy);
    let best = -1, bestD = Infinity;
    this.nodes.forEach((n, i) => {
      const d = Math.hypot(n.x - p.x, n.y - p.y);
      const reach = this.radius(n) + 10 / this.view.k;
      if (d < reach && d < bestD) { best = i; bestD = d; }
    });
    return best;
  }

  draw() {
    const { ctx, canvas } = this;
    if (!this.w) return;
    const css = getComputedStyle(canvas);
    const col = name => css.getPropertyValue(name).trim();
    const c = { line: col('--graph-line'), node: col('--graph-node'), missing: col('--graph-missing'), accent: col('--accent'), text: col('--text'), muted: col('--text-muted'), bg: col('--bg') };
    const dpr = canvas.width / this.w;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.translate(this.w / 2 + this.view.x, this.h / 2 + this.view.y);
    ctx.scale(this.view.k, this.view.k);

    const focus = this.hover >= 0 ? this.hover : -1;
    const lit = focus >= 0 ? new Set([focus, ...this.adj[focus]]) : null;
    ctx.lineWidth = 1 / this.view.k;
    for (const [i, j] of this.edges) {
      const on = lit && (i === focus || j === focus);
      ctx.strokeStyle = on ? c.accent : c.line;
      ctx.globalAlpha = lit && !on ? 0.25 : 1;
      ctx.beginPath(); ctx.moveTo(this.nodes[i].x, this.nodes[i].y); ctx.lineTo(this.nodes[j].x, this.nodes[j].y); ctx.stroke();
    }
    this.nodes.forEach((n, i) => {
      ctx.globalAlpha = lit && !lit.has(i) ? 0.3 : 1;
      ctx.fillStyle = i === focus || i === this.current ? c.accent : n.exists ? c.node : c.missing;
      ctx.beginPath(); ctx.arc(n.x, n.y, this.radius(n), 0, Math.PI * 2); ctx.fill();
    });
    const fontSize = 12 / Math.max(this.view.k, 0.6);
    ctx.font = `${fontSize}px system-ui, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    this.nodes.forEach((n, i) => {
      const show = this.view.k > 0.9 || i === this.current || (lit && lit.has(i));
      if (!show) return;
      ctx.globalAlpha = lit && !lit.has(i) ? 0.3 : 1;
      ctx.fillStyle = i === focus ? c.text : c.muted;
      const label = n.label.length > 28 ? n.label.slice(0, 27) + '…' : n.label;
      ctx.fillText(label, n.x, n.y + this.radius(n) + 3);
    });
    ctx.globalAlpha = 1;
  }

  bindPointer() {
    const cv = this.canvas;
    const pos = e => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    cv.addEventListener('pointerdown', e => {
      cv.setPointerCapture(e.pointerId);
      const p = pos(e);
      this.pointers.set(e.pointerId, p);
      if (this.pointers.size === 2) { this.drag = { type: 'pinch', ...this.pinchState() }; return; }
      const i = this.hit(p.x, p.y);
      this.drag = { type: i >= 0 ? 'node' : 'pan', i, start: p, last: p, moved: false };
      if (i >= 0) { this.nodes[i].fixed = true; this.alpha = Math.max(this.alpha, 0.3); }
      this.start();
    });
    cv.addEventListener('pointermove', e => {
      const p = pos(e);
      if (!this.drag) {
        const h = this.hit(p.x, p.y);
        if (h !== this.hover) { this.hover = h; cv.style.cursor = h >= 0 ? 'pointer' : 'grab'; this.draw(); }
        return;
      }
      this.pointers.set(e.pointerId, p);
      const d = this.drag;
      if (d.type === 'pinch' && this.pointers.size === 2) {
        const now = this.pinchState();
        const k = Math.min(4, Math.max(0.15, d.k * now.dist / d.dist));
        this.zoomTo(k, now.mid, d);
        return;
      }
      if (Math.hypot(p.x - d.start.x, p.y - d.start.y) > 4) d.moved = true;
      if (d.type === 'node') {
        const w = this.toWorld(p.x, p.y);
        Object.assign(this.nodes[d.i], { x: w.x, y: w.y });
        this.alpha = Math.max(this.alpha, 0.3);
      } else if (d.type === 'pan') {
        this.view.x += p.x - d.last.x; this.view.y += p.y - d.last.y;
      }
      d.last = p;
      this.draw();
    });
    const end = e => {
      this.pointers.delete(e.pointerId);
      const d = this.drag;
      if (!d) return;
      if (d.type === 'pinch') { this.drag = null; return; }
      if (d.type === 'node') this.nodes[d.i].fixed = false;
      if (!d.moved && e.type === 'pointerup' && d.i >= 0) this.onOpen(this.nodes[d.i]);
      this.drag = null;
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('pointerleave', () => { if (!this.drag && this.hover !== -1) { this.hover = -1; this.draw(); } });
    cv.addEventListener('wheel', e => {
      e.preventDefault();
      const p = pos(e);
      const k = Math.min(4, Math.max(0.15, this.view.k * Math.exp(-e.deltaY * 0.0015)));
      this.zoomTo(k, p, null);
    }, { passive: false });
  }

  pinchState() {
    const [a, b] = [...this.pointers.values()];
    return { dist: Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, k: this.view.k };
  }

  // Zoom keeping the world point under `at` (screen coordinates) in place.
  zoomTo(k, at) {
    const w = this.toWorld(at.x, at.y);
    this.view.k = k;
    this.view.x = at.x - this.w / 2 - w.x * k;
    this.view.y = at.y - this.h / 2 - w.y * k;
    this.draw();
  }
}
