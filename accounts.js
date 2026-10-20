// Общий диван — аккаунты и друзья.
// Данные хранятся в Upstash Redis (REST API, без сторонних библиотек).
// Пароли хранятся только в виде scrypt-хеша с солью, сами пароли нигде не сохраняются.

const crypto = require('crypto');

const DB_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const DB_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const enabled = !!(DB_URL && DB_TOKEN);

const SESSION_TTL = 90 * 24 * 3600; // сессия живёт 90 дней
const FRIENDS_MAX = 200;
const AVATARS = ['🐱', '🐶', '🦊', '🐼', '🐸', '🐵', '🦁', '🐯', '🐨', '🐰', '🦄', '🐙', '👽', '🤖', '👻', '💀', '🎃', '🍕', '🍿', '🎬', '⭐', '🔥', '🌚', '😎'];

const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
const validLogin = l => typeof l === 'string' && /^[a-z0-9_]{3,20}$/.test(l);
const normLogin = l => String(l || '').trim().replace(/^@/, '').toLowerCase();

// ---------- Redis ----------
async function db(...cmd) {
  const r = await fetch(DB_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + DB_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd.map(String)),
    signal: AbortSignal.timeout(8000),
  });
  const j = await r.json().catch(() => ({ error: 'bad response ' + r.status }));
  if (j.error) throw new Error('redis: ' + j.error);
  return j.result;
}
async function dbMany(cmds) {
  if (!cmds.length) return [];
  const r = await fetch(DB_URL + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + DB_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds.map(c => c.map(String))),
    signal: AbortSignal.timeout(8000),
  });
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error('redis pipeline: ' + (j.error || r.status));
  return j.map(x => x.result);
}
const hashObj = arr => { const o = {}; if (Array.isArray(arr)) for (let i = 0; i < arr.length; i += 2) o[arr[i]] = arr[i + 1]; return o; };

// ---------- пароли ----------
const scrypt = (pass, salt) => new Promise((res, rej) =>
  crypto.scrypt(pass, salt, 32, { N: 16384, r: 8, p: 1 }, (e, k) => e ? rej(e) : res(k)));
const DUMMY_SALT = crypto.randomBytes(16).toString('hex');

// ---------- пользователи ----------
const publicUser = (login, u) => ({
  login, name: u.name || login,
  emoji: AVATARS.includes(u.emoji) ? u.emoji : null,
  color: /^#[0-9a-f]{6}$/i.test(u.color || '') ? u.color : null,
  ava: /^\d+$/.test(u.avatar || '') ? '/api/avatar/' + login + '?v=' + u.avatar : null, // своё фото
});
const AVA_MAX = 60 * 1024; // фото после сжатия в браузере весит 5–20 КБ
function imageKind(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.length > 8 && buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  return null;
}

async function getUser(login) {
  if (!validLogin(login)) return null;
  const u = hashObj(await db('HGETALL', 'user:' + login));
  return u.hash ? u : null;
}
async function getUsers(logins) {
  const rows = await dbMany(logins.map(l => ['HMGET', 'user:' + l, 'name', 'emoji', 'color', 'avatar']));
  return logins.map((l, i) => publicUser(l, { name: rows[i]?.[0], emoji: rows[i]?.[1], color: rows[i]?.[2], avatar: rows[i]?.[3] }));
}
async function newSession(login) {
  const token = crypto.randomBytes(24).toString('base64url');
  await db('SET', 'sess:' + token, login, 'EX', SESSION_TTL);
  return token;
}
async function userByToken(token) {
  if (!enabled || typeof token !== 'string' || !/^[\w-]{20,64}$/.test(token)) return null;
  const login = await db('GET', 'sess:' + token);
  if (!login) return null;
  const u = await getUser(login);
  return u ? publicUser(login, u) : null;
}

// ---------- онлайн-статус (в памяти сервера) ----------
// login -> Set<ws>; у каждого ws: ws.user, ws.roomCode
const online = new Map();
const friendCache = new Map(); // login -> Set<login> (только для тех, кто онлайн)
let roomLocked = () => false;  // сервер подставит функцию «комната с паролем?»
let roomWhat = () => null;     // …и «что сейчас смотрят в комнате»

