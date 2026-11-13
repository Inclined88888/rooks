/**
 * Tray icon resolution (TIM-0019), kept free of Electron so it can be tested.
 *
 * The files come from `assets/tray/` (see `scripts/generate-tray-icons.py`).
 * Each OS wants its own shape: a multi-size `.ico` on Windows, a monochrome
 * template on macOS (recoloured for light and dark menu bars), a 24 px PNG on
 * Linux. `@2x` variants next to the PNGs are picked up by `nativeImage`.
 */
import { join } from 'node:path';

type Platform = NodeJS.Platform;

export interface TrayIconFile {
  file: string;
  /** macOS only: let the system paint the icon from its alpha channel. */
  template: boolean;
}

export interface TrayIconChoice {
  path: string;
  template: boolean;
  /** Set when the dedicated file is missing and the app icon must be resized. */
  fallback: { size: number } | null;
}

/** Edge of the app icon once resized, when the dedicated tray file is missing. */
export const TRAY_FALLBACK_SIZE: Readonly<Record<'win32' | 'darwin' | 'linux', number>> = {
  win32: 16,
  darwin: 18,
  linux: 24,
};

export function trayIconFileOf(platform: Platform): TrayIconFile {
  if (platform === 'win32') return { file: 'tray.ico', template: false };
  // The `Template` suffix alone marks the image as a template when loaded.
  if (platform === 'darwin') return { file: 'trayTemplate.png', template: true };
  return { file: 'tray.png', template: false };
}

export function trayIconDirOf(input: { isPackaged: boolean; resourcesPath: string; moduleDir: string }): string {
  // `extraResources` copies `assets/tray` to `resources/tray`; in development
  // the compiled module sits in `desktop/dist`, next to `desktop/assets`.
  return input.isPackaged
    ? join(input.resourcesPath, 'tray')
    : join(input.moduleDir, '..', 'assets', 'tray');
}

export function resolveTrayIcon(input: {
  platform: Platform;
  dir: string;
  appIconPath: string;
  exists: (path: string) => boolean;
}): TrayIconChoice {
  const { file, template } = trayIconFileOf(input.platform);
  const path = join(input.dir, file);
  if (input.exists(path)) return { path, template, fallback: null };
  const size = input.platform === 'win32' || input.platform === 'darwin'
    ? TRAY_FALLBACK_SIZE[input.platform]
    : TRAY_FALLBACK_SIZE.linux;
  // Never a template: the app icon is in colour and would turn into a solid square.
  return { path: input.appIconPath, template: false, fallback: { size } };
}

interface TrayImage<T> {
  isEmpty(): boolean;
  resize(size: { width: number; height: number }): T;
  setTemplateImage(template: boolean): void;
}

/** Inject decoding so missing and corrupt resources can be tested without Electron. */
export function loadTrayIcon<T extends TrayImage<T>>(
  input: Parameters<typeof resolveTrayIcon>[0],
  images: { createFromPath(path: string): T; warn(message: string): void },
): T {
  const choice = resolveTrayIcon(input);
  const image = images.createFromPath(choice.path);
  if (!choice.fallback && !image.isEmpty()) {
    if (choice.template) image.setTemplateImage(true);
    return image;
  }
  images.warn('[tray] Tray icon missing or unreadable; using the resized app icon.');
  const appImage = choice.fallback ? image : images.createFromPath(input.appIconPath);
  // An incomplete installation must fail visibly instead of creating an invisible tray item.
  if (appImage.isEmpty()) throw new Error('The Rooks app icon is missing or unreadable. Reinstall Rooks.');
  const platform = input.platform === 'win32' || input.platform === 'darwin' ? input.platform : 'linux';
  const size = TRAY_FALLBACK_SIZE[platform];
  return appImage.resize({ width: size, height: size });
}
