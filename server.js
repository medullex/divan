// Общий диван — сервер комнат.
// Отдаёт страницу и пересылает сообщения между зрителями одной комнаты: чат, реакции, синхронизацию.
// Видео с Rutube/VK идёт из их плееров. Файл с компьютера ведущий загружает сюда, во временную папку,
// и зрители смотрят его обычной ссылкой /media/<id>. Файл удаляется, когда загрузивший ушёл из комнаты.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { EventEmitter } = require('events');
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
  for (const [code, r] of rooms) {
    if (r.upload && r.upload.token === token) return { code, r, up: r.upload };
    if (r.qups.has(token)) return { code, r, up: r.qups.get(token) };
  }
  return null;
}
// Можно ли уже начинать смотреть, пока фильм догружается: сравниваем скорость загрузки с «весом» секунды фильма.
// Возвращает { safe, wait } — wait: примерно сколько секунд ещё подождать.
function judgeEarly(up) {
  if (!up.early || !up.dur || !up.rate) return { safe: false, wait: null };
  const B = up.size / up.dur;                 // байт в секунду фильма
  const S = up.rate * 0.8;                    // скорость загрузки с запасом
  const L = up.written, cushion = Math.min(up.size, Math.max(B * 15, 4 * 1048576)); // запас: 15 секунд фильма, минимум 4 МБ
  if (S >= B * 1.05) return L >= cushion ? { safe: true, wait: 0 } : { safe: false, wait: Math.ceil((cushion - L) / up.rate) };
  // загрузка медленнее фильма: стартуем, когда накоплено столько, что просмотр не догонит загрузку до конца
  const need = Math.min(up.size, Math.max(cushion, (B - S) * (up.size + 20 * S) / B));
  if (L >= need) return { safe: true, wait: 0 };
  return { safe: false, wait: Math.ceil((need - L) / up.rate) };
}
// приём файла: тело запроса пишется на диск по кусочкам, в памяти не держим.
// Бывает двух видов: «включить сейчас» (room.upload, одна на комнату) и «в очередь» (room.qups, фоном).
function apiUpload(req, res, token) {
  if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
  const f = findUpload(token);
  if (!f || f.up.started) return json(res, 403, { error: 'Загрузка не разрешена. Выберите файл ещё раз.' });
  const { r, up } = f;
  const len = Number(req.headers['content-length']);
  if (len !== up.size) return json(res, 400, { error: 'Размер файла не совпал. Выберите файл ещё раз.' });
  up.started = true; up.req = req;
  up.written = 0; up.rate = 0; up.ev = new EventEmitter(); up.ev.setMaxListeners(0);
  const final = path.join(UPLOAD_DIR, up.id + up.ext);
  const out = fs.createWriteStream(final);
  let got = 0, done = false, lastSent = 0, rateAt = Date.now(), rateBytes = 0;
  const alive = () => up.queued ? r.qups.get(up.token) === up : r.upload === up;
  const entry = () => ({ path: final, size: up.size, mime: VIDEO_TYPES[up.ext] || 'application/octet-stream', up: up.done ? null : up });
  const publish = () => {
    files.set(up.id, entry());
    playMedia(r, { kind: 'file', id: up.id, title: up.name, size: up.size, gen: up.gen, partial: !up.done }, Date.now(), up.vid);
  };
  const fail = (code, text) => {
    if (done) return; done = true;
    up.failed = true; up.ev.emit('more');
    out.destroy(); unlinkQuiet(final);
    if (up.queued) r.qups.delete(up.token); else if (r.upload === up) r.upload = null;
    dropFileId(r, up.id, true); // и из плеера, и из очереди
    broadcast(r, roomInfo(r));
    if (!res.headersSent) json(res, code, { error: text });
    req.resume();
  };
  up.abort = () => fail(409, 'Загрузка отменена');
  // фильм, который можно смотреть по мере загрузки, появляется у всех сразу
  if (up.early && !up.queued) publish();
  req.on('data', chunk => {
    if (done) return;
    got += chunk.length;
    if (got > up.size) { fail(400, 'Файл больше заявленного'); req.destroy(); return; }
    const okWrite = out.write(chunk, err => { if (!err) { up.written += chunk.length; up.ev.emit('more'); } });
    if (!okWrite) { req.pause(); out.once('drain', () => req.resume()); }
    up.loaded = got;
    const now = Date.now();
    if (now - rateAt >= 2000) { // скорость загрузки, сглаженная
      const inst = (got - rateBytes) / ((now - rateAt) / 1000);
      up.rate = up.rate ? up.rate * 0.6 + inst * 0.4 : inst; rateAt = now; rateBytes = got;
    }
    if (now - lastSent > 700) {
      lastSent = now;
      if (up.queued) {
        const item = r.queue.find(q => q.qid === up.qid);
        if (item) item.pct = Math.floor(got / up.size * 100);
        broadcast(r, { t: 'qprog', qid: up.qid, pct: Math.floor(got / up.size * 100) });
      } else {
        const j = judgeEarly(up); up.safe = up.safe || j.safe; up.wait = up.safe ? 0 : j.wait; // «можно начинать» назад не откатываем
        broadcast(r, { t: 'upprog', gen: up.gen, loaded: got, total: up.size, safe: up.safe, wait: up.wait });
      }
    }
  });
  req.on('aborted', () => fail(400, 'Загрузка прервалась'));
  req.on('error', () => fail(400, 'Загрузка прервалась'));
  out.on('error', e => { console.warn('upload write:', e.message); fail(507, 'На сервере не хватило места'); });
  req.on('end', () => {
    if (done) return;
    if (got !== up.size) return fail(400, 'Файл пришёл не целиком');
    out.end(() => {
      if (done) return; done = true;
      if (!alive()) { unlinkQuiet(final); return json(res, 409, { error: 'Загрузка отменена' }); }
      up.done = true; up.written = up.size; up.ev.emit('more');
      if (up.queued) { // фильм ждёт своей очереди
        r.qups.delete(up.token);
        files.set(up.id, entry());
        const item = r.queue.find(q => q.qid === up.qid);
        if (item) { delete item.loading; delete item.pct; }
        broadcast(r, roomInfo(r));
        return json(res, 200, { ok: true, id: up.id });
      }
      r.upload = null;
      const fe = files.get(up.id); if (fe) fe.up = null;
      if (up.early && r.media && r.media.kind === 'file' && r.media.id === up.id) {
        r.media = { ...r.media, partial: false };
        broadcast(r, roomInfo(r));
      } else publish();
      json(res, 200, { ok: true, id: up.id });
    });
  });
}
// отдача фильма с поддержкой Range (перемотка; без этого iPhone не играет).
// Если фильм ещё загружается — отдаём то, что есть, и ждём следующих кусочков.
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
  if (!f.up) {
    const s = fs.createReadStream(f.path, { start, end });
    s.on('error', () => res.destroy());
    res.on('close', () => s.destroy());
    return s.pipe(res);
  }
  streamGrowing(f.path, f.up, start, end, res);
}
async function streamGrowing(file, up, start, end, res) {
  let fd = null, closed = false;
  const wake = new EventEmitter(); wake.setMaxListeners(0);
  const onMore = () => wake.emit('go');
  up.ev.on('more', onMore);
  res.on('close', () => { closed = true; wake.emit('go'); });
  // ждём новых кусочков или освобождения сети; если зритель уже ушёл — не ждём вовсе
  // (раньше ожидание могло повиснуть навсегда, файл «терялся» и Node падал целиком — сайт выдавал 502)
  const wait = (ms, drain) => new Promise(ok => {
    if (closed || res.destroyed) return ok();
    const done = () => { clearTimeout(t); wake.off('go', done); res.off('drain', done); ok(); };
    const t = setTimeout(done, ms);
    wake.on('go', done); if (drain) res.on('drain', done);
  });
  try {
    fd = await fs.promises.open(file, 'r');
    let pos = start;
    while (pos <= end && !closed && !res.destroyed) {
      if (up.failed) throw new Error('upload failed');
      const avail = up.done ? end + 1 : Math.min(end + 1, up.written);
      if (pos >= avail) { await wait(15000); continue; }
      const n = Math.min(256 * 1024, avail - pos);
      const buf = Buffer.allocUnsafe(n);
      const { bytesRead } = await fd.read(buf, 0, n, pos);
      if (!bytesRead) { await wait(15000); continue; }
      pos += bytesRead;
      if (!res.write(buf.subarray(0, bytesRead))) await wait(60000, true);
    }
    if (!closed && !res.destroyed) res.end();
  } catch { res.destroy(); }
  finally {
    up.ev.off('more', onMore);
    if (fd) await fd.close().catch(() => {});
  }
}
// убрать фильм с диска: из плеера у всех (если он сейчас идёт), из очереди и из загрузок
function dropFileId(r, id, silent) {
  if (!id) return;
  const f = files.get(id);
  files.delete(id);
  if (f) unlinkQuiet(f.path);
  r.owned.delete(id);
  if (r.upload && r.upload.id === id) cancelUpload(r);
  for (const [tk, up] of r.qups) if (up.id === id) { r.qups.delete(tk); if (up.abort) up.abort(); if (up.req) try { up.req.destroy(); } catch {} }
  const qi = r.queue.findIndex(q => q.kind === 'file' && q.id === id);
  if (qi >= 0) r.queue.splice(qi, 1);
  if (r.media && r.media.kind === 'file' && r.media.id === id) {
    r.media = null; r.state = { playing: false, pos: 0, at: Date.now() };
    if (!silent) broadcast(r, roomInfo(r));
  } else if (!silent && qi >= 0) broadcast(r, roomInfo(r));
}
function dropAllFiles(r) { for (const id of [...r.owned.keys()]) dropFileId(r, id, true); }
function cancelUpload(r) {
  const up = r.upload; if (!up) return;
  r.upload = null;
  if (up.abort) up.abort();
  if (up.req) try { up.req.destroy(); } catch {}
}
// загрузивший ушёл? ждём 20 секунд (вдруг перезагрузил страницу), потом удаляем его фильмы — и тот, что идёт, и те, что в очереди
const present = (r, vid) => !!vid && [...r.people.values()].some(p => p.vid === vid);
function checkFileOwner(r) {
  const owners = new Set(r.owned.values());
  for (const [vid, t] of r.ownTimers) if (!owners.has(vid) || present(r, vid)) { clearTimeout(t); r.ownTimers.delete(vid); }
  for (const vid of owners) {
    if (present(r, vid) || r.ownTimers.has(vid)) continue;
    if (!vid) { for (const [id, v] of [...r.owned]) if (!v) dropFileId(r, id); continue; }
    r.ownTimers.set(vid, setTimeout(() => {
      r.ownTimers.delete(vid);
      if (present(r, vid)) return;
      let changed = false;
      for (const [id, v] of [...r.owned]) if (v === vid) { dropFileId(r, id, true); changed = true; }
      if (changed) broadcast(r, roomInfo(r));
    }, OWNER_GRACE));
  }
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
// реакции (всплывают на видео) и стикеры (в чат) — те же списки есть в index.html
const REACTS = ['😂','🤣','😮','😱','😭','🥲','❤️','🔥','👏','🎉','😍','🥰','😘','😎','🤔','🤨','😴','🤯','😡','🤬','🤢','🤮','💀','👻','🙈','🙉','👀','🍿','🥤','🍕','👍','👎','🙏','💯','⚡','💔','🤡','🥶','😈','🍻'];
const STICKERS = new Set(Array.from({ length: 24 }, (_, i) => 's' + (i + 1)));
const hashPass = (salt, pass) => crypto.createHash('sha256').update(salt + '\u0000' + pass).digest();

function getRoom(code) {
  let r = rooms.get(code);
  if (!r) { r = { people: new Map(), hostId: null, media: null, upload: null, qups: new Map(), owned: new Map(), ownTimers: new Map(), upGen: 0, queue: [], pass: null, state: { playing: false, pos: 0, at: Date.now() }, chat: [], emptySince: null }; rooms.set(code, r); }
  return r;
}
// Текущая позиция плеера по часам сервера — одинаковая для всех, кто подключится
function liveState(r) {
  const s = r.state;
  return { playing: s.playing, pos: s.playing ? s.pos + (Date.now() - s.at) / 1000 : s.pos };
}
const peersList = r => [...r.people.entries()].map(([id, p]) => ({ id, name: p.name, color: p.color, emoji: p.emoji, login: p.login || null, ava: p.ava || null,
  slot: p.slot, voice: p.voice ? { mic: !!p.voice.mic } : null }));
// номер участника для голоса (1…250): им подписан каждый кусочек звука, так короче, чем полный id
function freeSlot(r) { const used = new Set([...r.people.values()].map(p => p.slot)); for (let i = 1; i <= 250; i++) if (!used.has(i)) return i; return 0; }
const uploadInfo = r => r.upload ? { gen: r.upload.gen, name: r.upload.name, total: r.upload.size, loaded: r.upload.loaded || 0, early: !!r.upload.early, safe: !!r.upload.safe, wait: r.upload.wait ?? null } : null;
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
  // прежний фильм с компьютера больше не нужен (если это не он же)
  if (room.media && room.media.kind === 'file' && !(media && media.kind === 'file' && media.id === room.media.id)) dropFileId(room, room.media.id, true);
  if (media && media.kind === 'file') { delete media.loading; delete media.pct; if (fileVid !== undefined) room.owned.set(media.id, fileVid || null); }
  room.media = media;
  room.state = { playing: false, pos: 0, at: now };
  broadcast(room, roomInfo(room));
  notifyRoomFriends(room);
}

