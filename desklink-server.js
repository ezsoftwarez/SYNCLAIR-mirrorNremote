/**
 * SYNCLIKA Share Server — P2P (LAN/USB only, no cloud/relay)
 * Futtasd: START-DESKLINK.bat  vagy  node desklink-server.js
 * Dev WAN: set DESKLINK_ALLOW_WAN=1  (disables P2P peer filter — not for production)
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const dgram = require('dgram');
const { exec, spawn } = require('child_process');
const sec = require('./lib/desklink-security');
const adbUsb = require('./lib/desklink-adb');

let screenshot = null;
try {
  screenshot = require('screenshot-desktop');
  console.log('✅ screenshot-desktop betöltve');
} catch (e) {
  console.log('⚠️  screenshot-desktop nem elérhető — képernyő nézet kikapcsolva');
}

let QRCode = null;
try {
  QRCode = require('qrcode');
} catch (e) {
  console.log('⚠️  qrcode nem elérhető');
}

// ── RobotJS Betöltés ─────────────────────────────────────────────────────────
let robot = null;
try {
  robot = require('robotjs');
  console.log('✅ robotjs betöltve');
} catch (e) {
  try {
    robot = require('@jitsi/robotjs');
    console.log('✅ @jitsi/robotjs betöltve');
  } catch (e2) {
    console.log('⚠️  robotjs nem található - egér/billentyű vezérlés korlátozott');
    console.log('    Telepítsd: npm install @jitsi/robotjs');
  }
}

// ── Config ──────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 7331;
const DISCOVERY_PORT = 7332;
const UPLOAD_DIR = path.join(os.homedir(), 'DeskLink_Received');
const UI_PATH = path.join(__dirname, 'desklink-ui.html');
const HOST_PATH = path.join(__dirname, 'desklink-host.html');
const PC_UI_PATH = path.join(__dirname, 'desklink-pc.html');
const pcSseClients = new Set();
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const sessionStats = {
  startedAt: Date.now(),
  filesSent: 0,
  foldersSent: 0,
  bytesSent: 0,
  textsPasted: 0,
  linksOpened: 0,
  lastItems: [],
};

function rememberSessionItem(type, label, extra = {}) {
  sessionStats.lastItems.unshift({
    type,
    label: String(label || '').slice(0, 220),
    at: Date.now(),
    ...extra,
  });
  sessionStats.lastItems = sessionStats.lastItems.slice(0, 30);
}

const screenSubscribers = new Set();
let screenTimer = null;
let screenBusy = false;

const DIST_DIR = path.join(__dirname, 'dist');
const APK_PATHS = [
  path.join(DIST_DIR, 'SYNCLIKA-Share.apk'),
  path.join(DIST_DIR, 'DeskLink-Android.apk'),
  path.join(DIST_DIR, 'CH123.apk'),
  path.join(__dirname, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'),
];

function resolveApkPath() {
  for (const p of APK_PATHS) {
    if (fs.existsSync(p) && fs.statSync(p).size > 10_000) return p;
  }
  return null;
}

function apkMeta() {
  const p = resolveApkPath();
  if (!p) return { apkAvailable: false, apkSize: 0, apkUrl: null };
  const st = fs.statSync(p);
  return {
    apkAvailable: true,
    apkSize: st.size,
    apkUrl: '/apk/desklink.apk',
  };
}

function serverBase() {
  return {
    hostname: os.hostname(),
    platform: process.platform,
    robotAvailable: !!robot,
    screenAvailable: !!screenshot,
    audioAvailable: audio.isAudioAvailable(),
    port: PORT,
    version: '4.2.0',
    ...apkMeta(),
    usb: adbUsb.getUsbStatus(),
  };
}

function serverInfo(req) {
  const base = serverBase();
  const extras = {
    apkAvailable: base.apkAvailable,
    apkSize: base.apkSize,
    apkUrl: base.apkUrl,
    usb: base.usb,
    session: getSessionStatus(),
  };
  const ips = getLocalIPs();
  const primaryIp = getPrimaryLanIp(ips);
  if (req && sec.isLocalRequest(req)) {
    const info = { ...sec.hostServerInfo(base), ...extras, ips, primaryIp, uploadDir: UPLOAD_DIR };
    return { ...info, ...buildConnectUrls(primaryIp, base.port, info.qrGrant) };
  }
  return { ...sec.publicServerInfo(base), ...extras, ips, primaryIp };
}

// ── Segédfüggvények ──────────────────────────────────────────────────────────
const openUrl = (url) => {
  if (!sec.isSafeHttpUrl(url)) {
    console.log('🔗 Blocked unsafe URL');
    return false;
  }
  const safe = url.replace(/"/g, '');
  const cmd = process.platform === 'win32' ? `start "" "${safe}"` :
              process.platform === 'darwin' ? `open "${safe}"` : `xdg-open "${safe}"`;
  exec(cmd, (err) => { if (err) console.error('open error:', err.message); });
  return true;
};

function setClipboard(text) {
  if (process.platform === 'win32') {
    // Base64 encode to avoid shell escaping issues
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    exec(`powershell -NoProfile -Command "[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${b64}')) | Set-Clipboard"`,
      (err) => { if (err) console.error('clipboard err:', err.message); });
  } else if (process.platform === 'darwin') {
    const proc = spawn('pbcopy');
    proc.stdin.write(text); proc.stdin.end();
  } else {
    const proc = spawn('xclip', ['-selection', 'clipboard']);
    proc.stdin.write(text); proc.stdin.end();
  }
}

function getLocalIPs() {
  const ifaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push({ name, ip: iface.address });
    }
  }
  const rank = (ip) => {
    if (ip.startsWith('192.168.')) return 0;
    if (ip.startsWith('10.')) return 1;
    if (ip.startsWith('172.')) return 2;
    if (ip.startsWith('169.254.')) return 9;
    return 5;
  };
  ips.sort((a, b) => rank(a.ip) - rank(b.ip));
  return ips;
}

function getPrimaryLanIp(ips) {
  const list = ips || getLocalIPs();
  const ok = (x) => x.ip && !String(x.ip).startsWith('169.254.') && !String(x.ip).startsWith('127.');
  const pick = list.find(ok) || list.find((x) => x.ip && !String(x.ip).startsWith('127.')) || list[0];
  return pick ? pick.ip : '127.0.0.1';
}

/** desklink:// in QR = telefon kamera → app. /open = bongeszo → azonnal app redirect. */
function buildConnectUrls(primaryIp, port, qrGrant) {
  const base = `${primaryIp || '127.0.0.1'}:${port || PORT}`;
  const q = qrGrant ? `auto=1&g=${encodeURIComponent(qrGrant)}` : 'auto=1';
  return {
    connectHttp: `http://${base}/open?${q}`,
    connectOpen: `http://${base}/open?${q}`,
    connectQr: `desklink://${base}/?${q}`,
    connectApp: `desklink://${base}/?${q}`,
  };
}

