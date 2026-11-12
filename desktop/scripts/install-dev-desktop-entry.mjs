#!/usr/bin/env node
/**
 * Linux only: a launcher for the desktop shell run from the sources, so that
 * the dock (GNOME, KDE) shows Rooks with "New Window" on a right-click, as
 * an installed package does (01/11/2026).
 *
 *   node scripts/install-dev-desktop-entry.mjs            # write the entry
 *   node scripts/install-dev-desktop-entry.mjs --remove   # take it away
 *   node scripts/install-dev-desktop-entry.mjs --print    # show it, write nothing
 *
 * The entry lands in `$XDG_DATA_HOME/applications/rooks-dev.desktop`
 * (`~/.local/share/applications` by default). It starts this checkout's
 * `dist/main.js` (build it first: `npm run build`) with this checkout's
 * Electron, from `desktop/`, as `npm start` does. Its StartupWMClass is the
 * class a shell run from the sources takes on Linux (`src/linux-desktop.ts`),
 * never an installed Rooks's: the two icons stay apart.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Copy of `DEV_DESKTOP_ID` (`src/linux-desktop.ts`); `install-dev-desktop-entry.test.mjs` compares both. */
export const DEV_DESKTOP_ID = 'rooks-dev';
/** Copy of `NEW_WINDOW_FLAG` (`src/linux-desktop.ts`), compared by the same test. */
export const NEW_WINDOW_FLAG = '--new-window';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * One argument of an `Exec` line (Desktop Entry Specification, "The Exec
 * key"): quoted when it holds anything but plain path characters, with `"`,
 * `` ` ``, `$` and `\` escaped inside the quotes, and `%` doubled.
 */
export function execArgument(arg) {
  const percent = arg.replaceAll('%', '%%');
  if (/^[A-Za-z0-9_\/.+,:=@-]+$/.test(percent)) return percent;
  return `"${percent.replace(/(["`$\\])/g, '\\$1')}"`;
}

/** Where the entry goes: `$XDG_DATA_HOME/applications`, `~/.local/share/applications` when unset or relative. */
export function entryPath(env = process.env, home = homedir()) {
  const dataHome = env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : join(home, '.local', 'share');
  return join(dataHome, 'applications', `${DEV_DESKTOP_ID}.desktop`);
}

/** The entry's text, for an Electron binary, a main script, a working directory and an icon. */
export function devDesktopEntry({ electron, main, cwd, icon }) {
  const run = [electron, main].map(execArgument).join(' ');
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Rooks (dev)',
    'Comment=Rooks desktop shell run from the sources',
    `Exec=${run} %U`,
    `Path=${cwd}`,
    `Icon=${icon}`,
    'Terminal=false',
    'Categories=Development;',
    `StartupWMClass=${DEV_DESKTOP_ID}`,
    'Actions=new-window;',
    '',
    '[Desktop Action new-window]',
    'Name=New Window',
    // french-ok: the French name of the desktop action
    'Name[fr]=Nouvelle fenêtre',
    `Exec=${run} ${NEW_WINDOW_FLAG}`,
    '',
  ].join('\n');
}

function main(argv) {
  if (process.platform !== 'linux') {
    console.error('install-dev-desktop-entry: Linux only. Windows gets "New window" from the jump list of an installed Rooks, macOS from the Dock menu.');
    return 1;
  }
  const target = entryPath();
  if (argv.includes('--remove')) {
    rmSync(target, { force: true });
    console.log(`Removed ${target}`);
    return 0;
  }
  const require = createRequire(import.meta.url);
  // The `electron` package exports the path of its binary.
  const electron = require('electron');
  const mainScript = join(desktopRoot, 'dist', 'main.js');
  const entry = devDesktopEntry({
    electron,
    main: mainScript,
    cwd: desktopRoot,
    icon: join(desktopRoot, '..', 'app', 'public', 'icon-dev-512.png'),
  });
  if (argv.includes('--print')) {
    process.stdout.write(entry);
    return 0;
  }
  if (!existsSync(mainScript)) console.warn(`Warning: ${mainScript} does not exist yet: run \`npm run build\` in desktop/ before launching.`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, entry, { mode: 0o644 });
  console.log(`Wrote ${target}`);
  console.log('Launch "Rooks (dev)" from the app grid, pin it to the dock, then right-click it: "New Window".');
  console.log('A Rooks already running from a terminal keeps the class it started with: quit it first.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
