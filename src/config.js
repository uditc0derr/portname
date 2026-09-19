import os from 'node:os';
import path from 'node:path';

export const homeDir = process.env.PORTNAME_HOME || path.join(os.homedir(), '.portname');
export const certDir = process.env.PORTNAME_CERT_DIR || path.join(homeDir, 'certs');
export const keyPath = process.env.PORTNAME_KEY_PATH || path.join(certDir, 'portname-key.pem');
export const certPath = process.env.PORTNAME_CERT_PATH || path.join(certDir, 'portname-cert.pem');
export const caKeyPath = path.join(certDir, 'portname-ca-key.pem');
export const caCertPath = path.join(certDir, 'portname-ca.pem');
export const daemonPath = path.join(homeDir, 'daemon.json');
export const appsPath = path.join(homeDir, 'apps.json');

export const DEFAULT_PROXY_PORT = Number(process.env.PORTNAME_PROXY_PORT) || 443;
export const FALLBACK_PROXY_PORT = Number(process.env.PORTNAME_FALLBACK_PROXY_PORT) || 8443;
export const APP_PORT_BASE = Number(process.env.PORTNAME_BASE_PORT) || 3000;
export const APP_PORT_RANGE = Number(process.env.PORTNAME_PORT_RANGE) || 1000;

export const CONTROLLER_BIND = '127.0.0.1';
export const PROXY_BIND = process.env.PORTNAME_BIND || '0.0.0.0';

export const LOCALHOST_SUFFIX = '.localhost';