import http from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { LGTV, wakeOnLan, discover } from './lgtv.js';

const CONFIG_PATH = new URL('./config.json', import.meta.url);
const PORT = Number(process.env.PORT) || 8080;

const config = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH)) : {};
const saveConfig = () => writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

let tv = null;
let status = 'idle';
let reconnectTimer = null;

function startTV() {
  if (!config.ip) return;
  clearTimeout(reconnectTimer);
  tv?.removeAllListeners();
  tv = new LGTV({ ip: config.ip, clientKey: config.clientKey });
  tv.on('log', (m) => console.log('[tv]', m));
  tv.on('prompt', () => { status = 'pairing'; console.log('[tv] accept the pairing prompt on the TV'); });
  tv.on('registered', (key) => {
    status = 'connected';
    if (key !== config.clientKey) { config.clientKey = key; saveConfig(); }
    console.log('[tv] ready');
  });
  tv.on('close', () => { status = 'disconnected'; scheduleReconnect(); });
  status = 'connecting';
  tv.connect().catch(() => { status = 'disconnected'; scheduleReconnect(); });
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(startTV, 3000);
}

// Learn the MAC once we're connected so Wake-on-LAN works later.
async function learnMac() {
  if (config.mac || !tv?.ready) return;
  try {
    const info = await tv.request('ssap://com.webos.service.connectionmanager/getinfo');
    const mac = info.wifiInfo?.macAddress || info.wiredInfo?.macAddress;
    if (mac) { config.mac = mac; saveConfig(); console.log('[tv] learned MAC', mac); }
  } catch {}
}

// Current input + volume for the minimal view. Foreground app for HDMI 2 is "com.webos.app.hdmi2".
async function liveState() {
  if (!tv?.ready) return {};
  const [fg, vol] = await Promise.allSettled([
    tv.request('ssap://com.webos.applicationManager/getForegroundAppInfo'),
    tv.request('ssap://audio/getVolume'),
  ]);
  const appId = fg.value?.appId || '';
  const hdmi = appId.match(/hdmi(\d)/i);
  const v = vol.value?.volumeStatus || vol.value || {};
  return {
    input: hdmi ? `HDMI_${hdmi[1]}` : appId || null,
    volume: v.volume ?? null,
    muted: v.muteStatus ?? v.muted ?? null,
  };
}

const actions = {
  button: ({ name }) => tv.button(name),
  move: ({ dx, dy }) => tv.move(dx, dy),
  click: () => tv.click(),
  scroll: ({ dx, dy }) => tv.scroll(dx, dy),
  setVolume: ({ volume }) => tv.request('ssap://audio/setVolume', { volume }),
  volumeUp: () => tv.request('ssap://audio/volumeUp'),
  volumeDown: () => tv.request('ssap://audio/volumeDown'),
  mute: async () => {
    const { mute } = await tv.request('ssap://audio/getStatus');
    return tv.request('ssap://audio/setMute', { mute: !mute });
  },
  // In standby the TV keeps its socket open (so we look "connected") but ignores most requests,
  // so ask for the real power state and fall back to Wake-on-LAN when it isn't "Active".
  power: async () => {
    const state = tv?.ready
      ? await Promise.race([
          tv.request('ssap://com.webos.service.tvpower/power/getPowerState').then((r) => r.state, () => null),
          new Promise((r) => setTimeout(r, 1200, null)),
        ])
      : null;
    if (state === 'Active') {
      await tv.request('ssap://system/turnOff');
      return 'off';
    }
    await actions.powerOn();
    return 'on';
  },
  powerOff: () => tv.request('ssap://system/turnOff'),
  powerOn: async () => {
    if (!config.mac) throw new Error('MAC unknown: connect once while the TV is on, or set "mac" in config.json');
    await wakeOnLan(config.mac);
  },
  launch: ({ id }) => tv.request('ssap://system.launcher/launch', { id }),
  apps: async () => {
    const { launchPoints } = await tv.request('com.webos.applicationManager/listLaunchPoints');
    return launchPoints.map(({ id, title }) => ({ id, title }));
  },
  inputs: async () => {
    const { devices } = await tv.request('ssap://tv/getExternalInputList');
    return devices.map(({ id, label, connected }) => ({ id, label, connected }));
  },
  setInput: ({ id }) => tv.request('ssap://tv/switchInput', { inputId: id }),
  text: ({ value }) => tv.request('ssap://com.webos.service.ime/insertText', { text: value, replace: 0 }),
  toast: ({ message }) => tv.request('ssap://system.notifications/createToast', { message }),
};

const readBody = (req) => new Promise((resolve) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => resolve(data ? JSON.parse(data) : {}));
});

const send = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(readFileSync(new URL('./public/index.html', import.meta.url)));
    }
    if (url.pathname === '/manifest.webmanifest') {
      res.writeHead(200, { 'content-type': 'application/manifest+json' });
      return res.end(readFileSync(new URL('./public/manifest.webmanifest', import.meta.url)));
    }
    if (url.pathname === '/api/status') {
      learnMac();
      return send(res, 200, { status, ip: config.ip || null, hasMac: !!config.mac, ...(await liveState()) });
    }
    if (url.pathname === '/api/discover') return send(res, 200, { ips: await discover() });
    if (url.pathname === '/api/config' && req.method === 'POST') {
      const { ip, mac } = await readBody(req);
      if (ip && ip !== config.ip) { config.ip = ip; delete config.clientKey; }
      if (mac) config.mac = mac;
      saveConfig();
      startTV();
      return send(res, 200, { ok: true });
    }
    const action = url.pathname.startsWith('/api/') && actions[url.pathname.slice(5)];
    if (action && req.method === 'POST') {
      const needsTV = !['powerOn', 'power'].includes(url.pathname.slice(5));
      if (needsTV && !tv?.ready) return send(res, 503, { error: `TV ${status}` });
      return send(res, 200, { ok: true, result: await action(await readBody(req)) });
    }
    send(res, 404, { error: 'not found' });
  } catch (err) {
    send(res, 500, { error: err.message });
  }
}).listen(PORT, () => {
  const lan = Object.values(networkInterfaces()).flat()
    .find((i) => i.family === 'IPv4' && !i.internal)?.address;
  console.log(`LG remote: http://localhost:${PORT}  (phone: http://${lan}:${PORT})`);
  startTV();
});
