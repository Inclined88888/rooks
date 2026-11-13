import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DesktopConfig } from './config.js';
import {
  activeReleaseFile,
  clearServiceRefused,
  declineServiceRepair,
  markServiceRefusedNotice,
  packagedReleaseId,
  recordServiceRefused,
  serviceRefusedMessage,
  serviceRefusedNoticeDue,
  serviceRepairDeclinedFile,
  serviceRepairFailureMessage,
  serviceRepairPrompt,
  serviceRepairVerdict,
  serviceRepairWanted,
  serviceUpgradeNeeded,
  upgradeFailureMessage,
  runnerFailureReason,
  upgradeNeedsFallback,
  upgradePackagedService,
} from './upgrade.js';
import { WINDOWS_SERVICE_REVISION, hasDesktopService, windowsLauncher, windowsLegacyLauncher, windowsServiceRefusedFile, windowsServiceRevisionFile } from './service.js';

const cfg: DesktopConfig = {
  home: '/Users/sam/.rooks', packagedDefaults: false,
  daemon: { listen: { host: '127.0.0.1', port: 3010 }, supervisor: 'launchd', heapMb: 4096, installDir: '/old' },
  app: { enabled: true, listen: { host: '127.0.0.1', port: 3110 } },
};

test('un service legacy ou d’une autre version est migré au lancement suivant', () => {
  const home = mkdtempSync(join(tmpdir(), 'rooks-upgrade-'));
  try {
    const facts = { platform: 'darwin' as NodeJS.Platform, packaged: true, serviceInstalled: true };
    assert.equal(serviceUpgradeNeeded(home, '0.1.1', facts), true);
    mkdirSync(join(home, 'desktop-runtime'), { recursive: true });
    writeFileSync(activeReleaseFile(home), `${packagedReleaseId('0.1.0')}\n`);
    assert.equal(serviceUpgradeNeeded(home, '0.1.1', facts), true);
    writeFileSync(activeReleaseFile(home), `${packagedReleaseId('0.1.1')}\n`);
    assert.equal(serviceUpgradeNeeded(home, '0.1.1', facts), false);
    assert.equal(serviceUpgradeNeeded(home, '0.1.1', { ...facts, packaged: false }), false);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('une version plus ancienne réinstallée reprend aussi le service (retour arrière)', () => {
  const home = mkdtempSync(join(tmpdir(), 'rooks-downgrade-'));
  try {
    mkdirSync(join(home, 'desktop-runtime'), { recursive: true });
    for (const platform of ['darwin', 'linux'] as NodeJS.Platform[]) {
      const facts = { platform, packaged: true, serviceInstalled: true };
      // The service runs 0.1.2; the tester reinstalled 0.1.1.
      writeFileSync(activeReleaseFile(home), `${packagedReleaseId('0.1.2')}\n`);
      assert.equal(serviceUpgradeNeeded(home, '0.1.1', facts), true, `${platform} back to 0.1.1`);
      writeFileSync(activeReleaseFile(home), `${packagedReleaseId('0.1.1')}\n`);
      assert.equal(serviceUpgradeNeeded(home, '0.1.2', facts), true, `${platform} forward again to 0.1.2`);
      assert.equal(serviceUpgradeNeeded(home, '0.1.1', facts), false, `${platform} already back on 0.1.1`);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("l'upgrade exécute uniquement le runner livré par la nouvelle app", async () => {
  const root = mkdtempSync(join(tmpdir(), 'rooks-upgrade-runner-'));
  try {
    const resourcesPath = join(root, 'Resources');
    const runner = join(resourcesPath, 'orchestrator', 'dist', 'host', 'packaged-upgrade-runner.js');
    mkdirSync(join(resourcesPath, 'orchestrator', 'dist', 'host'), { recursive: true });
    writeFileSync(runner, '');
    const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    await upgradePackagedService(cfg, { execPath: '/Applications/Rooks.app/Contents/MacOS/Rooks', resourcesPath, version: '0.1.1' }, async (command, args, options) => {
      calls.push({ command, args, env: options.env });
      return { stdout: '', stderr: '' };
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.command, '/Applications/Rooks.app/Contents/MacOS/Rooks');
    assert.deepEqual(calls[0]?.args, [runner]);
    assert.equal(calls[0]?.env['ELECTRON_RUN_AS_NODE'], '1');
    assert.equal(calls[0]?.env['ROOKS_DESKTOP_VERSION'], '0.1.1');
    assert.equal(calls[0]?.env['ROOKS_INSTALL_DIR'], join(resourcesPath, 'orchestrator'));
    assert.equal(calls[0]?.env['ROOKS_HOME'], cfg.home);
    assert.equal(calls[0]?.env['ROOKS_DESKTOP_UPGRADE'], '1');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('macOS et Linux migrent une release packagée ; le mode portable et le dev jamais', () => {
  const home = mkdtempSync(join(tmpdir(), 'rooks-upgrade-matrix-'));
  try {
    for (const platform of ['darwin', 'linux', 'win32'] as NodeJS.Platform[]) {
      // Windows runs INSTDIR, not a staged copy: guarded by the onboarding test
      // "windows packagé : le service lance le dossier d'installation…". Its
      // task revision is covered by the next test.
      const staged = platform !== 'win32';
      for (const packaged of [true, false]) {
        for (const serviceInstalled of [true, false]) {
          rmSync(join(home, 'desktop-runtime'), { recursive: true, force: true });
          const facts = { platform, packaged, serviceInstalled };
          const expected = staged && packaged && serviceInstalled;
          assert.equal(serviceUpgradeNeeded(home, '0.2.0', facts), expected, `${platform} packaged=${packaged} service=${serviceInstalled}, no active-release`);
          mkdirSync(join(home, 'desktop-runtime'), { recursive: true });
          writeFileSync(activeReleaseFile(home), `${packagedReleaseId('0.1.0')}\n`);
          assert.equal(serviceUpgradeNeeded(home, '0.2.0', facts), expected, `${platform} packaged=${packaged} service=${serviceInstalled}, previous release`);
          writeFileSync(activeReleaseFile(home), packagedReleaseId('0.2.0'));
          assert.equal(serviceUpgradeNeeded(home, '0.2.0', facts), false, `${platform} already on this release`);
        }
      }
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

/**
 * Windows: an update replaces the files, never the registered task. The logon
 * task of revision 1 died at logoff and recorded no revision; it is rewritten
 * once, and never is a task installed where there was none.
 */
test('windows : la tâche est réécrite tant que sa révision n’est pas la courante', () => {
  const home = mkdtempSync(join(tmpdir(), 'rooks-upgrade-windows-'));
  try {
    const facts = { platform: 'win32' as NodeJS.Platform, packaged: true, serviceInstalled: false };
    assert.equal(serviceUpgradeNeeded(home, '0.2.0', facts), false, 'no task, nothing to migrate');
    mkdirSync(join(home, 'run'), { recursive: true });
    writeFileSync(windowsLegacyLauncher(home), "' revision 1");
    assert.equal(serviceUpgradeNeeded(home, '0.2.0', facts), true, 'revision 1');
    assert.equal(serviceUpgradeNeeded(home, '0.2.0', { ...facts, packaged: false }), false, 'dev and portable: never');
    writeFileSync(windowsServiceRevisionFile(home), '1\n');
    assert.equal(serviceUpgradeNeeded(home, '0.2.0', facts), true, 'an older recorded revision');
    writeFileSync(windowsServiceRevisionFile(home), `${WINDOWS_SERVICE_REVISION}\n`);
    assert.equal(serviceUpgradeNeeded(home, '0.2.0', facts), false, 'already migrated');
    writeFileSync(windowsServiceRevisionFile(home), '3\n');
    assert.equal(serviceUpgradeNeeded(home, '0.2.0', facts), true, 'revision 3: the task has no SID yet (TODO #564)');
    assert.equal(serviceUpgradeNeeded(home, '0.2.0', { ...facts, packaged: false }), false, 'revision 3, dev and portable: never');
    writeFileSync(windowsServiceRevisionFile(home), 'restored\n');
    assert.equal(serviceUpgradeNeeded(home, '0.2.0', facts), true, 'a rollback put an older task back: try again');
    assert.equal(hasDesktopService(home, 'win32'), true, 'and that task is still there');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

/**
 * TIM-0087: `rooks service install` from the CLI of 0.1.3 and earlier recorded
 * revision 3 with a launcher that does not mark its daemon as packaged. The
 * revision alone never had it rewritten.
 */
test('windows : une tâche à jour dont le lanceur n’est pas marqué packagé est réécrite', () => {
  const home = mkdtempSync(join(tmpdir(), 'rooks-upgrade-unmarked-'));
  const launcher = (marked: boolean) => ['@echo off', 'chcp 65001 >nul', 'set "ROOKS_HOME=C:\\Users\\sam\\.rooks"',
    ...(marked ? ['set "ROOKS_DESKTOP_SERVICE=1"', 'set "ROOKS_DESKTOP_EMBEDDED=0"'] : []), 'set "PORT=3010"', ''].join('\r\n');
  try {
    const facts = { platform: 'win32' as NodeJS.Platform, packaged: true, serviceInstalled: true };
    mkdirSync(join(home, 'run'), { recursive: true });
    writeFileSync(windowsLauncher(home), launcher(false));
    assert.equal(serviceUpgradeNeeded(home, '0.1.5', facts), false, 'a launcher without a task: never install one');
    writeFileSync(windowsServiceRevisionFile(home), `${WINDOWS_SERVICE_REVISION}\n`);
    assert.equal(serviceUpgradeNeeded(home, '0.1.5', facts), true, 'current revision, unmarked launcher');
    assert.equal(serviceUpgradeNeeded(home, '0.1.5', { ...facts, packaged: false }), false, 'dev and portable: never');
    writeFileSync(windowsLauncher(home), launcher(true));
    assert.equal(serviceUpgradeNeeded(home, '0.1.5', facts), false, 'current revision, marked launcher (CRLF)');
    rmSync(windowsLauncher(home));
    assert.equal(serviceUpgradeNeeded(home, '0.1.5', facts), false, 'current revision, no launcher to judge');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("un échec de migration dit ce qui tourne encore et que les données sont intactes", () => {
  const failure = Object.assign(new Error('Command failed: Rooks runner.js'), {
    code: 1,
    stderr: 'the new release of the service did not answer. The previous service was restored.\n',
  });
  assert.equal(upgradeNeedsFallback(failure), false);
  const { message, detail } = upgradeFailureMessage(failure, '0.2.0', '/home/sam/.rooks', 'en');
  assert.match(message, /0\.2\.0/);
  assert.match(detail, /background service it already had/);
  assert.match(detail, /\/home\/sam\/\.rooks were not modified/);
  assert.match(detail, /did not answer\. The previous service was restored\.$/);
  assert.match(upgradeFailureMessage(new Error('spawn ENOENT'), '0.2.0', '/h', 'en').detail, /spawn ENOENT$/);

  // Exit 2: no service left to boot on, the embedded daemon takes over.
  const orphan = Object.assign(new Error('Command failed'), {
    code: 2,
    stderr: 'There was no previous service definition to restore, so the new one was removed.',
  });
  assert.equal(upgradeNeedsFallback(orphan), true);
  assert.match(upgradeFailureMessage(orphan, '0.2.0', '/h', 'en').detail, /built-in daemon for this session.*were not modified/s);
  assert.match(upgradeFailureMessage(orphan, '0.2.0', '/h', 'fr').detail, /daemon intégré pour cette session.*n’ont pas été modifiés\.\n\nThere was no previous/s);
  assert.equal(upgradeFailureMessage(orphan, '0.2.0', '/h', 'fr').message, 'Le service d’arrière-plan n’a pas pu passer à la version 0.2.0.');
  assert.equal(upgradeNeedsFallback(new Error('spawn ENOENT')), false);
  assert.equal(upgradeNeedsFallback(Object.assign(new Error('x'), { code: 'ETIMEDOUT' })), false);
});

test('an uncaught runner error shows its message, not the minified source line', () => {
  const stderr = [
    'file:///Applications/Rooks.app/Contents/Resources/orchestrator/dist/data-version.js:1',
    `const _0x653e97=_0x3eb8;${'x'.repeat(4000)}`,
    '                                                  ^',
    '',
    'DataUpdatePendingError: Rooks 0.1.1-rc.4 is waiting for update approval.',
    '    at assertDataUpdateApproved (file:///Applications/Rooks.app/dist/data-version.js:1:9)',
    '    at file:///Applications/Rooks.app/dist/db.js:1:42',
    '',
    'Node.js v22.20.0',
  ].join('\n');
  assert.equal(runnerFailureReason(stderr), 'DataUpdatePendingError: Rooks 0.1.1-rc.4 is waiting for update approval.');
  const failure = Object.assign(new Error('Command failed'), { code: 1, stderr });
  assert.match(upgradeFailureMessage(failure, '0.1.1-rc.4', '/h', 'en').detail, /not modified\.\n\nDataUpdatePendingError: [^\n]+$/);
  // The runner's own messages come through unchanged.
  assert.equal(runnerFailureReason('the new release of the service did not answer.\n'), 'the new release of the service did not answer.');
});

test('Windows : une install configurée dont la tâche a disparu propose de la réinstaller', () => {
  const home = mkdtempSync(join(tmpdir(), 'rooks-repair-'));
  try {
    const facts = { platform: 'win32' as NodeJS.Platform, packaged: true, configured: true, taskExists: false };
    assert.equal(serviceRepairWanted(home, '0.1.5', facts), true);
    assert.equal(serviceRepairWanted(home, '0.1.5', { ...facts, taskExists: true }), false, 'task present');
    assert.equal(serviceRepairWanted(home, '0.1.5', { ...facts, configured: false }), false, 'first run: the wizard installs it');
    assert.equal(serviceRepairWanted(home, '0.1.5', { ...facts, packaged: false }), false, 'source checkout');
    for (const platform of ['darwin', 'linux'] as NodeJS.Platform[]) {
      assert.equal(serviceRepairWanted(home, '0.1.5', { ...facts, platform }), false, platform);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('« Plus tard » ne redemande pas pour cette version, la suivante redemande', () => {
  const home = mkdtempSync(join(tmpdir(), 'rooks-repair-'));
  try {
    const facts = { platform: 'win32' as NodeJS.Platform, packaged: true, configured: true, taskExists: false };
    declineServiceRepair(home, '0.1.5');
    assert.equal(serviceRepairDeclinedFile(home), join(home, 'run', 'service-repair-declined'));
    assert.equal(serviceRepairWanted(home, '0.1.5', facts), false);
    assert.equal(serviceRepairWanted(home, '0.1.6', facts), true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

/**
 * TODO #342 : Windows n'a jamais lancé la tâche pour ce compte (poste joint à
 * Entra ID). Le constat est durable : plus d'offre de réinstallation, et le
 * message honnête n'est dit qu'une fois par version.
 */
test('Windows : une tâche jamais lancée n’est plus reproposée, son message est dit une fois par version', () => {
  const home = mkdtempSync(join(tmpdir(), 'rooks-refused-'));
  try {
    const facts = { platform: 'win32' as NodeJS.Platform, packaged: true, configured: true, taskExists: false };
    assert.equal(serviceRepairWanted(home, '0.1.5', facts), true);
    recordServiceRefused(home);
    assert.equal(existsSync(windowsServiceRefusedFile(home)), true);
    assert.equal(serviceRepairWanted(home, '0.1.5', facts), false, 'a task Windows will not run is not offered again');
    recordServiceRefused(home);

    assert.equal(serviceRefusedNoticeDue(home, '0.1.5'), true);
    markServiceRefusedNotice(home, '0.1.5');
    assert.equal(serviceRefusedNoticeDue(home, '0.1.5'), false);
    assert.equal(serviceRefusedNoticeDue(home, '0.1.6'), true);

    const en = serviceRefusedMessage('en-US');
    assert.match(en.detail, /Microsoft Entra ID/);
    assert.match(en.detail, /built-in daemon/);
    assert.match(en.detail, /rooks service uninstall/);
    assert.doesNotMatch(en.message, /does not answer/);
    assert.match(serviceRefusedMessage('fr-FR').message, /Windows ne lance pas/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

/** TODO #342 suite : une tâche qui finit par tourner lève le constat, sinon le setup reste en mode portable. */
test('Windows : une tâche qui démarre efface le marqueur de refus', () => {
  const home = mkdtempSync(join(tmpdir(), 'rooks-refused-'));
  try {
    clearServiceRefused(home);
    recordServiceRefused(home);
    clearServiceRefused(home);
    assert.equal(existsSync(windowsServiceRefusedFile(home)), false);
    const facts = { platform: 'win32' as NodeJS.Platform, packaged: true, configured: true, taskExists: false };
    assert.equal(serviceRepairWanted(home, '0.1.5', facts), true, 'the repair offer speaks again');
  } finally { rmSync(home, { recursive: true, force: true }); }

  // Le démarrage l'efface sur 'started', et seulement là : 'never-ran' l'écrit.
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const neverRan = main.indexOf("service === 'never-ran'");
  const cleared = main.indexOf('clearServiceRefused(cfg.home)');
  assert.ok(neverRan > 0 && cleared > neverRan, 'cleared after the never-ran branch');
  assert.ok(cleared < main.indexOf('waitForHealth(daemonOrigin, SERVICE_BOOT_BUDGET_MS)', neverRan), 'in the started branch');
  assert.equal(main.indexOf('clearServiceRefused(cfg.home)', cleared + 1), -1);
});

test('offre de réparation et échec : textes localisés, raison du runner sans pile', () => {
  assert.deepEqual(serviceRepairPrompt('fr-FR').buttons, ['Réinstaller le service', 'Plus tard']);
  assert.deepEqual(serviceRepairPrompt('en-US').buttons, ['Reinstall the service', 'Not now']);
  const error = Object.assign(new Error('Command failed'), {
    stderr: 'Error: elevation refused\n    at run (file:///x.js:1:1)\nNode.js v24.19.0',
  });
  const failure = serviceRepairFailureMessage(error, 'C:\\Users\\sam\\.rooks', 'en');
  assert.match(failure.detail, /built-in daemon for this session/);
  assert.match(failure.detail, /Error: elevation refused$/);
  assert.doesNotMatch(failure.detail, /\bat run\b/);
});

test('TIM-0108: the repair verdict says why the offer stays silent', t => {
  const home = mkdtempSync(join(tmpdir(), 'rooks-verdict-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, 'run'), { recursive: true });
  const facts = { platform: 'win32' as const, packaged: true, configured: true, taskExists: false };
  assert.equal(serviceRepairVerdict(home, '0.1.5', facts), 'wanted');
  assert.equal(serviceRepairVerdict(home, '0.1.5', { ...facts, taskExists: true }), 'task-exists');
  assert.equal(serviceRepairVerdict(home, '0.1.5', { ...facts, configured: false }), 'not-configured');
  assert.equal(serviceRepairVerdict(home, '0.1.5', { ...facts, packaged: false }), 'not-applicable');
  declineServiceRepair(home, '0.1.5');
  assert.equal(serviceRepairVerdict(home, '0.1.5', facts), 'declined');
  recordServiceRefused(home);
  assert.equal(serviceRepairVerdict(home, '0.1.5', facts), 'refused');
});