function sendWs(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function toUser(login, msg) { for (const ws of online.get(login) || []) sendWs(ws, msg); }
function presenceOf(login) {
  const set = online.get(login);
  if (!set || !set.size) return { online: false, room: null };
  let room = null;
  for (const ws of set) if (ws.roomCode) { room = ws.roomCode; break; }
  return { online: true, room, locked: room ? roomLocked(room) : false, watching: room ? roomWhat(room) : null };
}
function notifyFriends(login) {
  const fr = friendCache.get(login);
  if (!fr) return;
  const p = presenceOf(login);
  for (const f of fr) toUser(f, { t: 'presence', login, ...p });
}
async function attach(ws, token) {
  const user = await userByToken(token);
  if (!user) return null;
  ws.user = user;
  if (!online.has(user.login)) online.set(user.login, new Set());
  online.get(user.login).add(ws);
  if (!friendCache.has(user.login)) friendCache.set(user.login, new Set(await db('SMEMBERS', 'friends:' + user.login) || []));
  notifyFriends(user.login);
  return user;
}
function detach(ws) {
  if (!ws.user) return;
  const login = ws.user.login, set = online.get(login);
  if (set) { set.delete(ws); if (!set.size) online.delete(login); }
  notifyFriends(login);
  if (!online.has(login)) friendCache.delete(login);
}
function refresh(login, u) { for (const ws of online.get(login) || []) ws.user = u; } // новые имя/фото — для следующих входов в комнату
const isFriend = (a, b) => !!friendCache.get(a)?.has(b);
function cacheFriend(a, b, on) {
  for (const [x, y] of [[a, b], [b, a]]) { const s = friendCache.get(x); if (s) on ? s.add(y) : s.delete(y); }
}

// ---------- HTTP API ----------
const hits = new Map(); // ip -> { n, at } — защита от перебора паролей
function limited(req, max) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now(); let h = hits.get(ip);
  if (!h || now - h.at > 10 * 60e3) { h = { n: 0, at: now }; hits.set(ip, h); }
  if (hits.size > 5000) hits.clear();
  return ++h.n > max;
}
function readBody(req, max = 4096) {
  return new Promise((res, rej) => {
    let size = 0; const parts = [];
    req.on('data', c => { size += c.length; if (size > max) { rej(new Error('big')); req.destroy(); } else parts.push(c); });
    req.on('end', () => { try { res(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); } catch { res({}); } });
    req.on('error', rej);
  });
}
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const bearer = req => (String(req.headers.authorization || '').match(/^Bearer ([\w-]+)$/) || [])[1];

async function me(login) {
  const [friends, reqs, sent] = await dbMany([['SMEMBERS', 'friends:' + login], ['SMEMBERS', 'req:' + login], ['SMEMBERS', 'sent:' + login]]);
  const [fu, ru, su] = await Promise.all([getUsers(friends || []), getUsers(reqs || []), getUsers(sent || [])]);
  return {
    friends: fu.map(f => ({ ...f, ...presenceOf(f.login) })).sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name)),
    requests: ru, sent: su,
  };
}

