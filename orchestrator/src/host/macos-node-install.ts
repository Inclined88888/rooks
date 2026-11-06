import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readlinkSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import type { ExecResult } from './types.js';

const NODE_CHANNEL = 'latest-v22.x';
const NODE_DIST = `https://nodejs.org/dist/${NODE_CHANNEL}`;

type FetchResponse = {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
};

export type MacNodeInstallOptions = {
  exec: (command: string, args: string[]) => Promise<ExecResult>;
  homeDir?: string;
  arch?: NodeJS.Architecture;
  fetcher?: (url: string) => Promise<FetchResponse>;
};

export function nodeArchiveFromChecksums(
  checksums: string,
  arch: NodeJS.Architecture,
): { sha256: string; filename: string } {
  if (arch !== 'arm64' && arch !== 'x64') throw new Error(`unsupported macOS architecture: ${arch}`);
  const suffix = `-darwin-${arch}.tar.gz`;
  for (const line of checksums.split('\n')) {
    const match = /^([a-f0-9]{64})\s+(.+)$/.exec(line.trim());
    if (match?.[2]?.endsWith(suffix)) return { sha256: match[1]!, filename: match[2] };
  }
  throw new Error(`Node.js ${NODE_CHANNEL} has no archive for darwin-${arch}`);
}

async function replaceSymlink(target: string, destination: string): Promise<void> {
  try {
    const info = lstatSync(destination);
    if (!info.isSymbolicLink()) {
      throw new Error(`refusing to overwrite existing file: ${destination}`);
    }
    // Only links in the user-owned bin directory are replaced.
    readlinkSync(destination);
    await unlink(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await symlink(target, destination);
}

/** Installs the current Node 22 LTS archive entirely inside this user account. */
export async function installMacNodeUserLocal(options: MacNodeInstallOptions): Promise<string[]> {
  const home = options.homeDir ?? homedir();
  const arch = options.arch ?? process.arch;
  const fetcher = options.fetcher ?? (globalThis.fetch as unknown as MacNodeInstallOptions['fetcher']);
  if (!fetcher) throw new Error('network downloads are unavailable in this runtime');

  const sumsResponse = await fetcher(`${NODE_DIST}/SHASUMS256.txt`);
  if (!sumsResponse.ok) throw new Error(`Node.js checksum download failed (HTTP ${sumsResponse.status})`);
  const archive = nodeArchiveFromChecksums(await sumsResponse.text(), arch);
  const archiveResponse = await fetcher(`${NODE_DIST}/${archive.filename}`);
  if (!archiveResponse.ok) throw new Error(`Node.js download failed (HTTP ${archiveResponse.status})`);
  const bytes = Buffer.from(await archiveResponse.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== archive.sha256) throw new Error('Node.js archive checksum mismatch');

  const release = archive.filename.replace(/\.tar\.gz$/, '');
  const library = join(home, '.local', 'lib', 'nodejs');
  const destination = join(library, release);
  const userBin = join(home, '.local', 'bin');
  const stage = await mkdtemp(join(tmpdir(), 'timon-node-'));
  try {
    const archivePath = join(stage, basename(archive.filename));
    await writeFile(archivePath, bytes, { mode: 0o600 });
    const extracted = join(stage, release);
    const unpack = await options.exec('/usr/bin/tar', ['-xzf', archivePath, '-C', stage]);
    if (unpack.code !== 0) throw new Error(unpack.stderr.trim() || `tar exited with ${unpack.code}`);
    if (!existsSync(extracted)) throw new Error('Node.js archive did not contain the expected directory');

    await mkdir(library, { recursive: true });
    if (!existsSync(destination)) {
      try {
        await rename(extracted, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
        await cp(extracted, destination, { recursive: true });
      }
    }
    if (!existsSync(join(destination, 'bin', 'node'))) {
      throw new Error('Node.js installation is missing its executable');
    }
    await mkdir(userBin, { recursive: true });
    for (const name of ['node', 'npm', 'npx', 'corepack']) {
      const target = join(destination, 'bin', name);
      if (existsSync(target)) await replaceSymlink(target, join(userBin, name));
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }

  const currentPath = process.env.PATH ?? '';
  if (!currentPath.split(delimiter).includes(userBin)) {
    process.env.PATH = [userBin, currentPath].filter(Boolean).join(delimiter);
  }
  return [`Node.js ${release.replace(/^node-/, '')} installed in ${destination}`];
}
