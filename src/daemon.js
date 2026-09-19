import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { ensureCert } from './certs.js';
import { findFreePort } from './ports.js';
import { formatUrl, isProcessAlive, readJson, readJsonBody, writeJson } from './util.js';
import {
  appsPath,
  certPath,
  CONTROLLER_BIND,
  daemonPath,
  DEFAULT_PROXY_PORT,
  FALLBACK_PROXY_PORT,
  LOCALHOST_SUFFIX,
  PROXY_BIND,
} from './config.js';

function loadApps() {
  const data = readJson(appsPath);
  const map = new Map();
  for (const app of data?.apps ?? []) {
    if (app?.name) map.set(app.name, app);
  }
  return map;
}

function saveApps(apps) {
  return writeJson(appsPath, { apps: [...apps.values()] });
}

function parseHost(raw) {
  const host = String(raw || '').split(':').shift().toLowerCase();
  if (host === 'localhost') return { name: '', local: true };
  if (host.endsWith(LOCALHOST_SUFFIX)) return { name: host.slice(0, -LOCALHOST_SUFFIX.length), local: true };
  return { name: '', local: false };
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function landingPage(apps, proxyPort) {
  const appList = [...apps.values()];
  const rows = appList.length
    ? appList
        .map((a) => `<li><a href="${formatUrl(a.name, proxyPort)}">${formatUrl(a.name, proxyPort)}</a></li>`)
        .join('\n')
    : '<li>no apps registered yet</li>';
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>portname</title></head>
<body>
<h1>portname</h1>
<p>Running apps:</p>
<ul>
${rows}
</ul>
</body>
</html>
`;
}

function handleRequest(apps, proxyPort, req, res) {
  const { name, local } = parseHost(req.headers.host);
  if (local && name) {
    const app = apps.get(name);
    if (app) {
      proxyToApp(app, req, res).catch(() => {
        if (!res.headersSent) sendJson(res, 502, { error: `Could not reach app "${name}"` });
      });
      return;
    }
    return sendJson(res, 404, {
      error: `No app registered for "${name}${LOCALHOST_SUFFIX}"`,
      hint: 'Register it with: portname start <name> <command...>',
      apps: [...apps.keys()],
    });
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(landingPage(apps, proxyPort));
}

const LOOPBACK_HOSTS = ['127.0.0.1', '::1'];
const targetHostCache = new Map();

function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(300);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function targetHost(app) {
  const cached = targetHostCache.get(app.name);
  if (cached && (await canConnect(cached, app.port))) return cached;
  for (const host of LOOPBACK_HOSTS) {
    if (await canConnect(host, app.port)) {
      targetHostCache.set(app.name, host);
      return host;
    }
  }
  return cached || LOOPBACK_HOSTS[0];
}

async function proxyToApp(app, req, res) {
  const host = await targetHost(app);
  const headers = { ...req.headers, host: `localhost:${app.port}` };
  const upstream = http.request({
    host,
    port: app.port,
    path: req.url,
    method: req.method,
    headers,
    timeout: 30_000,
  });
  upstream.on('response', (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  upstream.on('timeout', () => {
    upstream.destroy(new Error(`app "${app.name}" on port ${app.port} timed out`));
  });
  upstream.on('error', (err) => {
    targetHostCache.delete(app.name);
    if (!res.headersSent) {
      sendJson(res, 502, { error: `Could not reach app "${app.name}" on port ${app.port}: ${err.message}` });
    } else {
      res.destroy();
    }
  });
  req.on('error', () => upstream.destroy());
  req.pipe(upstream);
}

async function handleUpgrade(apps, req, socket, head) {
  const { name, local } = parseHost(req.headers.host);
  const app = local ? apps.get(name) : undefined;
  if (!app) {
    socket.destroy();
    return;
  }
  const host = await targetHost(app);
  const target = net.connect(app.port, host, () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (const [key, value] of Object.entries(req.headers)) {
      if (key === 'host') {
        lines.push(`Host: localhost:${app.port}`);
      } else if (Array.isArray(value)) {
        for (const v of value) lines.push(`${key}: ${v}`);
      } else {
        lines.push(`${key}: ${value}`);
      }
    }
    target.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head?.length) target.write(head);
  });
  target.on('error', () => {
    targetHostCache.delete(app.name);
    socket.destroy();
  });
  socket.on('error', () => target.destroy());
  socket.on('close', () => target.destroy());
  target.on('close', () => socket.destroy());
  socket.pipe(target);
  target.pipe(socket);
}

function authorized(token, req) {
  return (req.headers.authorization || '') === `Bearer ${token}`;
}

async function handleControl(apps, token, proxyPort, req, res, shutdown) {
  const route = (req.url || '/').split('?').shift();
  try {
    if (req.method === 'GET' && route === '/health') {
      return sendJson(res, 200, { ok: true, proxyPort });
    }
    if (!authorized(token, req)) {
      return sendJson(res, 401, { error: 'unauthorized' });
    }
    if (req.method === 'GET' && route === '/list') {
      const body = { apps: [...apps.entries()].map(([name, app]) => ({ ...app, url: formatUrl(name, proxyPort) })) };
      return sendJson(res, 200, body);
    }
    if (req.method !== 'POST') {
      return sendJson(res, 405, { error: 'method not allowed' });
    }
    const body = await readJsonBody(req);

    if (route === '/register') {
      const name = validateName(body.name);
      return register(apps, name, res);
    }
    if (route === '/attach') {
      const existing = apps.get(validateName(body.name));
      if (!existing) return sendJson(res, 404, { error: `no app registered for "${body.name}"` });
      existing.pid = Number(body.pid) || null;
      await saveApps(apps);
      return sendJson(res, 200, { ok: true, name: existing.name, port: existing.port });
    }
    if (route === '/unregister') {
      return unregister(apps, body, res);
    }
    if (route === '/shutdown') {
      sendJson(res, 200, { ok: true });
      await shutdown();
      return undefined;
    }
    return sendJson(res, 404, { error: `unknown route ${route}` });
  } catch (err) {
    return sendJson(res, 400, { error: err?.message ?? String(err) });
  }
}

function validateName(raw) {
  const name = String(raw || '').toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) {
    throw new Error(`invalid app name "${raw}" (use letters, digits and hyphens, up to 63 chars)`);
  }
  if (name === 'localhost') throw new Error('"localhost" is a reserved name');
  return name;
}

async function register(apps, name, res) {
  const existing = apps.get(name);
  if (existing?.pid && isProcessAlive(existing.pid)) {
    try {
      process.kill(existing.pid, 'SIGTERM');
    } catch {
      // process already gone
    }
  }
  const port = await findFreePort();
  apps.set(name, { name, port, pid: null, protocol: 'http', createdAt: new Date().toISOString() });
  await saveApps(apps);
  return sendJson(res, 200, { name, port });
}

async function unregister(apps, body, res) {
  let name;
  try {
    name = validateName(body.name);
  } catch {
    name = String(body.name || '').toLowerCase();
  }
  const existing = apps.get(name);
  if (!existing) return sendJson(res, 404, { error: `no app registered for "${body.name}"` });
  if (body.pid && existing.pid && existing.pid !== Number(body.pid)) {
    return sendJson(res, 409, { error: 'mapping belongs to a different process' });
  }
  const pid = existing.pid;
  const port = existing.port;
  apps.delete(name);
  await saveApps(apps);
  return sendJson(res, 200, { ok: true, name, pid, port });
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host, port }, resolve);
  });
}

async function startHttps(key, cert, onRequest, onUpgrade, preferred) {
  const candidates = [];
  const push = (p) => {
    if (Number.isInteger(p) && p > 0 && p < 65536 && !candidates.includes(p)) candidates.push(p);
  };
  push(preferred || DEFAULT_PROXY_PORT);
  push(DEFAULT_PROXY_PORT);
  push(FALLBACK_PROXY_PORT);
  for (let i = 0; i < 200; i += 1) push(FALLBACK_PROXY_PORT + i);

  let lastError;
  for (const port of candidates) {
    const server = https.createServer({ key, cert });
    server.on('request', onRequest);
    server.on('upgrade', onUpgrade);
    server.on('error', (err) => console.error(`[portname] proxy error: ${err.message}`));
    try {
      await listen(server, port, PROXY_BIND);
      return { server, port };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('no free proxy port found');
}

function onSignal(shutdown) {
  const handler = () => {
    shutdown().catch(() => process.exit(1));
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
}

export async function startProxyDaemon({ proxyPort } = {}) {
  const apps = loadApps();
  const { key, cert, created } = await ensureCert();
  const token = randomBytes(24).toString('hex');

  const { server: httpsServer, port: boundProxyPort } = await startHttps(
    key,
    cert,
    (req, res) => handleRequest(apps, boundProxyPort, req, res),
    (req, socket, head) => {
      handleUpgrade(apps, req, socket, head).catch(() => socket.destroy());
    },
    proxyPort
  );

  function shutdown() {
    return Promise.all([
      new Promise((resolve) => {
        httpsServer.closeIdleConnections?.();
        httpsServer.close(() => resolve());
      }),
      new Promise((resolve) => {
        control?.closeIdleConnections?.();
        control?.close(() => resolve());
      }),
    ]).finally(() => process.exit(0));
  }

  const control = http.createServer((req, res) => handleControl(apps, token, boundProxyPort, req, res, shutdown));
  await listen(control, 0, CONTROLLER_BIND);
  const controlPort = control.address().port;

  await writeJson(daemonPath, {
    pid: process.pid,
    proxyPort: boundProxyPort,
    controlPort,
    token,
    bind: PROXY_BIND,
    startedAt: new Date().toISOString(),
  });

  console.log(`[portname] proxy listening on https://<name>${LOCALHOST_SUFFIX}${boundProxyPort !== 443 ? `:${boundProxyPort}` : ''}`);
  console.log(`[portname] certificates generated at ${certPath}`);
  if (created) {
    console.log('[portname] trust the certificate in your OS/browser to avoid security warnings');
  }

  onSignal(shutdown);
  return { apps, httpsServer, control, controlPort, proxyPort: boundProxyPort };
}