const audio = require('./lib/desklink-audio');
const midiPc = require('./lib/desklink-midi-pc');
const ctrlPc = require('./lib/desklink-controller-pc');
const controllerState = new WeakMap();

function pushVolumeState(ws) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  audio.getVolumeState().then((state) => {
    try {
      ws.send(JSON.stringify({ type: 'volume_state', ...state }));
    } catch (e) { /* ignore */ }
  }).catch((err) => {
    try {
      ws.send(JSON.stringify({ type: 'volume_error', message: err.message || 'audio_unavailable' }));
    } catch (e) { /* ignore */ }
  });
}

function sendVolumeResult(ws, state) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    if (state && state.error) {
      ws.send(JSON.stringify({ type: 'volume_error', message: state.error }));
      return;
    }
    const payload = { type: 'volume_state', ...state };
    const msg = JSON.stringify(payload);
    clients.forEach((c) => {
      if (!c.authenticated || c.readyState !== WebSocket.OPEN) return;
      if (isPhoneRole(c) || c === ws || isHostController(c)) {
        try { c.send(msg); } catch (e) { /* ignore */ }
      }
    });
  } catch (e) { /* ignore */ }
}

function isPhoneRole(ws) {
  return !!(ws && ws.clientMeta && ws.clientMeta.role === 'phone');
}

function isHostController(ws) {
  if (!ws || !ws.clientMeta) return false;
  const role = ws.clientMeta.role;
  if (role === 'host') return true;
  const ip = ws.clientMeta.ip;
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}

function forwardToPhones(msg, exceptWs) {
  const payload = JSON.stringify(msg);
  clients.forEach((c) => {
    if (c === exceptWs) return;
    if (!isPhoneRole(c) || !c.authenticated || c.readyState !== WebSocket.OPEN) return;
    try { c.send(payload); } catch (e) { /* ignore */ }
  });
}

function forwardToHostControllers(msg) {
  const payload = JSON.stringify(msg);
  clients.forEach((c) => {
    if (!isHostController(c) || !c.authenticated || c.readyState !== WebSocket.OPEN) return;
    try { c.send(payload); } catch (e) { /* ignore */ }
  });
}

// ── Express app ─────────────────────────────────────────────────────────────
const app = express();
const auth = sec.createAuthMiddleware();
const authStrict = sec.createAuthMiddleware({ allowLocalhost: false });

app.use(sec.securityHeaders);
app.use(sec.p2pGuard);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowed = sec.allowCorsOrigin(origin);
  if (allowed) res.setHeader('Access-Control-Allow-Origin', allowed);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-DeskLink-Token, X-DeskLink-Pair, X-DeskLink-Grant');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

const VENDOR_DIR = path.join(__dirname, 'vendor');
if (fs.existsSync(VENDOR_DIR)) {
  app.use('/vendor', express.static(VENDOR_DIR, { maxAge: '7d', immutable: true }));
}

const DEBUG_LOG_PATH = path.join(__dirname, 'debug-876117.log');
app.post('/debug/client', (req, res) => {
  if (!sec.isP2pAllowed(sec.clientIp(req))) return res.status(403).json({ error: 'p2p_only' });
  try {
    const line = `${JSON.stringify({ sessionId: '876117', ...req.body, timestamp: Date.now() })}\n`;
    fs.appendFileSync(DEBUG_LOG_PATH, line);
  } catch (e) { /* ignore */ }
  res.json({ ok: true });
});

function normalizeRobotKeys(keys) {
  const list = keys.map(String);
  if (process.platform === 'win32') {
    return list.map((k) => (k === 'super' ? 'command' : k));
  }
  return list;
}

