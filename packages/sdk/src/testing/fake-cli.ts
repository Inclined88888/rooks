/**
 * A stand-in for the CLI: a real executable that prints a recorded transcript on
 * stdout, so a provider is exercised through a real process, a real pipe and a
 * real exit — the layer a `PassThrough` cannot reproduce (buffering at the
 * pipe's edge, the exit that precedes the last bytes, the shim a Windows
 * installation puts in front of a Node script).
 *
 * The executable is a Node script behind a launcher the OS understands: a
 * `#!/bin/sh` file on POSIX, a `.cmd` shim on Windows. It runs with the Node
 * that runs the tests, so nothing but Node has to be installed.
 *
 * The launchers contain ASCII only and no path: they find the script next to
 * themselves (`%~dp0`, `dirname "$0"`) and Node through an environment variable
 * that `spawn()` sets. `cmd.exe` reads a `.cmd` file in the OEM code page, not in
 * UTF-8, so a literal path with an accent (an accented Windows user name puts one
 * in `%TEMP%`) written into it would not survive; expanding a variable does.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type FakeCliOptions = {
  /** Directory to create the executable in (yours; remove it after the test). */
  readonly dir: string;
  /** File name without extension. Default `fake-cli`. */
  readonly name?: string;
  /** What the CLI prints on stdout, one line each, in order. */
  readonly lines: readonly string[];
  /** Printed on stderr before the lines (a banner, a warning, a sign-in notice). */
  readonly stderr?: string;
  /** Exit code once everything is printed. Default 0. */
  readonly exitCode?: number;
  /** Wait this long between two lines, to exercise a stream that arrives slowly. */
  readonly delayMs?: number;
  /** Do not exit until stdin is closed (a persistent CLI). Default: exit after printing. */
  readonly stayUntilStdinCloses?: boolean;
};

export type FakeCli = {
  /** The file to launch: pass it as the profile's `cmd`. */
  readonly cmd: string;
  /** Spawns it with the given arguments, as the daemon's host adapter would. */
  spawn(args?: readonly string[], env?: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams;
};

/** The variable the launchers read to find Node (set by `FakeCli.spawn`; `node` from the PATH otherwise). */
const NODE_VARIABLE = 'TIMON_FAKE_CLI_NODE';

/** cmd.exe quoting: double quotes around, a doubled quote inside. Not JSON's, which doubles every backslash. */
const winQuote = (value: string): string => `"${value.replace(/"/g, '""')}"`;

export function createFakeCli(options: FakeCliOptions): FakeCli {
  const name = options.name ?? 'fake-cli';
  mkdirSync(options.dir, { recursive: true });
  const script = join(options.dir, `${name}.mjs`);
  writeFileSync(script, [
    `const lines = ${JSON.stringify(options.lines)};`,
    `const delay = ${options.delayMs ?? 0};`,
    `if (${JSON.stringify(options.stderr ?? '')}) process.stderr.write(${JSON.stringify(options.stderr ?? '')});`,
    `const sleep = (ms) => new Promise((r) => setTimeout(r, ms));`,
    `for (const line of lines) { process.stdout.write(line + '\\n'); if (delay) await sleep(delay); }`,
    options.stayUntilStdinCloses
      ? `process.stdin.resume(); await new Promise((r) => process.stdin.on('end', r).on('close', r));`
      : `process.stdin.destroy();`,
    `process.exitCode = ${options.exitCode ?? 0};`,
  ].join('\n'), 'utf8');

  const windows = process.platform === 'win32';
  const cmd = join(options.dir, windows ? `${name}.cmd` : name);
  if (windows) {
    writeFileSync(cmd, [
      '@echo off',
      `if not defined ${NODE_VARIABLE} set "${NODE_VARIABLE}=node"`,
      `"%${NODE_VARIABLE}%" "%~dp0${name}.mjs" %*`,
      '',
    ].join('\r\n'), 'ascii');
  } else {
    writeFileSync(cmd, [
      '#!/bin/sh',
      `exec "\${${NODE_VARIABLE}:-node}" "$(dirname "$0")/${name}.mjs" "$@"`,
      '',
    ].join('\n'), 'ascii');
    chmodSync(cmd, 0o755);
  }

  return {
    cmd,
    spawn(args = [], env) {
      const environment = { ...process.env, ...env, [NODE_VARIABLE]: process.execPath };
      // Node refuses to run a .cmd without a shell since the 2024 fixes: go through cmd.exe, quoted.
      if (windows) {
        return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${[cmd, ...args].map(winQuote).join(' ')}"`], {
          windowsHide: true, windowsVerbatimArguments: true, env: environment,
        });
      }
      return spawn(cmd, [...args], { env: environment });
    },
  };
}
