#!/usr/bin/env node
/**
 * Refuse a Linux package whose native modules need a newer glibc than 2.31.
 * Debian bullseye is 2.31. A module built on a newer runner (Ubuntu 24.04 or
 * later) does not load on the machines people actually use.
 *
 * Non-ELF files (the macOS and Windows prebuilds that share the tree) are
 * skipped. Usage: node assert-native-glibc.mjs <directory>
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const GLIBC_MAX = [2, 31];

export function newerThan(version, max = GLIBC_MAX) {
  const parts = String(version).split('.').map((part) => Number(part));
  const width = Math.max(parts.length, max.length);
  for (let i = 0; i < width; i++) {
    const left = parts[i] ?? 0;
    const right = max[i] ?? 0;
    if (Number.isNaN(left)) return false;
    if (left !== right) return left > right;
  }
  return false;
}

export function glibcVersions(dump) {
  return [...String(dump).matchAll(/GLIBC_(\d+(?:\.\d+)*)/g)].map((match) => match[1]);
}

export function maxGlibc(versions) {
  return versions.reduce((best, version) => {
    if (best === null || newerThan(version, best.split('.').map(Number))) return version;
    return best;
  }, null);
}

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    let info;
    try { info = statSync(path); } catch { continue; }
    if (info.isDirectory()) walk(path, out);
    else if (name.endsWith('.node')) out.push(path);
  }
  return out;
}

function dumpOf(file) {
  try {
    return execFileSync('objdump', ['-T', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const text = `${error.stderr ?? ''}${error.message ?? ''}`;
    if (/file format not recognized|not a dynamic object|File format not recognized/i.test(text) || error.status === 1) return null;
    throw error;
  }
}

function main() {
  const root = process.argv[2];
  if (!root) {
    console.error('usage: assert-native-glibc.mjs <directory>');
    process.exit(2);
  }
  const files = walk(root, []);
  const offenders = [];
  let checked = 0;
  for (const file of files) {
    const dump = dumpOf(file);
    if (dump === null) {
      console.log(`skip (not ELF) ${file}`);
      continue;
    }
    checked += 1;
    const max = maxGlibc(glibcVersions(dump));
    console.log(`${max ?? 'none'} ${file}`);
    if (max && newerThan(max)) offenders.push(`${file} needs GLIBC_${max}`);
  }
  if (checked === 0) {
    console.error(`no ELF .node files under ${root}`);
    process.exit(1);
  }
  if (offenders.length) {
    console.error('native modules need a newer glibc than 2.31:');
    for (const line of offenders) console.error(line);
    process.exit(1);
  }
  console.log(`glibc ok: ${checked} native module(s) need GLIBC_2.31 or older`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