/** Phone browser landed from old http QR → redirect into SYNCLIKA APK */
app.get('/open', (req, res) => {
  const ips = getLocalIPs();
  const ip = getPrimaryLanIp(ips);
  const grant = req.query.g || req.query.grant || '';
  const auto = req.query.auto !== undefined ? 'auto=1&' : '';
  const g = grant ? `g=${encodeURIComponent(String(grant))}` : '';
  const q = [auto, g].filter(Boolean).join('').replace(/&$/, '') || 'auto=1';
  const appUrl = `desklink://${ip}:${PORT}/?${q}`;
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="0;url=${appUrl.replace(/"/g, '&quot;')}">
<title>SYNCLIKA Share</title></head><body style="font-family:system-ui;background:#0a0a12;color:#e8e8f0;text-align:center;padding:2rem">
<p>Opening SYNCLIKA app…</p>
<p><a href="${appUrl.replace(/"/g, '&quot;')}" style="color:#00e5ff;font-size:18px">Tap here if the app does not open</a></p>
<script>location.replace(${JSON.stringify(appUrl)});</script>
</body></html>`;
  res.type('html').send(html);
});

app.get('/', (req, res) => {
  if (fs.existsSync(UI_PATH)) res.sendFile(UI_PATH);
  else res.send('<h1>SYNCLIKA Share</h1><p>desklink-ui.html hiányzik</p>');
});

app.get('/host', (req, res) => {
  if (fs.existsSync(HOST_PATH)) res.sendFile(HOST_PATH);
  else res.redirect('/');
});

const LAUNCHER_PATH = path.join(__dirname, 'synclika-launcher.html');
app.get('/select', (req, res) => {
  if (fs.existsSync(LAUNCHER_PATH)) res.sendFile(LAUNCHER_PATH);
  else res.redirect('/host');
});

const MOBILE_ONECLICK = path.join(__dirname, 'ch123', 'desklink_mobile_oneclick.py');

app.get('/apk/desklink.apk', (req, res) => {
  const apk = resolveApkPath();
  if (!apk) {
    return res.status(404).json({
      error: 'apk_missing',
      hint: 'Run BUILD-APK.bat or python desklink_oneclick.py on PC first',
    });
  }
  res.download(apk, 'SYNCLIKA-Share.apk');
});

app.get('/apk/oneclick.py', (req, res) => {
  if (fs.existsSync(MOBILE_ONECLICK)) {
    res.type('text/plain').sendFile(MOBILE_ONECLICK);
  } else {
    res.status(404).send('# desklink_mobile_oneclick.py missing\n');
  }
});

app.get('/desklink-offline.js', (req, res) => {
  const p = path.join(__dirname, 'lib', 'desklink-offline.js');
  if (fs.existsSync(p)) res.type('application/javascript').sendFile(p);
  else res.status(404).send('// desklink-offline.js missing\n');
});

app.get('/usb/status', (req, res) => {
  res.json(adbUsb.getUsbStatus());
});

app.get('/usb/install-mode', (req, res) => {
  if (!sec.isLocalRequest(req)) return res.status(403).json({ error: 'local_only' });
  res.json(adbUsb.getInstallModeStatus());
});

app.post('/local/start-p2p', (req, res) => {
  if (!sec.isLocalRequest(req)) return res.status(403).json({ error: 'local_only' });
  const bat = path.join(__dirname, 'START-P2P-SERVER.bat');
  if (!fs.existsSync(bat)) {
    return res.status(404).json({ ok: false, error: 'bat_missing', path: bat });
  }
  try {
    const child = spawn('cmd.exe', ['/c', 'start', 'SYNCLIKA P2P', bat], {
      cwd: __dirname,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    res.json({ ok: true, message: 'start_p2p_launched', bat });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/usb/pc-to-mobile-install', async (req, res) => {
  if (!sec.isLocalRequest(req)) return res.status(403).json({ error: 'local_only' });
  const apk = resolveApkPath();
  if (!apk) {
    return res.status(404).json({ ok: false, error: 'apk_missing', mode: 'pc_to_mobile_install' });
  }
  try {
    const result = await adbUsb.pcToMobileInstall(apk);
    if (result.ok) console.log('📲 PC→Mobile Install OK:', result.serial);
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, mode: 'pc_to_mobile_install' });
  }
});

app.post('/usb/reverse', (req, res) => {
  if (!sec.isLocalRequest(req)) return res.status(403).json({ error: 'local_only' });
  adbUsb.refreshUsbState().then(({ state }) => res.json(state));
});

app.post('/usb/connect', async (req, res) => {
  if (!sec.isLocalRequest(req)) return res.status(403).json({ error: 'local_only' });
  try {
    const launch = req.query.launch !== '0' && !(req.body && req.body.launch === false);
    const result = await adbUsb.connectUsbFull({ launch });
    if (result.ok) {
      console.log(`🔌 USB CONNECT OK: ${result.serial} → ${result.phoneUrl}`);
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, mode: 'usb_connect' });
  }
});

app.post('/usb/install-apk', async (req, res) => {
  if (!sec.isLocalRequest(req)) return res.status(403).json({ error: 'local_only' });
  const apk = resolveApkPath();
  if (!apk) {
    return res.status(404).json({
      ok: false,
      error: 'apk_missing',
      hint: 'Futtasd: BUILD-APK.bat vagy python desklink_oneclick.py',
    });
  }
  try {
    const launchAfter = req.query.launch !== '0' && !(req.body && req.body.launch === false);
    const result = await adbUsb.installApk(apk);
    let launched = false;
    if (result.ok && launchAfter) {
      const launch = await adbUsb.launchSynclikaApp(result.serial);
      launched = launch.ok;
    }
    if (result.ok) console.log('📲 USB: SYNCLIKA Share APK telepítve →', result.serial);
    res.json({ ...result, apkInstalled: result.ok, launched, mode: 'pc_to_mobile_install' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

function isLikelyPhoneClient(meta) {
  if (!meta || meta.role !== 'phone') return false;
  const ua = meta.device || '';
  if (/Android|iPhone|iPad|iPod|Mobile|webOS|BlackBerry/i.test(ua)) return true;
  if (/Windows|Macintosh|Linux x86_64/i.test(ua) && !/Mobile/i.test(ua)) return false;
  return true;
}

function pcStatusPayload(req) {
  const phones = [];
  clients.forEach((ws) => {
    if (!isLikelyPhoneClient(ws.clientMeta)) return;
    phones.push({
      ...ws.clientMeta,
      phoneVolume: ws.clientMeta.phoneVolume || null,
    });
  });
  return {
    connected: phones.length > 0,
    phoneCount: phones.length,
    phones,
    sessionStats,
    bidirectional: true,
    ...serverInfo(req),
  };
}

function notifyPcDashboard() {
  if (pcSseClients.size === 0) return;
  const payload = `data: ${JSON.stringify(pcStatusPayload())}\n\n`;
  pcSseClients.forEach((res) => {
    try { res.write(payload); } catch (e) { pcSseClients.delete(res); }
  });
}

// ── Session window (1h / 12h / 24h / until closed) ─────────────────────────
// Set from the SYNCLIKA launcher (/select). Governs how long this host keeps
// accepting NEW phone pairings. "Until closed" (durationMs = null) never expires
// on its own — it only ends when the server process is stopped.
const sessionPolicy = {
  startedAt: Date.now(),
  durationMs: null,
  expiresAt: null,
  label: 'Until closed',
  expired: false,
};

function getSessionStatus() {
  const indefinite = sessionPolicy.durationMs == null;
  const remainingMs = indefinite ? null : Math.max(0, sessionPolicy.expiresAt - Date.now());
  return {
    startedAt: sessionPolicy.startedAt,
    indefinite,
    durationMs: sessionPolicy.durationMs,
    expiresAt: sessionPolicy.expiresAt,
    remainingMs,
    label: sessionPolicy.label,
    expired: sessionPolicy.expired,
    active: indefinite || (!sessionPolicy.expired && remainingMs > 0),
  };
}

function startSessionPolicy(durationMs, label) {
  const ms = (durationMs === null || durationMs === undefined) ? null : Math.max(0, Number(durationMs) || 0) || null;
  sessionPolicy.startedAt = Date.now();
  sessionPolicy.durationMs = ms;
  sessionPolicy.expiresAt = ms ? sessionPolicy.startedAt + ms : null;
  sessionPolicy.label = label || (ms ? `${(ms / 3600000).toFixed(ms % 3600000 ? 1 : 0)}h` : 'Until closed');
  sessionPolicy.expired = false;
  console.log(`⏱  Session window started: ${sessionPolicy.label}`);
}

function expireSessionNow() {
  if (sessionPolicy.expired) return;
  sessionPolicy.expired = true;
  console.log('⏰ Session window expired — disconnecting paired phones');
  clients.forEach((ws) => {
    if (!isLikelyPhoneClient(ws.clientMeta)) return;
    try { ws.send(JSON.stringify({ type: 'session_expired' })); } catch (e) { /* ignore */ }
    try { ws.close(4001, 'session_expired'); } catch (e) { /* ignore */ }
  });
  notifyPcDashboard();
}

setInterval(() => {
  if (sessionPolicy.durationMs != null && !sessionPolicy.expired && Date.now() >= sessionPolicy.expiresAt) {
    expireSessionNow();
  }
}, 5000);

app.get('/pc', (req, res) => {
  if (fs.existsSync(PC_UI_PATH)) res.sendFile(PC_UI_PATH);
  else res.redirect('/host');
});

app.get('/pc/status', (req, res) => {
  if (!sec.isLocalRequest(req)) return res.status(403).json({ error: 'local_only' });
  res.json(pcStatusPayload(req));
});

app.get('/pc/events', (req, res) => {
  if (!sec.isLocalRequest(req)) return res.status(403).end();
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(`data: ${JSON.stringify(pcStatusPayload(req))}\n\n`);
  pcSseClients.add(res);
  req.on('close', () => pcSseClients.delete(res));
});

app.post('/pc/disconnect', (req, res) => {
  if (!sec.isLocalRequest(req)) return res.status(403).json({ error: 'local_only' });
  clients.forEach((ws) => {
    if (!isLikelyPhoneClient(ws.clientMeta)) return;
    try { ws.close(1000, 'pc_disconnect'); } catch (e) { /* ignore */ }
  });
  notifyPcDashboard();
  res.json({ ok: true });
});

app.post('/pc/disconnect-device', (req, res) => {
  if (!sec.isLocalRequest(req)) return res.status(403).json({ error: 'local_only' });
  const { ip, connectedAt } = req.body || {};
  let dropped = 0;
  clients.forEach((ws) => {
    if (!isLikelyPhoneClient(ws.clientMeta)) return;
    const meta = ws.clientMeta || {};
    const ipMatch = !ip || String(meta.ip) === String(ip);
    const timeMatch = !connectedAt || Number(meta.connectedAt) === Number(connectedAt);
    if (!ipMatch || !timeMatch) return;
    dropped += 1;
    try { ws.close(1000, 'pc_disconnect_device'); } catch (e) { /* ignore */ }
  });
  notifyPcDashboard();
  res.json({ ok: true, dropped });
});

app.post('/pc/phone/volume', (req, res) => {
  if (!sec.isLocalRequest(req)) return res.status(403).json({ error: 'local_only' });
  const { action, value } = req.body || {};
  if (!action) return res.status(400).json({ error: 'action_required' });
  forwardToPhones({ type: 'remote_volume', action, value });
  res.json({ ok: true });
});

app.post('/pc/phone/media', (req, res) => {
  if (!sec.isLocalRequest(req)) return res.status(403).json({ error: 'local_only' });
  const action = req.body && req.body.action;
  if (!action) return res.status(400).json({ error: 'action_required' });
  forwardToPhones({ type: 'remote_media', action: String(action) });
  res.json({ ok: true });
});

app.post('/pc/phone/vibrate', (req, res) => {
  if (!sec.isLocalRequest(req)) return res.status(403).json({ error: 'local_only' });
  const ms = Math.max(20, Math.min(2000, Number(req.body && req.body.ms) || 120));
  forwardToPhones({ type: 'remote_vibrate', ms });
  res.json({ ok: true });
});

app.post('/pc/phone/speaker', (req, res) => {
  if (!sec.isLocalRequest(req)) return res.status(403).json({ error: 'local_only' });
  forwardToPhones({ type: 'remote_speaker', on: !!(req.body && req.body.on) });
  res.json({ ok: true });
});

app.post('/pc/phone/notify', (req, res) => {
  if (!sec.isLocalRequest(req)) return res.status(403).json({ error: 'local_only' });
  const text = req.body && req.body.text ? String(req.body.text).slice(0, 500) : '';
  if (!text) return res.status(400).json({ error: 'text_required' });
  forwardToPhones({ type: 'remote_notify', text });
  res.json({ ok: true });
});

app.post('/pc/phone/volume-sync', (req, res) => {
  if (!sec.isLocalRequest(req)) return res.status(403).json({ error: 'local_only' });
  forwardToPhones({ type: 'phone_volume_get' });
  res.json({ ok: true });
});

function runLocalCombo(keys) {
  if (!robot || !Array.isArray(keys) || keys.length < 1) return false;
  try {
    const normalized = normalizeRobotKeys(keys);
    const mods = normalized.slice(0, -1);
    const key = normalized[normalized.length - 1];
    robot.keyTap(key, mods);
    return true;
  } catch (e) {
    return false;
  }
}

app.post('/pc/local/combo', (req, res) => {
  if (!sec.isLocalRequest(req)) return res.status(403).json({ error: 'local_only' });
  const keys = req.body && req.body.keys;
  if (!Array.isArray(keys) || keys.length < 1) return res.status(400).json({ error: 'keys_required' });
  const ok = runLocalCombo(keys);
  res.json({ ok, robotAvailable: !!robot });
});

app.post('/pc/local/volume', (req, res) => {
  if (!sec.isLocalRequest(req)) return res.status(403).json({ error: 'local_only' });
  const { action, value } = req.body || {};
  if (!action) return res.status(400).json({ error: 'action_required' });
  audio.handleVolume(action, value)
    .then((state) => res.json({ ok: true, state }))
    .catch(() => res.status(500).json({ ok: false }));
});

app.post('/pc/local/media', (req, res) => {
  if (!sec.isLocalRequest(req)) return res.status(403).json({ error: 'local_only' });
  const action = req.body && req.body.action;
  if (!action) return res.status(400).json({ error: 'action_required' });
  audio.handleMedia(String(action))
    .then((state) => res.json({ ok: true, state }))
    .catch(() => res.status(500).json({ ok: false }));
});

function pathInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

app.post('/pc/open-folder', (req, res) => {
  if (!sec.isLocalRequest(req)) return res.status(403).json({ error: 'local_only' });
  const target = req.body && req.body.path ? String(req.body.path) : UPLOAD_DIR;
  const resolved = path.resolve(target);
  if (!pathInside(UPLOAD_DIR, resolved)) {
    return res.status(400).json({ error: 'invalid path' });
  }
  if (process.platform === 'win32') {
    exec(`explorer "${resolved.replace(/"/g, '')}"`, () => {});
  } else if (process.platform === 'darwin') {
    exec(`open "${resolved}"`, () => {});
  } else {
    exec(`xdg-open "${resolved}"`, () => {});
  }
  res.json({ ok: true });
});

