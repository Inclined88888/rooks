/**
 * The Copilot card's Install / Update line on macOS and Linux (TODO #789), RUN rather than read.
 * It lives outside `src/`: it checks a provider's manifest against the daemon, it is not daemon code.
 *
 * Three checks, each against the daemon's own search (`binaryCandidates` / `findExecutableBinary`)
 * given the same home and environment:
 * - the PATH the line builds, once per OS (a stand-in `uname` answers Darwin or Linux), is that
 *   search's folder order: no folder of the other OS, nvm folders in the daemon's order;
 * - stand-in CLIs in one or two places: the line runs `copilot update` on the copy the daemon
 *   selects, and never the vendor's script;
 * - what the line cannot do, kept as `todo` cases (TODO #799): an nvm folder with a SemVer
 *   pre-release (`v21.0.0-rc.1`) or build metadata. The daemon accepts and ranks those (SemVer
 *   §11); doing the same in sh takes ~830 characters, the manifest allows 500.
 *
 * Skipped when a real `copilot` sits in one of the fixed system folders the line appends to PATH:
 * the line would find it first and run a real update on this machine.
 */
import '../src/test-home.js';
import './helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

const { installBackendPlanFor } = await import('../src/host/machine.js');
const { binaryCandidates, findExecutableBinary } = await import('../src/host/binary-path.js');
const { runInstallBackend } = await import('../src/onboarding.js');

const posix = process.platform === 'darwin' || process.platform === 'linux';
// portability: macOS and Linux system folders, the ones the line itself appends (the test is posix-only)
const SYSTEM_DIRS = ['/usr/bin', '/bin', '/usr/local/bin', '/opt/homebrew/bin', '/home/linuxbrew/.linuxbrew/bin'];
const realCopy = posix ? SYSTEM_DIRS.map((dir) => join(dir, 'copilot')).find((file) => existsSync(file)) : undefined;
const skip = !posix ? 'macOS and Linux only' : realCopy ? `a real copilot is installed at ${realCopy}` : false;

// portability: the shells the line is pasted into or run by (`/bin/sh -c`), posix-only test
const SHELL_CANDIDATES = ['/bin/sh', '/bin/bash', '/bin/zsh', '/usr/bin/zsh'];
const shells = posix
  ? [...new Map(SHELL_CANDIDATES.filter((sh) => existsSync(sh)).map((sh) => [realpathSync(sh), sh])).values()]
  : [];

const line = (platform: NodeJS.Platform) => installBackendPlanFor('copilot', platform)!;

function stub(dir: string, name: string, body: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

/** A stand-in `copilot` that logs where it was started from and its arguments. */
function copilotAt(dir: string): string {
  return stub(dir, 'copilot', 'printf \'%s %s\\n\' "$0" "$*" >> "$LOG"\nexit "${COPILOT_EXIT:-0}"');
}

type Sandbox = { root: string; home: string; stubs: string; log: string; pathLog: string };

function sandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'rooks-copilot-line-'));
  const home = join(root, 'home');
  mkdirSync(home);
  const stubs = join(root, 'stubs');
  const pathLog = join(root, 'path');
  // Records the script branch and the PATH the line built, and prints nothing, so the `| bash`
  // after it runs an empty script.
  stub(stubs, 'curl', `printf 'curl %s\\n' "$*" >> "$LOG"\nprintf '%s' "$PATH" > '${pathLog}'`);
  return { root, home, stubs, log: join(root, 'log'), pathLog };
}

/** nvm's `versions/node` under `root`, one folder per name. */
function nvmFolders(root: string, names: string[]): string {
  const versions = join(root, 'versions', 'node');
  for (const name of names) mkdirSync(join(versions, name, 'bin'), { recursive: true });
  return versions;
}

type Extra = { path?: string[]; env?: Record<string, string>; uname?: 'Darwin' | 'Linux' };

