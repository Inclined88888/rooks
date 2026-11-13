import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { APP_INFO_CHANNEL } from './app-info.js';
import { ABOUT_CHANNEL } from './about.js';
import { OPEN_LOGS_CHANNEL } from './diagnostic-dialog.js';
import {
  canRestartFromSetup, handoverKeptMessage, handoverRoute, relaunchOptions, serviceHandover, serviceHandoverNeeded, setupRestarter,
  setupRestartPending, SETUP_HANDOVER_CHANNEL, SETUP_RESTART_CHANNEL, SETUP_RESTART_STATUS_CHANNEL,
} from './restart.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDesktopConfig, originOf } from './config.js';

test('only the main Timon window on its own origin can restart after navigation', () => {
  const sender = { isWindow: true, isMainFrame: true, url: 'http://127.0.0.1:4312/setup' };
  const origin = 'http://127.0.0.1:4312';
  assert.equal(canRestartFromSetup(sender, origin), true);
  assert.equal(canRestartFromSetup({ ...sender, url: `${origin}/setup/?from=login` }, origin), true);
  for (const path of ['/setup/team', '/', '/chat?agent=assistant']) {
    assert.equal(canRestartFromSetup({ ...sender, url: origin + path }, origin), true);
  }
  for (const change of [
    { isWindow: false }, { isMainFrame: false },
    { url: 'http://evil.test/setup' }, { url: 'http://127.0.0.1:4313/setup' },
    { url: 'not a URL' }, { url: 'file:///setup' },
  ]) assert.equal(canRestartFromSetup({ ...sender, ...change }, origin), false);
});

test('AppImage relaunch uses the persistent file and literal arguments, not shell interpolation', () => {
  const env = { APPIMAGE: '/tmp/Timon test.AppImage', TIMON_HOME: '/tmp/existing-instance' };
  assert.deepEqual(relaunchOptions('linux', env, ['/tmp/.mount_old/timon', '--no-sandbox']), {
    execPath: env.APPIMAGE, args: ['--no-sandbox'],
  });
  assert.equal(env.TIMON_HOME, '/tmp/existing-instance');
  assert.deepEqual(relaunchOptions('linux', {}, ['/opt/timon/timon']), { args: [] });
  assert.deepEqual(relaunchOptions('darwin', env, ['/Applications/Timon.app']), { args: [] });
  assert.throws(() => relaunchOptions('linux', { APPIMAGE: 'relative.AppImage' }, []), /not absolute/);
});

test('a failed quit cancels the queued native restart', async () => {
  const calls: string[] = [];
  const restart = setupRestarter({
    validate: () => {}, stopEmbedded: async () => {},
    relaunch: async () => { calls.push('queued'); return () => { calls.push('cancelled'); }; },
    quit: () => { throw new Error('quit refused'); },
  });
  await assert.rejects(restart(), /quit refused/);
  assert.deepEqual(calls, ['queued', 'cancelled']);
});

test('restart validates first, waits for the embedded child, and relaunches only once', async () => {
  const calls: string[] = [];
  let exited!: () => void;
  const childExit = new Promise<void>((resolve) => { exited = resolve; });
  const restart = setupRestarter({
    validate: () => { calls.push('validate'); },
    stopEmbedded: async () => { calls.push('stop'); await childExit; calls.push('exited'); },
    relaunch: () => { calls.push('relaunch'); },
    quit: () => { calls.push('quit'); },
  });
  const first = restart();
  assert.equal(first, restart());
  await Promise.resolve();
  assert.deepEqual(calls, ['validate', 'stop']);
  exited();
  await first;
  await restart();
  assert.deepEqual(calls, ['validate', 'stop', 'exited', 'relaunch', 'quit']);
});

