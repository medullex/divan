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
  if (url.pathname === '/api/search') return apiSearch(url.searchParams.get('q'), res);
  if (url.pathname === '/api/rutube') return apiRutubeInfo(url.searchParams.get('id'), res);
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

// ---------- поиск по Rutube ----------
// Используем открытый поиск Rutube. Видео потом показывается в официальном плеере Rutube.
const searchCache = new Map(); // запрос -> { at, data }
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36', 'Accept': 'application/json' };
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const rutubeId = s => (String(s || '').match(/[0-9a-f]{32}/) || [])[0] || null;

async function apiSearch(q, res) {
  q = clean(q, 100);
  if (q.length < 2) return json(res, 400, { error: 'Слишком короткий запрос' });
  const key = q.toLowerCase();
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60e3) return json(res, 200, hit.data);
  try {
    const out = [];
    for (let page = 1; page <= 2; page++) { // до 2 страниц выдачи
      const r = await fetch(`https://rutube.ru/api/search/video/?query=${encodeURIComponent(q)}&page=${page}`, { headers: UA, signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error('rutube ' + r.status);
      const j = await r.json();
      for (const v of j.results || []) {
        if (v.is_hidden || v.is_deleted || v.is_paid || v.is_livestream || v.is_audio || v.is_locked) continue;
        const id = rutubeId(v.embed_url) || rutubeId(v.video_url) || rutubeId(v.id);
        if (!id) continue;
        out.push({
          kind: 'rutube', id, title: String(v.title || '').slice(0, 200), dur: Number(v.duration) || 0,
          thumb: v.thumbnail_url || '', author: (v.author && v.author.name) || '',
          age: (v.pg_rating && v.pg_rating.age) || (v.is_adult ? 18 : 0), official: !!v.is_official,
        });
      }
      if (!j.has_next) break;
    }
    const data = { results: out };
    searchCache.set(key, { at: Date.now(), data });
    if (searchCache.size > 500) searchCache.delete(searchCache.keys().next().value);
    json(res, 200, data);
  } catch (e) {
    console.warn('search failed:', e.message);
    json(res, 502, { error: 'Rutube сейчас не отвечает, попробуйте ещё раз' });
  }
}

async function apiRutubeInfo(id, res) {
  id = rutubeId(id);
  if (!id) return json(res, 400, { error: 'Неверная ссылка' });
  try {
    const r = await fetch(`https://rutube.ru/api/video/${id}/`, { headers: UA, signal: AbortSignal.timeout(8000) });
    if (!r.ok) return json(res, 404, { error: 'Видео не найдено' });
    const v = await r.json();
    json(res, 200, { kind: 'rutube', id, title: String(v.title || 'Видео с Rutube').slice(0, 200), dur: Number(v.duration) || 0 });
  } catch { json(res, 200, { kind: 'rutube', id, title: 'Видео с Rutube', dur: 0 }); }
}

// ---------- комнаты ----------
/** code -> { people: Map<id,{ws,name,color}>, hostId, live: {title}|null, media: {...}|null,
 *            state: {playing,pos,at}, chat[], emptySince } */
const rooms = new Map();
const COLORS = ['#f5a742', '#d9707f', '#7cc59a', '#8fb3e8', '#c9a0e8', '#e8d27c', '#6fd0c8', '#f08a5d'];

function getRoom(code) {
  let r = rooms.get(code);
  if (!r) { r = { people: new Map(), hostId: null, live: null, media: null, state: { playing: false, pos: 0, at: Date.now() }, chat: [], emptySince: null }; rooms.set(code, r); }
  return r;
}
// Текущая позиция плеера по часам сервера — одинаковая для всех, кто подключится
function liveState(r) {
  const s = r.state;
  return { playing: s.playing, pos: s.playing ? s.pos + (Date.now() - s.at) / 1000 : s.pos };
}
const peersList = r => [...r.people.entries()].map(([id, p]) => ({ id, name: p.name, color: p.color }));
const roomInfo = r => ({ t: 'room', hostId: r.hostId, live: r.live, media: r.media, state: liveState(r), peers: peersList(r) });

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
      case 'live': { // ведущий начал/закончил показ своего файла
        if (!isHost) return;
        room.live = m.on ? { title: clean(m.title, 120) || 'Видео' } : null;
        if (m.on) room.media = null;
        broadcast(room, roomInfo(room));
        break;
      }
      case 'media': { // ведущий выбрал видео с Rutube или VK Видео (или убрал его)
        if (!isHost) return;
        let media = null;
        if (m.kind === 'rutube' && /^[0-9a-f]{32}$/.test(String(m.id))) {
          media = { kind: 'rutube', id: String(m.id) };
        } else if (m.kind === 'vk' && /^-?\d{1,20}$/.test(String(m.oid)) && /^\d{1,20}$/.test(String(m.vid))) {
          media = { kind: 'vk', oid: String(m.oid), vid: String(m.vid) };
          if (/^[0-9a-f]{4,40}$/i.test(String(m.hash || ''))) media.hash = String(m.hash);
        }
        if (media) { media.title = clean(m.title, 200) || 'Видео'; media.dur = Number(m.dur) || 0; media.n = Date.now(); }
        room.media = media;
        if (media) room.live = null;
        room.state = { playing: false, pos: 0, at: now };
        broadcast(room, roomInfo(room));
        break;
      }
      case 'sync': { // ведущий: состояние плеера Rutube/VK (пауза, время)
        if (!isHost || !room.media) return;
        const pos = Number(m.pos);
        if (!Number.isFinite(pos) || pos < 0 || pos > 1e6) return;
        room.state = { playing: !!m.playing, pos, at: now };
        broadcast(room, { t: 'sync', playing: !!m.playing, pos, ev: m.ev ? 1 : 0 }, id);
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
        room.hostId = String(m.to); room.live = null; // видео с Rutube/VK остаётся, его просто ведёт новый ведущий
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
      if (room.state.playing) room.state = { ...liveState(room), playing: false, at: Date.now() }; // ставим на паузу
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
