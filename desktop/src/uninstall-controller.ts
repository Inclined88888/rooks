import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { connect } from 'node:net';
import { join, dirname } from 'node:path';
import { createInterface } from 'node:readline';
import type { Socket } from 'node:net';
import type { DesktopConfig } from './config.js';
import { withRuntimeEnv, type DaemonRuntime } from './daemon-runtime.js';
import { UNINSTALL_HELPER_FLAG } from './uninstall.js';
import type { CleanupMessage } from './uninstall-helper.js';

/** Prepare the helper before stopping anything. It does nothing on a crash or
 * cancellation until both shutdown checks have passed and we explicitly arm it. */
export async function prepareCleanup(executable: string, payload: CleanupMessage): Promise<{ arm: () => Promise<void>; cancel: () => void }> {
  const env: NodeJS.ProcessEnv = { ...process.env, ROOKS_UNINSTALL_HELPER: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [UNINSTALL_HELPER_FLAG], {
    env, cwd: dirname(executable), detached: true, stdio: ['ignore', 'pipe', 'ignore', 'pipe'],
  });
  const control = child.stdio[3] as Socket;
  control.on('error', () => {});
  const lines = createInterface({ input: child.stdout! });
  const wait = (key: string, send?: unknown) => new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      child.off('error', failed); child.off('exit', exited); lines.off('line', received);
      error ? reject(error) : resolve();
    };
    const received = (line: string) => {
      try { if (JSON.parse(line)?.[key] === true) finish(); } catch { /* Ignore runtime diagnostics. */ }
    };
    const failed = (error: Error) => finish(error);
    const exited = () => finish(new Error('The uninstall helper exited unexpectedly.'));
    const timeout = setTimeout(() => finish(new Error('The uninstall helper did not respond.')), 30_000);
    lines.on('line', received); child.once('error', failed); child.once('exit', exited);
    if (send) control.write(JSON.stringify(send) + '\n', error => { if (error) finish(error); });
  });
  try {
    await wait('started');
    await wait('ready', payload);
  } catch (error) { child.kill(); throw error; }
  return {
    arm: async () => {
      await wait('armed', { action: 'arm' });
      child.unref();
      control.unref();
      (child.stdout as Socket).unref();
    },
    cancel: () => { child.kill(); },
  };
}

export async function stopInstalledService(
  cfg: DesktopConfig,
  runtime: DaemonRuntime,
  resources: string,
  version: string,
): Promise<void> {
  await promisify(execFile)(runtime.execPath, [join(resources, 'orchestrator', 'dist', 'host', 'desktop-uninstall-runner.js')], {
    timeout: 60_000,
    windowsHide: true,
    env: { ...withRuntimeEnv(process.env, runtime), ROOKS_HOME: cfg.home,
      ROOKS_DESKTOP_EMBEDDED: '1', ROOKS_DESKTOP_SERVICE: '0', ROOKS_DESKTOP_VERSION: version,
      ROOKS_INSTALL_DIR: join(resources, 'orchestrator') },
  });
}

/** A refused TCP connection confirms shutdown. A timeout or network error does
 * not: a stalled daemon must never be interpreted as safe to erase. */
export function portClosed(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', (error: NodeJS.ErrnoException) => error.code === 'ECONNREFUSED' ? resolve(true) : reject(error));
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('Could not verify daemon shutdown.')); });
  });
}

export async function verifyStopped(cfg: DesktopConfig): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await portClosed(cfg.daemon.listen.port) && (!cfg.app.enabled || await portClosed(cfg.app.listen.port))) return;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Rooks is still listening. Data has been preserved; stop the remaining daemon before trying again.');
}

export async function performUninstall(steps: {
  stopEmbedded: () => Promise<void>;
  stopService: () => Promise<void>;
  stopBrowser: () => Promise<void>;
  verifyStopped: () => Promise<void>;
  disableLogin: () => void;
  armCleanup: () => Promise<void>;
  quit: () => void;
}): Promise<void> {
  await steps.stopEmbedded();
  await steps.stopService();
  await steps.stopBrowser();
  await steps.verifyStopped();
  steps.disableLogin();
  await steps.armCleanup();
  steps.quit();
}
