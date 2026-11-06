/** An independent Electron process finishes cleanup after Chromium releases its
 * files, and reports failures visibly instead of silently deleting on quit. */
import { app, dialog } from 'electron';
import { createReadStream, fstatSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { cleanupData, type CleanupCopy, type CleanupPlan } from './uninstall.js';

export type CleanupMessage = { plan: CleanupPlan; copy: CleanupCopy; instructions: string };

export async function runUninstallHelper(): Promise<void> {
  if (process.env.TIMON_UNINSTALL_HELPER !== '1') { app.exit(1); return; }
  const descriptor = fstatSync(3);
  if (!descriptor.isFIFO() && !descriptor.isSocket()) { app.exit(1); return; }
  const control = createReadStream('', { fd: 3, autoClose: true });
  const lines = createInterface({ input: control });
  const send = (message: object) => process.stdout.write(JSON.stringify(message) + '\n');
  const temporary = mkdtempSync(join(tmpdir(), 'timon-uninstall-'));
  app.setPath('userData', temporary);
  // This helper must never acquire the normal instance lock or start a daemon.
  app.on('window-all-closed', () => {});
  let payload: CleanupMessage | undefined;
  let armed = false;
  lines.on('line', line => {
    const message = JSON.parse(line) as CleanupMessage | { action: string };
    if ('plan' in message && !payload) {
      payload = message;
      send({ ready: true });
    } else if ('action' in message && message.action === 'arm' && payload) {
      armed = true;
      send({ armed: true });
    }
  });
  lines.once('close', () => {
    void (async () => {
      if (armed && payload) {
        const { copy } = payload;
        try {
          const leftovers = await cleanupData(payload.plan);
          const leftover = leftovers.length === 0 ? '' : `\n\n${copy.leftover}\n${leftovers.join('\n')}`;
          await dialog.showMessageBox({ type: 'info', title: 'Timon',
            message: copy.done,
            detail: (payload.plan.mode === 'delete' ? copy.deleted : copy.kept)
              + leftover + `\n\n${payload.instructions}`, buttons: ['OK'] });
        } catch (error) {
          dialog.showErrorBox('Timon', `${copy.incomplete}\n\n${(error as Error).message}\n\n${payload.instructions}`);
        }
      }
      // Chromium may still hold helper caches on Windows. They contain no user data.
      await rm(temporary, { recursive: true, force: true }).catch(() => {});
      app.quit();
    })();
  });
  await app.whenReady();
  send({ started: true });
}
