#!/usr/bin/env node
import { createHash, sign } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join, relative, sep } from 'node:path';

const root = resolve(process.argv[2] || '');
const keyFile = join(homedir(), '.rooks-signing', 'plugins.key');
const keyId = process.env.ROOKS_PLUGIN_SIGNING_KEY_ID || 'rooks-plugins-2026-11';
if (!process.argv[2]) throw new Error('usage: sign-plugin.mjs <plugin-dir>');
if (!existsSync(keyFile)) {
  throw new Error(`private key missing: ${keyFile} — create an Ed25519 key outside the repo (chmod 0600)`);
}

function filesBelow(dir = root) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesBelow(path));
    else if (entry.isFile() && !(dir === root && entry.name === 'SIGNATURE')) out.push(path);
    else if (entry.isSymbolicLink()) throw new Error(`symbolic link not allowed: ${relative(root, path)}`);
  }
  return out;
}

const digest = createHash('sha256');
for (const file of filesBelow().sort((a, b) => relative(root, a).localeCompare(relative(root, b)))) {
  digest.update(relative(root, file).split(sep).join('/'));
  digest.update('\0');
  digest.update(readFileSync(file));
  digest.update('\0');
}
const hash = digest.digest('hex');
const sig = sign(null, Buffer.from(hash, 'hex'), readFileSync(keyFile, 'utf8')).toString('base64');
writeFileSync(join(root, 'SIGNATURE'), `${JSON.stringify({ alg: 'ed25519', keyId, hash, sig }, null, 2)}\n`, { mode: 0o644 });
process.stdout.write(`SIGNATURE written (${keyId}, ${hash})\n`);
