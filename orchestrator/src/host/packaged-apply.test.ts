import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyDecision, applyLogFile, applyServiceUpdate, runnerLaunch, runUpgradeRunner, serviceLag, serviceLagMessage,
  type ApplyFacts, type RunnerInput, type RunnerLaunch,
} from './packaged-apply.js';
import { instanceId, packagedReleaseId } from './packaged-service.js';

const facts = (over: Partial<ApplyFacts> = {}): ApplyFacts => ({
  platform: 'linux', packaged: true, cliVersion: '0.1.6', daemonVersion: '0.1.4',
  activeRelease: packagedReleaseId('0.1.4'), serviceInstalled: true, ...over,
});

const input = (over: Partial<RunnerInput> = {}): RunnerInput => ({
  platform: 'linux', home: join(tmpdir(), 'rooks-apply-home'), cliVersion: '0.1.6',
  execPath: join('/opt', 'Rooks', 'rooks'), installDir: join('/opt', 'Rooks', 'resources', 'orchestrator'),
  daemonPort: 3010, appEnabled: true, appPort: 3110, path: '/usr/bin', now: 42, ...over,
});

test('a packaged CLI newer than its daemon reports the lag and the command to run', () => {
  const lag = serviceLag({ platform: 'linux', packaged: true, cliVersion: '0.1.6', daemonVersion: '0.1.4' });
  assert.deepEqual(lag, { version: '0.1.6', serviceOutdated: true, command: 'rooks update apply' });
  assert.match(serviceLagMessage(lag!, '0.1.4'), /still runs 0\.1\.4.*`rooks update apply`.*`rooks update approve 0\.1\.6`/);
  assert.ok(serviceLag({ platform: 'darwin', packaged: true, cliVersion: '0.1.6', daemonVersion: '0.1.4' }));
});

test('no lag from the sources, on Windows, for the same or an older package, or without a version', () => {
  const base = { platform: 'linux' as const, packaged: true, cliVersion: '0.1.6', daemonVersion: '0.1.4' as unknown };
  assert.equal(serviceLag({ ...base, packaged: false }), null);
  assert.equal(serviceLag({ ...base, platform: 'win32' }), null);
  assert.equal(serviceLag({ ...base, daemonVersion: '0.1.6' }), null);
  assert.equal(serviceLag({ ...base, daemonVersion: '0.1.7' }), null);
  assert.equal(serviceLag({ ...base, daemonVersion: undefined }), null);
});

test('apply runs for a service left on the previous release, or whose daemon does not answer', () => {
  assert.deepEqual(applyDecision(facts()), { run: true });
  assert.deepEqual(applyDecision(facts({ daemonVersion: null })), { run: true });
  // An earlier `service install` marked the new release without restarting the daemon.
  assert.deepEqual(applyDecision(facts({ activeRelease: packagedReleaseId('0.1.6') })), { run: true });
  assert.deepEqual(applyDecision(facts({ platform: 'darwin' })), { run: true });
});

test('apply refuses what it cannot or must not move', () => {
  const refusal = (over: Partial<ApplyFacts>) => {
    const decision = applyDecision(facts(over));
    assert.equal(decision.run, false);
    return decision as { run: false; code: number; message: string };
  };
  assert.equal(refusal({ packaged: false }).code, 1);
  assert.match(refusal({ serviceInstalled: false }).message, /rooks service install/);
  assert.match(refusal({ daemonVersion: '0.1.7' }).message, /newer than this package/);
  assert.equal(applyDecision(facts({ daemonVersion: '0.1.7', allowOlder: true })).run, true);
  const done = refusal({ daemonVersion: '0.1.6', activeRelease: packagedReleaseId('0.1.6') });
  assert.equal(done.code, 0);
  assert.match(done.message, /already runs Rooks 0\.1\.6/);
  // Windows: nothing left behind, and nothing broken either.
  const windows = refusal({ platform: 'win32' });
  assert.equal(windows.code, 0);
  assert.match(windows.message, /rooks service start/);
});

