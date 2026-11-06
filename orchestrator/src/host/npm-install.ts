import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, win32 } from 'node:path';
import { randomUUID } from 'node:crypto';
import { findExecutableBinary, INSTALLED_BINARIES_FILE, readInstalledBinaries } from './binary-path.js';
import type { ExecResult } from './types.js';

/** Persist discovery separately: writing the config here would bypass first-run setup. */
export async function rememberWindowsNpmBinary(
  name: string,
  exec: (command: string, args: string[]) => Promise<ExecResult>,
): Promise<string> {
  const result = await exec('npm', ['prefix', '-g']);
  const prefix = result.stdout.trim();
  if (result.code !== 0 || !prefix || /[\r\n]/.test(prefix)
    || !(isAbsolute(prefix) || win32.isAbsolute(prefix))) {
    throw new Error('Installation finished, but the global npm directory could not be resolved. Check npm prefix -g.');
  }
  // Restrict validation to npm's output, not another executable already on PATH.
  const pathJoin = win32.isAbsolute(prefix) && !isAbsolute(prefix) ? win32.join : join;
  const binary = ['.exe', '.cmd', '.bat'].map((ext) => pathJoin(prefix, name + ext))
    .find((candidate) => findExecutableBinary(candidate, { platform: 'win32' }));
  if (!binary) throw new Error(`Installation finished, but ${name} was not found in the global npm directory: ${prefix}`);
  const installed = { ...readInstalledBinaries(), [name]: binary };
  mkdirSync(dirname(INSTALLED_BINARIES_FILE), { recursive: true });
  const temporary = `${INSTALLED_BINARIES_FILE}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(installed, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, INSTALLED_BINARIES_FILE);
  } finally { rmSync(temporary, { force: true }); }
  return binary;
}
