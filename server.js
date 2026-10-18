// Общий диван — сервер синхронизации.
// Отдаёт страницу из папки public и пересылает между зрителями одной комнаты
// только команды (пауза, время, чат, реакции). Видео через сервер не проходит.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const miniws = require('./miniws');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MAX_PEOPLE = 20;        // человек в одной комнате
const CHAT_KEEP = 60;         // сколько сообщений помнит комната
const ROOM_TTL = 6 * 3600e3;  // пустая комната живёт 6 часов

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

// ---------- статика ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') { res.writeHead(200); return res.end('ok'); }
  let file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) {
      // любые неизвестные пути (например /r/abc) — отдаём главную страницу
      return fs.readFile(path.join(PUBLIC, 'index.html'), (e2, html) => {
        if (e2) { res.writeHead(500); return res.end('index.html not found'); }
        res.writeHead(200, { 'Content-Type': TYPES['.html'] });
        res.end(html);
      });
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---------- комнаты ----------
/** rooms: code -> { people: Map<id, {ws,name,color,file,dur}>, state, chat[], emptySince } */
const rooms = new Map();
const COLORS = ['#f5a742', '#d9707f', '#7cc59a', '#8fb3e8', '#c9a0e8', '#e8d27c', '#6fd0c8', '#f08a5d'];

function getRoom(code) {
  let r = rooms.get(code);
  if (!r) {
    r = { people: new Map(), state: null, chat: [], emptySince: null };
    rooms.set(code, r);
  }
  return r;
}

// Текущее положение видео с учётом прошедшего времени (часы только сервера — без расхождений между устройствами)
function liveState(r) {
  if (!r.state) return null;
  const s = r.state;
  const pos = s.playing ? s.pos + (Date.now() - s.at) / 1000 : s.pos;
  return { playing: s.playing, pos, by: s.by };
}

function peersList(r) {
  return [...r.people.entries()].map(([id, p]) => ({ id, name: p.name, color: p.color, file: p.file, dur: p.dur }));
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}
function broadcast(r, msg, exceptId) {
  const text = JSON.stringify(msg);
  for (const [id, p] of r.people) if (id !== exceptId && p.ws.readyState === 1) p.ws.send(text);
}

const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
const validCode = c => typeof c === 'string' && /^[a-z0-9-]{3,32}$/.test(c);

// ---------- websocket ----------
const wss = miniws.attach(server, { path: '/ws', maxPayload: 8 * 1024 }, ws => {
  let room = null, id = null, code = null;
  let tokens = 20, last = Date.now(); // простой антиспам: ~5 сообщений в секунду

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', raw => {
    const now = Date.now();
    tokens = Math.min(20, tokens + (now - last) / 200); last = now;
    if (tokens < 1) return; tokens -= 1;

    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'hello') {
      if (room || !validCode(m.room)) return send(ws, { t: 'error', text: 'Неверный код комнаты' });
      const r = getRoom(m.room);
      if (r.people.size >= MAX_PEOPLE) return send(ws, { t: 'error', text: 'Комната заполнена' });
      code = m.room; room = r; r.emptySince = null;
      id = crypto.randomBytes(6).toString('hex');
      const used = new Set([...r.people.values()].map(p => p.color));
      const color = COLORS.find(c => !used.has(c)) || COLORS[r.people.size % COLORS.length];
      r.people.set(id, { ws, name: clean(m.name, 24) || 'Гость', color, file: null, dur: null });
      send(ws, { t: 'welcome', id, state: liveState(r), chat: r.chat, peers: peersList(r) });
      broadcast(r, { t: 'peers', peers: peersList(r) }, id);
      return;
    }
    if (!room) return;
    const me = room.people.get(id);

    switch (m.t) {
      case 'sync': {
        const pos = Number(m.pos);
        if (!Number.isFinite(pos) || pos < 0 || pos > 1e6) return;
        room.state = { playing: !!m.playing, pos, at: now, by: id };
        broadcast(room, { t: 'sync', playing: !!m.playing, pos, by: id, name: me.name }, id);
        break;
      }
      case 'chat': {
        const text = clean(m.text, 400);
        if (!text) return;
        const vt = Number.isFinite(Number(m.vt)) ? Number(m.vt) : null;
        const msg = { t: 'chat', id: crypto.randomBytes(4).toString('hex'), by: id, name: me.name, color: me.color, text, vt, ts: now };
        room.chat.push(msg);
        if (room.chat.length > CHAT_KEEP) room.chat.splice(0, room.chat.length - CHAT_KEEP);
        broadcast(room, msg);
        break;
      }
      case 'react': {
        const e = clean(m.e, 8);
        if (!['😂', '😮', '❤️', '🔥', '😭', '👏'].includes(e)) return;
        broadcast(room, { t: 'react', e, by: id });
        break;
      }
      case 'meta': {
        me.file = clean(m.file, 120) || null;
        const dur = Number(m.dur);
        me.dur = Number.isFinite(dur) && dur > 0 ? Math.round(dur) : null;
        broadcast(room, { t: 'peers', peers: peersList(room) });
        break;
      }
      case 'ask': // новичок просит актуальное время
        send(ws, { t: 'state', state: liveState(room) });
        break;
    }
  });

  ws.on('close', () => {
    if (!room) return;
    room.people.delete(id);
    if (room.people.size === 0) room.emptySince = Date.now();
    else broadcast(room, { t: 'peers', peers: peersList(room) });
  });
});

// поддерживаем соединения живыми (хостинги рвут «молчащие» сокеты) и чистим пустые комнаты
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
  const now = Date.now();
  for (const [code, r] of rooms) if (r.emptySince && now - r.emptySince > ROOM_TTL) rooms.delete(code);
}, 25000);

server.listen(PORT, () => console.log(`Общий диван запущен: http://localhost:${PORT}`));
