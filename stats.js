// Общий диван — список посетителей для владельца сайта.
// Каждому браузеру выдаётся случайная анонимная метка (без IP), по ней посетители различаются:
// «Гость #1», «Гость #2»… Если человек вписал имя или вошёл в аккаунт — это тоже видно.
// Смотреть список может только аккаунт, указанный в переменной STATS_USER на хостинге.

const DB_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const DB_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const enabled = !!(DB_URL && DB_TOKEN);
const OWNERS = String(process.env.STATS_USER || '').toLowerCase().split(',').map(s => s.trim().replace(/^@/, '')).filter(Boolean);
const KEEP = 3000; // сколько посетителей помнить

async function dbMany(cmds) {
  const r = await fetch(DB_URL + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + DB_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds.map(c => c.map(String))),
    signal: AbortSignal.timeout(8000),
  });
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error('redis: ' + (j.error || r.status));
  return j.map(x => x.result);
}
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const validVid = v => typeof v === 'string' && /^[a-f0-9]{16}$/.test(v);
const day = t => new Date(t + 3 * 3600e3).toISOString().slice(0, 10); // день по Москве

// Грубое описание устройства из User-Agent: «Chrome · Windows»
function device(ua, app) {
  ua = String(ua || '');
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'другое';
  const br = /YaBrowser/.test(ua) ? 'Яндекс' : /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'браузер';
  return br + ' · ' + os + (app ? ' · приложение' : '');
}

const seen = new Map(); // vid -> время последнего сигнала (в памяти, для «сейчас на сайте»)
const lastHit = new Map(); // vid -> время, защита от частых запросов
function touch(vid) { if (validVid(vid)) seen.set(vid, Date.now()); if (seen.size > 5000) seen.clear(); }

function readBody(req) {
  return new Promise(res => {
    let size = 0; const parts = [];
    req.on('data', c => { size += c.length; if (size > 2048) req.destroy(); else parts.push(c); });
    req.on('end', () => { try { res(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); } catch { res({}); } });
    req.on('error', () => res({}));
  });
}

// userByToken и liveRooms передаёт сервер
async function handle(req, res, pathname, { userByToken, liveRooms }) {
  if (pathname !== '/api/hit' && pathname !== '/api/stats') return false;
  if (!enabled) { send(res, 503, { error: 'База не настроена' }); return true; }
  const token = (String(req.headers.authorization || '').match(/^Bearer ([\w-]+)$/) || [])[1];
  try {
    if (pathname === '/api/hit' && req.method === 'POST') { // отметка «зашёл на сайт» / «зашёл в комнату»
      const b = await readBody(req);
      const vid = String(b.vid || '');
      if (!validVid(vid)) return send(res, 400, { error: 'bad' }), true;
      const now = Date.now();
      touch(vid);
      const plain = !b.room && !token; // простые отметки «открыл сайт» — не чаще раза в 3 секунды
      if (plain && now - (lastHit.get(vid) || 0) < 3000) return send(res, 200, { ok: true }), true;
      lastHit.set(vid, now); if (lastHit.size > 5000) lastHit.clear();
      const user = token ? await userByToken(token).catch(() => null) : null;
      const k = 'v:' + vid;
      const cmds = [
        ['HSETNX', k, 'first', now],
        ['HSET', k, 'last', now, 'dev', device(req.headers['user-agent'], b.app)],
        ['HINCRBY', k, 'n', 1],
        ['ZADD', 'visitors', now, vid],
        ['SADD', 'day:' + day(now), vid], ['EXPIRE', 'day:' + day(now), 40 * 86400],
        ['EXISTS', k + ':num'],
      ];
      const name = clean(b.name, 24);
      if (name) cmds.push(['HSET', k, 'name', name]);
      if (user) cmds.push(['HSET', k, 'login', user.login]);
      if (/^[a-z0-9-]{3,32}$/.test(String(b.room || ''))) cmds.push(['HSET', k, 'room', b.room, 'roomAt', now]);
      const out = await dbMany(cmds);
      if (!out[6]) { // новый посетитель — выдаём порядковый номер
        const [num] = await dbMany([['INCR', 'vcount']]);
        await dbMany([['SET', k + ':num', num], ['HSET', k, 'num', num], ['ZREMRANGEBYRANK', 'visitors', 0, -KEEP - 1]]);
      }
      return send(res, 200, { ok: true }), true;
    }

    if (pathname === '/api/stats' && req.method === 'GET') { // список для владельца
      const user = token ? await userByToken(token).catch(() => null) : null;
      if (!OWNERS.length) return send(res, 403, { error: 'На хостинге не задана переменная STATS_USER — впишите туда свой ник.' }), true;
      if (!user) return send(res, 401, { error: 'Войдите в аккаунт на главной странице сайта.' }), true;
      if (!OWNERS.includes(user.login)) return send(res, 403, { error: 'Этот список видит только владелец сайта.' }), true;
      const now = Date.now();
      const days = []; for (let i = 0; i < 7; i++) days.push('day:' + day(now - i * 86400e3));
      const [vids, total, ...dayLists] = await dbMany([['ZREVRANGE', 'visitors', 0, 499], ['GET', 'vcount'], ...days.map(d => ['SMEMBERS', d])]);
      const rows = vids && vids.length ? await dbMany(vids.map(v => ['HMGET', 'v:' + v, 'num', 'name', 'login', 'dev', 'first', 'last', 'n', 'room', 'roomAt'])) : [];
      const rooms = liveRooms(); // vid -> код комнаты, где человек сидит прямо сейчас
      const week = new Set(dayLists.flat().filter(Boolean));
      const list = (vids || []).map((vid, i) => {
        const r = rows[i] || [];
        const lastSeen = Math.max(Number(r[5]) || 0, seen.get(vid) || 0);
        return {
          num: Number(r[0]) || null, name: r[1] || null, login: r[2] || null, dev: r[3] || '',
          first: Number(r[4]) || null, last: lastSeen || null, visits: Number(r[6]) || 0,
          room: r[7] || null, roomAt: Number(r[8]) || null,
          nowRoom: rooms.get(vid) || null, online: !!rooms.get(vid) || now - lastSeen < 5 * 60e3,
        };
      });
      return send(res, 200, {
        total: Number(total) || 0, today: (dayLists[0] || []).length, week: week.size,
        online: list.filter(x => x.online).length, list,
      }), true;
    }
    send(res, 405, { error: 'method' });
  } catch (e) {
    console.warn('stats:', e.message);
    if (!res.headersSent) send(res, 500, { error: 'База недоступна' });
  }
  return true;
}

module.exports = { enabled, handle, touch };