test('validation and shutdown failures do not quit and leave a retry available', async () => {
  for (const failure of ['validate', 'stop']) {
    let fail = true;
    const calls: string[] = [];
    const restart = setupRestarter({
      validate: () => { if (failure === 'validate' && fail) throw new Error('missing config'); },
      stopEmbedded: async () => { calls.push('stop'); if (failure === 'stop' && fail) throw new Error('still running'); },
      relaunch: () => { calls.push('relaunch'); }, quit: () => { calls.push('quit'); },
    });
    await assert.rejects(restart());
    assert.equal(calls.includes('quit'), false);
    assert.equal(calls.includes('relaunch'), false);
    if (failure === 'validate') assert.deepEqual(calls, []);
    fail = false;
    await restart();
    assert.deepEqual(calls.slice(-2), ['relaunch', 'quit']);
  }
});

test('the sandbox preload exposes narrow restart, directory and browser presentation capabilities', async () => {
  // Exercise the shipping compiler settings without writing to live dist/.
  const { fileURLToPath } = await import('node:url');
  const configPath = fileURLToPath(new URL('../tsconfig.json', import.meta.url));
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, fileURLToPath(new URL('..', import.meta.url)));
  const program = ts.createProgram([fileURLToPath(new URL('./preload.cts', import.meta.url))], parsed.options);
  let compiled = '';
  program.emit(undefined, (path, source) => {
    assert.match(path, /preload\.cjs$/);
    compiled = source;
  });
  assert.ok(compiled, 'the packaging glob dist/**/* must contain preload.cjs');
  let bridge!: {
    setupRestartPending: (...args: unknown[]) => Promise<boolean>;
    restartAfterSetup: (...args: unknown[]) => Promise<void>;
    handOverToService: (...args: unknown[]) => Promise<string>;
    selectDirectory: (...args: unknown[]) => Promise<string | null>;
    selectPluginSource: (...args: unknown[]) => Promise<string | null>;
    selectExecutable: (...args: unknown[]) => Promise<string | null>;
    revealPath: (...args: unknown[]) => Promise<void>;
    appInfo: (...args: unknown[]) => Promise<{ version: string }>;
    openLogsFolder: (...args: unknown[]) => Promise<string>;
    openAbout: (...args: unknown[]) => Promise<void>;
    browser: { attach: (...args: unknown[]) => Promise<void>; detach: (...args: unknown[]) => Promise<void> };
    windowMachine: { set: (...args: unknown[]) => Promise<unknown> };
    openWindow: (...args: unknown[]) => Promise<unknown>;
    windowScheme: (...args: unknown[]) => Promise<unknown>;
    tailscale: { openInstaller: (...args: unknown[]) => Promise<unknown>; openApp: (...args: unknown[]) => Promise<unknown> };
    updates: {
      state: (...args: unknown[]) => Promise<unknown>;
      start: (...args: unknown[]) => Promise<unknown>;
      cancel: (...args: unknown[]) => Promise<unknown>;
      open: (...args: unknown[]) => Promise<unknown>;
      install: (...args: unknown[]) => Promise<unknown>;
      onState: (listener: (state: unknown) => void) => () => void;
    };
    speech: {
      getState: (...args: unknown[]) => Promise<unknown>;
      startDictation: (...args: unknown[]) => Promise<unknown>;
      feed: (...args: unknown[]) => void;
      stopDictation: (...args: unknown[]) => Promise<void>;
      onEvent: (listener: (event: unknown) => void) => () => void;
      microphone: (...args: unknown[]) => Promise<unknown>;
      listModels: (...args: unknown[]) => Promise<unknown>;
      importModel: (...args: unknown[]) => Promise<unknown>;
      proposePack: (...args: unknown[]) => Promise<unknown>;
    };
  };
  const calls: unknown[][] = [];
  const sent: unknown[][] = [];
  const listeners = new Map<string, (event: unknown, payload: unknown) => void>();
  runInNewContext(compiled, {
    exports: {},
    require: (name: string) => {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld: (key: string, api: typeof bridge) => {
          assert.equal(key, 'timonDesktop'); bridge = api;
        } },
        ipcRenderer: {
          invoke: async (...args: unknown[]) => { calls.push(args); },
          send: (...args: unknown[]) => { sent.push(args); },
          on: (channel: string, fn: (event: unknown, payload: unknown) => void) => { listeners.set(channel, fn); },
          removeListener: (channel: string, fn: unknown) => { if (listeners.get(channel) === fn) listeners.delete(channel); },
        },
      };
    },
  });
  assert.deepEqual(Object.keys(bridge), ['selectDirectory', 'selectPluginSource', 'selectExecutable', 'revealPath', 'setupRestartPending', 'restartAfterSetup', 'handOverToService', 'appInfo', 'openLogsFolder', 'openAbout', 'uninstall', 'speech', 'windowMachine', 'windowScheme', 'openWindow', 'browser', 'updates', 'tailscale']);
  assert.deepEqual(Object.keys(bridge.browser), ['attach', 'detach']);
  // Multi-window V3: an id crosses, nothing else; the main process checks it is one.
  assert.deepEqual(Object.keys(bridge.windowMachine), ['set']);
  await bridge.windowMachine.set('vps', 'https://evil.example');
  assert.deepEqual(calls.pop(), ['timon:window-machine', 'vps', undefined]);
  await bridge.windowMachine.set('vps', { route: '/kanban', url: 'https://evil.example' });
  assert.equal(JSON.stringify(calls.pop()), '["timon:window-machine","vps",{"route":"/kanban"}]', 'V4: a route, nothing else');
  // Each machine its own mode: one object crosses, as given; the main process checks it is { scheme, machineId? }.
  await bridge.windowScheme({ scheme: 'light', machineId: 'vps' }, 'https://evil.example');
  assert.deepEqual(calls.pop(), ['timon:window-scheme', { scheme: 'light', machineId: 'vps' }]);
  // Multi-window V5: one object crosses, as given; the main process checks it is { route, machineId? }.
  await bridge.openWindow({ route: '/kanban', machineId: 'vps' }, 'https://evil.example');
  assert.deepEqual(calls.pop(), ['timon:open-window', { route: '/kanban', machineId: 'vps' }]);
  assert.deepEqual(Object.keys(bridge.tailscale), ['openInstaller', 'openApp']);
  await bridge.restartAfterSetup('untrusted executable', 'another home');
  await bridge.selectDirectory('/Users/example/My Project', 'untrusted extra option');
  assert.deepEqual(calls, [[SETUP_RESTART_CHANNEL], ['timon:select-directory', '/Users/example/My Project']]);
  await bridge.selectPluginSource('archive', 'untrusted extra option');
  assert.deepEqual(calls.at(-1), ['timon:select-plugin-source', 'archive']);
  calls.pop();
  await bridge.selectExecutable('/opt/homebrew/bin/claude', 'untrusted extra option');
  assert.deepEqual(calls.at(-1), ['timon:select-executable', '/opt/homebrew/bin/claude']);
  calls.pop();
  await bridge.revealPath({ agentId: 'a', path: 'a b.txt' }, 'untrusted extra option');
  assert.deepEqual(calls.at(-1), ['timon:reveal-path', { agentId: 'a', path: 'a b.txt' }]);
  calls.pop();
  const presentation = { profileId: 'client-a', viewToken: 'ticket', bounds: { x: 0, y: 0, width: 400, height: 300 } };
  await bridge.browser.attach(presentation, 'untrusted extra capability');
  await bridge.browser.detach('untrusted extra capability');
  assert.deepEqual(calls.slice(2), [['timon:browser-attach', presentation], ['timon:browser-detach']]);
  await bridge.setupRestartPending('untrusted home');
  assert.deepEqual(calls.at(-1), [SETUP_RESTART_STATUS_CHANNEL]);
  // A path crosses, and nothing else; the main process checks it is one of the interface.
  await bridge.handOverToService('/setup/agent', 'untrusted home');
  assert.deepEqual(calls.at(-1), [SETUP_HANDOVER_CHANNEL, '/setup/agent']);
  await bridge.appInfo('untrusted extra option');
  assert.deepEqual(calls.at(-1), [APP_INFO_CHANNEL]);
  await bridge.openLogsFolder('/etc');
  assert.deepEqual(calls.at(-1), [OPEN_LOGS_CHANNEL], 'no path crosses the bridge');
  await bridge.openAbout('file:///etc/passwd');
  assert.deepEqual(calls.at(-1), [ABOUT_CHANNEL], 'the page cannot choose what the About window shows');
  await bridge.tailscale.openInstaller('C:\\evil.msi', { url: 'https://evil.example/x.pkg' });
  assert.deepEqual(calls.at(-1), ['timon:tailscale-installer'], 'no path or URL crosses the bridge');
  await bridge.tailscale.openApp('/Applications/Evil.app');
  assert.deepEqual(calls.at(-1), ['timon:tailscale-open-app']);
  // A newer Timon (P2): the installer is the daemon's verified offer; no URL, path or version crosses.
  assert.deepEqual(Object.keys(bridge.updates), ['state', 'start', 'cancel', 'open', 'install', 'onState']);
  await bridge.updates.start('https://evil.example/Timon.exe', { url: 'https://evil.example/x' });
  assert.deepEqual(calls.at(-1), ['timon:update-start'], 'no URL crosses the bridge');
  await bridge.updates.cancel('C:\\evil');
  assert.deepEqual(calls.at(-1), ['timon:update-cancel']);
  await bridge.updates.state({ version: '9.9.9' });
  assert.deepEqual(calls.at(-1), ['timon:update-state']);
  await bridge.updates.open('installer', 'C:\\evil.exe');
  assert.equal(JSON.stringify(calls.at(-1)), '["timon:update-open",{"target":"installer"}]', 'a gesture, never a path');
  // P3: install carries a strict boolean, whatever the page passes.
  await bridge.updates.install('yes', 'C:\\evil.exe');
  assert.equal(JSON.stringify(calls.at(-1)), '["timon:update-install",{"confirmed":false}]');
  await bridge.updates.install(true);
  assert.equal(JSON.stringify(calls.at(-1)), '["timon:update-install",{"confirmed":true}]');
  const updateStates: unknown[] = [];
  const stopUpdates = bridge.updates.onState((state) => updateStates.push(state));
  listeners.get('timon:update-event')!({ sender: 'raw ipc event' }, { phase: 'idle' });
  assert.equal(JSON.stringify(updateStates), '[{"phase":"idle"}]');
  stopUpdates();
  assert.equal(listeners.has('timon:update-event'), false);
  // Local dictation (TODO #443): fixed channels, extra arguments dropped, audio
  // sent without a round trip, events without the raw IPC event. Objects built
  // inside the vm context have its prototypes: compare them through JSON.
  const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null));
  assert.deepEqual(plain(Object.keys(bridge.speech)), [
    'getState', 'downloadModel', 'cancelDownload', 'deleteModel', 'startDictation', 'listModels', 'importModel', 'proposePack',
    'feed', 'stopDictation', 'cancelDictation', 'microphone', 'onEvent',
  ]);
  // The live catalog (TODO #484): no path crosses, extra arguments are dropped.
  await bridge.speech.listModels('/etc');
  assert.deepEqual(plain(calls.at(-1)), ['timon:speech-list-models']);
  await bridge.speech.importModel({ family: 'whisper' }, '/home/me/model');
  assert.deepEqual(plain(calls.at(-1)), ['timon:speech-import-model', { family: 'whisper' }]);
  await bridge.speech.proposePack({ pluginId: 'acme', modelId: 'acme.x' }, 'extra');
  assert.deepEqual(plain(calls.at(-1)), ['timon:speech-propose-pack', { pluginId: 'acme', modelId: 'acme.x' }]);
  await bridge.speech.getState(undefined, 'untrusted extra option');
  assert.deepEqual(plain(calls.at(-1)), ['timon:speech-state', null]);
  // The language crosses as a value; the main process parses it (speech-ipc.test.ts).
  // The provisional-text choice travels as is: the main process holds it to a closed list. A fourth argument is dropped.
  await bridge.speech.startDictation('parakeet-tdt-0.6b-v3-int8', 'fr-FR', 'final-only', '/etc/passwd');
  assert.deepEqual(plain(calls.at(-1)), ['timon:speech-start', { modelId: 'parakeet-tdt-0.6b-v3-int8', language: 'fr-FR', interim: 'final-only' }]);
  await bridge.speech.startDictation(undefined, undefined, 'delayed');
  assert.deepEqual(plain(calls.at(-1)), ['timon:speech-start', { interim: 'delayed' }]);
  await bridge.speech.startDictation(undefined, 'fr');
  assert.deepEqual(plain(calls.at(-1)), ['timon:speech-start', { language: 'fr' }]);
  await bridge.speech.startDictation();
  assert.deepEqual(plain(calls.at(-1)), ['timon:speech-start', null]);
  await bridge.speech.microphone('untrusted extra option');
  assert.deepEqual(plain(calls.at(-1)), ['timon:speech-microphone', { request: true }], 'only a boolean crosses');
  await bridge.speech.microphone();
  assert.deepEqual(plain(calls.at(-1)), ['timon:speech-microphone', null]);
  const samples = new Float32Array(1600);
  bridge.speech.feed('id', samples, 48_000);
  assert.equal(sent.length, 1);
  const [channel, payload] = sent[0] as [string, { sessionId: string; samples: Float32Array; sampleRate: number }];
  assert.equal(channel, 'timon:speech-feed');
  assert.equal(payload.samples, samples, 'the audio buffer crosses as is');
  assert.deepEqual([payload.sessionId, payload.sampleRate, Object.keys(payload).length], ['id', 16000, 3]);
  await bridge.speech.stopDictation('id', 'extra');
  assert.deepEqual(plain(calls.at(-1)), ['timon:speech-stop', { sessionId: 'id' }]);
  const received: unknown[] = [];
  const unsubscribe = bridge.speech.onEvent((event) => received.push(event));
  listeners.get('timon:speech-event')?.({ sender: 'raw ipc event' }, { type: 'stopped', sessionId: 'id' });
  assert.deepEqual(received, [{ type: 'stopped', sessionId: 'id' }]);
  unsubscribe();
  assert.equal(listeners.has('timon:speech-event'), false);
});


