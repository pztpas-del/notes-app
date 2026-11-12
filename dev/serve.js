// Local development server: serves ../docs and a small in-memory imitation of the
// GitHub Git Data API at /mock-github, so sync can be tested without a real account.
// Run: node dev/serve.js   (then open http://localhost:5173)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', 'docs');
const PORT = Number(process.env.PORT) || 5173;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm',
  '.css': 'text/css; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json',
};

// ---------- Mock Git storage ----------
const store = { blobs: new Map(), trees: new Map(), commits: new Map(), head: null };
const sha1 = data => crypto.createHash('sha1').update(data).digest('hex');
const blobSha = buf => sha1(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf]));
function putBlob(buf) { const s = blobSha(buf); store.blobs.set(s, buf); return s; }
function putTree(map) { const s = sha1(JSON.stringify([...map].sort())); store.trees.set(s, new Map(map)); return s; }
function putCommit(tree, parents, message) {
  const s = sha1(tree + parents.join(',') + message + Date.now() + Math.random());
  store.commits.set(s, { tree, parents, message }); return s;
}
function headTree() { return new Map(store.trees.get(store.commits.get(store.head).tree)); }
function commitFiles(changes, message) {
  const t = headTree();
  for (const [p, content] of Object.entries(changes)) {
    if (content === null) t.delete(p); else t.set(p, putBlob(Buffer.from(content, 'utf8')));
  }
  store.head = putCommit(putTree(t), [store.head], message);
}
store.head = putCommit(putTree(new Map([['README.md', putBlob(Buffer.from('# Заметки\n', 'utf8'))]])), [], 'init');

function isAncestor(ancestor, sha) {
  const seen = new Set(); const stack = [sha];
  while (stack.length) {
    const s = stack.pop(); if (s === ancestor) return true;
    if (seen.has(s) || !store.commits.has(s)) continue; seen.add(s);
    stack.push(...store.commits.get(s).parents);
  }
  return false;
}

function send(res, status, body, extra = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, X-GitHub-Api-Version',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    ...extra,
  });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

function mock(req, res, url, body) {
  if (req.method === 'OPTIONS') return send(res, 204);
  const p = url.pathname.replace(/^\/mock-github/, '');
  // Test hooks (not part of GitHub's API): look at or change the "remote" as another device would.
  if (p === '/_files') {
    const out = {}; for (const [k, s] of headTree()) out[k] = store.blobs.get(s).toString('utf8');
    return send(res, 200, out);
  }
  if (p === '/_edit' && req.method === 'POST') { commitFiles(body.changes, 'edit from another device'); return send(res, 200, { ok: true }); }

  if (!/^Bearer \S+/.test(req.headers.authorization || '')) return send(res, 401, { message: 'Bad credentials' });
  const m = p.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
  if (!m) return send(res, 404, { message: 'Not Found' });
  const rest = m[3] || '';
  let r;
  if (rest === '' && req.method === 'GET') return send(res, 200, { full_name: `${m[1]}/${m[2]}`, default_branch: 'main', private: true, permissions: { push: true } });
  if ((r = rest.match(/^\/git\/ref\/heads\/(.+)$/)) && req.method === 'GET') {
    if (r[1] !== 'main') return send(res, 404, { message: 'Not Found' });
    return send(res, 200, { ref: 'refs/heads/main', object: { sha: store.head, type: 'commit' } });
  }
  if ((r = rest.match(/^\/git\/commits\/([0-9a-f]+)$/)) && req.method === 'GET') {
    const c = store.commits.get(r[1]); if (!c) return send(res, 404, { message: 'Not Found' });
    return send(res, 200, { sha: r[1], tree: { sha: c.tree }, parents: c.parents.map(sha => ({ sha })), message: c.message });
  }
  if ((r = rest.match(/^\/git\/trees\/([0-9a-f]+)$/)) && req.method === 'GET') {
    const t = store.trees.get(r[1]); if (!t) return send(res, 404, { message: 'Not Found' });
    return send(res, 200, { sha: r[1], truncated: false, tree: [...t].map(([path, sha]) => ({ path, mode: '100644', type: 'blob', sha, size: store.blobs.get(sha).length })) });
  }
  if ((r = rest.match(/^\/git\/blobs\/([0-9a-f]+)$/)) && req.method === 'GET') {
    const b = store.blobs.get(r[1]); if (!b) return send(res, 404, { message: 'Not Found' });
    return send(res, 200, { sha: r[1], encoding: 'base64', content: b.toString('base64').replace(/(.{60})/g, '$1\n'), size: b.length });
  }
  if (rest === '/git/blobs' && req.method === 'POST') {
    const buf = Buffer.from(body.content || '', body.encoding === 'base64' ? 'base64' : 'utf8');
    return send(res, 201, { sha: putBlob(buf) });
  }
  if (rest === '/git/trees' && req.method === 'POST') {
    const base = body.base_tree ? store.trees.get(body.base_tree) : new Map();
    if (!base) return send(res, 422, { message: 'Invalid base_tree' });
    const t = new Map(base);
    for (const e of body.tree) {
      if (e.sha === null) { if (!t.has(e.path)) return send(res, 422, { message: `Path not found: ${e.path}` }); t.delete(e.path); }
      else if (typeof e.content === 'string') t.set(e.path, putBlob(Buffer.from(e.content, 'utf8')));
      else t.set(e.path, e.sha);
    }
    return send(res, 201, { sha: putTree(t) });
  }
  if (rest === '/git/commits' && req.method === 'POST') {
    if (!store.trees.has(body.tree)) return send(res, 422, { message: 'Tree not found' });
    return send(res, 201, { sha: putCommit(body.tree, body.parents || [], body.message || '') });
  }
  if ((r = rest.match(/^\/git\/refs\/heads\/(.+)$/)) && req.method === 'PATCH') {
    if (!store.commits.has(body.sha)) return send(res, 422, { message: 'Object does not exist' });
    if (!body.force && !isAncestor(store.head, body.sha)) return send(res, 422, { message: 'Update is not a fast forward' });
    store.head = body.sha;
    return send(res, 200, { ref: 'refs/heads/main', object: { sha: store.head } });
  }
  return send(res, 404, { message: 'Not Found' });
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname.startsWith('/mock-github')) {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { return send(res, 400, { message: 'Bad JSON' }); }
      mock(req, res, url, body);
    });
    return;
  }
  let file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`Notes app: http://localhost:${PORT}  (mock GitHub API: /mock-github)`));
