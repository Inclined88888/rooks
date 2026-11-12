import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { homeOfPlist, homeOfTask, homeOfUnit, orphanServices, orphanServiceText } from './orphan-services.js';
import { packagedServiceOptions, packagedUnit } from './packaged-service.js';
import {
  launchDaemonPath, plistPath, renderLaunchDaemonPlist, renderPlist, renderTaskXml, unitPath, type ServiceOpts,
} from './service-install.js';

function base(homeDir: string, rooksHome: string, platform: NodeJS.Platform = 'linux'): ServiceOpts {
  return {
    platform, homeDir, rooksHome, installDir: join(homeDir, 'install'), userName: 't', uid: 501,
    heapMb: 1024, port: 3010, nodePath: process.execPath,
    exec: () => ({ code: 1, stdout: '', stderr: '' }),
  };
}

test('the home is read back from each supervisor definition as it is rendered', () => {
  const home = '/tmp/rooks "rc" 100%';
  const packaged = packagedServiceOptions(base('/home/t', home), '/opt/Rooks/rooks', 3110, '0.1.9-rc.1');
  assert.equal(homeOfUnit(packaged.unitContent!, '/home/t'), home);
  assert.equal(homeOfUnit('[Service]\nEnvironment=ROOKS_HOME=/srv/rooks\n', '/home/t'), '/srv/rooks');
  // The hand-written unit of a source checkout (the build machine's own).
  assert.equal(homeOfUnit('[Service]\nEnvironment=ROOKS_HOME=%h/.rooks\n', '/home/t'), '/home/t/.rooks');
  assert.equal(homeOfUnit('[Service]\nEnvironment=ROOKS_HOME=%t/rooks\n', '/home/t'), null, 'an unresolved specifier is not judged');
  assert.equal(homeOfUnit('[Service]\nEnvironment=PATH=/usr/bin\n', '/home/t'), null);
  assert.equal(homeOfPlist(renderPlist(base('/Users/t', '/var/folders/x/T/a&b'))), '/var/folders/x/T/a&b');
  assert.equal(homeOfPlist(renderLaunchDaemonPlist(base('/Users/t', '/private/tmp/rc'))), '/private/tmp/rc');
  const xml = renderTaskXml({ userName: 't', rooksHome: 'C:\\Users\\t\\AppData\\Local\\Temp\\rc & co', installDir: 'C:\\Rooks' });
  assert.equal(homeOfTask(xml), 'C:\\Users\\t\\AppData\\Local\\Temp\\rc & co');
  assert.equal(homeOfTask('<Task><Actions><Exec><Command>notepad.exe</Command></Exec></Actions></Task>'), null);
});

test('#464: Linux lists the Rooks units whose home is gone, and only those', () => {
  const user = mkdtempSync(join(tmpdir(), 'rooks-orphans-'));
  try {
    const alive = join(user, 'alive-home');
    mkdirSync(alive);
    const gone = join(user, 'deleted-home');
    const dir = join(user, '.config', 'systemd', 'user');
    mkdirSync(dir, { recursive: true });
    const deadUnit = packagedServiceOptions(base(user, gone), '/opt/Rooks/rooks', 3110).unitContent!;
    writeFileSync(unitPath(user, packagedUnit(gone)), deadUnit);
    writeFileSync(unitPath(user, packagedUnit(alive)), packagedServiceOptions(base(user, alive), '/opt/Rooks/rooks', 3110).unitContent!);
    // A source unit without ROOKS_HOME uses the default home: never an orphan.
    writeFileSync(unitPath(user, 'rooks-orchestrator'), '[Service]\nExecStart=/usr/bin/env node dist/index.js\n');
    mkdirSync(join(user, '.rooks-dev'));
    writeFileSync(unitPath(user, 'rooks-dev-orchestrator'), '[Service]\nEnvironment=ROOKS_HOME=%h/.rooks-dev\n');
    writeFileSync(join(dir, 'rooks-1234-missions.slice'), `[Slice]\nEnvironment="ROOKS_HOME=${gone}"\n`);
    writeFileSync(join(dir, 'other.service'), `[Service]\nEnvironment="ROOKS_HOME=${gone}"\n`);

    const found = orphanServices({ platform: 'linux', homeDir: user });
    assert.deepEqual(found.map((orphan) => [orphan.name, orphan.home]), [[packagedUnit(gone), gone]]);
    assert.match(found[0]!.removal, new RegExp(`^systemctl --user disable --now ${packagedUnit(gone)} && rm '`));
    assert.match(orphanServiceText(found[0]!), /no longer exists/);
  } finally {
    rmSync(user, { recursive: true, force: true });
  }
});

test('#464: no systemd directory, nothing to report', () => {
  assert.deepEqual(orphanServices({ platform: 'linux', homeDir: join(tmpdir(), 'rooks-no-such-user-dir') }), []);
});

test('#464: macOS checks both the LaunchDaemon and the LaunchAgent', () => {
  const user = mkdtempSync(join(tmpdir(), 'rooks-orphans-mac-'));
  try {
    const daemons = join(user, 'LaunchDaemons');
    mkdirSync(daemons);
    mkdirSync(join(user, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(launchDaemonPath(daemons), renderLaunchDaemonPlist(base(user, '/var/folders/x/T/gone', 'darwin')));
    writeFileSync(plistPath(user), renderPlist(base(user, user, 'darwin')));
    const found = orphanServices({ platform: 'darwin', homeDir: user, uid: 501, launchDaemonsDir: daemons });
    assert.deepEqual(found.map((orphan) => [orphan.definition, orphan.home]), [[launchDaemonPath(daemons), '/var/folders/x/T/gone']]);
    assert.match(found[0]!.removal, /^sudo launchctl bootout system\/com\.rooks\.daemon/);

    rmSync(launchDaemonPath(daemons));
    writeFileSync(plistPath(user), renderPlist(base(user, '/var/folders/x/T/gone-too', 'darwin')));
    const agent = orphanServices({ platform: 'darwin', homeDir: user, uid: 501, launchDaemonsDir: daemons });
    assert.deepEqual(agent.map((orphan) => orphan.home), ['/var/folders/x/T/gone-too']);
    assert.match(agent[0]!.removal, /^launchctl bootout gui\/501\/com\.rooks\.daemon/);
  } finally {
    rmSync(user, { recursive: true, force: true });
  }
});

test('#464: Windows reads the home from the registered task', () => {
  const dead = 'C:\\Users\\t\\AppData\\Local\\Temp\\rc';
  const xml = renderTaskXml({ userName: 't', rooksHome: dead, installDir: 'C:\\Rooks' });
  const exists = (path: string) => path !== dead;
  const found = orphanServices({ platform: 'win32', homeDir: 'C:\\Users\\t', readWindowsTask: () => xml, exists });
  assert.deepEqual(found.map((orphan) => [orphan.name, orphan.home]), [['RooksOrchestrator', dead]]);
  assert.match(found[0]!.removal, /schtasks \/Delete \/TN RooksOrchestrator \/F/);
  assert.deepEqual(orphanServices({ platform: 'win32', homeDir: 'C:\\Users\\t', readWindowsTask: () => xml, exists: () => true }), []);
  assert.deepEqual(orphanServices({ platform: 'win32', homeDir: 'C:\\Users\\t', readWindowsTask: () => null }), []);
  assert.deepEqual(orphanServices({ platform: 'win32', homeDir: 'C:\\Users\\t', readWindowsTask: () => { throw new Error('no powershell'); } }), []);
});
