import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { startProxyDaemon } from './daemon.js';
import { ensureCert } from './certs.js';
import { runTrust } from './trust.js';
import { daemonPath, DEFAULT_PROXY_PORT } from './config.js';
import { formatUrl, isProcessAlive, readJson, sleep } from './util.js';

const binPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/portname.js');

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const KNOWN_PORT_FLAGS = new Map([
  ['next', '-p'],
  ['vite', '--port'],
  ['webpack', '--port'],
  ['parcel', '--port'],
]);

const PACKAGE_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

function usage() {
  return `portname - local dev reverse proxy

Usage:
  portname <name> <command...>       Start <command> and map https://<name>.localhost to it
  portname start <name> <cmd...>     Explicit form (use for names like "list" or "stop")
  portname list                      List registered apps
  portname stop <name>               Stop an app and remove its mapping
  portname trust                     Trust the local HTTPS certificate (no browser warnings)
  portname daemon                    Run the proxy in the foreground
  portname daemon status             Show daemon status
  portname daemon stop               Stop the proxy daemon

Examples:
  portname myapp next dev
  portname dashboard vite --host
`;
}

function validateName(raw) {
  const name = String(raw || '').toLowerCase();
  if (!NAME_RE.test(name)) {
    throw new Error(`invalid app name "${raw}" (use letters, digits and hyphens, up to 63 chars)`);
  }
  if (name === 'localhost') throw new Error('"localhost" is a reserved name');
  return name;
}

function controlCall(info, method, urlPath, body, timeoutMs = 8000) {
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
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          let parsed;
          try {
            parsed = raw ? JSON.parse(raw) : {};
          } catch {
            parsed = { raw };
          }
          if (res.statusCode >= 400) {
            const err = new Error(parsed.error || `control request failed: HTTP ${res.statusCode}`);
            err.status = res.statusCode;
            return reject(err);
          }
          resolve(parsed);
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error(`control request to ${urlPath} timed out`)));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function health(info) {
  try {
    await controlCall(info, 'GET', '/health');
    return true;
  } catch {
    return false;
  }
}

async function existingDaemon() {
  const info = readJson(daemonPath);
  if (info && info.pid && isProcessAlive(info.pid) && (await health(info))) {
    return info;
  }
  return null;
}

async function ensureDaemon() {
  const info = await existingDaemon();
  if (info) return info;

  const child = spawn(process.execPath, [binPath, 'daemon'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  child.unref();

  for (let i = 0; i < 60; i += 1) {
    await sleep(100);
    const next = await existingDaemon();
    if (next) return next;
  }
  throw new Error(`could not start the portname daemon (see ${daemonPath})`);
}

function portArgsFor(cmd, port) {
  const base = String(cmd[0]).replace(/^.*[\\/]/, '').replace(/\.[cm]?[jt]s$/, '');
  if (PACKAGE_RUNNERS.has(base)) {
    return ['--', '--port', String(port)];
  }
  const flag = KNOWN_PORT_FLAGS.get(base);
  return flag ? [flag, String(port)] : [];
}

function printStartBanner({ name, url, target, pid }) {
  const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
  const red = useColor ? '\x1b[31m' : '';
  const reset = useColor ? '\x1b[0m' : '';
  const rule = '  ' + '─'.repeat(48);
  console.log('');
  console.log(`  portname  ${name}`);
  console.log(rule);
  console.log(`  URL     ${red}${url}${reset}`);
  console.log(`  Local   ${target}`);
  console.log(`  PID     ${pid ?? '-'}`);
  console.log(rule);
  console.log('');
}

async function startApp(rawName, cmd) {
  if (!cmd?.length) throw new Error(`<command...> is required`);
  const name = validateName(rawName);
  const info = await ensureDaemon();
  const { port } = await controlCall(info, 'POST', '/register', { name });
  const url = formatUrl(name, info.proxyPort);
  const args = portArgsFor(cmd, port);
  const localBin = path.join(process.cwd(), 'node_modules', '.bin');
  const env = {
    ...process.env,
    PATH: [localBin, process.env.PATH].filter(Boolean).join(path.delimiter),
    PORT: String(port),
    PORTNAME_PORT: String(port),
    PORTNAME_NAME: name,
    PORTNAME_URL: url,
  };
  const child = spawn(cmd[0], [...cmd.slice(1), ...args], { env, stdio: 'inherit', cwd: process.cwd() });

  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
    child.once('error', (err) => {
      if (err.code === 'ENOENT') {
        console.error(`[portname] could not find "${cmd[0]}". Run it via a package script (e.g. portname ${name} npm run dev) or use a binary in this project's node_modules/.bin.`);
      } else {
        console.error(`[portname] failed to start ${cmd.join(' ')}: ${err.message}`);
      }
      resolve({ code: 1 });
    });
  });

  const forward = (signal) => () => child.kill(signal);
  process.on('SIGINT', forward('SIGINT'));
  process.on('SIGTERM', forward('SIGTERM'));

  try {
    try {
      await controlCall(info, 'POST', '/attach', { name, pid: child.pid });
    } catch {
      // best-effort: mapping stays but without a pid to signal
    }

    printStartBanner({ name, url, target: `http://localhost:${port}`, pid: child.pid });

    const result = await exited;
    return result.code == null ? 0 : result.code;
  } finally {
    try {
      await controlCall(info, 'POST', '/unregister', { name, pid: child.pid });
    } catch {
      // best-effort
    }
  }
}

