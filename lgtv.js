// Minimal LG webOS (SSAP) client: persistent connection, pairing, pointer-socket buttons.
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import dgram from 'node:dgram';
import { networkInterfaces } from 'node:os';
import WebSocket from 'ws';

const PAIRING = JSON.parse(readFileSync(new URL('./pairing.json', import.meta.url)));

export class LGTV extends EventEmitter {
  constructor({ ip, clientKey }) {
    super();
    this.ip = ip;
    this.clientKey = clientKey;
    this.ws = null;
    this.pointer = null;
    this.ready = false;
    this.nextId = 0;
    this.pending = new Map();
  }

  // webOS 4.x on newer firmware only accepts wss:3001; older firmware uses ws:3000.
  async connect() {
    for (const url of [`wss://${this.ip}:3001`, `ws://${this.ip}:3000`]) {
      try {
        await this.#open(url);
        return;
      } catch (err) {
        this.emit('log', `connect ${url} failed: ${err.message}`);
      }
    }
    throw new Error('TV unreachable');
  }

  #open(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { rejectUnauthorized: false, handshakeTimeout: 4000 });
      ws.once('error', reject);
      ws.once('open', () => {
        ws.off('error', reject);
        this.ws = ws;
        ws.on('message', (data) => this.#onMessage(JSON.parse(data)));
        ws.on('close', () => this.#onClose());
        ws.on('error', (err) => this.emit('log', `socket error: ${err.message}`));
        this.emit('log', `connected ${url}, registering (accept the prompt on the TV if asked)`);
        this.#register().then(resolve, reject);
      });
    });
  }

  #register() {
    return new Promise((resolve, reject) => {
      const id = 'register_0';
      const payload = { ...PAIRING, 'client-key': this.clientKey };
      this.pending.set(id, (msg) => {
        if (msg.type === 'error') { reject(new Error(msg.error)); return true; }
        if (msg.type === 'response' && msg.payload?.pairingType === 'PROMPT') {
          this.emit('prompt');
          return false; // keep waiting for "registered"
        }
        if (msg.type === 'registered') {
          this.clientKey = msg.payload['client-key'];
          this.ready = true;
          this.emit('registered', this.clientKey);
          resolve();
          return true;
        }
        return false;
      });
      this.ws.send(JSON.stringify({ type: 'register', id, payload }));
    });
  }

  #onMessage(msg) {
    const handler = this.pending.get(msg.id);
    if (handler && handler(msg) !== false) this.pending.delete(msg.id);
  }

  #onClose() {
    this.ready = false;
    this.ws = null;
    this.pointer?.close();
    this.pointer = null;
    for (const handler of this.pending.values()) handler({ type: 'error', error: 'connection closed' });
    this.pending.clear();
    this.emit('close');
  }

  request(uri, payload = {}) {
    if (!this.ready) return Promise.reject(new Error('not connected'));
    return new Promise((resolve, reject) => {
      const id = `req_${this.nextId++}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('timeout'));
      }, 5000);
      this.pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.type === 'error' || msg.payload?.returnValue === false) {
          reject(new Error(msg.error || msg.payload?.errorText || 'request failed'));
        } else {
          resolve(msg.payload);
        }
      });
      this.ws.send(JSON.stringify({ type: 'request', id, uri, payload }));
    });
  }

  async #getPointer() {
    if (this.pointer?.readyState === WebSocket.OPEN) return this.pointer;
    const { socketPath } = await this.request('ssap://com.webos.service.networkinput/getPointerInputSocket');
    this.pointer = await new Promise((resolve, reject) => {
      const ws = new WebSocket(socketPath, { rejectUnauthorized: false });
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
      ws.on('close', () => { if (this.pointer === ws) this.pointer = null; });
    });
    return this.pointer;
  }

  // Remote keys: UP DOWN LEFT RIGHT ENTER BACK HOME MENU EXIT INFO VOLUMEUP VOLUMEDOWN MUTE
  // CHANNELUP CHANNELDOWN PLAY PAUSE STOP REWIND FASTFORWARD RED GREEN YELLOW BLUE 0-9 ...
  async button(name) {
    (await this.#getPointer()).send(`type:button\nname:${name}\n\n`);
  }

  async move(dx, dy) {
    (await this.#getPointer()).send(`type:move\ndx:${dx}\ndy:${dy}\ndown:0\n\n`);
  }

  async click() {
    (await this.#getPointer()).send('type:click\n\n');
  }

  async scroll(dx, dy) {
    (await this.#getPointer()).send(`type:scroll\ndx:${dx}\ndy:${dy}\n\n`);
  }
}

export function wakeOnLan(mac) {
  const hex = mac.replace(/[^0-9a-f]/gi, '');
  if (hex.length !== 12) throw new Error('invalid MAC address');
  const packet = Buffer.from('ff'.repeat(6) + hex.repeat(16), 'hex');
  // macOS may route 255.255.255.255 out the wrong interface, so also hit each subnet's broadcast.
  const targets = ['255.255.255.255', ...Object.values(networkInterfaces()).flat()
    .filter((i) => i.family === 'IPv4' && !i.internal)
    .map((i) => {
      const ip = i.address.split('.').map(Number), mask = i.netmask.split('.').map(Number);
      return ip.map((b, n) => (b | (~mask[n] & 255))).join('.');
    })];
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    sock.once('error', reject);
    sock.bind(async () => {
      sock.setBroadcast(true);
      const sendTo = (addr) => new Promise((r) => sock.send(packet, 9, addr, r));
      for (let i = 0; i < 3; i++) await Promise.all(targets.map(sendTo));
      sock.close();
      resolve();
    });
  });
}

// SSDP search for webOS TVs on the LAN; resolves to a list of IPs.
export function discover(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const found = new Set();
    const sock = dgram.createSocket('udp4');
    const msg = Buffer.from(
      'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\n' +
      'ST: urn:lge-com:service:webos-second-screen:1\r\n\r\n'
    );
    sock.on('message', (data, rinfo) => {
      if (/webos/i.test(data.toString())) found.add(rinfo.address);
    });
    sock.bind(() => sock.send(msg, 1900, '239.255.255.250'));
    setTimeout(() => {
      sock.close();
      resolve([...found]);
    }, timeoutMs);
  });
}
