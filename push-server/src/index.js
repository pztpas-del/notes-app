// Push server for the notes app's calendar (Cloudflare Worker + D1).
// The app uploads the list of upcoming reminders; every minute the worker
// sends the ones that are due as push notifications to the user's devices,
// so they arrive even when the app is closed.
//
// Access: the first app that calls /claim sets the access key (the app keeps
// it in the private notes repository, so all the user's devices share it).
import { generateVapid, sendPush } from './webpush.js';

const ALLOWED = ['https://pztpas-del.github.io', 'http://localhost:5173'];
const SUBJECT = 'https://pztpas-del.github.io/notes-app/';
const MAX_LATE = 6 * 3600e3; // a reminder older than this is no longer sent

const cors = origin => ({
  'Access-Control-Allow-Origin': ALLOWED.includes(origin) ? origin : ALLOWED[0],
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, authorization',
  'Access-Control-Max-Age': '86400',
  Vary: 'Origin',
});
const json = (obj, status, origin) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...cors(origin) } });

async function get(env, k, fallback) {
  const row = await env.DB.prepare('SELECT v FROM kv WHERE k = ?').bind(k).first();
  return row ? JSON.parse(row.v) : fallback;
}
async function put(env, k, v) {
  await env.DB.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, JSON.stringify(v)).run();
}

async function vapidKeys(env) {
  let v = await get(env, 'vapid', null);
  if (!v) { v = await generateVapid(); await put(env, 'vapid', v); }
  return v;
}

const safeEqual = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

// Sends due reminders. Returns how many messages went out.
async function deliver(env, now = Date.now()) {
  const schedule = await get(env, 'schedule', []);
  const sent = await get(env, 'sent', {});
  const due = schedule.filter(i => i.at <= now && i.at > now - MAX_LATE && !sent[i.id]);
  if (!due.length) return 0;
  let subs = await get(env, 'subs', []);
  const vapid = await vapidKeys(env);
  const gone = new Set();
  let count = 0;
  for (const item of due) {
    for (const s of subs) {
      if (gone.has(s.endpoint)) continue;
      try {
        const status = await sendPush(s, { title: item.title, body: item.body, tag: item.id, url: item.url || '#calendar' }, vapid, SUBJECT);
        if (status === 404 || status === 410) gone.add(s.endpoint);
        else if (status < 300) count++;
      } catch { /* try again next minute */ }
    }
    sent[item.id] = now;
  }
  if (gone.size) { subs = subs.filter(s => !gone.has(s.endpoint)); await put(env, 'subs', subs); }
  for (const k of Object.keys(sent)) if (sent[k] < now - 30 * 864e5) delete sent[k];
  await put(env, 'sent', sent);
  return count;
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get('origin') || '';
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (path === '/vapid' && req.method === 'GET') {
        const vapid = await vapidKeys(env);
        return json({ publicKey: vapid.publicKey, claimed: Boolean(await get(env, 'key', null)) }, 200, origin);
      }
      const body = req.method === 'GET' ? {} : await req.json().catch(() => ({}));
      if (path === '/claim' && req.method === 'POST') {
        const current = await get(env, 'key', null);
        if (typeof body.key !== 'string' || body.key.length < 32) return json({ error: 'bad key' }, 400, origin);
        if (current && !safeEqual(current, body.key)) return json({ error: 'already claimed' }, 403, origin);
        if (!current) await put(env, 'key', body.key);
        return json({ ok: true }, 200, origin);
      }
      const key = await get(env, 'key', null);
      const given = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      if (!key || !safeEqual(key, given)) return json({ error: 'unauthorized' }, 401, origin);

      if (path === '/subscribe' && req.method === 'POST') {
        const s = body.subscription;
        if (!s || typeof s.endpoint !== 'string' || !/^https:\/\//.test(s.endpoint) || !s.keys?.p256dh || !s.keys?.auth) return json({ error: 'bad subscription' }, 400, origin);
        const subs = (await get(env, 'subs', [])).filter(x => x.endpoint !== s.endpoint);
        subs.push({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth }, device: String(body.device || '').slice(0, 80), added: Date.now() });
        await put(env, 'subs', subs.slice(-20));
        return json({ ok: true, devices: subs.length }, 200, origin);
      }
      if (path === '/unsubscribe' && req.method === 'POST') {
        const subs = (await get(env, 'subs', [])).filter(x => x.endpoint !== body.endpoint);
        await put(env, 'subs', subs);
        return json({ ok: true, devices: subs.length }, 200, origin);
      }
      if (path === '/schedule' && req.method === 'PUT') {
        if (!Array.isArray(body.items)) return json({ error: 'bad schedule' }, 400, origin);
        const items = body.items.slice(0, 5000).map(i => ({
          id: String(i.id).slice(0, 120), at: Number(i.at), title: String(i.title || '').slice(0, 200),
          body: String(i.body || '').slice(0, 300), url: String(i.url || '#calendar').slice(0, 300),
        })).filter(i => i.id && Number.isFinite(i.at));
        await put(env, 'schedule', items);
        await deliver(env); // something may be due right now
        return json({ ok: true, items: items.length }, 200, origin);
      }
      if (path === '/status' && req.method === 'GET') {
        const subs = await get(env, 'subs', []);
        const schedule = await get(env, 'schedule', []);
        const next = schedule.filter(i => i.at > Date.now()).sort((a, b) => a.at - b.at)[0];
        return json({ devices: subs.map(s => ({ device: s.device, added: s.added })), scheduled: schedule.length, next: next ? { at: next.at, title: next.title } : null }, 200, origin);
      }
      if (path === '/test' && req.method === 'POST') {
        const subs = await get(env, 'subs', []);
        const vapid = await vapidKeys(env);
        const results = [];
        for (const s of subs) {
          if (body.endpoint && s.endpoint !== body.endpoint) continue;
          try { results.push(await sendPush(s, { title: 'Проверка', body: 'Так будут приходить напоминания календаря', tag: 'test', url: '#calendar' }, vapid, SUBJECT)); }
          catch (e) { results.push(String(e)); }
        }
        return json({ ok: true, results }, 200, origin);
      }
      return json({ error: 'not found' }, 404, origin);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500, origin);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(deliver(env));
  },
};
