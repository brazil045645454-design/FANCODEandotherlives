const http = require('http');
const crypto = require('crypto');
const store = require('./src/store');
const source = require('./src/source');

const PORT = process.env.PORT || 7860;
const ID = 'live1';
const MODE = (process.env.SOURCE_MODE || 'manual').toLowerCase() === 'automatic' ? 'automatic' : 'manual';
const INTERVAL = Math.max(10, parseInt(process.env.REFRESH_INTERVAL, 10) || 300) * 1000;

const manifest = {
  id: 'org.example.single-live', version: '2.0.0', name: 'Live Stream',
  description: 'Single live HLS stream', resources: ['catalog', 'meta', 'stream'],
  types: ['tv'], idPrefixes: ['live'], catalogs: [{ type: 'tv', id: 'live', name: 'Live Stream' }]
};
const item = { id: ID, type: 'tv', name: 'Live Stream' };

// ---------- single source of truth ----------
const state = {
  url: '', updatedAt: null, origin: 'none',
  source: { status: MODE === 'automatic' ? 'pending' : 'disabled', checkedAt: null, error: null }
};
const validUrl = (s) => {
  if (typeof s !== 'string' || !s || s.length > 4096) return false;
  try { return /^https?:$/.test(new URL(s).protocol); } catch { return false; }
};
function setUrl(url, origin) {
  state.url = url; state.updatedAt = new Date().toISOString(); state.origin = origin;
  return store.save({ streamUrl: url, updatedAt: state.updatedAt });
}
const mask = (u) => {
  try {
    const x = new URL(u);
    return x.origin + x.pathname.slice(0, 40) + (x.pathname.length > 40 ? '…' : '') +
      (x.search ? '?' + x.search.slice(1, 7) + '…[masked]' : '');
  } catch { return ''; }
};

// startup: data.json -> STREAM_URL -> empty
const saved = store.load();
const env = (process.env.STREAM_URL || '').trim();
if (saved && validUrl(saved.streamUrl)) {
  state.url = saved.streamUrl; state.updatedAt = saved.updatedAt || null; state.origin = 'saved';
} else if (validUrl(env)) {
  state.url = env; state.updatedAt = new Date().toISOString(); state.origin = 'env';
} else {
  console.error(env ? 'STREAM_URL is not a valid http(s) URL' : 'STREAM_URL is not configured');
}

// ---------- automatic refresh ----------
async function refresh() {
  try {
    const u = await source.getStreamUrl();
    state.source = { status: 'connected', checkedAt: new Date().toISOString(), error: null };
    if (u !== state.url) setUrl(u, 'automatic');
  } catch (e) {
    state.source = { status: 'error', checkedAt: new Date().toISOString(), error: String(e.message).slice(0, 120) };
    console.error('source:', state.source.error);
  }
}
if (MODE === 'automatic') { refresh(); setInterval(refresh, INTERVAL); }

// ---------- helpers ----------
const sha = (s) => crypto.createHash('sha256').update(s).digest();
const fails = new Map();
function guard(req) { // returns {code,msg} on failure, null if OK
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) return { code: 503, msg: 'ADMIN_PASSWORD is not configured; admin is disabled.' };
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim();
  const f = fails.get(ip);
  if (f && f.n >= 10 && Date.now() - f.t < 60000) return { code: 429, msg: 'Too many attempts. Wait a minute.' };
  const h = req.headers.authorization || '';
  if (h.startsWith('Basic ')) {
    const dec = Buffer.from(h.slice(6), 'base64').toString();
    if (crypto.timingSafeEqual(sha(dec.slice(dec.indexOf(':') + 1)), sha(pw))) { fails.delete(ip); return null; }
    fails.set(ip, { n: (f && Date.now() - f.t < 60000 ? f.n : 0) + 1, t: Date.now() });
  }
  return { code: 401, msg: 'Authentication required.' };
}
const readBody = (req) => new Promise((ok) => {
  let b = '';
  req.on('data', (c) => { b += c; if (b.length > 8192) { req.destroy(); ok(null); } });
  req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch { ok(null); } });
  req.on('error', () => ok(null));
});
async function testUrl(u) {
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return { ok: false, message: 'HTTP ' + r.status + ([401, 403, 410].includes(r.status) ? ' (likely expired or blocked)' : '') };
    const head = await source.readText(r, 2048);
    return head.trimStart().startsWith('#EXTM3U')
      ? { ok: true, message: 'OK: valid HLS playlist' }
      : { ok: false, message: 'Reachable, but not an HLS playlist' };
  } catch (e) {
    return { ok: false, message: 'Unreachable (' + (e.name === 'TimeoutError' ? 'timeout' : 'network error') + ')' };
  }
}
const status = () => ({
  status: !state.url ? 'Missing' : MODE === 'automatic' && state.source.status === 'error' ? 'Source error' : 'Active',
  mode: MODE, maskedUrl: mask(state.url), updatedAt: state.updatedAt, origin: state.origin, source: state.source
});

