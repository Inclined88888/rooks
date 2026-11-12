import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { app, dialog, net, utilityProcess, type BrowserWindow } from 'electron';
import { SpeechEngineHost, type EnginePort } from './speech-engine-host.js';
import { importDialogOptions, packConfirmDialog, probeModel } from './speech-import.js';
import { SpeechController, type EngineAvailability, type PackSource, type SpeechDialogs, type SpeechEvent } from './speech-ipc.js';
import { prepareSpeechModels } from './speech-dir-guard.js';
import { SpeechModelManager } from './speech-model-manager.js';
import { inspectModelGraphs } from './speech-onnx-inspect.js';
import { sherpaAddonDir, sherpaPackageName, speechModelsDirPlan } from './speech-paths.js';
import type { WorkerInit, WorkerInput } from './speech-protocol.js';

/**
 * Electron wiring of local dictation: the only speech file that imports
 * `electron`, kept out of the unit tests on purpose. Built on the first IPC
 * call, so a session that never dictates never creates the models folder.
 */

export type DesktopSpeech = {
  controller: SpeechController;
  /** Synchronous, for `before-quit`: ends the engine and any download. */
  dispose: () => void;
};

/**
 * The model folder is the working directory: whatever base path the addon
 * resolves an external-data name against, a bare name (the only kind the
 * inspector lets through) lands in the model folder.
 */
function spawnEngine(init: WorkerInit): EnginePort {
  const child = utilityProcess.fork(fileURLToPath(new URL('./speech-worker.mjs', import.meta.url)), [], {
    serviceName: 'Rooks Dictation',
    stdio: 'inherit',
    cwd: init.modelDir,
  });
  const port: EnginePort = {
    postMessage: (message: WorkerInput) => child.postMessage(message),
    on(event: 'message' | 'exit', listener: ((message: unknown) => void) | ((code: number) => void)) {
      if (event === 'message') child.on('message', listener as (message: unknown) => void);
      else child.on('exit', listener as (code: number) => void);
      return port;
    },
    kill: () => child.kill(),
  };
  return port;
}

/** Native boxes, modal to the Rooks window when it is there. */
function nativeDialogs(window: () => BrowserWindow | null, locale: () => string): SpeechDialogs {
  const parent = (): BrowserWindow | null => {
    const win = window();
    return win && !win.isDestroyed() ? win : null;
  };
  return {
    async pickModelFolder() {
      const options = importDialogOptions(locale());
      const win = parent();
      const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
      return result.canceled ? null : result.filePaths[0] ?? null;
    },
    async confirmPack(model, pluginId) {
      const options = packConfirmDialog(model, pluginId, locale());
      const win = parent();
      const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
      return response === 1;
    },
  };
}

export function createDesktopSpeech(
  home: string,
  send: (event: SpeechEvent) => void,
  window: () => BrowserWindow | null,
  /** A plugin's pack, read from the daemon as the signed-in user (TODO #584). */
  packs: PackSource,
  /** The shell's language when the box opens: it follows the app's choice. */
  locale: () => string,
): DesktopSpeech {
  // Set once the controller exists: the manager's trial load goes through it.
  let controller: SpeechController | null = null;
  // A folder outside the home (Windows, non-ASCII home) is locked down to this
  // account before use, and its files re-hashed once per session (TODO #445).
  const shared = speechModelsDirPlan(home).some((candidate) => candidate.shared);
  const models = new SpeechModelManager({
    modelsDir: async () => (await prepareSpeechModels(home)).dir,
    verifyOnLoad: shared,
    // Chromium's network stack: the system proxy and certificates apply, as in the window.
    fetch: (url, init) => net.fetch(url, init),
    // A pack: its graphs read, then one load in a disposable process, before ready.
    vetting: {
      inspect: async (model, dir) => {
        const result = await inspectModelGraphs(model, dir);
        return result.ok ? { ok: true } : result;
      },
      probe: (model, dir) => controller?.probeModel(model, dir) ?? Promise.resolve({ ok: false, message: 'Dictation is not ready.' }),
    },
  });
  models.onState((state) => send({ type: 'model-state', state }));
  const engine = new SpeechEngineHost({ spawn: spawnEngine, emit: send });
  const addon = (): string | null => sherpaAddonDir({
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    resolvePackage: (name) => createRequire(import.meta.url).resolve(name),
    exists: (path) => existsSync(path),
  });
  const availability = (): EngineAvailability => {
    if (!sherpaPackageName(process.platform, process.arch)) return 'unsupported-platform';
    return addon() ? 'available' : 'not-installed';
  };
  controller = new SpeechController({
    models,
    engine,
    availability,
    addonDir: addon,
    // Half the cores, at most 4: dictation shares the machine with agents and builds.
    numThreads: Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2))),
    dialogs: nativeDialogs(window, locale),
    packs,
    // A process of its own, never the live engine: an invalid model aborts it.
    probe: (init, timeoutMs) => probeModel(spawnEngine, init, timeoutMs),
  });
  return {
    controller,
    dispose: () => {
      engine.dispose();
      models.cancelAll();
    },
  };
}
