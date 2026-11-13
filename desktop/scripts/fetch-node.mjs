#!/usr/bin/env node
/**
 * Fetches the Node the packaged daemon runs on into
 * `desktop/build-resources/node/`, from where `electron-builder.yml` ships it
 * as `resources/node/node[.exe]`.
 *
 * The version and the SHA-256 of every archive are pinned in
 * `node-runtime.json`: a download that does not match is refused, never
 * shipped. Only the `node` executable travels (no npm, no headers). Builds are
 * native (one OS per machine), so the target is the platform and architecture
 * of the Node running this script, unless `--platform` / `--arch` say otherwise.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const NODE_DIR = join(desktopDir, 'build-resources', 'node');
const CACHE_DIR = join(desktopDir, 'build-resources', '.node-cache');

/** The pinned runtime: version, module ABI and the archive of each target. */
export function nodeRuntimeSpec() {
  return JSON.parse(readFileSync(join(desktopDir, 'scripts', 'node-runtime.json'), 'utf8'));
}

/** Where the fetched executable lands for `platform`. */
export function bundledNodeExecutable(platform = process.platform) {
  return join(NODE_DIR, platform === 'win32' ? 'node.exe' : 'node');
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`download failed: ${url} answered ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/** The archive of `key`, from the cache when its hash still matches. */
async function verifiedArchive(spec, key) {
  const entry = spec.files[key];
  if (!entry) throw new Error(`no pinned Node ${spec.version} for ${key} (node-runtime.json)`);
  const cached = join(CACHE_DIR, `${spec.version}-${entry.archive.replace(/[\\/]/g, '-')}`);
  if (existsSync(cached) && sha256(readFileSync(cached)) === entry.sha256) return cached;
  const url = `https://nodejs.org/dist/v${spec.version}/${entry.archive}`;
  console.log(`[node] downloading ${url}`);
  const body = await download(url);
  const actual = sha256(body);
  if (actual !== entry.sha256) {
    throw new Error(`${entry.archive}: SHA-256 ${actual} does not match the pinned ${entry.sha256} — refusing to ship it`);
  }
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cached, body);
  return cached;
}

/** Copies the `node` executable of a verified archive to `NODE_DIR`. */
function extract(spec, entry, archive, platform) {
  const target = bundledNodeExecutable(platform);
  rmSync(NODE_DIR, { recursive: true, force: true });
  mkdirSync(NODE_DIR, { recursive: true });
  if (entry.archive.endsWith('.exe')) {
    copyFileSync(archive, target);
    return target;
  }
  // `<name>/bin/node` inside `<name>.tar.{gz,xz}`. tar ships with Linux,
  // macOS and Windows 10+.
  const name = entry.archive.replace(/\.tar\.(gz|xz)$/, '');
  const scratch = mkdtempSync(join(tmpdir(), 'rooks-node-'));
  try {
    // portability: tar is a build-machine tool here, present on the three OSes
    execFileSync('tar', ['-xf', archive, '-C', scratch, `${name}/bin/node`], { stdio: 'inherit' });
    copyFileSync(join(scratch, name, 'bin', 'node'), target);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  chmodSync(target, 0o755);
  return target;
}

/** Fetches, verifies and places the executable; checks it runs and reports the pinned version. */
export async function fetchNode({ platform = process.platform, arch = process.arch } = {}) {
  const spec = nodeRuntimeSpec();
  const key = `${platform}-${arch}`;
  const entry = spec.files[key];
  if (!entry) throw new Error(`no pinned Node ${spec.version} for ${key} (node-runtime.json)`);
  const target = extract(spec, entry, await verifiedArchive(spec, key), platform);
  if (platform === process.platform && arch === process.arch) {
    const version = execFileSync(target, ['-p', 'process.versions.node + " " + process.versions.modules'], { encoding: 'utf8' }).trim();
    if (version !== `${spec.version} ${spec.abi}`) throw new Error(`${target} reports ${version}, expected ${spec.version} ${spec.abi}`);
  }
  console.log(`[node] Node ${spec.version} (${key}) → ${target}`);
  return target;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flag = (name) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  fetchNode({ platform: flag('--platform') ?? process.platform, arch: flag('--arch') ?? process.arch }).catch((error) => {
    console.error(`[node] ${error.message}`);
    process.exit(1);
  });
}
