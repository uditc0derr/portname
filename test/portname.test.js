import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findFreePort } from '../src/ports.js';
import { sleep } from '../src/util.js';

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const bin = path.join(projectRoot, 'bin', 'portname.js');
let tmpHome;
let controlPort;
let token;
let proxyPort;
let daemonChild;
let sharedInfo;

function controlCall(info, method, urlPath, body, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port: info.controlPort,
        method,
        path: urlPath,
        timeout: timeoutMs,
        headers: {
          authorization: `Bearer ${info.token}`,
          ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => {
          raw += c;
        });
        res.on('end', () => {
          let parsed;
          try {
            parsed = raw ? JSON.parse(raw) : {};
          } catch {
            parsed = { raw };
          }
          if (res.statusCode >= 400) return reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
          resolve(parsed);
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function register(name) {
  return controlCall(sharedInfo, 'POST', '/register', { name });
}

function unregister(name) {
  return controlCall(sharedInfo, 'POST', '/unregister', { name });
}

function proxyGet(name, urlPath = '/', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: '127.0.0.1',
        port: proxyPort,
        path: urlPath,
        method: 'GET',
        rejectUnauthorized: false,
        servername: `${name}${name ? '.' : ''}localhost`,
        headers: { host: `${name}${name ? '.' : ''}localhost`, ...headers },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => {
          raw += c;
        });
        res.on('end', () => resolve({ status: res.statusCode, body: raw, headers: res.headers }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function waitFor(fn, timeoutMs = 8000) {
  const start = Date.now();
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      // keep polling
    }
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await sleep(120);
  }
}

test.before(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'portname-'));
  proxyPort = await findFreePort({ from: 59000, range: 500 });
  const env = {
    ...process.env,
    PORTNAME_HOME: tmpHome,
    PORTNAME_PROXY_PORT: String(proxyPort),
    PORTNAME_BASE_PORT: '61000',
    PORTNAME_PORT_RANGE: '2000',
  };
  daemonChild = spawn(process.execPath, [bin, 'daemon'], { env, stdio: 'ignore' });
  daemonChild.on('error', () => {});
  sharedInfo = await waitFor(async () => {
    const info = JSON.parse(fs.readFileSync(path.join(tmpHome, 'daemon.json'), 'utf8'));
    if (!info.controlPort) return null;
    await controlCall(info, 'GET', '/health');
    return info;
  });
  ({ controlPort, token, proxyPort } = sharedInfo);
});

test.after(async () => {
  if (daemonChild && daemonChild.exitCode == null) {
    try {
      await controlCall(sharedInfo, 'POST', '/shutdown');
    } catch {
      // already gone
    }
  }
  if (daemonChild && daemonChild.exitCode == null) {
    daemonChild.kill('SIGKILL');
    await new Promise((resolve) => daemonChild.once('exit', resolve));
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('daemon exposes a control API on the loopback interface', () => {
  assert.equal(controlPort > 0, true);
  assert.equal(typeof token === 'string' && token.length >= 10, true);
  assert.ok(proxyPort > 0);
});

test('authorization is required for mutating control routes', async () => {
  const res = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: controlPort, method: 'POST', path: '/register', headers: { 'content-type': 'application/json' } },
      (r) => {
        let raw = '';
        r.on('data', (c) => {
          raw += c;
        });
        r.on('end', () => resolve({ status: r.statusCode, body: raw }));
      }
    );
    req.on('error', reject);
    req.end('{"name":"nope"}');
  });
  assert.equal(res.status, 401);
});

test('registering assigns a free port and proxies requests to the upstream app', async () => {
  const { name, port } = await register('catapp');
  assert.equal(name, 'catapp');
  assert.ok(port > 0);

  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'x-upstream': 'yes' });
    res.end(JSON.stringify({ app: name, path: req.url, echo: req.headers['x-test'] || null }));
  });
  await new Promise((resolve) => upstream.listen(port, '127.0.0.1', resolve));

  const res = await proxyGet('catapp', '/hello?q=1', { 'x-test': 'yes-sir' });
  assert.equal(res.status, 200);
  assert.equal(res.headers['x-upstream'], 'yes');
  const body = JSON.parse(res.body);
  assert.equal(body.app, 'catapp');
  assert.equal(body.path, '/hello?q=1');
  assert.equal(body.echo, 'yes-sir');

  await new Promise((resolve) => upstream.close(resolve));
});

test('unknown hostnames return a JSON 404, the bare proxy returns a landing page', async () => {
  const missing = await proxyGet('ghostapp');
  assert.equal(missing.status, 404);
  assert.match(missing.body, /ghostapp\.localhost/);

  const landing = await proxyGet('', '/');
  assert.equal(landing.status, 200);
  assert.match(landing.body, /portname/);
});