async function handle(req, res, pathname) {
  if (!/^\/api\/(auth|me|friends|avatar)(\/|$)/.test(pathname)) return false;
  if (!enabled) { send(res, 503, { error: 'Аккаунты пока не настроены' }); return true; }
  try {
    const am = pathname.match(/^\/api\/avatar\/([a-z0-9_]{3,20})$/);
    if (am) { // отдаём фото пользователя
      const b64 = await db('GET', 'ava:' + am[1]);
      const buf = b64 ? Buffer.from(b64, 'base64') : null;
      const type = buf && imageKind(buf);
      if (!type) { res.writeHead(404, { 'Cache-Control': 'no-store' }); res.end(); return true; }
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=604800, immutable', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'" });
      res.end(buf);
      return true;
    }
    if (pathname === '/api/auth/register' || pathname === '/api/auth/login') {
      if (req.method !== 'POST') return send(res, 405, { error: 'POST' }), true;
      if (limited(req, 30)) return send(res, 429, { error: 'Слишком много попыток. Подождите 10 минут.' }), true;
      const b = await readBody(req);
      const login = normLogin(b.login), pass = String(b.pass || '');
      if (pathname.endsWith('register')) {
        if (!validLogin(login)) return send(res, 400, { error: 'Ник: от 3 до 20 символов, латинские буквы, цифры и _' }), true;
        if (pass.length < 6 || pass.length > 100) return send(res, 400, { error: 'Пароль: минимум 6 символов' }), true;
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = (await scrypt(pass, salt)).toString('hex');
        const emoji = AVATARS.includes(b.emoji) ? b.emoji : '';
        const color = /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : '';
        const name = clean(b.name, 24) || login;
        const created = await db('HSETNX', 'user:' + login, 'hash', hash);
        if (!created) return send(res, 409, { error: 'Такой ник уже занят' }), true;
        await db('HSET', 'user:' + login, 'salt', salt, 'name', name, 'emoji', emoji, 'color', color, 'created', Date.now());
        const token = await newSession(login);
        return send(res, 200, { token, user: publicUser(login, { name, emoji, color }) }), true;
      }
      const u = validLogin(login) ? await getUser(login) : null;
      const key = await scrypt(pass, u ? u.salt : DUMMY_SALT); // считаем хеш всегда, чтобы по времени ответа нельзя было понять, есть ли ник
      if (!u || !crypto.timingSafeEqual(key, Buffer.from(u.hash, 'hex'))) return send(res, 401, { error: 'Неверный ник или пароль' }), true;
      const token = await newSession(login);
      return send(res, 200, { token, user: publicUser(login, u) }), true;
    }

    const token = bearer(req);
    const user = await userByToken(token);
    if (!user) return send(res, 401, { error: 'Нужно войти заново' }), true;
    const L = user.login;

    if (pathname === '/api/auth/logout') {
      await db('DEL', 'sess:' + token);
      return send(res, 200, { ok: true }), true;
    }
    if (pathname === '/api/me/avatar' && req.method === 'POST') { // загрузить или убрать своё фото
      const b = await readBody(req, AVA_MAX * 1.4 + 1024);
      const data = String(b.data || '').replace(/^data:image\/[a-z]+;base64,/, '');
      if (!data) {
        await dbMany([['DEL', 'ava:' + L], ['HDEL', 'user:' + L, 'avatar']]);
        const nu = { ...user, ava: null }; refresh(L, nu);
        return send(res, 200, { user: nu }), true;
      }
      const buf = Buffer.from(data, 'base64');
      if (!buf.length || buf.length > AVA_MAX || !imageKind(buf)) return send(res, 400, { error: 'Нужна картинка JPG, PNG или WebP' }), true;
      const ver = String(Date.now());
      await dbMany([['SET', 'ava:' + L, buf.toString('base64')], ['HSET', 'user:' + L, 'avatar', ver]]);
      const nu = publicUser(L, await getUser(L));
      refresh(L, nu);
      return send(res, 200, { user: nu }), true;
    }
    if (pathname === '/api/me' && req.method === 'GET') {
      return send(res, 200, { user, ...(await me(L)) }), true;
    }
    if (pathname === '/api/me' && req.method === 'POST') { // сохранить имя, аватарку, цвет
      const b = await readBody(req);
      const name = clean(b.name, 24) || L;
      const emoji = AVATARS.includes(b.emoji) ? b.emoji : '';
      const color = /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : '';
      await db('HSET', 'user:' + L, 'name', name, 'emoji', emoji, 'color', color);
      const nu = publicUser(L, { name, emoji, color, avatar: (await db('HGET', 'user:' + L, 'avatar')) || '' });
      refresh(L, nu);
      return send(res, 200, { user: nu }), true;
    }

    if (pathname === '/api/friends/search' && req.method === 'GET') { // поиск людей по началу ника
      if (limited(req, 300)) return send(res, 429, { error: 'Слишком часто. Подождите немного.' }), true;
      const q = normLogin(new URL(req.url, 'http://x').searchParams.get('q') || '').replace(/[^a-z0-9_]/g, '').slice(0, 20);
      if (q.length < 2) return send(res, 200, { users: [] }), true;
      const found = [];
      let cur = '0';
      for (let i = 0; i < 12 && found.length < 8; i++) {
        const r = await db('SCAN', cur, 'MATCH', 'user:' + q + '*', 'COUNT', 500);
        cur = String(r[0]);
        for (const k of r[1] || []) { const l = k.slice(5); if (validLogin(l) && l !== L && !found.includes(l)) found.push(l); }
        if (cur === '0') break;
      }
      found.sort((a, b) => (a === q ? -1 : b === q ? 1 : a.length - b.length || a.localeCompare(b)));
      const top = found.slice(0, 8);
      if (!top.length) return send(res, 200, { users: [] }), true;
      const [users, rel] = await Promise.all([getUsers(top), dbMany(top.flatMap(o => [['SISMEMBER', 'friends:' + L, o], ['SISMEMBER', 'sent:' + L, o], ['SISMEMBER', 'req:' + L, o]]))]);
      return send(res, 200, { users: users.map((u, i) => ({ ...u, rel: rel[i * 3] ? 'friend' : rel[i * 3 + 1] ? 'sent' : rel[i * 3 + 2] ? 'incoming' : null })) }), true;
    }

    if (req.method !== 'POST') return send(res, 405, { error: 'POST' }), true;
    const b = await readBody(req);
    const other = normLogin(b.login);
    if (!validLogin(other) || other === L) return send(res, 400, { error: 'Неверный ник' }), true;

    if (pathname === '/api/friends/add') {
      if (limited(req, 120)) return send(res, 429, { error: 'Слишком часто. Подождите немного.' }), true;
      if (!(await getUser(other))) return send(res, 404, { error: 'Пользователь @' + other + ' не найден' }), true;
      const [already, theyAsked, count] = await dbMany([['SISMEMBER', 'friends:' + L, other], ['SISMEMBER', 'req:' + L, other], ['SCARD', 'friends:' + L]]);
      if (already) return send(res, 200, { status: 'friends' }), true;
      if (count >= FRIENDS_MAX) return send(res, 400, { error: 'Слишком много друзей' }), true;
      if (theyAsked) return accept(L, other, res);
      await dbMany([['SADD', 'req:' + other, L], ['SADD', 'sent:' + L, other]]);
      toUser(other, { t: 'friends' });
      return send(res, 200, { status: 'sent' }), true;
    }
    if (pathname === '/api/friends/accept') {
      if (!(await db('SISMEMBER', 'req:' + L, other))) return send(res, 400, { error: 'Заявки нет' }), true;
      return accept(L, other, res);
    }
    if (pathname === '/api/friends/decline') { // отклонить входящую или отменить свою заявку
      await dbMany([['SREM', 'req:' + L, other], ['SREM', 'sent:' + other, L], ['SREM', 'sent:' + L, other], ['SREM', 'req:' + other, L]]);
      toUser(other, { t: 'friends' });
      return send(res, 200, { ok: true }), true;
    }
    if (pathname === '/api/friends/remove') {
      await dbMany([['SREM', 'friends:' + L, other], ['SREM', 'friends:' + other, L]]);
      cacheFriend(L, other, false);
      toUser(other, { t: 'friends' });
      return send(res, 200, { ok: true }), true;
    }
    send(res, 404, { error: 'Нет такого метода' });
  } catch (e) {
    console.warn('accounts:', e.message);
    if (!res.headersSent) send(res, 500, { error: 'База недоступна, попробуйте ещё раз' });
  }
  return true;
}
async function accept(L, other, res) {
  await dbMany([
    ['SADD', 'friends:' + L, other], ['SADD', 'friends:' + other, L],
    ['SREM', 'req:' + L, other], ['SREM', 'sent:' + other, L],
    ['SREM', 'req:' + other, L], ['SREM', 'sent:' + L, other],
  ]);
  cacheFriend(L, other, true);
  toUser(other, { t: 'friends' }); toUser(L, { t: 'friends' });
  notifyFriends(L); notifyFriends(other);
  send(res, 200, { status: 'friends' });
  return true;
}

module.exports = {
  enabled, handle, attach, detach, notifyFriends, presenceOf, isFriend, toUser, userByToken,
  setRoomLocked: fn => { roomLocked = fn; },
  setRoomWhat: fn => { roomWhat = fn; },
};
