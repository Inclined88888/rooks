/**
 * TIM-0019 — the tray item showed an empty slot on every OS: `buildTray` handed
 * Electron `nativeImage.createEmpty()`, a placeholder that was never replaced.
 * The menu worked, so nothing failed loudly; only the icon was invisible.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveTrayIcon, trayIconDirOf, trayIconFileOf, TRAY_FALLBACK_SIZE } from './tray-icon.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const appIcon = join('res', 'app', 'public', 'icon-512.png');

test('each OS gets the icon format its tray expects', () => {
  assert.deepEqual(trayIconFileOf('win32'), { file: 'tray.ico', template: false });
  // The `Template` suffix is what lets macOS recolour the icon for a light or dark menu bar.
  assert.deepEqual(trayIconFileOf('darwin'), { file: 'trayTemplate.png', template: true });
  assert.deepEqual(trayIconFileOf('linux'), { file: 'tray.png', template: false });
  assert.deepEqual(trayIconFileOf('freebsd'), { file: 'tray.png', template: false });
});

test('the icons live in resources once packaged, in the repo during development', () => {
  const moduleDir = join('repo', 'desktop', 'dist');
  assert.equal(
    trayIconDirOf({ isPackaged: true, resourcesPath: 'res', moduleDir }),
    join('res', 'tray'),
  );
  assert.equal(
    trayIconDirOf({ isPackaged: false, resourcesPath: 'res', moduleDir }),
    join('repo', 'desktop', 'assets', 'tray'),
  );
});

test('the shipped icon file is used when present', () => {
  const dir = join('res', 'tray');
  const choice = resolveTrayIcon({ platform: 'darwin', dir, appIconPath: appIcon, exists: () => true });
  assert.deepEqual(choice, { path: join(dir, 'trayTemplate.png'), template: true, fallback: null });
});

test('a missing tray file falls back to the resized app icon, never to nothing', () => {
  for (const platform of ['win32', 'darwin', 'linux'] as const) {
    const choice = resolveTrayIcon({
      platform,
      dir: join('res', 'tray'),
      appIconPath: appIcon,
      exists: (p) => p === appIcon,
    });
    assert.equal(choice.path, appIcon);
    // The app icon is in colour: flagging it as a template would turn it into a black square.
    assert.equal(choice.template, false);
    assert.deepEqual(choice.fallback, { size: TRAY_FALLBACK_SIZE[platform] });
  }
});

test('every icon the resolver can pick is committed', () => {
  const dir = join(root, 'assets', 'tray');
  for (const file of ['tray.ico', 'tray.png', 'tray@2x.png', 'trayTemplate.png', 'trayTemplate@2x.png']) {
    assert.ok(existsSync(join(dir, file)), `${file} missing from assets/tray`);
  }
});

test('the tray icons travel with the package', () => {
  const yml = readFileSync(join(root, 'electron-builder.yml'), 'utf8');
  assert.match(yml, /from: assets\/tray\s+to: tray/);
});

test('the tray is never built on an empty image again', () => {
  const main = readFileSync(join(root, 'src', 'main.ts'), 'utf8');
  assert.ok(!/new Tray\(nativeImage\.createEmpty\(\)\)/.test(main), 'buildTray still uses an empty image');
  assert.match(main, /loadTrayIcon\(/);
});

test('missing or unreadable tray images warn and use the resized app artwork', async () => {
  const { loadTrayIcon } = await import('./tray-icon.js');
  for (const exists of [false, true]) {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      const loaded: string[] = [];
      const warnings: string[] = [];
      let resized = 0;
      const good = {
        isEmpty: () => false,
        resize: ({ width }: { width: number; height: number }) => { resized = width; return good; },
        setTemplateImage: () => { assert.fail('colour fallback must not be a template'); },
      };
      const image = loadTrayIcon({ platform, dir: 'tray', appIconPath: appIcon, exists: () => exists }, {
        createFromPath: (path) => {
          loaded.push(path);
          return path === appIcon ? good : { ...good, isEmpty: () => true };
        },
        warn: (message) => { warnings.push(message); },
      });
      assert.equal(image, good);
      assert.equal(resized, TRAY_FALLBACK_SIZE[platform]);
      assert.equal(loaded.length, exists ? 2 : 1);
      assert.equal(warnings.length, 1);
    }
  }
});

test('valid templates are marked, and a broken app fallback never reaches Tray', async () => {
  const { loadTrayIcon } = await import('./tray-icon.js');
  let template = false;
  const good = {
    isEmpty: () => false,
    resize: () => good,
    setTemplateImage: (value: boolean) => { template = value; },
  };
  loadTrayIcon({ platform: 'darwin', dir: 'tray', appIconPath: appIcon, exists: () => true }, {
    createFromPath: () => good, warn: () => assert.fail('unexpected fallback'),
  });
  assert.equal(template, true);
  assert.throws(() => loadTrayIcon({ platform: 'linux', dir: 'tray', appIconPath: appIcon, exists: () => false }, {
    createFromPath: () => ({ ...good, isEmpty: () => true }), warn: () => {},
  }), /app icon.*missing or unreadable/);
});