test('deferred setup survives navigation but clears on the next configured launch', () => {
  const boot = { embedded: true, configuredAtLaunch: false, configuredNow: false, serviceInstalled: false };
  assert.equal(setupRestartPending(boot), false);
  const saved = { ...boot, configuredNow: true };
  assert.equal(setupRestartPending(saved), false, 'a portable first run does not ask for a restart');
  assert.equal(setupRestartPending({ ...saved, serviceInstalled: true }), true);
  assert.equal(setupRestartPending({ ...saved, configuredAtLaunch: true }), false, 'ordinary portable launch');
  assert.equal(setupRestartPending({ ...saved, configuredAtLaunch: true, embedded: false, serviceInstalled: true }), false, 'service took over');
});

test('a service-run daemon is restarted through its service, never by relaunching the shell', async () => {
  const calls: string[] = [];
  const restart = setupRestarter({
    validate: () => { calls.push('validate'); },
    stopEmbedded: async () => { calls.push('stop-embedded'); },
    relaunch: () => { calls.push('relaunch'); },
    quit: () => { calls.push('quit'); },
    serviceOwnsDaemon: () => true,
    restartService: async () => { calls.push('restart-service'); },
  });
  await restart();
  assert.deepEqual(calls, ['validate', 'restart-service']);
  // Still pending after that restart (the page asks again): the button must work again.
  await restart();
  assert.deepEqual(calls, ['validate', 'restart-service', 'validate', 'restart-service']);
});

