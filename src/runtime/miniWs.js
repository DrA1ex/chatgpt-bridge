import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import { createHash, randomBytes } from 'node:crypto';

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function encodeFrame(payload, { opcode = 1, masked = false } = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  let headerLength = 2;
  if (data.length >= 126 && data.length <= 0xffff) headerLength += 2;
  else if (data.length > 0xffff) headerLength += 8;
  if (masked) headerLength += 4;
  const frame = Buffer.allocUnsafe(headerLength + data.length);
  frame[0] = 0x80 | (opcode & 0x0f);
  let offset = 2;
  if (data.length < 126) frame[1] = (masked ? 0x80 : 0) | data.length;
  else if (data.length <= 0xffff) {
    frame[1] = (masked ? 0x80 : 0) | 126;
    frame.writeUInt16BE(data.length, offset);
    offset += 2;
  } else {
    frame[1] = (masked ? 0x80 : 0) | 127;
    frame.writeBigUInt64BE(BigInt(data.length), offset);
    offset += 8;
  }
  if (masked) {
    const mask = randomBytes(4);
    mask.copy(frame, offset);
    offset += 4;
    for (let index = 0; index < data.length; index += 1) frame[offset + index] = data[index] ^ mask[index % 4];
  } else data.copy(frame, offset);
  return frame;
}

class MiniWebSocketPeer extends EventEmitter {
  constructor(socket, { client = false, head = null } = {}) {
    super();
    this.socket = socket;
    this.client = client;
    this.readyState = OPEN;
    this.buffer = head?.length ? Buffer.from(head) : Buffer.alloc(0);
    this.fragmentOpcode = 0;
    this.fragments = [];
    socket.on('data', (chunk) => this.#consume(chunk));
    socket.on('error', (error) => this.emit('error', error));
    socket.on('close', () => this.#closed());
    socket.on('end', () => this.#closed());
    if (this.buffer.length) queueMicrotask(() => this.#parse());
  }

  send(payload, callback) {
    if (this.readyState !== OPEN) {
      const error = new Error('WebSocket is not open');
      callback?.(error);
      if (!callback) throw error;
      return;
    }
    this.socket.write(encodeFrame(payload, { opcode: 1, masked: this.client }), callback);
  }

  ping(payload = '') { if (this.readyState === OPEN) this.socket.write(encodeFrame(payload, { opcode: 9, masked: this.client })); }
  pong(payload = '') { if (this.readyState === OPEN) this.socket.write(encodeFrame(payload, { opcode: 10, masked: this.client })); }

  close(code = 1000, reason = '') {
    if (this.readyState >= CLOSING) return;
    this.readyState = CLOSING;
    const reasonBuffer = Buffer.from(String(reason || ''));
    const payload = Buffer.alloc(2 + Math.min(reasonBuffer.length, 123));
    payload.writeUInt16BE(Number(code) || 1000, 0);
    reasonBuffer.copy(payload, 2, 0, payload.length - 2);
    try { this.socket.write(encodeFrame(payload, { opcode: 8, masked: this.client })); } catch {}
    setTimeout(() => this.socket.end(), 10).unref?.();
  }

  terminate() { this.readyState = CLOSED; this.socket.destroy(); }

  #closed() {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    this.emit('close');
  }

  #consume(chunk) { this.buffer = Buffer.concat([this.buffer, chunk]); this.#parse(); }

  #parse() {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = Boolean(first & 0x80);
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < offset + 2) return;
        length = this.buffer.readUInt16BE(offset); offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) return;
        const large = this.buffer.readBigUInt64BE(offset); offset += 8;
        if (large > BigInt(Number.MAX_SAFE_INTEGER)) { this.terminate(); return; }
        length = Number(large);
      }
      let mask = null;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        mask = this.buffer.subarray(offset, offset + 4); offset += 4;
      }
      if (this.buffer.length < offset + length) return;
      let payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(offset + length);
      if (mask) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
      if (opcode === 8) {
        if (this.readyState === OPEN) {
          this.readyState = CLOSING;
          try { this.socket.write(encodeFrame(payload, { opcode: 8, masked: this.client })); } catch {}
        }
        this.socket.end();
        continue;
      }
      if (opcode === 9) { this.pong(payload); this.emit('ping', payload); continue; }
      if (opcode === 10) { this.emit('pong', payload); continue; }
      if (opcode === 0) this.fragments.push(payload);
      else if (opcode === 1 || opcode === 2) { this.fragmentOpcode = opcode; this.fragments = [payload]; }
      else continue;
      if (fin) {
        const complete = Buffer.concat(this.fragments);
        this.fragments = [];
        this.emit('message', complete, this.fragmentOpcode === 2);
      }
    }
  }
}

export class MiniWebSocket extends EventEmitter {
  static CONNECTING = CONNECTING;
  static OPEN = OPEN;
  static CLOSING = CLOSING;
  static CLOSED = CLOSED;

  constructor(address, options = {}) {
    super();
    this.readyState = CONNECTING;
    this.peer = null;
    const url = new URL(address);
    const transport = url.protocol === 'wss:' ? https : http;
    const key = randomBytes(16).toString('base64');
    const request = transport.request({
      protocol: url.protocol === 'wss:' ? 'https:' : 'http:',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'wss:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key,
        Origin: options.origin || 'null', ...(options.headers || {}),
      },
    });
    request.on('upgrade', (_response, socket, head) => {
      this.peer = new MiniWebSocketPeer(socket, { client: true, head });
      this.readyState = OPEN;
      this.peer.on('message', (...args) => this.emit('message', ...args));
      this.peer.on('close', (...args) => { this.readyState = CLOSED; this.emit('close', ...args); });
      this.peer.on('error', (error) => this.emit('error', error));
      this.peer.on('ping', (payload) => this.emit('ping', payload));
      this.peer.on('pong', (payload) => this.emit('pong', payload));
      this.emit('open');
    });
    request.on('response', (response) => {
      const error = new Error(`Unexpected WebSocket response: ${response.statusCode}`);
      this.readyState = CLOSED;
      this.emit('error', error);
      response.resume();
    });
    request.on('error', (error) => { this.readyState = CLOSED; this.emit('error', error); });
    request.end();
  }

  send(payload, callback) { return this.peer?.send(payload, callback); }
  close(code, reason) { this.readyState = CLOSING; return this.peer?.close(code, reason); }
  terminate() { this.readyState = CLOSED; return this.peer?.terminate(); }
  ping(payload) { return this.peer?.ping(payload); }
  pong(payload) { return this.peer?.pong(payload); }
}

export class MiniWebSocketServer extends EventEmitter {
  constructor() { super(); this.clients = new Set(); }
  handleUpgrade(req, socket, head, callback) {
    const key = String(req.headers['sec-websocket-key'] || '');
    if (!key) { socket.destroy(); return; }
    const accept = createHash('sha1').update(`${key}${GUID}`).digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket', 'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`, '', '',
    ].join('\r\n'));
    const peer = new MiniWebSocketPeer(socket, { client: false, head });
    this.clients.add(peer);
    peer.once('close', () => this.clients.delete(peer));
    callback(peer);
  }
  close(callback) {
    for (const client of this.clients) client.close(1001, 'Server closing');
    this.clients.clear();
    callback?.();
  }
}

export default MiniWebSocket;
