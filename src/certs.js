import fs from 'node:fs';
import path from 'node:path';
import forge from 'node-forge';
import { caCertPath, caKeyPath, certPath, keyPath } from './config.js';
import { mkdirp } from './util.js';

const ALT_NAMES = [
  { type: 2, value: 'localhost' },
  { type: 2, value: '*.localhost' },
  { type: 7, ip: '127.0.0.1' },
  { type: 7, ip: '::1' },
];

const CA_ATTRS = [
  { name: 'commonName', value: 'portname local development CA' },
  { name: 'organizationName', value: 'portname' },
];

function yearsFromNow(years) {
  const date = new Date();
  date.setFullYear(date.getFullYear() + years);
  return date;
}

function createAuthority(pki) {
  const keys = pki.rsa.generateKeyPair(2048);
  const cert = pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = yearsFromNow(10);
  cert.setSubject(CA_ATTRS);
  cert.setIssuer(CA_ATTRS);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { keys, cert };
}

function createLeaf(pki, ca) {
  const keys = pki.rsa.generateKeyPair(2048);
  const cert = pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '02';
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = yearsFromNow(2);
  cert.setSubject([{ name: 'commonName', value: 'localhost' }]);
  cert.setIssuer(ca.cert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: ALT_NAMES },
  ]);
  cert.sign(ca.keys.privateKey, forge.md.sha256.create());
  return { keys, cert };
}

function generateBundle() {
  const pki = forge.pki;
  const ca = createAuthority(pki);
  const leaf = createLeaf(pki, ca);
  return {
    key: pki.privateKeyToPem(leaf.keys.privateKey),
    cert: pki.certificateToPem(leaf.cert),
    caKey: pki.privateKeyToPem(ca.keys.privateKey),
    caCert: pki.certificateToPem(ca.cert),
  };
}

export function certsExist() {
  return fs.existsSync(keyPath) && fs.existsSync(certPath) && fs.existsSync(caCertPath) && fs.existsSync(caKeyPath);
}

export function generateCerts() {
  const bundle = generateBundle();
  mkdirp(path.dirname(keyPath));
  fs.writeFileSync(keyPath, bundle.key, { mode: 0o600 });
  fs.writeFileSync(certPath, bundle.cert);
  fs.writeFileSync(caKeyPath, bundle.caKey, { mode: 0o600 });
  fs.writeFileSync(caCertPath, bundle.caCert);
  return bundle;
}

export async function ensureCert() {
  if (!certsExist()) {
    const bundle = generateCerts();
    return { key: bundle.key, cert: bundle.cert, created: true };
  }
  return {
    key: fs.readFileSync(keyPath, 'utf8'),
    cert: fs.readFileSync(certPath, 'utf8'),
    created: false,
  };
}

export function readCaCert() {
  return fs.existsSync(caCertPath) ? fs.readFileSync(caCertPath, 'utf8') : null;
}