/** Runs the card's line as the install job does, with nothing of this machine's environment. */
function runLine(shell: string, box: Sandbox, extra: Extra = {}) {
  const platform: NodeJS.Platform = extra.uname === 'Darwin' ? 'darwin' : extra.uname === 'Linux' ? 'linux' : process.platform;
  const head = [box.stubs];
  if (extra.uname) head.unshift(dirname(stub(join(box.root, 'uname'), 'uname', `echo ${extra.uname}`)));
  const env = {
    HOME: box.home,
    LOG: box.log,
    PATH: [...head, ...(extra.path ?? []), '/usr/bin', '/bin'].join(delimiter),
    ...extra.env,
  };
  const result = spawnSync(shell, ['-c', line(platform).display], { env, encoding: 'utf8', timeout: 20_000 });
  const log = existsSync(box.log) ? readFileSync(box.log, 'utf8').trim().split('\n') : [];
  const options = { platform, homeDir: box.home, env, path: env.PATH };
  return {
    status: result.status,
    stderr: result.stderr,
    log,
    // What the daemon selects for the card, and the folders it searches, in order.
    selected: findExecutableBinary('copilot', options),
    searched: [...new Set(binaryCandidates('copilot', options).map((file) => dirname(file)))],
    // The PATH the line ends with, read the way the shell does (first occurrence wins).
    built: existsSync(box.pathLog) ? [...new Set(readFileSync(box.pathLog, 'utf8').split(':').filter(Boolean))] : null,
  };
}

test('the line: /bin/sh -c, if/then/else (a failed update never falls through to the script), within the manifest cap', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    const plan = line(platform);
    assert.deepEqual(plan.argv.slice(0, 2), ['/bin/sh', '-c']);
    assert.match(plan.display, /;if command -v copilot>\/dev\/null;then copilot update;else curl -fsSL https:\/\/gh\.io\/copilot-install\|bash;fi$/);
    assert.ok(!/&&|\|\|/.test(plan.display), plan.display);
    assert.ok(plan.display.length <= 500, `${plan.display.length} characters`);
  }
});

test('a failed Copilot update on macOS or Linux is a failed job, though the CLI is still found (TODO #789)', async () => {
  // `copilot update` cannot replace a binary in a folder the account does not own (a sudo install
  // in /usr/local/bin, a root-owned npm prefix): it exits 1, the old copy stays where Rooks looks.
  const calls: string[][] = [];
  const failed = await runInstallBackend('copilot', 'darwin', async (command, args) => {
    calls.push([command, ...args]);
    return { code: 1, stdout: '', stderr: 'Copilot CLI version 1.0.105 downloaded, but the executable was not replaced: Error: EACCES: permission denied' };
  }, () => '/usr/local/bin/copilot');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]![0], '/bin/sh');
  assert.match(calls[0]!.at(-1) ?? '', /then copilot update;else curl /);
  assert.equal(failed.ok, false);
  assert.match(failed.reason ?? '', /EACCES: permission denied \(exit 1\)/);
});

// SemVer folders the line ranks like the daemon, and folders both ignore (leading zero, not SemVer).
const NVM_RELEASES = ['v9.0.0', 'v18.9.0', 'v18.10.0', '20.1.0', 'v01.2.3', 'v99'];

