import { mkdirSync, writeFileSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';

/**
 * Shell launchers belong to the package, so upgrades replace them with the
 * runtime. They run `bin/rooks` on the Node the package ships
 * (`resources/node`), which loads the natives built for it — never a Node
 * from the PATH, nor Electron itself.
 */
export function packagedCliLauncher(platform) {
  if (platform === 'win32') {
    const runtime = win32.join('..', 'resources', 'node', 'node.exe');
    const cli = win32.join('..', 'resources', 'orchestrator', 'bin', 'rooks');
    return ['@echo off', 'setlocal DisableDelayedExpansion',
      `"%~dp0${runtime}" "%~dp0${cli}" %*`, 'exit /b %errorlevel%', ''].join('\r\n');
  }
  const resources = platform === 'darwin' ? 'Resources' : 'resources';
  const runtime = posix.join('..', resources, 'node', 'node');
  const cli = posix.join('..', resources, 'orchestrator', 'bin', 'rooks');
  // Resolve links without GNU readlink -f: macOS ships the BSD implementation.
  return `#!/bin/sh
# Rooks packaged CLI launcher
source_path=$0
while [ -L "$source_path" ]; do
  parent=$(CDPATH= cd -P -- "$(dirname -- "$source_path")" && pwd) || exit 1
  target=$(readlink "$source_path") || exit 1
  case "$target" in
    /*) source_path=$target ;;
    *) source_path="$parent/$target" ;;
  esac
done
launcher_dir=$(CDPATH= cd -P -- "$(dirname -- "$source_path")" && pwd) || exit 1
exec "$launcher_dir/${runtime}" "$launcher_dir/${cli}" "$@"
`;
}

export function writePackagedCli(appDirectory, platform) {
  const directory = join(appDirectory, ...(platform === 'darwin' ? ['Contents'] : []), 'cli');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, platform === 'win32' ? 'rooks.cmd' : 'rooks');
  writeFileSync(file, packagedCliLauncher(platform), { mode: 0o755 });
  return file;
}