async function stopApp(rawName) {
  const name = validateName(rawName);
  const info = await existingDaemon();
  if (!info) {
    console.log('daemon not running');
    return 0;
  }
  const res = await controlCall(info, 'POST', '/unregister', { name });
  if (res.pid) {
    try {
      process.kill(res.pid, 'SIGTERM');
      console.log(`[portname] stopped ${name} (pid ${res.pid})`);
    } catch {
      console.log(`[portname] unregistered ${name} (process ${res.pid} already gone)`);
    }
  } else {
    console.log(`[portname] unregistered ${name}`);
  }
  return 0;
}

async function listApps() {
  const info = await existingDaemon();
  if (!info) {
    console.log('daemon not running');
    return 0;
  }
  const { apps } = await controlCall(info, 'GET', '/list');
  if (!apps.length) {
    console.log('no apps registered');
    return 0;
  }
  const nameW = Math.max(...apps.map((a) => a.name.length), 4);
  const urlW = Math.max(...apps.map((a) => a.url.length), 3);
  const pidW = Math.max(...apps.map((a) => String(a.pid ?? '-').length), 3);
  const pad = (s, w) => String(s).padEnd(w);
  console.log(`${pad('name', nameW)}  ${pad('url', urlW)}  ${pad('pid', pidW)}  port`);
  for (const app of apps) {
    console.log(`${pad(app.name, nameW)}  ${pad(app.url, urlW)}  ${pad(app.pid ?? '-', pidW)}  ${app.port}`);
  }
  return 0;
}

async function daemonStatus() {
  const info = readJson(daemonPath);
  if (!info || !isProcessAlive(info.pid) || !(await health(info))) {
    console.log('daemon not running');
    return 0;
  }
  const suffix = info.proxyPort !== DEFAULT_PROXY_PORT ? `:${info.proxyPort}` : '';
  console.log(`daemon running (pid ${info.pid})`);
  console.log(`proxy: https://<name>.localhost${suffix}`);
  console.log(`config: ${daemonPath}`);
  return 0;
}

async function trust() {
  const { created } = await ensureCert();
  if (created) {
    console.log('[portname] generated a new local certificate authority.');
  }
  const running = await existingDaemon();
  if (running) {
    try {
      await controlCall(running, 'POST', '/shutdown');
    } catch {
      // already gone
    }
    await sleep(300);
  }
  const code = await runTrust();
  if (code !== 0) return code;
  await ensureDaemon();
  console.log('[portname] proxy restarted with the trusted certificate. Reload your browser to clear the warning.');
  return 0;
}

async function daemonStop() {
  const info = readJson(daemonPath);
  if (!info || !info.pid || !isProcessAlive(info.pid)) {
    console.log('daemon not running');
    return 0;
  }
  try {
    await controlCall(info, 'POST', '/shutdown');
  } catch {
    throw new Error(`could not stop daemon (pid ${info.pid})`);
  }
  console.log('daemon stopped');
  return 0;
}

async function runForeground() {
  await startProxyDaemon();
  await new Promise(() => {});
  return 0;
}

export async function main(argv) {
  const [a, b, ...rest] = argv;

  if (!a || a === '--help' || a === '-h' || a === 'help') {
    console.log(usage());
    return a ? 0 : 1;
  }
  if (a.startsWith('-')) {
    console.log(usage());
    return 1;
  }
  if (a === 'daemon') {
    if (b === 'status') return daemonStatus();
    if (b === 'stop') return daemonStop();
    return runForeground();
  }
  if (a === 'list') return listApps();
  if (a === 'trust') return trust();
  if (a === 'stop') return stopApp(b ?? '');
  if (a === 'start') return startApp(b, rest);
  return startApp(a, argv.slice(1));
}