test('an embedded daemon keeps the relaunch path even when a service is installed', async () => {
  const calls: string[] = [];
  const restart = setupRestarter({
    validate: () => {}, stopEmbedded: async () => { calls.push('stop-embedded'); },
    relaunch: () => { calls.push('relaunch'); }, quit: () => { calls.push('quit'); },
    serviceOwnsDaemon: () => false,
    restartService: async () => { calls.push('restart-service'); },
  });
  await restart();
  assert.deepEqual(calls, ['stop-embedded', 'relaunch', 'quit']);
});

const fresh = {
  embedded: true, configuredAtLaunch: false, configuredNow: true, serviceInstalled: true,
  serviceRefused: false, supervisor: 'systemd-user', sameOrigins: true,
};

test('a first setup that installed the service hands the embedded daemon over to it', () => {
  assert.equal(serviceHandoverNeeded(fresh), true);
  for (const supervisor of ['launchd', 'windows']) assert.equal(serviceHandoverNeeded({ ...fresh, supervisor }), true);
});

test('nothing changes where no service takes over, or where it would answer elsewhere', () => {
  for (const change of [
    { embedded: false },                 // the service already served the wizard
    { configuredAtLaunch: true },        // not a first setup
    { configuredNow: false },            // the configuration is not written yet
    { serviceInstalled: false },         // portable mode
    { supervisor: 'none' },              // portable mode, chosen
    { serviceRefused: true },            // Windows will not run the task (TODO #342)
    { sameOrigins: false },              // the window would lose its interface
  ]) assert.equal(serviceHandoverNeeded({ ...fresh, ...change }), false, JSON.stringify(change));
});

