#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sign } from 'node:crypto';

const keyFile = join(homedir(), '.rooks-signing', 'license.key');
if (!existsSync(keyFile)) {
  console.error(`licence private key missing: ${keyFile}`);
  process.exit(1);
}
const args = process.argv.slice(2);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const sub = value('sub');
const edition = value('edition');
const days = Number(value('days'));
if (!sub || !['lite', 'expert'].includes(edition) || !Number.isFinite(days) || days <= 0) {
  console.error("usage: issue-license.mjs --sub acme --edition expert --modules '*' --plugins acme-crm-sync --days 365 [--machine <id>] [--key-id <id>]");
  process.exit(64);
}
const list = (raw) => raw === '*' ? '*' : (raw ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const now = Math.floor(Date.now() / 1000);
const header = { alg: 'EdDSA', typ: 'JWT', kid: value('key-id') ?? 'license-v1' };
const claims = {
  sub, edition, modules: list(value('modules')), plugins: list(value('plugins')),
  iat: now, exp: now + Math.floor(days * 86400),
  ...(value('machine') ? { machineId: value('machine') } : {}),
};
const enc = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
const input = `${enc(header)}.${enc(claims)}`;
const signature = sign(null, Buffer.from(input), readFileSync(keyFile)).toString('base64url');
process.stdout.write(`${input}.${signature}\n`);
