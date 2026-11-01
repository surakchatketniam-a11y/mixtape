import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseFile } from 'music-metadata';

const dir = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(dir, 'index.html');
const DJ_FILE = path.join(dir, 'dj.html');
const MUSIC = process.env.MUSIC_DIR || path.join(dir, 'music');
const STATION = process.env.STATION_NAME || 'สถานีเพลงของเรา';
const PORT = +process.env.PORT || 5173;
const LAN = process.argv.includes('--lan');
const SHUFFLE = process.env.SHUFFLE !== '0';

fs.mkdirSync(MUSIC, { recursive: true });

const win874 = new TextDecoder('windows-874');
const fixThai = s => {
  if (!s || /[฀-๿]/.test(s) || !/[¡-ÿ]/.test(s) || /[^\u0000-ÿ]/.test(s)) return s;
  const t = win874.decode(Buffer.from(s, 'latin1'));
  return /[฀-๿]/.test(t) ? t : s;
};

const cache = new Map();
const byId = new Map();

async function scan() {
  let names = [];
  try { names = fs.readdirSync(MUSIC, { recursive: true }).filter(n => /\.mp3$/i.test(n)).sort(); } catch {}
  const out = [];
  for (const n of names) {
    const f = path.join(MUSIC, n);
    let st; try { st = fs.statSync(f); } catch { continue; }
    const c = cache.get(f);
    if (c && c.mtime === st.mtimeMs) { out.push(c.track); continue; }
    try {
      const m = await parseFile(f, { duration: true });
      const d = m.format.duration;
      if (!d) continue;
      const pic = m.common.picture && m.common.picture[0];
      const track = {
        id: crypto.createHash('sha1').update(n).digest('hex').slice(0, 10),
        file: f, title: fixThai(m.common.title) || path.parse(n).name, artist: fixThai(m.common.artist) || '',
        duration: d, cover: pic ? { data: Buffer.from(pic.data), type: pic.format } : null
      };
      cache.set(f, { mtime: st.mtimeMs, track });
      byId.set(track.id, track);
      out.push(track);
    } catch (e) { console.warn('ข้ามไฟล์', n, e.message); }
  }
  return out;
}

const shuffle = a => { const r = [...a]; for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; } return r; };
let queue = [], cur = null;

async function refill(min) {
  while (queue.length < min) {
    const lib = await scan();
    if (!lib.length) return false;
    const batch = SHUFFLE ? shuffle(lib) : lib;
    const last = queue.length ? queue[queue.length - 1] : (cur && cur.track);
    if (SHUFFLE && lib.length > 1 && last && batch[0].id === last.id) batch.push(batch.shift());
    queue.push(...batch);
  }
  return true;
}

let busy = Promise.resolve();
const locked = fn => { const p = busy.then(fn); busy = p.catch(() => {}); return p; };

const djQueue = [];
const requests = [];
const wishes = [];
const listeners = new Map();
const countListeners = () => {
  const cutoff = Date.now() - 12000;
  let n = 0;
  for (const [id, at] of listeners) { if (at < cutoff) listeners.delete(id); else n++; }
  return n;
};
const lastReqAt = new Map();
let requestsOpen = true, ridSeq = 1;
const pickNext = () => (djQueue.length ? djQueue.shift() : queue.shift());

const nowState = () => locked(async () => {
  const now = Date.now();
  if (!(await refill(5))) return null;
  if (!cur) cur = { track: pickNext(), startedAt: now };
  while (now >= cur.startedAt + cur.track.duration * 1000) {
    if (queue.length < 5) await refill(5);
    cur = { track: pickNext(), startedAt: cur.startedAt + cur.track.duration * 1000 };
  }
  await refill(5);
  return { now, cur, next: [...djQueue, ...queue].slice(0, 3) };
});

const trackBy = id => {
  const t = byId.get(id);
  if (!t) throw Object.assign(new Error('ไม่พบเพลงนี้ (ลองโหลดคลังเพลงใหม่)'), { code: 404 });
  return t;
};
const djDo = (action, body) => locked(async () => {
  switch (action) {
    case 'playnow': cur = { track: trackBy(body.id), startedAt: Date.now() }; break;
    case 'next': djQueue.unshift(trackBy(body.id)); break;
    case 'add': djQueue.push(trackBy(body.id)); break;
    case 'remove': if (Number.isInteger(body.index)) djQueue.splice(body.index, 1); break;
    case 'clear': djQueue.length = 0; break;
    case 'req-accept': {
      const i = requests.findIndex(r => r.rid === body.rid);
      if (i < 0) throw Object.assign(new Error('คำขอนี้ไม่อยู่แล้ว'), { code: 404 });
      const base = trackBy(requests[i].id);
      const t = requests[i].name ? { ...base, by: requests[i].name } : base;
      if (body.mode === 'next') djQueue.unshift(t); else djQueue.push(t);
      requests.splice(i, 1);
      break;
    }
    case 'req-reject': { const i = requests.findIndex(r => r.rid === body.rid); if (i >= 0) requests.splice(i, 1); break; }
    case 'req-clear': requests.length = 0; wishes.length = 0; break;
    case 'wish-remove': { const i = wishes.findIndex(w => w.wid === body.wid); if (i >= 0) wishes.splice(i, 1); break; }
    case 'req-open': requestsOpen = !!body.open; break;
    case 'skip':
      if (!(await refill(5))) throw Object.assign(new Error('ไม่มีเพลงในคลัง'), { code: 503 });
      cur = { track: pickNext(), startedAt: Date.now() };
      break;
    default: throw Object.assign(new Error('คำสั่งไม่ถูกต้อง'), { code: 400 });
  }
});

