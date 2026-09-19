import net from 'node:net';
import { APP_PORT_BASE, APP_PORT_RANGE } from './config.js';

function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(true));
    socket.setTimeout(300, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function portFromEphemeral() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export async function findFreePort({ prefer, from = APP_PORT_BASE, range = APP_PORT_RANGE } = {}) {
  const candidates = new Set();
  if (prefer) candidates.add(prefer);
  for (let p = from; p < from + range; p += 1) candidates.add(p);
  for (const p of candidates) {
    if (await isPortFree(p)) return p;
  }
  return portFromEphemeral();
}