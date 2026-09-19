import { spawn } from 'node:child_process';
import { caCertPath } from './config.js';

export function trustInstructions() {
  if (process.platform === 'darwin') {
    return {
      cmd: 'sudo',
      args: ['security', 'add-trusted-cert', '-d', '-r', 'trustRoot', '-k', '/Library/Keychains/System.keychain', caCertPath],
      manual: `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${caCertPath}`,
    };
  }
  if (process.platform === 'linux') {
    return {
      cmd: 'sudo',
      args: ['sh', '-c', `cp "${caCertPath}" /usr/local/share/ca-certificates/portname.crt && update-ca-certificates`],
      manual: `sudo cp ${caCertPath} /usr/local/share/ca-certificates/portname.crt && sudo update-ca-certificates`,
    };
  }
  if (process.platform === 'win32') {
    return {
      cmd: 'certutil',
      args: ['-addstore', '-user', 'Root', caCertPath],
      manual: `certutil -addstore -user Root ${caCertPath}`,
    };
  }
  return { cmd: null, args: [], manual: `Trust ${caCertPath} as a root CA in your system/browser.` };
}

export function runTrust() {
  const { cmd, args, manual } = trustInstructions();
  if (!cmd) {
    console.log(`[portname] automatic trust is not supported on ${process.platform}.`);
    console.log(`[portname] add this certificate as a trusted root: ${caCertPath}`);
    return Promise.resolve(1);
  }
  return new Promise((resolve) => {
    console.log(`[portname] trusting ${caCertPath}`);
    console.log('[portname] you may be asked for your computer password (sudo).');
    const child = spawn(cmd, args, { stdio: 'inherit' });
    child.on('error', (err) => {
      console.error(`[portname] could not run trust command: ${err.message}`);
      console.error(`[portname] run it manually: ${manual}`);
      resolve(1);
    });
    child.on('exit', (code) => {
      if (code === 0) {
        console.log('[portname] certificate trusted.');
        resolve(0);
      } else {
        console.error(`[portname] trust command failed (exit ${code}).`);
        console.error(`[portname] run it manually: ${manual}`);
        resolve(1);
      }
    });
  });
}
