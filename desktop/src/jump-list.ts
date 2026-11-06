/**
 * Windows: "New window" in the taskbar's jump list (right-click on Timon,
 * 01/11/2026). The task starts Timon again with `--new-window`; a running
 * shell receives that launch (`second-instance`) and opens one more window,
 * a shell that is not running simply starts.
 *
 * Windows ties a jump list to an AppUserModelID, the one the installer writes
 * on its shortcuts (electron-builder: the `appId`). Electron's own default
 * (`electron.app.<name>`) is not it: the tasks would land on an ID that no
 * taskbar button or pinned shortcut carries. The shell takes the installer's.
 */
import { newWindowCopy } from './app-menu.js';
import { NEW_WINDOW_FLAG } from './linux-desktop.js';

/** Copy of `appId` in `electron-builder.yml`; `packaging.test.ts` compares both. */
export const WINDOWS_APP_USER_MODEL_ID = 'com.timon.desktop';

/**
 * The tasks of a packaged shell, or none: from the sources `execPath` is
 * `electron.exe`, which started alone opens Electron's default app, not Timon.
 */
export function windowsUserTasks(input: { platform: NodeJS.Platform; packaged: boolean; execPath: string; locale: string }): Electron.Task[] | null {
  if (input.platform !== 'win32' || !input.packaged) return null;
  const title = newWindowCopy(input.locale).item;
  return [{
    program: input.execPath,
    arguments: NEW_WINDOW_FLAG,
    title,
    description: title,
    iconPath: input.execPath,
    iconIndex: 0,
  }];
}
