// Общий диван — сервер комнат.
// Отдаёт страницу и пересылает служебные сообщения между зрителями одной комнаты:
// чат, реакции и «рукопожатия» WebRTC. Само видео идёт напрямую из браузера ведущего
// к браузерам зрителей и через этот сервер не проходит.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const miniws = require('./miniws');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MAX_PEOPLE = 12;        // человек в одной комнате (ведущий раздаёт видео каждому сам)
const CHAT_KEEP = 60;         // сколько сообщений помнит комната
const ROOM_TTL = 6 * 3600e3;  // пустая комната живёт 6 часов

// STUN/TURN-серверы для WebRTC. TURN можно добавить через переменные окружения на хостинге.
const ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
if (process.env.TURN_URLS) {
  ICE.push({
    urls: process.env.TURN_URLS.split(',').map(s => s.trim()).filter(Boolean),
    username: process.env.TURN_USER || '',
    credential: process.env.TURN_PASS || '',
  });
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ---------- страница ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') { res.writeHead(200); return res.end('ok'); }
  if (url.pathname === '/config') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ iceServers: ICE }));
  }
  const file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) {
      // любые неизвестные пути (например /r/abcd-1234) — главная страница
      return fs.readFile(path.join(PUBLIC, 'index.html'), (e2, html) => {
        if (e2) { res.writeHead(500); return res.end('index.html not found'); }
        res.writeHead(200, { 'Content-Type': TYPES['.html'], 'Cache-Control': 'no-cache' });
        res.end(html);
      });
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ---------- комнаты ----------
/** code -> { people: Map<id,{ws,name,color}>, hostId, live: {title}|null, chat[], emptySince } */
const rooms = new Map();
const COLORS = ['#f5a742', '#d9707f', '#7cc59a', '#8fb3e8', '#c9a0e8', '#e8d27c', '#6fd0c8', '#f08a5d'];

function getRoom(code) {
  let r = rooms.get(code);
  if (!r) { r = { people: new Map(), hostId: null, live: null, chat: [], emptySince: null }; rooms.set(code, r); }
  return r;
}
const peersList = r => [...r.people.entries()].map(([id, p]) => ({ id, name: p.name, color: p.color }));
const roomInfo = r => ({ t: 'room', hostId: r.hostId, live: r.live, peers: peersList(r) });

function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(r, msg, exceptId) {
  const text = JSON.stringify(msg);
  for (const [id, p] of r.people) if (id !== exceptId && p.ws.readyState === 1) p.ws.send(text);
}

const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
const validCode = c => typeof c === 'string' && /^[a-z0-9-]{3,32}$/.test(c);

// ---------- websocket ----------
const wss = miniws.attach(server, { path: '/ws', maxPayload: 64 * 1024 }, ws => {
  let room = null, id = null;
  // антиспам: запас 80 сообщений, пополняется ~20 в секунду (WebRTC шлёт пачки служебных сообщений)
  let tokens = 80, last = Date.now();

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', raw => {
    const now = Date.now();
    tokens = Math.min(80, tokens + (now - last) / 50); last = now;
    if (tokens < 1) return; tokens -= 1;

    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;

    if (m.t === 'hello') {
      if (room || !validCode(m.room)) return send(ws, { t: 'error', text: 'Неверный код комнаты' });
      const r = getRoom(m.room);
      if (r.people.size >= MAX_PEOPLE) return send(ws, { t: 'error', text: 'Комната заполнена' });
      room = r; r.emptySince = null;
      id = crypto.randomBytes(6).toString('hex');
      const used = new Set([...r.people.values()].map(p => p.color));
      const color = COLORS.find(c => !used.has(c)) || COLORS[r.people.size % COLORS.length];
      r.people.set(id, { ws, name: clean(m.name, 24) || 'Гость', color });
      if (!r.hostId) r.hostId = id; // первый вошедший — ведущий
      send(ws, { ...roomInfo(r), t: 'welcome', id, chat: r.chat });
      broadcast(r, roomInfo(r), id);
      return;
    }
    if (!room) return;
    const me = room.people.get(id);
    const isHost = room.hostId === id;

    switch (m.t) {
      case 'signal': { // WebRTC: пересылаем конкретному участнику
        const target = room.people.get(String(m.to));
        if (!target || typeof m.data !== 'object') return;
        send(target.ws, { t: 'signal', from: id, data: m.data });
        break;
      }
      case 'live': { // ведущий начал/закончил показ
        if (!isHost) return;
        room.live = m.on ? { title: clean(m.title, 120) || 'Видео' } : null;
        broadcast(room, roomInfo(room));
        break;
      }
      case 'control': { // ведущий: пауза/плей/перемотка — для подсказок у зрителей
        if (!isHost) return;
        const pos = Number(m.pos);
        broadcast(room, { t: 'control', playing: !!m.playing, pos: Number.isFinite(pos) ? pos : 0, dur: Number(m.dur) || 0 }, id);
        break;
      }
      case 'givehost': { // ведущий передаёт управление
        if (!isHost || !room.people.has(String(m.to))) return;
        room.hostId = String(m.to); room.live = null;
        broadcast(room, roomInfo(room));
        break;
      }
      case 'chat': {
        const text = clean(m.text, 400);
        if (!text) return;
        const msg = { t: 'chat', id: crypto.randomBytes(4).toString('hex'), by: id, name: me.name, color: me.color, text, ts: now };
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
    }
  });

  ws.on('close', () => {
    if (!room) return;
    room.people.delete(id);
    if (room.hostId === id) { // ведущий ушёл — управление переходит следующему
      room.hostId = room.people.keys().next().value || null;
      room.live = null;
    }
    if (room.people.size === 0) room.emptySince = Date.now();
    else broadcast(room, roomInfo(room));
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
