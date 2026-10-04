'use strict';

const net = require('net');

// Minimal Source RCON client (the protocol ARK servers speak).
//
// Packet: int32 size | int32 id | int32 type | body\0 | \0   (little-endian)
// size counts everything after itself. Types: 3 = auth, 2 = command (and the
// auth reply), 0 = response.
//
// ARK replies to each command with a single response packet, so requests are
// sent one at a time and matched by id. That keeps the client simple and
// avoids interleaving replies from back-to-back commands.

const TYPE_AUTH = 3;
const TYPE_EXEC = 2;
const TYPE_AUTH_RESPONSE = 2;
const MAX_BODY = 4096; // ARK rejects longer command strings

function encode(id, type, body) {
  const bodyBuf = Buffer.from(body, 'utf8');
  const buf = Buffer.alloc(14 + bodyBuf.length);
  buf.writeInt32LE(10 + bodyBuf.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  bodyBuf.copy(buf, 12);
  // last two bytes stay 0: body terminator + empty string terminator
  return buf;
}

// Pulls complete packets off the front of a buffer; returns [packets, rest].
function decode(buffer) {
  const packets = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const size = buffer.readInt32LE(offset);
    if (size < 10 || size > 1024 * 1024) throw new Error('Garbled reply from the server.');
    if (buffer.length - offset - 4 < size) break; // wait for the rest
    const id = buffer.readInt32LE(offset + 4);
    const type = buffer.readInt32LE(offset + 8);
    const body = buffer.toString('utf8', offset + 12, offset + 4 + size - 2);
    packets.push({ id, type, body });
    offset += 4 + size;
  }
  return [packets, buffer.subarray(offset)];
}

class RconClient {
  constructor({ host, port, password, timeoutMs = 6000 }) {
    this.host = host;
    this.port = Number(port);
    this.password = password;
    this.timeoutMs = timeoutMs;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.nextId = 1;
    this.waiting = null;   // { id, resolve, reject, timer }
    this.queue = Promise.resolve();
    this.authed = false;
  }

  get connected() {
    return Boolean(this.socket && this.authed);
  }

  async connect() {
    if (this.connected) return;
    await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      const fail = (err) => {
        socket.destroy();
        reject(friendlyError(err, this));
      };
      const timer = setTimeout(() => fail(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), this.timeoutMs);
      socket.once('error', fail);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.off('error', fail);
        this.socket = socket;
        socket.setKeepAlive(true, 30_000);
        socket.on('data', (d) => this._onData(d));
        socket.on('error', () => {});
        socket.on('close', () => this._onClose());
        resolve();
      });
    });
    const reply = await this._send(TYPE_AUTH, this.password, { auth: true });
    // A failed login comes back with id -1.
    if (reply.id === -1) {
      this.close();
      throw new Error('The server rejected the RCON password. Use the server’s ServerAdminPassword.');
    }
    this.authed = true;
  }

  // Runs one command and resolves with the server's text reply.
  command(text) {
    const body = String(text);
    if (Buffer.byteLength(body) > MAX_BODY) return Promise.reject(new Error('That command is too long for RCON.'));
    // Serialize: each command waits for the previous reply.
    const run = this.queue.then(async () => {
      await this.connect();
      const reply = await this._send(TYPE_EXEC, body);
      return reply.body.replace(/\s+$/, '');
    });
    this.queue = run.catch(() => {});
    return run;
  }

  close() {
    if (this.socket) this.socket.destroy();
    this._onClose();
  }

  _send(type, body, { auth = false } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new Error('Not connected to the server.'));
      const id = this.nextId++;
      if (this.nextId > 0x7fffffff) this.nextId = 1;
      const timer = setTimeout(() => {
        this.waiting = null;
        reject(new Error('The server didn’t answer in time.'));
        this.close();
      }, this.timeoutMs);
      this.waiting = { id, auth, resolve, reject, timer };
      this.socket.write(encode(id, type, body));
    });
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let packets;
    try {
      [packets, this.buffer] = decode(this.buffer);
    } catch (err) {
      this._fail(err);
      return;
    }
    for (const p of packets) {
      const w = this.waiting;
      if (!w) continue;
      if (w.auth) {
        // Some servers send an empty RESPONSE_VALUE before the auth reply.
        if (p.type !== TYPE_AUTH_RESPONSE) continue;
      } else if (p.id !== w.id) {
        continue;
      }
      clearTimeout(w.timer);
      this.waiting = null;
      w.resolve(p);
    }
  }

  _fail(err) {
    const w = this.waiting;
    this.waiting = null;
    if (w) { clearTimeout(w.timer); w.reject(err); }
    this.close();
  }

  _onClose() {
    const w = this.waiting;
    this.waiting = null;
    if (w) { clearTimeout(w.timer); w.reject(new Error('The server closed the connection.')); }
    this.socket = null;
    this.authed = false;
    this.buffer = Buffer.alloc(0);
  }
}

function friendlyError(err, { host, port }) {
  switch (err.code) {
    case 'ECONNREFUSED': return new Error(`Nothing is answering on ${host}:${port}. Check the RCON port and that RCONEnabled=True on the server.`);
    case 'ETIMEDOUT': return new Error(`Couldn't reach ${host}:${port}. Check the address, and that your host's firewall allows the RCON port.`);
    case 'ENOTFOUND': return new Error(`"${host}" isn't a server address that resolves.`);
    case 'EHOSTUNREACH': case 'ENETUNREACH': return new Error(`${host} isn't reachable from this PC.`);
    default: return new Error(`RCON connection failed: ${err.message}`);
  }
}

module.exports = { RconClient, encode, decode, TYPE_AUTH, TYPE_EXEC };
