// Общий диван — сервер комнат.
// Отдаёт страницу и пересылает сообщения между зрителями одной комнаты: чат, реакции, синхронизацию.
// Видео с Rutube/VK идёт из их плееров. Файл с компьютера ведущий загружает сюда, во временную папку,
// и зрители смотрят его обычной ссылкой /media/<id>. Файл удаляется, когда загрузивший ушёл из комнаты.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const miniws = require('./miniws');
const accounts = require('./accounts');
const stats = require('./stats');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MAX_PEOPLE = 12;        // человек в одной комнате
const CHAT_KEEP = 60;         // сколько сообщений помнит комната
const ROOM_TTL = 6 * 3600e3;  // пустая комната живёт 6 часов
const UPLOAD_DIR = path.join(os.tmpdir(), 'divan-uploads');
const MAX_UPLOAD = (Number(process.env.MAX_UPLOAD_MB) || 2500) * 1024 * 1024;
const OWNER_GRACE = 20000;    // столько ждём загрузившего после перезагрузки страницы, прежде чем удалить файл
const VIDEO_TYPES = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.ogv': 'video/ogg' };
// при старте — пустая папка (файлы от прошлого запуска уже никому не нужны)
try { fs.rmSync(UPLOAD_DIR, { recursive: true, force: true }); } catch {}
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const files = new Map(); // id -> { path, size, mime } — опубликованные файлы, которые можно смотреть

// STUN/TURN-серверы для WebRTC. TURN можно добавить через переменные окружения на хостинге.
const ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
if (process.env.TURN_URLS) {
  ICE.push({
    urls: process.env.TURN_URLS.split(',').map(s => s.trim()).filter(Boolean),
    username: process.env.TURN_USER || '',
    credential: process.env.TURN_PASS || '',
  });
}