const isLocal = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '');
const hostOk = req => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(req.headers.host || '');
const brief = t => ({ id: t.id, title: t.title, artist: t.artist, duration: t.duration, by: t.by || '' });
const readBody = req => new Promise((ok, no) => {
  let s = '';
  req.on('data', c => { s += c; if (s.length > 10000) { req.destroy(); no(new Error('too large')); } });
  req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { no(Object.assign(new Error('JSON ไม่ถูกต้อง'), { code: 400 })); } });
});

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};

function stream(req, res, t) {
  let size; try { size = fs.statSync(t.file).size; } catch { res.writeHead(404); return res.end(); }
  let start = 0, end = size - 1, code = 200;
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (m) {
    if (m[1] !== '') start = +m[1];
    if (m[2] !== '') end = Math.min(+m[2], size - 1);
    if (m[1] === '' && m[2] !== '') { start = Math.max(0, size - +m[2]); end = size - 1; }
    if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': 'bytes */' + size }); return res.end(); }
    code = 206;
  }
  const h = { 'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'no-cache' };
  if (code === 206) h['Content-Range'] = `bytes ${start}-${end}/${size}`;
  res.writeHead(code, h);
  fs.createReadStream(t.file, { start, end }).on('error', () => res.destroy()).pipe(res);
}

http.createServer(async (req, res) => {
  try {
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/dj' || p.startsWith('/api/dj/')) {
      if (!isLocal(req) || !hostOk(req)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end(`หน้า DJ ใช้ได้เฉพาะบนเครื่อง server เท่านั้น เปิดด้วย http://127.0.0.1:${PORT}/dj`);
      }
      if (p === '/dj') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return fs.createReadStream(DJ_FILE).pipe(res);
      }
      try {
        if (req.method === 'GET' && p === '/api/dj/library') {
          const lib = await scan();
          return json(res, 200, lib.map(t => ({ ...brief(t), folder: path.relative(MUSIC, path.dirname(t.file)) })));
        }
        if (req.method === 'GET' && p === '/api/dj/state') {
          const s = await nowState();
          if (!s) return json(res, 503, { error: 'ยังไม่มีเพลงในโฟลเดอร์ music', station: STATION });
          return json(res, 200, {
            now: s.now, station: STATION,
            cur: { ...brief(s.cur.track), startedAt: s.cur.startedAt },
            dj: djQueue.map(brief), next: queue.slice(0, 5).map(brief),
            requestsOpen, listeners: countListeners(),
            wishes: wishes.map(w => ({ wid: w.wid, title: w.title, artist: w.artist, name: w.name, votes: w.voters.size, at: w.at })),
            requests: requests.map(r => ({ ...brief(byId.get(r.id) || { id: r.id, title: '(ไม่พบไฟล์)', artist: '', duration: 0 }), rid: r.rid, name: r.name, votes: r.voters.size, at: r.at }))
          });
        }
        if (req.method === 'POST') {
          if (req.headers['x-dj'] !== '1') { res.writeHead(403); return res.end(); }
          await djDo(p.slice('/api/dj/'.length), await readBody(req));
          return json(res, 200, { ok: true });
        }
        res.writeHead(404); return res.end();
      } catch (e) { return json(res, e.code || 500, { error: e.message }); }
    }
    if (p === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return fs.createReadStream(FILE).pipe(res);
    }
    if (p === '/api/now') {
      const lid = new URL(req.url, 'http://x').searchParams.get('l');
      if (lid && /^[a-z0-9]{6,20}$/.test(lid) && listeners.size < 5000) listeners.set(lid, Date.now());
      const s = await nowState();
      if (!s) return json(res, 503, { error: 'no-music', station: STATION });
      const t = s.cur.track;
      return json(res, 200, {
        now: s.now, station: STATION,
        track: { id: t.id, title: t.title, artist: t.artist, duration: t.duration, startedAt: s.cur.startedAt, cover: !!t.cover, by: t.by || '' },
        next: s.next.map(n => ({ title: n.title, artist: n.artist, duration: n.duration, by: n.by || '' })),
        requests: { open: requestsOpen, pending: requests.length + wishes.length },
        listeners: countListeners()
      });
    }
    if (p === '/api/library' && req.method === 'GET') {
      const lib = await scan();
      return json(res, 200, lib.map(brief));
    }
    if (p === '/api/request' && req.method === 'POST') {
      if (req.headers['x-req'] !== '1') { res.writeHead(403); return res.end(); }
      const fail = (code, error) => json(res, code, { error });
      if (!requestsOpen) return fail(403, 'ตอนนี้ DJ ปิดรับขอเพลงอยู่');
      const body = await readBody(req);
      const mine = ip => requests.filter(r => r.ip === ip).length + wishes.filter(w => w.ip === ip).length;
      if (body.wish) {
        const ip = req.socket.remoteAddress || '?', now = Date.now();
        const title = String(body.wish.title || '').trim().slice(0, 80), artist = String(body.wish.artist || '').trim().slice(0, 60);
        if (!title) return fail(400, 'กรอกชื่อเพลงก่อน');
        const key = (title + '|' + artist).toLowerCase().replace(/\s+/g, ' ');
        const ex = wishes.find(w => w.key === key);
        if (ex) {
          if (ex.voters.has(ip)) return fail(409, 'คุณขอเพลงนี้ไปแล้ว');
          ex.voters.add(ip);
          return json(res, 200, { ok: true, status: 'voted' });
        }
        if (now - (lastReqAt.get(ip) || 0) < 30000) return fail(429, 'ขอเพลงถี่เกินไป รอสักครู่แล้วลองใหม่');
        if (mine(ip) >= 3) return fail(429, 'คุณมีคำขอที่รอ DJ อยู่ 3 เพลงแล้ว');
        if (wishes.length >= 50) return fail(429, 'คิวคำขอเพลงนอกคลังเต็มแล้ว');
        wishes.push({ wid: ridSeq++, key, title, artist, ip, name: String(body.name || '').trim().slice(0, 30), voters: new Set([ip]), at: now });
        lastReqAt.set(ip, now);
        return json(res, 200, { ok: true, status: 'new' });
      }
      const t = byId.get(String(body.id));
      if (!t) return fail(404, 'ไม่พบเพลงนี้ ลองโหลดหน้าใหม่');
      const ip = req.socket.remoteAddress || '?', now = Date.now();
      if ((cur && cur.track.id === t.id) || djQueue.some(x => x.id === t.id)) return fail(409, 'เพลงนี้กำลังเล่นหรืออยู่ในคิวแล้ว');
      const ex = requests.find(r => r.id === t.id);
      if (ex) {
        if (ex.voters.has(ip)) return fail(409, 'คุณขอเพลงนี้ไปแล้ว');
        ex.voters.add(ip);
        return json(res, 200, { ok: true, status: 'voted' });
      }
      if (now - (lastReqAt.get(ip) || 0) < 30000) return fail(429, 'ขอเพลงถี่เกินไป รอสักครู่แล้วลองใหม่');
      if (mine(ip) >= 3) return fail(429, 'คุณมีคำขอที่รอ DJ อยู่ 3 เพลงแล้ว');
      if (requests.length >= 50) return fail(429, 'คิวคำขอเต็มแล้ว');
      requests.push({ rid: ridSeq++, id: t.id, ip, name: String(body.name || '').trim().slice(0, 30), voters: new Set([ip]), at: now });
      lastReqAt.set(ip, now);
      return json(res, 200, { ok: true, status: 'new' });
    }
    let m = /^\/stream\/([0-9a-f]+)$/.exec(p);
    if (m) { const t = byId.get(m[1]); if (!t) { res.writeHead(404); return res.end(); } return stream(req, res, t); }
    m = /^\/api\/cover\/([0-9a-f]+)$/.exec(p);
    if (m) {
      const t = byId.get(m[1]);
      if (!t || !t.cover) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': t.cover.type || 'image/jpeg', 'Cache-Control': 'public, max-age=3600' });
      return res.end(t.cover.data);
    }
    res.writeHead(404); res.end();
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
}).listen(PORT, LAN ? '0.0.0.0' : '127.0.0.1', () => {
  console.log(`สถานี "${STATION}" พร้อมแล้ว  โฟลเดอร์เพลง: ${MUSIC}`);
  console.log(`เครื่องนี้:  http://127.0.0.1:${PORT}/`);
  console.log(`หน้า DJ (เฉพาะเครื่องนี้):  http://127.0.0.1:${PORT}/dj`);
  if (!LAN) { console.log('ให้คนในออฟฟิศฟังด้วย: node serve.mjs --lan'); return; }
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) console.log(`คนในออฟฟิศ:  http://${a.address}:${PORT}/`);
  }
});
