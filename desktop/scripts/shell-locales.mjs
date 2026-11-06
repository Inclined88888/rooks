/**
 * The languages of the shell, shipped with the package (docs/I18N.md).
 *
 * The shell reads `<tag>/meta.json` and `<tag>/desktop.json` from
 * `app/src/locales` when it runs from the sources. A package has no app
 * sources (the app travels as its standalone build), so `prepare:deps`
 * copies those two files of every language to `build-resources/locales`,
 * which `electron-builder.yml` ships as `resources/locales`; `afterPack`
 * fails the pack when a file did not land or differs from this checkout.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SHELL_LOCALES_SOURCE = join(desktopDir, '..', 'app', 'src', 'locales');
export const SHELL_LOCALES_BUILD = join(desktopDir, 'build-resources', 'locales');
const FILES = ['meta.json', 'desktop.json'];

/** `<tag>/meta.json` and `<tag>/desktop.json` of every language under `sourceDir`, as relative paths. */
export function shellLocaleFiles(sourceDir = SHELL_LOCALES_SOURCE) {
  const files = [];
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    // `.generated` and other tool folders are not languages.
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (!existsSync(join(sourceDir, entry.name, 'meta.json'))) continue;
    for (const name of FILES) {
      if (existsSync(join(sourceDir, entry.name, name))) files.push(join(entry.name, name));
    }
  }
  if (!files.includes(join('en', 'desktop.json'))) throw new Error(`${sourceDir} has no en/desktop.json: the shell would show its keys`);
  return files.sort();
}

/** Replaces `targetDir` with the shell's files of every language. */
export function copyShellLocales(sourceDir = SHELL_LOCALES_SOURCE, targetDir = SHELL_LOCALES_BUILD) {
  const files = shellLocaleFiles(sourceDir);
  rmSync(targetDir, { recursive: true, force: true });
  for (const file of files) {
    mkdirSync(dirname(join(targetDir, file)), { recursive: true });
    cpSync(join(sourceDir, file), join(targetDir, file));
  }
  return files;
}

/** Every language file of this checkout is in `resources/locales`, byte for byte. */
export function assertPackagedShellLocales(resources, sourceDir = SHELL_LOCALES_SOURCE) {
  for (const file of shellLocaleFiles(sourceDir)) {
    const shipped = join(resources, 'locales', file);
    if (!existsSync(shipped)) throw new Error(`${shipped} is missing: the extraResources entry of electron-builder.yml did not ship the shell's languages`);
    if (!readFileSync(shipped).equals(readFileSync(join(sourceDir, file)))) {
      throw new Error(`${shipped} is not the one of this checkout: run prepare:deps again`);
    }
  }
}