test('proxy returns 502 when the app is not actually listening', async () => {
  const { name } = await register('deadapp');
  const res = await proxyGet(name, '/');
  assert.equal(res.status, 502);
  await unregister(name);
});

test('registering the same name again stops the old process and rebinds', async () => {
  const first = await register('rebind');
  assert.equal(first.port > 0, true);
  const second = await register('rebind');
  assert.equal(second.port > 0, true);
  const res = await proxyGet('rebind', '/');
  assert.equal(res.status, 502);
  await unregister('rebind');
});

test('websocket upgrades are forwarded to the upstream app', async () => {
  let name;
  let port;
  let upstream;
  let socket;
  try {
    ({ name, port } = await register('wsapp'));
    upstream = http.createServer();
    upstream.on('upgrade', (_req, sock) => {
      sock.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
      sock.on('data', (d) => sock.write(d.toString().toUpperCase()));
    });
    await new Promise((resolve) => upstream.listen(port, '127.0.0.1', resolve));

    socket = tls.connect({ host: '127.0.0.1', port: proxyPort, rejectUnauthorized: false });
    socket.setEncoding('utf8');
    let received = '';
    let socketError = null;
    socket.on('data', (d) => {
      received += d;
    });
    socket.on('error', (err) => {
      socketError = err;
    });

    await new Promise((resolve, reject) => {
      let sentHello = false;
      const timer = setTimeout(
        () =>
          reject(
            new Error(
              `websocket handshake timed out (received: ${JSON.stringify(received)}, error: ${socketError?.message || 'none'})`
            )
          ),
        5000
      );
      socket.on('connect', () => {
        socket.write(`GET /ws HTTP/1.1\r\nHost: ${name}.localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
      });
      const poll = setInterval(() => {
        if (socketError) {
          clearInterval(poll);
          clearTimeout(timer);
          return reject(socketError);
        }
        if (!sentHello && received.includes('101')) {
          sentHello = true;
          socket.write('hello');
          return;
        }
        if (sentHello && received.includes('HELLO')) {
          clearInterval(poll);
          clearTimeout(timer);
          resolve();
        }
      }, 15);
    });

    assert.ok(received.startsWith('HTTP/1.1 101'));
  } finally {
    socket?.destroy();
    upstream?.closeAllConnections?.();
    upstream?.close();
    if (name) {
      try {
        await unregister(name);
      } catch {
        // already gone
      }
    }
  }
});

test('portname start spawns an app, exposes it on a *.localhost URL, and portname stop tears it down', async () => {
  const serverCode = `
    const http = require("node:http");
    http.createServer((req, res) => {
      res.writeHead(200);
      res.end("e2e-running on " + (process.env.PORT || process.env.PORTNAME_PORT));
    }).listen(Number(process.env.PORTNAME_PORT || process.env.PORT));
  `;
  const env = { ...process.env, PORTNAME_HOME: tmpHome, PORTNAME_PROXY_PORT: String(proxyPort) };

  const cli = spawn(process.execPath, [bin, 'start', 'e2eapp', 'node', '-e', serverCode], { env, stdio: 'ignore' });

  const res = await waitFor(async () => {
    const r = await proxyGet('e2eapp', '/');
    return r.status === 200 ? r : null;
  });
  assert.match(res.body, /e2e-running/);

  const listed = await execFileP(process.execPath, [bin, 'list'], env);
  assert.match(listed, /e2eapp/);
  assert.match(listed, /e2eapp\.localhost/);

  const apps = await controlCall(sharedInfo, 'GET', '/list');
  const app = apps.apps.find((a) => a.name === 'e2eapp');
  assert.ok(app && app.pid > 0);

  const stopped = await execFileP(process.execPath, [bin, 'stop', 'e2eapp'], env);
  assert.match(stopped, /e2eapp/);

  const stillAlive = await new Promise((resolve) => {
    try {
      process.kill(app.pid, 0);
      resolve(true);
    } catch {
      resolve(false);
    }
  });
  assert.equal(stillAlive, false);

  await waitFor(async () => {
    try {
      const r = await proxyGet('e2eapp', '/');
      return r.status === 404;
    } catch {
      return null;
    }
  });

  await new Promise((resolve) => cli.on('exit', resolve));
});

function execFileP(binFile, args, env) {
  return new Promise((resolve, reject) => {
    execFile(binFile, args, { env, timeout: 20000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(err.message + '\n' + stderr));
      else resolve(stdout);
    });
  });
}