import type { MenuItemConstructorOptions } from 'electron';
import { aboutCopy } from './about.js';
import { shellText } from './shell-i18n.js';
import type { ReloadKeyInput } from './reload-shortcuts.js';

/** "New window" (multi-window V3), in the tray and the macOS File menu. */
export function newWindowCopy(locale: string): { item: string } {
  return { item: shellText(locale)('menu.newWindow') };
}

/**
 * Ctrl+Shift+N (Cmd+Shift+N on macOS) opens a new window. Handled on
 * `before-input-event` like the reload keys: the window hides its menu bar on
 * Windows and Linux, so a menu accelerator alone would not be reliable there.
 */
export function newWindowShortcut(input: ReloadKeyInput, platform: NodeJS.Platform): boolean {
  if (input.type !== 'keyDown' || input.alt || !input.shift) return false;
  const command = platform === 'darwin' ? input.meta : input.control;
  return command && input.key.toLowerCase() === 'n';
}

/**
 * The macOS menu bar: Electron's default menus, except the "About" entry
 * (TODO #641). The default one opens the native panel, which cannot carry the
 * licences of the speech models; this one opens Rooks's window. Edit stays: on
 * macOS Cmd+C and Cmd+V only reach a page through its roles.
 *
 * `null` on Windows and Linux: Electron's default menu has no "About" there,
 * so nothing is replaced.
 */
export function appMenuTemplate(input: {
  platform: NodeJS.Platform;
  appName: string;
  locale: string;
  onAbout: () => void;
  /** Absent: the File menu stays Electron's own. */
  onNewWindow?: () => void;
}): MenuItemConstructorOptions[] | null {
  if (input.platform !== 'darwin') return null;
  return [
    {
      label: input.appName,
      submenu: [
        { label: aboutCopy(input.locale).trayItem, click: () => input.onAbout() },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    input.onNewWindow
      ? {
        role: 'fileMenu',
        submenu: [
          // Shown, not registered: the window's own key handler opens it, once.
          { label: newWindowCopy(input.locale).item, accelerator: 'CmdOrCtrl+Shift+N', registerAccelerator: false, click: () => input.onNewWindow?.() },
          { type: 'separator' },
          { role: 'close' },
        ],
      }
      : { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    { role: 'help', submenu: [] },
  ];
}
