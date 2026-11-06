import { createHash, verify } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Only immutable product files: user state and installed dependencies are not
// covered. Signing packages and OS trust remain separate layers.
export const protectedRoots = ['dist', 'bin', 'scripts', 'presets', 'package.json'];
// Built-in plugins (orchestrator/src/plugins/builtin.ts): signed when shipped.
// Optional only for inventories that predate them — a manifest that lists
// them still fails on their removal, since the inventories must match.
// `build-info.json` (channel + expiry) is signed too, so the date cannot be
// edited in an installed package; a release prepared before it stays valid.
export const optionalRoots = ['builtin-plugins', 'builtin-plugins.json', 'build-info.json'];
// Read by the daemon to trust built-in plugins by location; set only here,
// after the inventory below has been verified.
export const RELEASE_MARKER = Symbol.for('timon.verifiedRelease');
// Version 2 lists the signed files and nothing else; version 1 also named a
// protection scheme the package no longer applies. The shell and the daemon of
// a package only check their own release, so no reader of version 1 remains.
export const RELEASE_MANIFEST_VERSION = 2;
export function productFiles(root) {
  const files = [];
  function visit(name) {
    const path = join(root, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Release contains a symbolic link: ${name}`);
    if (stat.isDirectory()) {
      for (const child of readdirSync(path).sort()) visit(`${name}/${child}`);
    } else if (stat.isFile()) files.push(name);
    else throw new Error(`Unsupported release file: ${name}`);
  }
  for (const name of protectedRoots) visit(name);
  for (const name of optionalRoots) if (existsSync(join(root, name))) visit(name);
  return files.sort();
}
export function digest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
export function verifyRelease(root, publicKey) {
  const body = readFileSync(join(root, 'release-manifest.json'));
  const signature = readFileSync(join(root, 'release-manifest.sig'));
  if (!verify(null, body, publicKey, signature)) throw new Error('Invalid release signature');
  const manifest = JSON.parse(body.toString('utf8'));
  if (manifest.version !== RELEASE_MANIFEST_VERSION) throw new Error('Unsupported release manifest version');
  const actual = productFiles(root);
  const expected = Object.keys(manifest.files).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Release inventory differs');
  for (const name of actual) {
    if (digest(join(root, name)) !== manifest.files[name]) throw new Error(`Release integrity failed: ${name}`);
  }
  return manifest;
}
