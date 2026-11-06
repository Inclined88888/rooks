/** systemd owns this process while the original embedded daemon finishes setup. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimeDir, waitForHandover } from './packaged-service.js';

const home = process.env.TIMON_HOME;
if (!home) throw new Error('TIMON_HOME is required');
try {
  const handover = JSON.parse(await readFile(join(runtimeDir(home), 'handover.json'), 'utf8')) as { pid: number; token: string };
  if (!Number.isSafeInteger(handover.pid) || handover.pid <= 0) throw new Error('Invalid handover PID');
  await waitForHandover(handover);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
await import('../boot.js');

if (process.platform === 'linux') {
  // Never fatal: a daemon that cannot watch its package still serves its data.
  try {
    const { spawnSync } = await import('node:child_process');
    const { inspectInstalledPackage, startReleaseHandback } = await import('./packaged-handback.js');
    startReleaseHandback({
      platform: process.platform,
      home,
      ownVersion: process.env.TIMON_DESKTOP_VERSION ?? 'current',
      ownExecutable: process.execPath,
      ownInstallDir: process.env.TIMON_INSTALL_DIR ?? '',
      env: process.env,
      inspect: inspectInstalledPackage,
      run: (command, args) => {
        const result = spawnSync(command, args, { encoding: 'utf8', timeout: 15_000 });
        return { code: result.status ?? 1, stderr: result.stderr || result.error?.message || '' };
      },
      log: (message) => console.log(message),
      now: Date.now,
    });
  } catch (error) {
    console.warn('[desktop-runtime] cannot watch the installed package', error);
  }
}
