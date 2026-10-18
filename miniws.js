// Минимальный WebSocket-сервер на встроенных модулях Node (без зависимостей).
// Поддерживает текстовые и двоичные сообщения, ping/pong и закрытие.

const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class Socket extends EventEmitter {
  constructor(sock, maxPayload) {
    super();
    this.sock = sock;
    this.maxPayload = maxPayload;
    this.readyState = 1;
    this.buf = Buffer.alloc(0);
    this.frag = [];
    this.fragOp = 0;
    sock.setNoDelay(true);
    sock.on('data', d => this._data(d));
    sock.on('close', () => this._closed());
    sock.on('error', () => this._closed());
  }

  _closed() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }

  _data(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.buf.length >= 2) {
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0, op = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(this.maxPayload)) return this.terminate();
        len = Number(big); off = 10;
      }
      if (!masked || len > this.maxPayload) return this.terminate(); // клиент обязан маскировать
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const payload = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);

      if (op === 0x8) { this._frame(0x8, Buffer.alloc(0)); this.sock.end(); return this._closed(); }
      if (op === 0x9) { this._frame(0xA, payload); continue; }
      if (op === 0xA) { this.emit('pong'); continue; }
      if (op === 0x1 || op === 0x2 || op === 0x0) {
        if (op !== 0x0) this.fragOp = op;
        this.frag.push(payload);
        const total = this.frag.reduce((n, p) => n + p.length, 0);
        if (total > this.maxPayload) return this.terminate();
        if (fin) {
          const msg = Buffer.concat(this.frag); this.frag = [];
          if (this.fragOp === 0x2) this.emit('message', msg, true); // двоичные данные (кусочки видео)
          else this.emit('message', msg.toString('utf8'), false);
        }
      }
    }
  }

  _frame(op, payload) {
    if (this.sock.destroyed) return;
    const len = payload.length;
    let head;
    if (len < 126) { head = Buffer.from([0x80 | op, len]); }
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
    this.sock.write(Buffer.concat([head, payload]));
  }

  send(text) { if (this.readyState === 1) this._frame(0x1, Buffer.from(String(text), 'utf8')); }
  sendBinary(buf) { if (this.readyState === 1) this._frame(0x2, buf); }
  get bufferedAmount() { return this.sock.writableLength || 0; }
  ping() { if (this.readyState === 1) this._frame(0x9, Buffer.alloc(0)); }
  terminate() { this.sock.destroy(); this._closed(); }
}

/** Подключает WebSocket к http-серверу по пути `path`. */
function attach(server, { path, maxPayload = 8192 }, onConnection) {
  const clients = new Set();
  server.on('upgrade', (req, sock) => {
    const url = new URL(req.url, 'http://x');
    const key = req.headers['sec-websocket-key'];
    if (url.pathname !== path || !key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
      sock.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const ws = new Socket(sock, maxPayload);
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    onConnection(ws, req);
  });
  return { clients };
}

module.exports = { attach };
