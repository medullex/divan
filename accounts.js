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
const publicUser = (login, u) => ({ login, name: u.name || login, emoji: AVATARS.includes(u.emoji) ? u.emoji : null, color: /^#[0-9a-f]{6}$/i.test(u.color || '') ? u.color : null });

async function getUser(login) {
  if (!validLogin(login)) return null;
  const u = hashObj(await db('HGETALL', 'user:' + login));
  return u.hash ? u : null;
}
async function getUsers(logins) {
  const rows = await dbMany(logins.map(l => ['HMGET', 'user:' + l, 'name', 'emoji', 'color']));
  return logins.map((l, i) => publicUser(l, { name: rows[i]?.[0], emoji: rows[i]?.[1], color: rows[i]?.[2] }));
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

function sendWs(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function toUser(login, msg) { for (const ws of online.get(login) || []) sendWs(ws, msg); }
function presenceOf(login) {
  const set = online.get(login);
  if (!set || !set.size) return { online: false, room: null };
  let room = null;
  for (const ws of set) if (ws.roomCode) { room = ws.roomCode; break; }
  return { online: true, room, locked: room ? roomLocked(room) : false };
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
function readBody(req) {
  return new Promise((res, rej) => {
    let size = 0; const parts = [];
    req.on('data', c => { size += c.length; if (size > 4096) { rej(new Error('big')); req.destroy(); } else parts.push(c); });
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
  if (!pathname.startsWith('/api/auth/') && !pathname.startsWith('/api/me') && !pathname.startsWith('/api/friends/')) return false;
  if (!enabled) { send(res, 503, { error: 'Аккаунты пока не настроены' }); return true; }
  try {
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
    if (pathname === '/api/me' && req.method === 'GET') {
      return send(res, 200, { user, ...(await me(L)) }), true;
    }
    if (pathname === '/api/me' && req.method === 'POST') { // сохранить имя, аватарку, цвет
      const b = await readBody(req);
      const name = clean(b.name, 24) || L;
      const emoji = AVATARS.includes(b.emoji) ? b.emoji : '';
      const color = /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : '';
      await db('HSET', 'user:' + L, 'name', name, 'emoji', emoji, 'color', color);
      return send(res, 200, { user: publicUser(L, { name, emoji, color }) }), true;
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
  enabled, handle, attach, detach, notifyFriends, presenceOf, isFriend, toUser,
  setRoomLocked: fn => { roomLocked = fn; },
};
