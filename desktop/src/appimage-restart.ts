import { spawn } from 'node:child_process';
import { accessSync, closeSync, constants, mkdirSync, openSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

// Electron 33's relaunch helper inherits Chromium's NoNewPrivs flag. That
// prevents fusermount from mounting a second AppImage. A native child of the
// main process preserves its permissions; renderer sandboxing is unchanged.
// FD 3 is a lifetime pipe: EOF after the arm message means the parent exited.
// Do not interpolate paths or arguments into this fixed shell program.
const WAIT_FOR_EXIT = `
IFS= read -r action <&3 || exit 0
[ "$action" = restart ] || exit 0
if IFS= read -r action <&3; then exit 0; fi
exec 3<&-
exec "$@"
`;

/** Queue one AppImage launch after this process exits; return a cancellation. */
export async function queueAppImageRelaunch(
  executable: string,
  args: string[],
  home: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<() => void> {
  if (!isAbsolute(executable) || executable.includes('\0')) throw new Error('Invalid AppImage path.');
  accessSync(executable, constants.X_OK);
  const logDir = join(home, 'tmp');
  mkdirSync(logDir, { recursive: true });
  // Electron's relauncher discards stderr. Preserve mount/startup diagnostics.
  const log = openSync(join(logDir, 'desktop-restart.log'), 'a', 0o600);
  const child = (() => {
    try {
      // The AppImage is the application, never Node: whatever this shell inherited (I2 of audit-packaged-os).
      const childEnv: NodeJS.ProcessEnv = { ...env, ROOKS_HOME: home };
      delete childEnv.ELECTRON_RUN_AS_NODE;
      return spawn('/bin/sh', ['-c', WAIT_FOR_EXIT, 'rooks-appimage-restart', executable, ...args], {
        cwd: home, env: childEnv, detached: true,
        stdio: ['ignore', log, log, 'pipe'],
      });
    } finally { closeSync(log); }
  })();
  const control = child.stdio[3];
  if (!control || !('write' in control)) {
    child.kill();
    throw new Error('Could not create the restart control pipe.');
  }
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => { child.kill(); reject(error); };
    child.on('error', failed);
    control.on('error', failed);
    child.once('spawn', () => {
      control.write('restart\n', (error?: Error | null) => {
        if (error) { failed(error); return; }
        child.unref();
        // Keep the descriptor open until process exit, without keeping Node
        // alive. No timer, polling, PID reuse or single-instance lock race.
        if ('unref' in control && typeof control.unref === 'function') control.unref();
        resolve();
      });
    });
  });
  return () => { child.kill(); control.destroy(); };
}