// TURN-посредник для зрителей за «строгими» сетями (мобильный интернет): видео идёт через него,
// когда прямое подключение невозможно. Временные ключи берём у Cloudflare или Metered (что настроено).
let turnCache = { at: 0, list: [] };
async function turnServers() {
  if (Date.now() - turnCache.at < 3600e3) return turnCache.list;
  let list = [];
  try {
    if (process.env.CF_TURN_KEY_ID && process.env.CF_TURN_TOKEN) {
      const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(process.env.CF_TURN_KEY_ID)}/credentials/generate-ice-servers`, {
        method: 'POST', headers: { Authorization: 'Bearer ' + process.env.CF_TURN_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: 86400 }), signal: AbortSignal.timeout(8000),
      });
      const j = await r.json();
      list = Array.isArray(j.iceServers) ? j.iceServers : j.iceServers ? [j.iceServers] : [];
    } else if (process.env.METERED_TURN_URL) {
      const r = await fetch(process.env.METERED_TURN_URL, { signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      list = Array.isArray(j) ? j : Array.isArray(j.iceServers) ? j.iceServers : [];
    }
  } catch (e) { console.warn('turn:', e.message); }
  // оставляем только TURN (STUN у нас свой), и кэшируем на час
  list = list.filter(x => x && x.urls && [].concat(x.urls).some(u => /^turns?:/.test(u)));
  turnCache = { at: list.length ? Date.now() : Date.now() - 3300e3, list };
  return list;
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webmanifest': 'application/manifest+json',
};

// ---------- страница ----------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/health') { res.writeHead(200); return res.end('ok'); }
  if (url.pathname === '/config') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return turnServers().then(t => res.end(JSON.stringify({ iceServers: ICE.concat(t), accounts: accounts.enabled })));
  }
  if (/^\/api\/(auth|me|friends|avatar)(\/|$)/.test(url.pathname)) { accounts.handle(req, res, url.pathname); return; }
  if (url.pathname === '/api/hit' || url.pathname === '/api/stats') {
    stats.handle(req, res, url.pathname, { userByToken: accounts.userByToken, liveRooms });
    return;
  }
  if (url.pathname === '/api/upload') return apiUpload(req, res, url.searchParams.get('t'));
  if (url.pathname.startsWith('/media/')) return serveMedia(req, res, url.pathname.slice(7));
  if (url.pathname === '/stats') url.pathname = '/stats.html';
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

// долгие загрузки фильма не должны обрываться таймаутом сервера (по умолчанию 5 минут)
server.requestTimeout = 0;
server.timeout = 0;

// ---------- фильм с компьютера ведущего ----------
const randId = n => crypto.randomBytes(n).toString('hex');
function unlinkQuiet(f) { if (f) fs.unlink(f, () => {}); }
function findUpload(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{48}$/.test(token)) return null;
  for (const [code, r] of rooms) if (r.upload && r.upload.token === token) return { code, r, up: r.upload };
  return null;
}
// приём файла: тело запроса пишется на диск по кусочкам, в памяти не держим
function apiUpload(req, res, token) {
  if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
  const f = findUpload(token);
  if (!f || f.up.started) return json(res, 403, { error: 'Загрузка не разрешена. Выберите файл ещё раз.' });
  const { r, up } = f;
  const len = Number(req.headers['content-length']);
  if (len !== up.size) return json(res, 400, { error: 'Размер файла не совпал. Выберите файл ещё раз.' });
  up.started = true; up.req = req;
  const tmp = path.join(UPLOAD_DIR, up.id + '.part');
  const out = fs.createWriteStream(tmp);
  let got = 0, done = false, lastSent = 0;
  const fail = (code, text) => {
    if (done) return; done = true;
    out.destroy(); unlinkQuiet(tmp);
    if (r.upload === up) { r.upload = null; broadcast(r, roomInfo(r)); }
    if (!res.headersSent) json(res, code, { error: text });
    req.resume();
  };
  up.abort = () => fail(409, 'Загрузка отменена');
  req.on('data', chunk => {
    got += chunk.length;
    if (got > up.size) { fail(400, 'Файл больше заявленного'); req.destroy(); return; }
    if (!out.write(chunk)) { req.pause(); out.once('drain', () => req.resume()); }
    up.loaded = got;
    const now = Date.now();
    if (now - lastSent > 700) { lastSent = now; broadcast(r, { t: 'upprog', gen: up.gen, loaded: got, total: up.size }); }
  });
  req.on('aborted', () => fail(400, 'Загрузка прервалась'));
  req.on('error', () => fail(400, 'Загрузка прервалась'));
  out.on('error', e => { console.warn('upload write:', e.message); fail(507, 'На сервере не хватило места'); });
  req.on('end', () => {
    if (done) return;
    if (got !== up.size) return fail(400, 'Файл пришёл не целиком');
    out.end(() => {
      if (done) return; done = true;
      if (r.upload !== up) { unlinkQuiet(tmp); return json(res, 409, { error: 'Загрузка отменена' }); }
      const final = path.join(UPLOAD_DIR, up.id + up.ext);
      fs.rename(tmp, final, err => {
        if (err || r.upload !== up) { unlinkQuiet(tmp); unlinkQuiet(final); if (r.upload === up) { r.upload = null; broadcast(r, roomInfo(r)); } return json(res, 500, { error: 'Не удалось сохранить файл' }); }
        r.upload = null;
        files.set(up.id, { path: final, size: up.size, mime: VIDEO_TYPES[up.ext] || 'application/octet-stream' });
        playMedia(r, { kind: 'file', id: up.id, title: up.name, size: up.size, gen: up.gen }, Date.now(), up.vid);
        json(res, 200, { ok: true, id: up.id });
      });
    });
  });
}
// отдача фильма с поддержкой Range (перемотка; без этого iPhone не играет)
function serveMedia(req, res, id) {
  const f = /^[a-f0-9]{32}$/.test(id) ? files.get(id) : null;
  if (!f || (req.method !== 'GET' && req.method !== 'HEAD')) { res.writeHead(404); return res.end(); }
  const head = { 'Content-Type': f.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  const range = String(req.headers.range || '');
  let start = 0, end = f.size - 1, code = 200;
  if (range) {
    const m = range.match(/^bytes=(\d*)-(\d*)$/);
    if (!m || (m[1] === '' && m[2] === '')) { res.writeHead(416, { 'Content-Range': 'bytes */' + f.size }); return res.end(); }
    if (m[1] === '') { start = Math.max(0, f.size - Number(m[2])); }
    else { start = Number(m[1]); if (m[2] !== '') end = Math.min(end, Number(m[2])); }
    if (start > end || start >= f.size) { res.writeHead(416, { 'Content-Range': 'bytes */' + f.size }); return res.end(); }
    code = 206; head['Content-Range'] = `bytes ${start}-${end}/${f.size}`;
  }
  head['Content-Length'] = end - start + 1;
  res.writeHead(code, head);
  if (req.method === 'HEAD' || f.size === 0) return res.end();
  const s = fs.createReadStream(f.path, { start, end });
  s.on('error', () => res.destroy());
  res.on('close', () => s.destroy());
  s.pipe(res);
}
// убрать фильм комнаты с диска (и из плеера у всех, если он ещё показывается)
function dropFile(r, silent) {
  clearTimeout(r.fileTimer); r.fileTimer = null;
  if (!r.file) return;
  const f = files.get(r.file.id);
  files.delete(r.file.id);
  if (f) unlinkQuiet(f.path);
  const wasPlaying = r.media && r.media.kind === 'file' && r.media.id === r.file.id;
  r.file = null;
  if (wasPlaying) {
    r.media = null; r.state = { playing: false, pos: 0, at: Date.now() };
    if (!silent) broadcast(r, roomInfo(r));
  }
}
function cancelUpload(r) {
  const up = r.upload; if (!up) return;
  r.upload = null;
  if (up.abort) up.abort();
  if (up.req) try { up.req.destroy(); } catch {}
}
// загрузивший ушёл? ждём 20 секунд (вдруг перезагрузил страницу), потом удаляем фильм
function checkFileOwner(r) {
  if (!r.file) return;
  const here = r.file.vid && [...r.people.values()].some(p => p.vid === r.file.vid);
  if (here) { clearTimeout(r.fileTimer); r.fileTimer = null; return; }
  if (r.fileTimer) return;
  if (!r.file.vid) return dropFile(r);
  r.fileTimer = setTimeout(() => { r.fileTimer = null; checkFileOwnerNow(r); }, OWNER_GRACE);
}
function checkFileOwnerNow(r) {
  if (!r.file) return;
  if (!(r.file.vid && [...r.people.values()].some(p => p.vid === r.file.vid))) dropFile(r);
}
async function freeSpace() {
  try { const st = await fs.promises.statfs(UPLOAD_DIR); return st.bavail * st.bsize; } catch { return Infinity; }
}

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
/** code -> { people: Map<id,{ws,vid,name,color}>, hostId, media: {...}|null, queue[], pass,
 *            state: {playing,pos,at}, chat[], emptySince,
 *            upload: {token,gen,id,vid,name,size,ext,loaded}|null — идёт загрузка фильма,
 *            file: {id, vid}|null — загруженный фильм и метка браузера загрузившего } */
const rooms = new Map();
const COLORS = ['#f5a742', '#d9707f', '#7cc59a', '#8fb3e8', '#c9a0e8', '#e8d27c', '#6fd0c8', '#f08a5d'];
const AVATARS = ['🐱', '🐶', '🦊', '🐼', '🐸', '🐵', '🦁', '🐯', '🐨', '🐰', '🦄', '🐙', '👽', '🤖', '👻', '💀', '🎃', '🍕', '🍿', '🎬', '⭐', '🔥', '🌚', '😎'];
const QUEUE_MAX = 50;
const hashPass = (salt, pass) => crypto.createHash('sha256').update(salt + '\u0000' + pass).digest();

function getRoom(code) {
  let r = rooms.get(code);
  if (!r) { r = { people: new Map(), hostId: null, media: null, upload: null, file: null, upGen: 0, queue: [], pass: null, state: { playing: false, pos: 0, at: Date.now() }, chat: [], emptySince: null }; rooms.set(code, r); }
  return r;
}
// Текущая позиция плеера по часам сервера — одинаковая для всех, кто подключится
function liveState(r) {
  const s = r.state;
  return { playing: s.playing, pos: s.playing ? s.pos + (Date.now() - s.at) / 1000 : s.pos };
}
const peersList = r => [...r.people.entries()].map(([id, p]) => ({ id, name: p.name, color: p.color, emoji: p.emoji, login: p.login || null, ava: p.ava || null }));
const uploadInfo = r => r.upload ? { gen: r.upload.gen, name: r.upload.name, total: r.upload.size, loaded: r.upload.loaded || 0 } : null;
const roomInfo = r => ({ t: 'room', hostId: r.hostId, upload: uploadInfo(r), media: r.media, queue: r.queue, locked: !!r.pass, state: liveState(r), peers: peersList(r) });

// Видео с Rutube / VK Видео из сообщения клиента -> проверенный объект (или null)
function makeMedia(m) {
  let media = null;
  if (m.kind === 'rutube' && /^[0-9a-f]{32}$/.test(String(m.id))) {
    media = { kind: 'rutube', id: String(m.id) };
  } else if (m.kind === 'vk' && /^-?\d{1,20}$/.test(String(m.oid)) && /^\d{1,20}$/.test(String(m.vid))) {
    media = { kind: 'vk', oid: String(m.oid), vid: String(m.vid) };
    if (/^[0-9a-f]{4,40}$/i.test(String(m.hash || ''))) media.hash = String(m.hash);
  }
  if (media) {
    media.title = clean(m.title, 200) || 'Видео';
    const d = Number(m.dur); media.dur = Number.isFinite(d) && d > 0 ? Math.round(d) : 0;
    if (typeof m.thumb === 'string' && /^https:\/\/[\w.-]+\/[\w\/.\-]+$/.test(m.thumb) && m.thumb.length < 300) media.thumb = m.thumb;
  }
  return media;
}
function playMedia(room, media, now, fileVid) {
  if (media) { media = { ...media, n: now }; delete media.qid; delete media.by; delete media.byName; }
  dropFile(room, true); // прежний фильм с компьютера больше не нужен
  if (media && media.kind === 'file') { room.file = { id: media.id, vid: fileVid || null }; }
  room.media = media;
  room.state = { playing: false, pos: 0, at: now };
  broadcast(room, roomInfo(room));
}

function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(r, msg, exceptId) {
  const text = JSON.stringify(msg);
  for (const [id, p] of r.people) if (id !== exceptId && p.ws.readyState === 1) p.ws.send(text);
}

const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
const validCode = c => typeof c === 'string' && /^[a-z0-9-]{3,32}$/.test(c);

accounts.setRoomLocked(code => !!(rooms.get(code) && rooms.get(code).pass));

// кто сейчас в какой комнате (для списка посетителей): метка посетителя -> код комнаты
function liveRooms() {
  const m = new Map();
  for (const [code, r] of rooms) for (const p of r.people.values()) if (p.vid) m.set(p.vid, code);
  return m;
}

// ---------- websocket ----------
const wss = miniws.attach(server, { path: '/ws', maxPayload: 1024 * 1024 }, ws => {
  let room = null, roomCode = null, id = null, passTries = 0;
  // антиспам: запас 80 сообщений, пополняется ~20 в секунду
  let tokens = 80, last = Date.now();

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // сообщения обрабатываем строго по очереди: вход в аккаунт (запрос к базе) должен закончиться раньше, чем вход в комнату
  let chain = Promise.resolve();
  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    if (raw.length > 64 * 1024) return;
    const now = Date.now();
    tokens = Math.min(80, tokens + (now - last) / 50); last = now;
    if (tokens < 1) return; tokens -= 1;

    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    chain = chain.then(() => onMessage(m, now)).catch(e => console.warn('ws:', e.message));
  });

  async function onMessage(m, now) {
    if (m.t === 'auth') { // вход в аккаунт: для онлайн-статуса, друзей и приглашений
      if (ws.user || !accounts.enabled) return;
      const user = await accounts.attach(ws, String(m.token || '')).catch(() => null);
      send(ws, user ? { t: 'authok', user } : { t: 'authfail' });
      return;
    }
    if (m.t === 'invite') { // позвать друга в свою комнату
      if (!ws.user || !room) return;
      const to = String(m.to || '');
      if (!accounts.isFriend(ws.user.login, to)) return send(ws, { t: 'error', text: 'Это не ваш друг' });
      if (!accounts.presenceOf(to).online) return send(ws, { t: 'error', text: 'Друг сейчас не в сети' });
      ws.invites = ws.invites || {};
      if (now - (ws.invites[to] || 0) < 10000) return;
      ws.invites[to] = now;
      accounts.toUser(to, { t: 'invited', from: ws.user, room: roomCode, locked: !!room.pass });
      send(ws, { t: 'invitesent', to });
      return;
    }

    if (m.t === 'hello') {
      if (room || !validCode(m.room)) return send(ws, { t: 'error', text: 'Неверный код комнаты' });
      const r = getRoom(m.room);
      const vid = /^[a-f0-9]{16}$/.test(String(m.vid || '')) ? String(m.vid) : null; // метка браузера
      const isOwner = !!vid && vid === r.ownerVid; // создатель комнаты (или тот, кому он передал управление)
      // тот же браузер уже числится в комнате (перезагрузил страницу или открыл вторую вкладку) — убираем старую копию
      const old = vid ? [...r.people.entries()].filter(([, p]) => p.vid === vid) : [];
      if (r.people.size - old.length >= MAX_PEOPLE) return send(ws, { t: 'error', text: 'Комната заполнена' });
      const pass = clean(m.pass, 64);
      if (r.pass && !isOwner) { // комната с паролем (создателю пароль не нужен)
        if (++passTries > 10) return send(ws, { t: 'error', text: 'Слишком много попыток. Обновите страницу.' });
        const ok = pass && crypto.timingSafeEqual(hashPass(r.pass.salt, pass), r.pass.hash);
        if (!ok) return send(ws, { t: 'needpass', wrong: !!pass });
      } else if (r.people.size === 0 && !r.hostId && pass) { // создатель комнаты задал пароль
        const salt = crypto.randomBytes(8).toString('hex');
        r.pass = { salt, hash: hashPass(salt, pass) };
      }
      for (const [pid, p] of old) {
        r.people.delete(pid);
        if (r.hostId === pid) r.hostId = null;
        p.ws.replaced = true; send(p.ws, { t: 'replaced' }); try { p.ws.close(); } catch {}
      }
      room = r; r.emptySince = null;
      id = crypto.randomBytes(6).toString('hex');
      const used = new Set([...r.people.values()].map(p => p.color));
      const color = /^#[0-9a-f]{6}$/i.test(String(m.color || '')) ? String(m.color).toLowerCase()
        : (COLORS.find(c => !used.has(c)) || COLORS[r.people.size % COLORS.length]);
      const emoji = AVATARS.includes(m.emoji) ? m.emoji : null;
      const u = ws.user; // вошёл в аккаунт — показываем имя и аватарку из профиля
      if (vid) { ws.vid = vid; stats.touch(vid); }
      r.people.set(id, { ws, vid: ws.vid || null, name: (u && u.name) || clean(m.name, 24) || 'Гость', color: (u && u.color) || color, emoji: (u && u.emoji) || emoji, login: u ? u.login : null, ava: u ? u.ava : null });
      roomCode = m.room; ws.roomCode = m.room;
      if (u) accounts.notifyFriends(u.login);
      if (!r.ownerVid && vid && !r.hostId) r.ownerVid = vid; // первый вошедший — создатель комнаты
      // ведущим становится: первый вошедший; создатель, вернувшийся в комнату; ведущий, который перезагрузил страницу
      if (!r.hostId || isOwner || (vid && vid === r.graceVid)) {
        r.hostId = id;
        clearTimeout(r.graceTimer); r.graceVid = null;
      }
      checkFileOwner(r); // загрузивший фильм вернулся — фильм не удаляем
      send(ws, { ...roomInfo(r), t: 'welcome', id, chat: r.chat });
      broadcast(r, roomInfo(r), id);
      return;
    }
    if (!room) return;
    const me = room.people.get(id);
    const isHost = room.hostId === id;

    switch (m.t) {
      case 'upreq': { // ведущий хочет загрузить фильм со своего компьютера
        if (!isHost) return;
        const name = clean(m.name, 200) || 'Видео';
        const size = Number(m.size);
        let ext = path.extname(name).toLowerCase(); if (!VIDEO_TYPES[ext]) ext = '.mp4';
        if (!Number.isSafeInteger(size) || size <= 0) return send(ws, { t: 'upfail', text: 'Пустой файл' });
        if (size > MAX_UPLOAD) return send(ws, { t: 'upfail', text: `Файл слишком большой: можно до ${Math.round(MAX_UPLOAD / 1048576)} МБ` });
        cancelUpload(room); // предыдущая незаконченная загрузка больше не нужна
        const reserve = 200 * 1048576;
        const free = await freeSpace() + (room.file && files.get(room.file.id) ? files.get(room.file.id).size : 0);
        if (free < size + reserve) return send(ws, { t: 'upfail', text: 'На сервере сейчас не хватает места для такого файла' });
        if (room.hostId !== id) return;
        const up = { token: randId(24), gen: ++room.upGen, id: randId(16), vid: me.vid || null, name: name.replace(/\.[a-z0-9]{1,5}$/i, '') || name, size, ext, loaded: 0 };
        room.upload = up;
        send(ws, { t: 'uptoken', token: up.token, gen: up.gen });
        broadcast(room, roomInfo(room));
        break;
      }
      case 'upcancel': { // ведущий отменил загрузку
        if (!room.upload || room.upload.vid !== me.vid) return;
        cancelUpload(room);
        broadcast(room, roomInfo(room));
        break;
      }
      case 'media': { // ведущий выбрал видео с Rutube или VK Видео (или убрал его)
        if (!isHost) return;
        playMedia(room, makeMedia(m), now);
        break;
      }
      case 'qadd': { // любой участник добавляет видео в очередь
        const media = makeMedia(m);
        if (!media) return;
        if (room.queue.length >= QUEUE_MAX) return send(ws, { t: 'error', text: 'Очередь заполнена' });
        room.queue.push({ ...media, qid: crypto.randomBytes(4).toString('hex'), by: id, byName: me.name });
        broadcast(room, roomInfo(room));
        break;
      }
      case 'qdel': { // убрать из очереди: ведущий — любое, участник — своё
        const i = room.queue.findIndex(q => q.qid === String(m.qid));
        if (i < 0 || !(isHost || room.queue[i].by === id)) return;
        room.queue.splice(i, 1);
        broadcast(room, roomInfo(room));
        break;
      }
      case 'qmove': { // ведущий меняет порядок: поднять на одну позицию вверх
        if (!isHost) return;
        const i = room.queue.findIndex(q => q.qid === String(m.qid));
        if (i <= 0) return;
        [room.queue[i - 1], room.queue[i]] = [room.queue[i], room.queue[i - 1]];
        broadcast(room, roomInfo(room));
        break;
      }
      case 'qplay': { // ведущий включает видео из очереди сейчас
        if (!isHost) return;
        const i = room.queue.findIndex(q => q.qid === String(m.qid));
        if (i < 0) return;
        const [item] = room.queue.splice(i, 1);
        playMedia(room, item, now);
        break;
      }
      case 'next': { // ведущий: следующее видео из очереди (вручную или по окончании)
        if (!isHost || !room.queue.length) return;
        playMedia(room, room.queue.shift(), now);
        break;
      }
      case 'setpass': { // ведущий ставит, меняет или снимает пароль
        if (!isHost) return;
        const pass = clean(m.pass, 64);
        if (pass) { const salt = crypto.randomBytes(8).toString('hex'); room.pass = { salt, hash: hashPass(salt, pass) }; }
        else room.pass = null;
        broadcast(room, roomInfo(room));
        for (const p of room.people.values()) if (p.login) accounts.notifyFriends(p.login);
        break;
      }
      case 'sync': { // ведущий: состояние плеера (пауза, время)
        if (!isHost || !room.media) return;
        const pos = Number(m.pos);
        if (!Number.isFinite(pos) || pos < 0 || pos > 1e6) return;
        room.state = { playing: !!m.playing, pos, at: now };
        broadcast(room, { t: 'sync', playing: !!m.playing, pos, ev: m.ev ? 1 : 0 }, id);
        break;
      }
      case 'givehost': { // ведущий передаёт управление
        if (!isHost || !room.people.has(String(m.to))) return;
        room.hostId = String(m.to); // видео остаётся (и фильм с компьютера тоже), его просто ведёт новый ведущий
        room.ownerVid = room.people.get(room.hostId).vid || room.ownerVid; // передал управление — передал и комнату
        broadcast(room, roomInfo(room));
        break;
      }
      case 'chat': {
        const text = clean(m.text, 400);
        if (!text) return;
        const msg = { t: 'chat', id: crypto.randomBytes(4).toString('hex'), by: id, name: me.name, color: me.color, emoji: me.emoji, ava: me.ava || null, text, ts: now };
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
  }

  ws.on('close', () => {
    ws.roomCode = null;
    accounts.detach(ws);
    if (!room || ws.replaced || room.people.get(id)?.ws !== ws) return; // эту копию уже заменила новая вкладка
    room.people.delete(id);
    // загрузка фильма идёт отдельным запросом: если вкладку закрыли, он оборвётся сам
    checkFileOwner(room);
    if (room.hostId === id) { // ведущий ушёл
      room.hostId = null;
      if (room.state.playing) room.state = { ...liveState(room), playing: false, at: Date.now() }; // ставим на паузу
      const r = room;
      const pass = () => { r.graceVid = null; if (!r.hostId && r.people.size) { r.hostId = r.people.keys().next().value; broadcast(r, roomInfo(r)); } };
      if (ws.vid && r.people.size) { // ждём 20 секунд — вдруг он просто перезагрузил страницу
        r.graceVid = ws.vid; clearTimeout(r.graceTimer); r.graceTimer = setTimeout(pass, 20000);
      } else pass();
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
  for (const [code, r] of rooms) if (r.emptySince && now - r.emptySince > ROOM_TTL) { cancelUpload(r); dropFile(r, true); rooms.delete(code); }
}, 25000);

server.listen(PORT, () => console.log(`Общий диван запущен: http://localhost:${PORT}`));