function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function broadcast(r, msg, exceptId) {
  const text = JSON.stringify(msg);
  for (const [id, p] of r.people) if (id !== exceptId && p.ws.readyState === 1) p.ws.send(text);
}

const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
const validCode = c => typeof c === 'string' && /^[a-z0-9-]{3,32}$/.test(c);

accounts.setRoomLocked(code => !!(rooms.get(code) && rooms.get(code).pass));
accounts.setRoomWhat(code => { const r = rooms.get(code); return r ? (r.media ? r.media.title : r.upload ? r.upload.name : null) : null; });
// в комнате сменилось видео — друзья зрителей видят «смотрит „…“»
function notifyRoomFriends(r) { for (const p of r.people.values()) if (p.login) accounts.notifyFriends(p.login); }

// кто сейчас в какой комнате (для списка посетителей): метка посетителя -> код комнаты
function liveRooms() {
  const m = new Map();
  for (const [code, r] of rooms) for (const p of r.people.values()) if (p.vid) m.set(p.vid, code);
  return m;
}

// страховка: если где-то случится непойманная ошибка, пишем её в лог, а сайт продолжает работать
process.on('uncaughtException', e => console.error('[uncaught]', e && e.stack || e));
process.on('unhandledRejection', e => console.error('[unhandled]', e && e.stack || e));