test('linux: the runner gets a transient unit of its own, with the desktop upgrade environment', () => {
  const launch = runnerLaunch(input());
  assert.equal(launch.command, 'systemd-run');
  assert.equal(launch.detached, false);
  const home = input().home;
  assert.ok(launch.args.includes('--wait'));
  assert.ok(launch.args.includes(`--unit=rooks-update-${instanceId(home)}-42`));
  assert.ok(launch.args.includes(`--property=StandardOutput=append:${applyLogFile(home)}`));
  for (const env of ['ROOKS_DESKTOP_UPGRADE=1', 'ROOKS_DESKTOP_EMBEDDED=1', 'ROOKS_DESKTOP_SERVICE=0',
    'ROOKS_DESKTOP_VERSION=0.1.6', `ROOKS_HOME=${home}`, 'PORT=3010', 'ROOKS_APP_PORT=3110', 'ROOKS_APP_ENABLED=1',
    'ELECTRON_RUN_AS_NODE=1', 'PATH=/usr/bin']) {
    assert.ok(launch.args.includes(`--setenv=${env}`), env);
  }
  assert.deepEqual(launch.args.slice(-2), [input().execPath, join(input().installDir, 'dist', 'host', 'packaged-upgrade-runner.js')]);
});

test('macOS: the runner is the package executable in a session of its own', () => {
  const launch = runnerLaunch(input({ platform: 'darwin' }));
  assert.equal(launch.command, input().execPath);
  assert.equal(launch.detached, true);
  assert.equal(launch.env.ROOKS_DESKTOP_UPGRADE, '1');
  assert.equal(launch.env.ROOKS_DESKTOP_VERSION, '0.1.6');
});

test('a successful run names the next step; a failed one says the data were left alone', async () => {
  let launched: RunnerLaunch | null = null;
  const ok = await applyServiceUpdate(facts(), input(), async (launch) => {
    launched = launch;
    return { code: 0, output: 'service installed (rooks-desktop-x)\n    at stack\n' };
  });
  assert.ok(launched);
  assert.equal(ok.code, 0);
  assert.deepEqual(ok.lines.slice(0, 1), ['service installed (rooks-desktop-x)']);
  assert.match(ok.lines.join('\n'), /rooks update approve 0\.1\.6/);

  const failed = await applyServiceUpdate(facts(), input(), async () => ({ code: 1, output: 'the new release of the service did not answer. The previous service was restored.\n' }));
  assert.equal(failed.code, 1);
  assert.match(failed.lines.join('\n'), /previous service was restored[\s\S]*were not modified/);

  let ran = false;
  const refused = await applyServiceUpdate(facts({ serviceInstalled: false }), input(), async () => { ran = true; return { code: 0, output: '' }; });
  assert.equal(ran, false);
  assert.equal(refused.code, 1);
});

test('the runner output is read back from its log file', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rooks-apply-'));
  try {
    const launch: RunnerLaunch = {
      command: process.execPath, args: ['-e', 'console.log("moved"); console.error("warned"); process.exitCode = 2'],
      env: process.env, logFile: applyLogFile(home), detached: true,
    };
    const outcome = await runUpgradeRunner(launch);
    assert.equal(outcome.code, 2);
    assert.match(outcome.output, /moved/);
    assert.match(outcome.output, /warned/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('what the launcher itself prints when it refuses is kept', async () => {
  const home = mkdtempSync(join(tmpdir(), 'rooks-apply-'));
  try {
    const outcome = await runUpgradeRunner({
      command: process.execPath, args: ['-e', 'console.error("Unknown assignment"); process.exitCode = 1'],
      env: process.env, logFile: applyLogFile(home), detached: false,
    });
    assert.equal(outcome.code, 1);
    assert.match(outcome.output, /Unknown assignment/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