test('the handover route is a path of the interface, never another origin', () => {
  const origin = 'http://127.0.0.1:3110';
  assert.equal(handoverRoute('/setup/agent', origin), '/setup/agent');
  assert.equal(handoverRoute('/', origin), '/');
  assert.equal(handoverRoute('/setup/agent?from=setup', origin), '/setup/agent?from=setup');
  for (const route of ['//evil.example/x', 'http://evil.example/', 'setup/agent', '/\\evil.example', '', 42, null, undefined]) {
    assert.equal(handoverRoute(route, origin), null, String(route));
  }
});

function handover(over: Partial<Parameters<typeof serviceHandover>[0]> = {}) {
  const calls: string[] = [];
  const run = serviceHandover({
    needed: () => { calls.push('needed'); return true; },
    showRestarting: (route) => { calls.push(`waiting ${route}`); },
    stopEmbedded: async () => { calls.push('stop'); },
    kickService: async () => { calls.push('kick'); return true; },
    waitService: async () => { calls.push('wait'); return true; },
    resume: () => { calls.push('resume'); },
    resumeEmbedded: async () => { calls.push('embedded again'); },
    reportKept: (why) => { calls.push(`kept ${why ?? ''}`.trim()); },
    ...over,
  });
  return { run, calls };
}

test('the pages wait before the embedded daemon stops, and reopen once the service answers', async () => {
  const { run, calls } = handover();
  assert.equal(await run('/setup/agent'), 'handed-over');
  assert.deepEqual(calls, ['needed', 'waiting /setup/agent', 'stop', 'kick', 'wait', 'resume']);
});