// ---------- websocket ----------
const wss = miniws.attach(server, { path: '/ws', maxPayload: 1024 * 1024 }, (ws, req) => {
  let room = null, roomCode = null, id = null, passTries = 0;
  // антиспам: запас 80 сообщений, пополняется ~20 в секунду
  let tokens = 80, last = Date.now();
  let vtokens = 120, vlast = Date.now(); // голос: ~50 кусочков в секунду

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // сообщения обрабатываем строго по очереди: вход в аккаунт (запрос к базе) должен закончиться раньше, чем вход в комнату
  let chain = Promise.resolve();
  ws.on('message', (raw, isBinary) => {
    if (isBinary) { voiceFrame(raw); return; }
    if (raw.length > 64 * 1024) return;
    const now = Date.now();
    tokens = Math.min(80, tokens + (now - last) / 50); last = now;
    if (tokens < 1) return; tokens -= 1;

    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    chain = chain.then(() => onMessage(m, now)).catch(e => console.warn('ws:', e.message));
  });

  // Голос: кусочек звука (20 мс, сжатый в 8 бит) от говорящего — пересылаем остальным в голосовом канале.
  // Формат: [1][звук…] → остальным [1][номер говорящего][звук…]
  function voiceFrame(buf) {
    if (!room || buf.length < 2 || buf.length > 4000 || buf[0] !== 1) return;
    const me = room.people.get(id);
    if (!me || !me.voice || !me.voice.mic || !me.slot) return;
    const now = Date.now();
    vtokens = Math.min(120, vtokens + (now - vlast) / 15); vlast = now;
    if (vtokens < 1) return; vtokens -= 1;
    const out = Buffer.allocUnsafe(buf.length + 1);
    out[0] = 1; out[1] = me.slot; buf.copy(out, 2, 1);
    for (const [pid, p] of room.people) {
      if (pid === id || !p.voice || p.ws.readyState !== 1) continue;
      if (p.ws.bufferedAmount > 256 * 1024) continue; // не успевает — пропускаем кусочек, иначе голос начнёт отставать
      p.ws.sendBinary(out);
    }
  }

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
      // что сейчас смотрят — чтобы в приглашении было «зовёт смотреть „…“»
      const what = room.media ? room.media.title : room.upload ? room.upload.name : null;
      accounts.toUser(to, { t: 'invited', from: ws.user, room: roomCode, locked: !!room.pass, what: what ? clean(what, 120) : null });
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
      r.people.set(id, { ws, slot: freeSlot(r), voice: null, vid: ws.vid || null, name: (u && u.name) || clean(m.name, 24) || 'Гость', color: (u && u.color) || color, emoji: (u && u.emoji) || emoji, login: u ? u.login : null, ava: u ? u.ava : null });
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
      case 'upreq': { // загрузить фильм с компьютера: ведущий — включить сейчас, любой — в очередь
        const queued = !!m.queue;
        if (!queued && !isHost) return;
        const cid = clean(m.cid, 16);
        const name = clean(m.name, 200) || 'Видео';
        const size = Number(m.size);
        let ext = path.extname(name).toLowerCase(); if (!VIDEO_TYPES[ext]) ext = '.mp4';
        if (!Number.isSafeInteger(size) || size <= 0) return send(ws, { t: 'upfail', cid, text: 'Пустой файл' });
        if (size > MAX_UPLOAD) return send(ws, { t: 'upfail', cid, text: `Файл слишком большой: можно до ${Math.round(MAX_UPLOAD / 1048576)} МБ` });
        if (queued && room.queue.length >= QUEUE_MAX) return send(ws, { t: 'upfail', cid, text: 'Очередь заполнена' });
        if (queued && [...room.qups.values()].some(u => u.vid && u.vid === me.vid)) return send(ws, { t: 'upfail', cid, text: 'Сначала дождитесь, пока загрузится предыдущий фильм' });
        if (!queued) cancelUpload(room); // предыдущая незаконченная загрузка больше не нужна
        const reserve = 200 * 1048576;
        const cur = !queued && room.media && room.media.kind === 'file' && files.get(room.media.id);
        const free = await freeSpace() + (cur ? cur.size : 0);
        if (free < size + reserve) return send(ws, { t: 'upfail', cid, text: 'На сервере сейчас не хватает места для такого файла' });
        if (!queued && room.hostId !== id) return;
        const dur = Number(m.dur);
        const up = { token: randId(24), gen: ++room.upGen, id: randId(16), vid: me.vid || null, name: name.replace(/\.[a-z0-9]{1,5}$/i, '') || name, size, ext, loaded: 0,
          dur: Number.isFinite(dur) && dur > 1 && dur < 86400 ? dur : 0, early: !!m.early && !queued, safe: false, wait: null, queued };
        if (queued) { // в очереди сразу появляется строчка «загружается…»
          up.qid = crypto.randomBytes(4).toString('hex');
          room.qups.set(up.token, up); room.owned.set(up.id, up.vid);
          room.queue.push({ kind: 'file', id: up.id, title: up.name, size, qid: up.qid, by: id, byName: me.name, loading: true, pct: 0 });
        } else room.upload = up;
        send(ws, { t: 'uptoken', token: up.token, gen: up.gen, id: up.id, cid, queued });
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
        // одно и то же видео дважды не добавляем
        const same = x => x && x.kind === media.kind && (media.kind === 'vk' ? x.oid === media.oid && x.vid === media.vid : x.id === media.id);
        if (room.queue.some(same)) return send(ws, { t: 'error', text: 'Это видео уже в очереди' });
        if (same(room.media)) return send(ws, { t: 'error', text: 'Это видео уже идёт' });
        room.queue.push({ ...media, qid: crypto.randomBytes(4).toString('hex'), by: id, byName: me.name });
        broadcast(room, roomInfo(room));
        break;
      }
      case 'qdel': { // убрать из очереди: ведущий — любое, участник — своё
        const i = room.queue.findIndex(q => q.qid === String(m.qid));
        if (i < 0 || !(isHost || room.queue[i].by === id)) return;
        const [gone] = room.queue.splice(i, 1);
        if (gone.kind === 'file') dropFileId(room, gone.id, true); // фильм с компьютера убрали из очереди — стираем
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
        if (room.queue[i].loading) return send(ws, { t: 'error', text: 'Этот фильм ещё загружается' });
        const [item] = room.queue.splice(i, 1);
        playMedia(room, item, now);
        break;
      }
      case 'next': { // ведущий: следующее видео из очереди (вручную или по окончании)
        if (!isHost) return;
        const i = room.queue.findIndex(q => !q.loading); // ещё загружающиеся фильмы пропускаем
        if (i < 0) return;
        playMedia(room, room.queue.splice(i, 1)[0], now);
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
      case 'diag': { // отчёт зрителя о том, как идёт фильм (для отладки, только в лог)
        const ua = String(req.headers['user-agent'] || '');
        const dev = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : 'PC';
        const d = {}; for (const k of ['lag','rs','ahead','stalls','seekLag','busy','rate','paused','mbit']) if (k in m) d[k] = typeof m[k] === 'number' || typeof m[k] === 'boolean' ? m[k] : null;
        console.log('[diag]', roomCode, dev, clean(me.name, 20), JSON.stringify(d));
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
        const st = STICKERS.has(String(m.st)) ? String(m.st) : null; // стикер вместо текста
        const text = st ? '' : clean(m.text, 400);
        if (!text && !st) return;
        const msg = { t: 'chat', id: crypto.randomBytes(4).toString('hex'), by: id, name: me.name, color: me.color, emoji: me.emoji, ava: me.ava || null, text, ts: now };
        if (st) msg.st = st;
        room.chat.push(msg);
        if (room.chat.length > CHAT_KEEP) room.chat.splice(0, room.chat.length - CHAT_KEEP);
        broadcast(room, msg);
        break;
      }
      case 'voice': { // вошёл/вышел из голосового, включил/выключил микрофон
        const v = m.on ? { mic: !!m.mic } : null;
        const was = JSON.stringify(me.voice);
        me.voice = v;
        if (was !== JSON.stringify(v)) broadcast(room, roomInfo(room));
        break;
      }
      case 'react': {
        const e = clean(m.e, 8);
        if (!REACTS.includes(e)) return;
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
  for (const [code, r] of rooms) if (r.emptySince && now - r.emptySince > ROOM_TTL) { cancelUpload(r); dropAllFiles(r); for (const t of r.ownTimers.values()) clearTimeout(t); rooms.delete(code); }
}, 25000);

server.listen(PORT, () => console.log(`Общий диван запущен: http://localhost:${PORT}`));