app.get('/qr', async (req, res) => {
  const ips = getLocalIPs();
  const ip = getPrimaryLanIp(ips);
  const grant = sec.issueGrant();
  const defaults = buildConnectUrls(ip, PORT, grant);
  let url = req.query.url ? String(req.query.url) : '';
  if (!url || !sec.isSafeQrUrl(url)) {
    if (sec.isLocalRequest(req)) {
      url = defaults.connectQr;
    } else if (!url) {
      return res.status(400).json({ error: 'missing_url' });
    } else {
      return res.status(400).json({ error: 'invalid_qr_url', hint: 'Use desklink:// LAN URL' });
    }
  }
  if (!QRCode) {
    return res.status(400).json({
      error: 'qrcode_not_installed',
      hint: 'Run: npm install (qrcode package)',
    });
  }
  try {
    const dataUrl = await QRCode.toDataURL(url, { margin: 1, width: 280 });
    res.json({ dataUrl, url: String(url) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const MANIFEST_PATH = path.join(__dirname, 'manifest.json');
app.get('/manifest.json', (req, res) => {
  if (fs.existsSync(MANIFEST_PATH)) res.sendFile(MANIFEST_PATH);
  else res.status(404).json({ error: 'manifest missing' });
});

// ── File Upload ──────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ts = Date.now();
    const safe = Buffer.from(file.originalname, 'latin1').toString('utf8')
      .replace(/[^a-zA-Z0-9.\-_áéíóöőúüűÁÉÍÓÖŐÚÜŰ ]/g, '_');
    cb(null, `${ts}_${safe}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 512 * 1024 * 1024, files: 12 },
});

app.post('/upload', authStrict, (req, res, next) => {
  const ip = sec.clientIp(req);
  if (!sec.rateCheck(`upload:${ip}`, sec.LIMITS.uploadMax)) {
    return res.status(429).json({ error: 'rate_limited' });
  }
  next();
}, upload.array('files', 12), (req, res) => {
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files' });
  const saved = req.files.map(f => ({ name: f.originalname, size: f.size, path: f.path }));
  sessionStats.filesSent += saved.length;
  sessionStats.bytesSent += saved.reduce((sum, f) => sum + (Number(f.size) || 0), 0);
  saved.forEach((f) => rememberSessionItem('file', f.name, { size: f.size }));
  console.log(`📁 ${saved.length} file(s) received`);
  broadcast({ type: 'files_received', files: saved.map(f => ({ name: f.name, size: f.size })) });
  notifyPcDashboard();
  res.json({ ok: true, saved: saved.map(f => ({ name: f.name, size: f.size })) });
});

app.post('/text', authStrict, (req, res) => {
  const { text } = req.body;
  if (text === undefined || text === null) return res.status(400).json({ error: 'No text' });
  const t = String(text).slice(0, 500_000);
  setClipboard(t);
  sessionStats.textsPasted += 1;
  rememberSessionItem('text', t.slice(0, 120));
  console.log('📋 Clipboard updated');
  broadcast({ type: 'text_received', preview: '' });
  notifyPcDashboard();
  res.json({ ok: true });
});

app.post('/open', authStrict, (req, res) => {
  const ip = sec.clientIp(req);
  if (!sec.rateCheck(`open:${ip}`, sec.LIMITS.openMax)) {
    return res.status(429).json({ error: 'rate_limited' });
  }
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'No url' });
  if (!openUrl(url)) return res.status(400).json({ error: 'unsafe_url' });
  sessionStats.linksOpened += 1;
  rememberSessionItem('link', url);
  console.log('🔗 URL opened');
  notifyPcDashboard();
  res.json({ ok: true });
});

app.get('/info', (req, res) => {
  res.json(serverInfo(req));
});

app.get('/security', (req, res) => {
  res.json({
    ...sec.p2pSecurityInfo(),
    version: serverBase().version,
    pairRequiredForLan: true,
    wsAuthTimeoutSec: Math.floor(sec.WS_AUTH_TIMEOUT_MS / 1000),
    grantTtlSec: Math.floor(sec.GRANT_TTL_MS / 1000),
  });
});

app.get('/session/status', (req, res) => {
  res.json(getSessionStatus());
});

app.post('/session/start', (req, res) => {
  if (!sec.isLocalRequest(req)) return res.status(403).json({ error: 'local_only' });
  const { durationMs, label } = req.body || {};
  startSessionPolicy(durationMs, label);
  notifyPcDashboard();
  res.json({ ok: true, session: getSessionStatus() });
});

app.get('/files', authStrict, (req, res) => {
  const files = fs.readdirSync(UPLOAD_DIR).map(name => {
    const stat = fs.statSync(path.join(UPLOAD_DIR, name));
    return { name, size: stat.size, modified: stat.mtime };
  }).sort((a, b) => b.modified - a.modified).slice(0, 50);
  res.json(files);
});

// ── HTTP + WS Server ─────────────────────────────────────────────────────────
const server = http.createServer(app);

const wss = new WebSocket.Server({
  server,
  // Ping built into ws library
  clientTracking: true,
});

const clients = new Set();

function broadcast(data) {
  const msg = JSON.stringify(data);
  clients.forEach((c) => {
    if (c.authenticated && c.readyState === WebSocket.OPEN) {
      try { c.send(msg); } catch (e) { /* ignore */ }
    }
  });
}

function tryAuthenticate(ws, msg) {
  if (ws.authenticated) return true;
  if (sessionPolicy.expired) return false;
  if (sec.validateWsCredentials(msg, { consumeGrant: true })) {
    ws.authenticated = true;
    return true;
  }
  const ip = ws.clientMeta && ws.clientMeta.ip;
  if (ip) sec.rateAuthFail(ip);
  return false;
}

wss.on('connection', (ws, req) => {
  const ip = sec.clientIp(req);
  if (!sec.isP2pAllowed(ip)) {
    console.log(`⛔ P2P blocked non-LAN peer: ${ip}`);
    ws.close(1008, 'p2p_only');
    return;
  }

  clients.add(ws);
  ws.authenticated = ip === '127.0.0.1' || ip === '::1';
  ws.clientMeta = {
    ip,
    connectedAt: Date.now(),
    label: ip,
    role: 'pending',
  };
  console.log(`📱 Client connected: ${ip}`);
  notifyPcDashboard();

  ws.send(JSON.stringify({
    type: 'welcome',
    ...serverInfo(req),
    authRequired: !ws.authenticated,
    security: sec.p2pSecurityInfo(),
  }));

  if (ws.authenticated) {
    ws.send(JSON.stringify({
      type: 'auth_ok',
      security: sec.p2pSecurityInfo(),
      audioAvailable: audio.isAudioAvailable(),
    }));
    pushVolumeState(ws);
  }

  if (!ws.authenticated) {
    ws.authDeadline = setTimeout(() => {
      if (!ws.authenticated && ws.readyState === WebSocket.OPEN) {
        console.log(`⛔ WS auth timeout: ${ip}`);
        ws.close(1008, 'auth_timeout');
      }
    }, sec.WS_AUTH_TIMEOUT_MS);
  }

  // Heartbeat — keep connection alive
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      handleWS(msg, ws);
    } catch(e) {
      console.error('WS parse error:', e.message);
    }
  });

  ws.on('close', (code) => {
    if (ws.authDeadline) clearTimeout(ws.authDeadline);
    clients.delete(ws);
    screenSubscribers.delete(ws);
    if (screenSubscribers.size === 0 && screenTimer) {
      clearInterval(screenTimer);
      screenTimer = null;
    }
    console.log(`📴 Kliens lecsatlakozott: ${ip} (ok: ${code})`);
    notifyPcDashboard();
  });

  ws.on('error', (err) => {
    console.error(`WS hiba (${ip}):`, err.message);
    clients.delete(ws);
    notifyPcDashboard();
  });
});

// Heartbeat interval — detect dead connections
const heartbeat = setInterval(() => {
  let changed = false;
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) {
      clients.delete(ws);
      screenSubscribers.delete(ws);
      changed = true;
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
  if (changed) notifyPcDashboard();
}, 15000);

wss.on('close', () => clearInterval(heartbeat));

async function pushScreenFrame() {
  if (!screenshot || screenSubscribers.size === 0 || screenBusy) return;
  screenBusy = true;
  try {
    const buf = await screenshot({ format: 'jpg', quality: 38 });
    const data = buf.toString('base64');
    const msg = JSON.stringify({ type: 'screen_frame', data, t: Date.now() });
    screenSubscribers.forEach((c) => {
      if (c.readyState === WebSocket.OPEN) {
        try { c.send(msg); } catch (e) { /* ignore */ }
      }
    });
  } catch (e) {
    console.error('screen capture:', e.message);
  } finally {
    screenBusy = false;
  }
}

function ensureScreenLoop() {
  if (screenTimer || !screenshot) return;
  screenTimer = setInterval(pushScreenFrame, 450);
}

// ── UDP LAN discovery ─────────────────────────────────────────────────────────
function startDiscovery() {
  const sock = dgram.createSocket('udp4');
  sock.on('message', (msg, rinfo) => {
    if (msg.toString().trim() !== 'DESKLINK_DISCOVER') return;
    if (!sec.isP2pAllowed(rinfo.address)) return;
    const ips = getLocalIPs();
    const primary = ips[0]?.ip || '127.0.0.1';
    const payload = JSON.stringify({
      service: 'desklink',
      host: primary,
      port: PORT,
      hostname: os.hostname(),
      url: `http://${primary}:${PORT}/`,
      authRequired: true,
    });
    sock.send(payload, rinfo.port, rinfo.address, () => {});
  });
  sock.on('error', (err) => console.log('⚠️  Discovery UDP:', err.message));
  sock.bind(DISCOVERY_PORT, '0.0.0.0', () => {
    console.log(`🔍 LAN discovery: UDP ${DISCOVERY_PORT}`);
  });
  return sock;
}

// ── WebSocket Command Handler ─────────────────────────────────────────────────
let mouseAccX = 0, mouseAccY = 0, lastMouseFlush = Date.now();

function handleWS(msg, ws) {
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'auth') {
    if (tryAuthenticate(ws, msg)) {
      if (ws.authDeadline) { clearTimeout(ws.authDeadline); ws.authDeadline = null; }
      ws.send(JSON.stringify({
        type: 'auth_ok',
        security: sec.p2pSecurityInfo(),
        audioAvailable: audio.isAudioAvailable(),
      }));
      pushVolumeState(ws);
    } else {
      ws.send(JSON.stringify({ type: 'auth_fail' }));
    }
    return;
  }

  if (msg.type === 'hello') {
    if (tryAuthenticate(ws, msg)) {
      if (ws.authDeadline) {
        clearTimeout(ws.authDeadline);
        ws.authDeadline = null;
      }
      pushVolumeState(ws);
    }
    const device = msg.device ? String(msg.device).slice(0, 200) : '';
    const uaPhone = /Android|iPhone|iPad|iPod|Mobile|webOS/i.test(device);
    const role = msg.role === 'phone' ? 'phone'
      : msg.role === 'preview' ? 'preview'
      : uaPhone ? 'phone' : 'preview';
    ws.clientMeta.role = role;
    if (msg.label) ws.clientMeta.label = String(msg.label).slice(0, 64);
    if (device) ws.clientMeta.device = device;
    notifyPcDashboard();
    if (!ws.authenticated) ws.send(JSON.stringify({ type: 'auth_required' }));
    return;
  }

  if (!ws.authenticated) {
    if (sec.isWsPreAuthType(msg.type)) {
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', t: msg.t, serverTime: Date.now() }));
      }
    } else {
      ws.send(JSON.stringify({ type: 'auth_required', security: sec.p2pSecurityInfo() }));
    }
    return;
  }

  if (!sec.wsRateOk(ws)) return;

  // ── PC → Phone (remote) ───────────────────────────────────────────────
  if (msg.type === 'phone_volume_get') {
    if (isHostController(ws)) forwardToPhones({ type: 'phone_volume_get' });
    return;
  }
  if (msg.type === 'phone_volume_state') {
    if (!isPhoneRole(ws)) return;
    ws.clientMeta.phoneVolume = {
      level: typeof msg.level === 'number' ? msg.level : 0,
      muted: !!msg.muted,
    };
    notifyPcDashboard();
    forwardToHostControllers({
      type: 'phone_volume_state',
      level: ws.clientMeta.phoneVolume.level,
      muted: ws.clientMeta.phoneVolume.muted,
      phone: ws.clientMeta.label || ws.clientMeta.ip,
    });
    return;
  }
  if (msg.type === 'remote_volume' || msg.type === 'remote_media' || msg.type === 'remote_vibrate'
      || msg.type === 'remote_speaker' || msg.type === 'remote_notify' || msg.type === 'remote_midi') {
    if (!isHostController(ws)) return;
    forwardToPhones(msg, ws);
    return;
  }

  // Host-only commands (phone → PC)
  const hostOnly = new Set([
    'mouse_move', 'mouse_click', 'mouse_scroll', 'mouse_down', 'mouse_up',
    'key_tap', 'key_combo', 'type_text', 'text', 'open_url',
    'volume_get', 'volume', 'media', 'screen_subscribe', 'screen_unsubscribe',
    'controller_stick', 'controller_button', 'gamepad_state', 'midi_event',
  ]);
  if (hostOnly.has(msg.type) && !isPhoneRole(ws)) return;

  if (msg.type === 'midi_event' && isPhoneRole(ws)) {
    midiPc.handleMidiOnPc(msg, robot).then((result) => {
      try {
        ws.send(JSON.stringify({ type: 'midi_ack', ...result }));
      } catch (e) { /* ignore */ }
      forwardToHostControllers({ type: 'midi_event', ...msg, result });
    }).catch((err) => {
      try { ws.send(JSON.stringify({ type: 'midi_error', message: err.message })); } catch (e) { /* ignore */ }
    });
    return;
  }

  if (msg.type === 'controller_button' && isPhoneRole(ws)) {
    const result = ctrlPc.handleControllerButton(msg, robot);
    try { ws.send(JSON.stringify({ type: 'controller_ack', ...result })); } catch (e) { /* ignore */ }
    return;
  }

  if (msg.type === 'gamepad_state' && isPhoneRole(ws)) {
    const last = controllerState.get(ws) || {};
    controllerState.set(ws, ctrlPc.handleGamepadState(msg, robot, last));
    return;
  }

  if (msg.type === 'controller_stick' && isPhoneRole(ws)) {
    if (!robot) return;
    const dx = (msg.dx || 0) * (msg.sensitivity || 1.5);
    const dy = (msg.dy || 0) * (msg.sensitivity || 1.5);
    mouseAccX += dx;
    mouseAccY += dy;
    const now = Date.now();
    if (now - lastMouseFlush > 14) {
      try {
        const pos = robot.getMousePos();
        const screen = robot.getScreenSize();
        const nx = Math.max(0, Math.min(screen.width - 1, pos.x + Math.round(mouseAccX)));
        const ny = Math.max(0, Math.min(screen.height - 1, pos.y + Math.round(mouseAccY)));
        robot.moveMouse(nx, ny);
      } catch (e) { /* ignore */ }
      mouseAccX = 0;
      mouseAccY = 0;
      lastMouseFlush = now;
    }
    return;
  }

  switch (msg.type) {

    // ── Connectivity ──────────────────────────────────────────────────────
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong', t: msg.t, serverTime: Date.now() }));
      break;

    // ── Mouse ─────────────────────────────────────────────────────────────
    case 'mouse_move': {
      if (!robot) break;
      mouseAccX += (msg.dx || 0) * (msg.sensitivity || 1.5);
      mouseAccY += (msg.dy || 0) * (msg.sensitivity || 1.5);
      const now = Date.now();
      if (now - lastMouseFlush > 14) {
        try {
          const pos = robot.getMousePos();
          const screen = robot.getScreenSize();
          const nx = Math.max(0, Math.min(screen.width - 1, pos.x + Math.round(mouseAccX)));
          const ny = Math.max(0, Math.min(screen.height - 1, pos.y + Math.round(mouseAccY)));
          robot.moveMouse(nx, ny);
        } catch(e) {}
        mouseAccX = 0; mouseAccY = 0; lastMouseFlush = now;
      }
      break;
    }
    case 'mouse_click':
      if (!robot) break;
      try { robot.mouseClick(msg.button || 'left', msg.double || false); } catch(e) {}
      break;

    case 'mouse_scroll':
      if (!robot) break;
      try { robot.scrollMouse(msg.dx || 0, msg.dy || 0); } catch(e) {}
      break;

    case 'mouse_down':
      if (!robot) break;
      try { robot.mouseToggle('down', msg.button || 'left'); } catch(e) {}
      break;

    case 'mouse_up':
      if (!robot) break;
      try { robot.mouseToggle('up', msg.button || 'left'); } catch(e) {}
      break;

    // ── Keyboard ──────────────────────────────────────────────────────────
    case 'key_tap':
      if (!robot || !msg.key) break;
      try { robot.keyTap(msg.key, msg.modifiers || []); } catch(e) {}
      break;

    case 'key_combo':
      if (!robot || !msg.keys || !msg.keys.length) break;
      try {
        const normalized = normalizeRobotKeys(msg.keys);
        const mods = normalized.slice(0, -1);
        const key = normalized[normalized.length - 1];
        robot.keyTap(key, mods);
      } catch(e) {}
      break;

    case 'type_text':
      if (!robot || !msg.text) break;
      try {
        // Split into chunks to handle unicode better
        robot.typeString(msg.text);
      } catch(e) {}
      break;

    // ── Clipboard / Text ──────────────────────────────────────────────────
    case 'text':
      if (msg.text !== undefined) setClipboard(msg.text);
      break;

    // ── URL / Open ────────────────────────────────────────────────────────
    case 'open_url':
      if (msg.url) {
        if (!openUrl(msg.url)) ws.send(JSON.stringify({ type: 'error', code: 'unsafe_url' }));
      }
      break;

    // ── Volume / Media ────────────────────────────────────────────────────
    case 'volume_get':
      pushVolumeState(ws);
      break;

    case 'volume':
      audio.handleVolume(msg.action, msg.value).then((state) => sendVolumeResult(ws, state));
      break;

    case 'media':
      audio.handleMedia(msg.action).then((state) => sendVolumeResult(ws, state));
      break;

    // ── System ────────────────────────────────────────────────────────────
    case 'get_info':
      ws.send(JSON.stringify({ type: 'info', ...serverInfo({ socket: { remoteAddress: ws.clientMeta.ip } }) }));
      break;

    case 'screen_subscribe':
      if (!screenshot) {
        ws.send(JSON.stringify({ type: 'screen_error', message: 'Screen capture unavailable' }));
        break;
      }
      screenSubscribers.add(ws);
      ensureScreenLoop();
      pushScreenFrame();
      break;

    case 'screen_unsubscribe':
      screenSubscribers.delete(ws);
      if (screenSubscribers.size === 0 && screenTimer) {
        clearInterval(screenTimer);
        screenTimer = null;
      }
      break;

    default:
      // Silently ignore unknown messages
      break;
  }
}