test('a handover that is not needed touches nothing: the page goes on by itself', async () => {
  const { run, calls } = handover({ needed: () => { calls.push('needed'); return false; } });
  assert.equal(await run('/setup/agent'), 'not-needed');
  assert.deepEqual(calls, ['needed']);
});

test('a service that does not answer leaves the embedded daemon serving, and says so', async () => {
  const silent = handover({ waitService: async () => { silent.calls.push('wait'); return false; } });
  assert.equal(await silent.run('/setup/agent'), 'kept-embedded');
  assert.deepEqual(silent.calls, ['needed', 'waiting /setup/agent', 'stop', 'kick', 'wait', 'embedded again', 'kept']);
  // Windows refused to run the task: no wait on a daemon nothing starts.
  const refused = handover({ kickService: async () => { refused.calls.push('kick'); return false; } });
  assert.equal(await refused.run('/'), 'kept-embedded');
  assert.deepEqual(refused.calls, ['needed', 'waiting /', 'stop', 'kick', 'embedded again', 'kept']);
  const failing = handover({ kickService: async () => { throw new Error('systemctl failed'); } });
  assert.equal(await failing.run('/'), 'kept-embedded');
  assert.equal(failing.calls.at(-1), 'kept systemctl failed');
});

test('an embedded daemon that will not stop keeps the pages, and the error is reported', async () => {
  const stuck = handover({ stopEmbedded: async () => { throw new Error('still running'); } });
  await assert.rejects(stuck.run('/setup/agent'), /still running/);
  assert.deepEqual(stuck.calls, ['needed', 'waiting /setup/agent', 'resume']);
});