for (const shell of shells) {
  for (const uname of ['Darwin', 'Linux'] as const) {
    test(`copilot update line (${shell}, ${uname}): the PATH it builds is the daemon's search order, no folder of the other OS`, { skip }, () => {
      const box = sandbox();
      const nvm = join(box.root, 'nvm');
      nvmFolders(nvm, NVM_RELEASES);
      const extra = join(box.root, 'npm-prefix', 'bin');
      const run = runLine(shell, box, { uname, path: [extra], env: { NVM_DIR: nvm } });
      assert.equal(run.status, 0, run.stderr);
      assert.deepEqual(run.log, ['curl -fsSL https://gh.io/copilot-install'], 'no CLI anywhere: the script');
      assert.deepEqual(run.built, run.searched);
      // portability: the other OS's Homebrew folder, named to check it is absent
      const foreign = uname === 'Darwin' ? '/home/linuxbrew/.linuxbrew/bin' : '/opt/homebrew/bin';
      assert.ok(!run.built!.includes(foreign), `${foreign} is not searched on ${uname}`);
    });
  }

  type Layout = { name: string; arrange: (box: Sandbox) => { expected: string } & Extra };

  const LAYOUTS: Layout[] = [
    {
      name: 'npm under nvm, default ~/.nvm',
      arrange: ({ home }) => ({ expected: copilotAt(join(home, '.nvm', 'versions', 'node', 'v20.11.1', 'bin')) }),
    },
    {
      name: 'npm under nvm with $NVM_DIR, highest version first (v18.10.0 over v18.9.0 and v9.0.0), ~/.nvm unread',
      arrange: ({ root, home }) => {
        const nvm = join(root, 'custom-nvm');
        for (const version of ['v9.0.0', 'v18.9.0']) copilotAt(join(nvm, 'versions', 'node', version, 'bin'));
        // Not SemVer, or a leading zero: neither the daemon nor the line looks there.
        copilotAt(join(nvm, 'versions', 'node', 'v99', 'bin'));
        copilotAt(join(nvm, 'versions', 'node', 'v01.2.3', 'bin'));
        copilotAt(join(home, '.nvm', 'versions', 'node', 'v22.0.0', 'bin'));
        return { expected: copilotAt(join(nvm, 'versions', 'node', 'v18.10.0', 'bin')), env: { NVM_DIR: nvm } };
      },
    },
    {
      name: 'an nvm folder without the v, ranked by its version like the daemon (20.1.0 over v18.10.0)',
      arrange: ({ home }) => {
        copilotAt(join(home, '.nvm', 'versions', 'node', 'v18.10.0', 'bin'));
        return { expected: copilotAt(join(home, '.nvm', 'versions', 'node', '20.1.0', 'bin')) };
      },
    },
    {
      name: 'npm with the ~/.npm-global prefix npm documents',
      arrange: ({ home }) => ({ expected: copilotAt(join(home, '.npm-global', 'bin')) }),
    },
    {
      name: 'npm with a custom prefix on the daemon\'s PATH, over ~/.local/bin',
      arrange: ({ root, home }) => {
        copilotAt(join(home, '.local', 'bin'));
        const bin = join(root, 'npm-prefix', 'bin');
        return { expected: copilotAt(bin), path: [bin] };
      },
    },
    {
      name: 'two copies: ~/.npm-global over nvm',
      arrange: ({ home }) => {
        copilotAt(join(home, '.nvm', 'versions', 'node', 'v20.11.1', 'bin'));
        return { expected: copilotAt(join(home, '.npm-global', 'bin')) };
      },
    },
    {
      name: 'two copies: Volta over ~/.npm-global',
      arrange: ({ home }) => {
        copilotAt(join(home, '.npm-global', 'bin'));
        return { expected: copilotAt(join(home, '.volta', 'bin')) };
      },
    },
    {
      name: 'two copies: the vendor script\'s ~/.local/bin over Volta',
      arrange: ({ home }) => {
        copilotAt(join(home, '.volta', 'bin'));
        return { expected: copilotAt(join(home, '.local', 'bin')) };
      },
    },
  ];

  for (const layout of LAYOUTS) {
    test(`copilot update line (${shell}): ${layout.name} → copilot update on the copy the daemon selects`, { skip }, () => {
      const box = sandbox();
      const { expected, ...extra } = layout.arrange(box);
      const run = runLine(shell, box, extra);
      assert.equal(run.status, 0, run.stderr);
      assert.equal(run.selected, expected, 'the daemon selects the copy this case expects');
      assert.deepEqual(run.log, [`${expected} update`], 'one update, on that copy, and no script');
    });
  }

  // Known gaps of a static line (TODO #799): reported, not failed, until the daemon hands the
  // installer the path it resolved.
  const GAPS: Layout[] = [
    {
      name: 'the only copy in an nvm pre-release folder (v21.0.0-rc.1)',
      arrange: ({ home }) => ({ expected: copilotAt(join(home, '.nvm', 'versions', 'node', 'v21.0.0-rc.1', 'bin')) }),
    },
    {
      name: 'an nvm pre-release (v21.0.0-rc.1) the daemon ranks above a lower release (v20.0.0)',
      arrange: ({ home }) => {
        copilotAt(join(home, '.nvm', 'versions', 'node', 'v20.0.0', 'bin'));
        return { expected: copilotAt(join(home, '.nvm', 'versions', 'node', 'v21.0.0-rc.1', 'bin')) };
      },
    },
    {
      name: 'the only copy in an nvm folder with build metadata (v22.0.0+local)',
      arrange: ({ home }) => ({ expected: copilotAt(join(home, '.nvm', 'versions', 'node', 'v22.0.0+local', 'bin')) }),
    },
  ];

  for (const gap of GAPS) {
    // The premise holds today: the daemon does select that copy. Only the line falls short.
    test(`copilot update line (${shell}): ${gap.name} → the daemon selects it`, { skip }, () => {
      const box = sandbox();
      const { expected, ...extra } = gap.arrange(box);
      assert.equal(runLine(shell, box, extra).selected, expected);
    });
    test(`copilot update line (${shell}): ${gap.name} → copilot update on that copy`, { skip, todo: 'TODO #799: the installer is not given the resolved path' }, () => {
      const box = sandbox();
      const { expected, ...extra } = gap.arrange(box);
      assert.deepEqual(runLine(shell, box, extra).log, [`${expected} update`]);
    });
  }
}