function onUsbStateChange(state) {
  if (state.autoConnect) {
    console.log(`🔌 USB kész: ${state.serial} → telefon: http://127.0.0.1:${PORT}/`);
  }
}

// ── Start ────────────────────────────────────────────────────────────────────
startDiscovery();
if (process.platform === 'win32') {
  adbUsb.startUsbWatch(onUsbStateChange);
}

const BIND_HOST = process.env.DESKLINK_BIND || '0.0.0.0';

server.listen(PORT, BIND_HOST, () => {
  const ips = getLocalIPs();
  const pad = (s, n) => String(s).padEnd(n);
  const LINE = '║';
  const primary = ips[0]?.ip || '127.0.0.1';

  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log('║  SYNCLIKA Share v4.2.0 ↔ P2P · USB auto · QR 5 min  ║');
  console.log('╠════════════════════════════════════════════════════╣');
  console.log(`${LINE}  Security: ${sec.P2P_STRICT ? 'LAN/USB only · QR grant' : 'WAN allowed (dev)'}     ${LINE}`);
  console.log(`${LINE}  Pair: ${sec.PAIR_CODE}  (QR grant on /host — no token leak) ${LINE}`);
  console.log(`${LINE}  Robot: ${robot ? '✅ Aktív' : '⚠️  Korlátozott'}  Képernyő: ${screenshot ? '✅' : '—'}              ${LINE}`);
  console.log(`${LINE}  Launcher: ${pad(`http://${primary}:${PORT}/select`, 36)}${LINE}`);
  console.log(`${LINE}  Host UI: ${pad(`http://${primary}:${PORT}/host`, 38)}${LINE}`);
  console.log('╠════════════════════════════════════════════════════╣');
  console.log('║  📱 Telefon (WiFi):                                ║');
  if (ips.length === 0) {
    console.log('║  ⚠️  Nem található hálózati interface!             ║');
  } else {
    ips.forEach(({ name, ip }) => {
      const url = `http://${ip}:${PORT}/`;
      console.log(`${LINE}  ${pad(name, 12)} ➜  ${pad(url, 36)}${LINE}`);
    });
  }
  console.log('║  🔌 Telefon (USB):  http://127.0.0.1:7331          ║');
  console.log('╚════════════════════════════════════════════════════╝');
  console.log('');
  console.log('  Ctrl+C = leállítás\n');

  if (process.platform === 'win32' && !process.env.DESKLINK_NATIVE) {
    const hostUrl = `http://127.0.0.1:${PORT}/select`;
    exec(`start "" "${hostUrl}"`, () => {});
  }
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 SYNCLIKA Share leállítva.');
  wss.close();
  server.close(() => process.exit(0));
});