test('a double click hands over once, and a later call finds nothing left to do', async () => {
  let embedded = true;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { run, calls } = handover({
    needed: () => { calls.push('needed'); return embedded; },
    stopEmbedded: async () => { calls.push('stop'); await gate; embedded = false; },
  });
  const first = run('/setup/agent');
  assert.equal(run('/setup/agent'), first);
  release();
  assert.equal(await first, 'handed-over');
  assert.equal(await run('/setup/agent'), 'not-needed');
  assert.equal(calls.filter((c) => c === 'stop').length, 1);
});

test('the kept-embedded notice names the home and the reason, in the user\'s language', () => {
  const en = handoverKeptMessage('en-US', '/home/me/.timon', 'timeout');
  assert.match(en.message, /did not answer/);
  assert.match(en.detail, /\/home\/me\/\.timon/);
  assert.match(en.detail, /timeout/);
  assert.match(handoverKeptMessage('fr', 'C:\\Users\\me\\.timon', null).message, /n’a pas répondu/);
});

test('the configuration the wizard writes keeps the origins the window opened on', () => {
  // `applySetup` writes only the ports the embedded daemon got from its
  // environment (`readEnvDecisions`): no host. The handover compares origins,
  // so a host or port that changed on the way would silently skip it.
  const written = (daemonPort: number, appPort: number) => JSON.stringify({
    version: 1, edition: 'expert', profile: 'default',
    daemon: { supervisor: 'systemd-user', listen: { port: daemonPort } },
    app: { enabled: true, listen: { port: appPort } },
  });
  const origins = (home: string) => {
    const cfg = loadDesktopConfig(home, { packaged: true });
    return [originOf(cfg.daemon.listen), originOf(cfg.app.listen)];
  };
  const first = mkdtempSync(join(tmpdir(), 'timon-handover-'));
  const before = origins(first);
  writeFileSync(join(first, 'timon.config.json'), written(3010, 3110));
  assert.deepEqual(origins(first), before);
  // Ports moved at first launch (`desktop-bootstrap.json`) are written back the same way.
  const moved = mkdtempSync(join(tmpdir(), 'timon-handover-'));
  writeFileSync(join(moved, 'desktop-bootstrap.json'), JSON.stringify({ daemonPort: 41010, appPort: 41110 }));
  const bootstrap = origins(moved);
  assert.deepEqual(bootstrap, ['http://127.0.0.1:41010', 'http://127.0.0.1:41110']);
  writeFileSync(join(moved, 'timon.config.json'), written(41010, 41110));
  assert.deepEqual(origins(moved), bootstrap);
});
