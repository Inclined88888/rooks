/**
 * Terminal host — entry point of the process that owns the web terminal's
 * pseudo-terminals. The daemon launches it outside its own supervisor
 * (`host.spawnDetached`) and talks to it over `protocol.ts`; it leaves on its
 * own once it has had no session for a while.
 *
 * Environment: `TIMON_HOME` (required). The token is read from its file under
 * `<TIMON_HOME>/run/`, never from argv or the environment, and never logged.
 * Loads nothing outside this folder: no database, no settings, no config.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';
import { hostFiles } from './protocol.js';
import { loadNodePty, nodePtySpawner } from './pty.js';
import { createHostServer } from './server.js';

const DEFAULT_EXIT_MS = 10 * 60_000;

function log(line: string): void {
  console.log(`[terminal-host] ${new Date().toISOString()} ${line}`);
}

function build(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** True when another host already answers on the endpoint. */
function answering(endpoint: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(endpoint);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

/** The socket's folder must be ours alone: the token is the lock, this is the door. */
function prepareDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
  if (!st.isDirectory() || (uid >= 0 && st.uid !== uid)) throw new Error(`refusing the socket folder ${dir}: not a directory owned by this user`);
  if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

async function main(): Promise<void> {
  const home = process.env.TIMON_HOME?.trim();
  if (!home) throw new Error('TIMON_HOME is required');
  const files = hostFiles(home);
  const token = readFileSync(files.token, 'utf8').trim();
  if (token.length < 32) throw new Error('terminal host token missing or too short');

  if (await answering(files.endpoint)) {
    log('another terminal host already serves this home, leaving');
    return;
  }
  if (files.endpointDir) {
    prepareDir(files.endpointDir);
    // Nothing answered: a socket left there is stale.
    if (existsSync(files.endpoint)) unlinkSync(files.endpoint);
  }
  if (!loadNodePty()) log('node-pty unavailable: every shell will fail to start');

  const exitAfter = Number(process.env.TIMON_TERMINAL_HOST_EXIT_MS);
  const host = createHostServer({
    token,
    spawn: nodePtySpawner,
    build: build(),
    entry: fileURLToPath(import.meta.url),
    exitAfterMs: Number.isFinite(exitAfter) && exitAfter > 0 ? exitAfter : DEFAULT_EXIT_MS,
    onIdleExit: () => { host.close(); process.exit(0); },
    log,
  });
  const stop = (signal: string): void => {
    log(`${signal}: closing every shell`);
    host.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  // Detached from any terminal; a stray hangup must not take the shells.
  process.on('SIGHUP', () => {});

  await new Promise<void>((resolve, reject) => {
    host.server.once('error', reject);
    host.server.listen(files.endpoint, () => resolve());
  });
  if (files.endpointDir) chmodSync(files.endpoint, 0o600);
  log(`listening (pid ${process.pid})`);
}

main().catch((err: unknown) => {
  log(`cannot start: ${(err as Error).message}`);
  process.exit(1);
});