const PAGE = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>Live Stream Manager</title>
<style>body{font:16px system-ui;max-width:720px;margin:2rem auto;padding:0 1rem}input{width:100%;padding:.7rem;font:inherit;box-sizing:border-box}button{padding:.6rem 1rem;margin:.6rem .6rem .6rem 0;font:inherit}code{word-break:break-all}</style>
<h1>Live Stream Manager</h1>
<p>Current HLS URL:<br><code id=cur>…</code></p>
<input id=u placeholder="Paste new .m3u8 URL" autocomplete=off spellcheck=false>
<button id=save>Save Stream</button><button id=test>Test Stream</button>
<p id=msg></p>
<p>Status: <b id=st></b><br>Mode: <b id=mode></b><br>Updated: <b id=upd></b><br>Automatic Source: <b id=src></b> <small id=err></small></p>
<script>
const $=i=>document.getElementById(i);
async function api(p,b){const r=await fetch(p,b?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)}:{});return r.json().catch(()=>({error:'Bad response'}));}
async function load(){const s=await api('/api/status');if(!s.source)return;$('cur').textContent=s.maskedUrl||'(none)';$('st').textContent=s.status;$('mode').textContent=s.mode;$('upd').textContent=s.updatedAt?new Date(s.updatedAt).toLocaleString():'-';$('src').textContent=s.source.status;$('err').textContent=s.source.error||'';}
$('save').onclick=async()=>{const r=await api('/api/stream',{url:$('u').value.trim()});$('msg').textContent=r.error||('Saved'+(r.persisted?'':' (in memory only; disk write failed)'));if(!r.error)$('u').value='';load();};
$('test').onclick=async()=>{$('msg').textContent='Testing…';const r=await api('/api/test',{url:$('u').value.trim()});$('msg').textContent=r.message||r.error;};
load();
</script>`;

// ---------- server ----------
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
const json = (res, code, obj, extra) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify(obj));
};

http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    const path = decodeURIComponent(req.url.split('?')[0]);

    // Stremio (public)
    if (path === '/manifest.json') return json(res, 200, manifest, CORS);
    if (path === '/catalog/tv/live.json') return json(res, 200, { metas: [item] }, CORS);
    if (path === `/meta/tv/${ID}.json`) return json(res, 200, { meta: item }, CORS);
    if (path === `/stream/tv/${ID}.json`) {
      if (!state.url) return json(res, 500, { error: 'No stream URL configured. Set STREAM_URL or save one at /admin.' }, CORS);
      return json(res, 200, { streams: [{ name: 'Live Stream', title: 'Live HLS', url: state.url }] }, CORS);
    }

    // Admin (password protected)
    if (path === '/admin' || path.startsWith('/api/')) {
      const g = guard(req);
      if (g) {
        res.writeHead(g.code, { 'Content-Type': 'text/plain', ...(g.code === 401 && { 'WWW-Authenticate': 'Basic realm="admin"' }) });
        return res.end(g.msg);
      }
      if (path === '/admin' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(PAGE);
      }
      if (path === '/api/status' && req.method === 'GET') return json(res, 200, status());
      if (req.method === 'POST' && (path === '/api/stream' || path === '/api/test')) {
        if (!(req.headers['content-type'] || '').includes('application/json')) return json(res, 415, { error: 'JSON required' });
        const b = await readBody(req);
        if (!b) return json(res, 400, { error: 'Invalid or oversized request body' });
        const url = typeof b.url === 'string' ? b.url.trim() : '';
        if (path === '/api/test') {
          const target = url || state.url;
          if (!validUrl(target)) return json(res, 400, { error: 'No valid URL to test' });
          return json(res, 200, await testUrl(target));
        }
        if (!validUrl(url)) return json(res, 400, { error: 'Not a valid http(s) URL' });
        return json(res, 200, { ok: true, persisted: setUrl(url, 'manual') });
      }
    }
    json(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error('request error:', e.message);
    if (!res.headersSent) json(res, 500, { error: 'Internal error' });
  }
}).listen(PORT, '0.0.0.0', () => console.log('Listening on ' + PORT + ' (' + MODE + ' mode)'));

process.on('uncaughtException', (e) => console.error('uncaught:', e.message));
process.on('unhandledRejection', (e) => console.error('unhandled:', e && e.message));
