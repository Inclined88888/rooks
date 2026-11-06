import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { config, setConfig } from '../../src/config/load.js';

/**
 * What the operator does for a third party's program: an entry of `pluginPolicy.exec.allow`. A third
 * party's launch is compared with it at every spawn (TODO #531), so a test dialect's program needs it too.
 */
export function authorizeProgram(entry: string): void {
  const previous = config();
  if (previous.pluginPolicy.exec.allow.includes(entry)) return;
  setConfig({ ...previous, pluginPolicy: { ...previous.pluginPolicy, exec: { ...previous.pluginPolicy.exec, allow: [...previous.pluginPolicy.exec.allow, entry] } } });
}

/**
 * A program that is node under another NAME, for a test dialect whose CLI is a
 * script. The launch of a plugin's backend refuses `node` itself (a generic
 * launcher, `backends/launch-binary.ts`): a dialect that really ships a CLI has
 * its own binary, and so does the witness. Never a symbolic link to node: a
 * third party's launch is judged by the file a link leads to, and a link to
 * node IS node. On POSIX a two-line script that execs node; on Windows, where a
 * script is no executable, a copy. Authorized, as the operator would.
 */
export function witnessCli(dir: string, name = 'witness-cli'): string {
  mkdirSync(dir, { recursive: true });
  let path: string;
  if (process.platform === 'win32') {
    path = join(dir, `${name}.exe`);
    if (!existsSync(path)) copyFileSync(process.execPath, path);
  } else {
    path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`);
    chmodSync(path, 0o755);
  }
  authorizeProgram(path);
  return path;
}

/**
 * A third party's CLI `name` installed on this host's search path (a stub that exits 0) and authorized by
 * name: for a test whose spawn is recorded, never run, but whose launch must resolve to a real file.
 */
export function installedProgram(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'timon-installed-'));
  const path = join(dir, process.platform === 'win32' ? `${name}.cmd` : name);
  writeFileSync(path, process.platform === 'win32' ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n');
  if (process.platform !== 'win32') chmodSync(path, 0o755);
  process.env.PATH = `${dir}${delimiter}${process.env.PATH ?? ''}`;
  authorizeProgram(name);
  return path;
}
