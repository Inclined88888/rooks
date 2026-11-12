// Sandboxed preloads must be CommonJS and expose capabilities, never raw IPC.
const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

contextBridge.exposeInMainWorld('novaDesktop', {
  selectDirectory: (defaultPath?: string): Promise<string | null> => ipcRenderer.invoke('rooks:select-directory', defaultPath),
  selectPluginSource: (kind: 'folder' | 'archive'): Promise<string | null> => ipcRenderer.invoke('rooks:select-plugin-source', kind),
  selectExecutable: (defaultPath?: string): Promise<string | null> => ipcRenderer.invoke('rooks:select-executable', defaultPath),
  revealPath: (request: { agentId: string; path: string }): Promise<unknown> => ipcRenderer.invoke('rooks:reveal-path', request),
  setupRestartPending: (): Promise<boolean> => ipcRenderer.invoke('rooks:setup-restart-pending'),
  restartAfterSetup: (): Promise<void> => ipcRenderer.invoke('rooks:restart-after-setup'),
  // End of a first setup: the service takes over, then the window opens `route`, a path of the interface.
  handOverToService: (route: string): Promise<string> => ipcRenderer.invoke('rooks:setup-handover', route),
  appInfo: (): Promise<{ version: string }> => ipcRenderer.invoke('rooks:app-info'),
  openLogsFolder: (): Promise<string> => ipcRenderer.invoke('rooks:open-logs'),
  // About Rooks and the speech-model licences (TODO #582).
  openAbout: (): Promise<void> => ipcRenderer.invoke('rooks:open-about'),
  uninstall: {
    info: () => ipcRenderer.invoke('rooks:uninstall-info'),
    run: (request: { mode: 'keep' | 'delete'; confirmation: string; locale: string }) => ipcRenderer.invoke('rooks:uninstall', request),
  },
  // Local dictation (TODO #443). Audio is 16 kHz mono Float32 PCM, ~100 ms per
  // chunk; events carry the session id, and `stopped` is always the last one.
  speech: {
    getState: (modelId?: string): Promise<unknown> => ipcRenderer.invoke('rooks:speech-state', modelId ? { modelId } : undefined),
    downloadModel: (modelId?: string): Promise<unknown> => ipcRenderer.invoke('rooks:speech-download', modelId ? { modelId } : undefined),
    cancelDownload: (modelId?: string): Promise<boolean> => ipcRenderer.invoke('rooks:speech-cancel-download', modelId ? { modelId } : undefined),
    deleteModel: (modelId?: string): Promise<unknown> => ipcRenderer.invoke('rooks:speech-delete-model', modelId ? { modelId } : undefined),
    // `language`: 'auto' or a tag ('fr', 'fr-FR'); the main process picks the model that fits.
    // `interim`: 'auto' | 'live' | 'delayed' | 'final-only'; it can only make the model's own mode stricter.
    startDictation: (modelId?: string, language?: string, interim?: string): Promise<unknown> => ipcRenderer.invoke(
      'rooks:speech-start',
      modelId || language || interim
        ? { ...(modelId ? { modelId } : {}), ...(language ? { language } : {}), ...(interim ? { interim } : {}) }
        : undefined,
    ),
    // The live catalog (TODO #484): built-in models, confirmed packs, local imports.
    listModels: (): Promise<unknown> => ipcRenderer.invoke('rooks:speech-list-models'),
    // The main process opens the folder picker: no path ever crosses from the page.
    importModel: (request?: { family?: string; languages?: string[] }): Promise<unknown> => ipcRenderer.invoke('rooks:speech-import-model', request),
    // A plugin's model entry; the main process asks the user before anything downloads.
    proposePack: (request: { pluginId: string; modelId: string }): Promise<unknown> => ipcRenderer.invoke('rooks:speech-propose-pack', request),
    feed: (sessionId: string, samples: Float32Array): void => ipcRenderer.send('rooks:speech-feed', { sessionId, samples, sampleRate: 16000 }),
    stopDictation: (sessionId: string): Promise<void> => ipcRenderer.invoke('rooks:speech-stop', { sessionId }),
    cancelDictation: (sessionId: string): Promise<void> => ipcRenderer.invoke('rooks:speech-cancel', { sessionId }),
    // 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'; `request` prompts on macOS.
    microphone: (request?: boolean): Promise<{ status: string }> => ipcRenderer.invoke('rooks:speech-microphone', request ? { request: true } : undefined),
    onEvent: (listener: (event: unknown) => void): (() => void) => {
      const forward = (_event: unknown, payload: unknown): void => listener(payload);
      ipcRenderer.on('rooks:speech-event', forward);
      return () => { ipcRenderer.removeListener('rooks:speech-event', forward); };
    },
  },
  // The machine this window drives (multi-window V3): an id, and the page to open should the
  // machine have no live page in the window (V4). `shown`: the shell switched pages, nothing reloads.
  windowMachine: {
    set: (id: string, request?: { route?: string }): Promise<{ id: string; shown?: boolean }> =>
      ipcRenderer.invoke('rooks:window-machine', id, request?.route === undefined ? undefined : { route: request.route }),
  },
  // The light/dark mode this page paints, and the machine it was served for: the shell
  // paints the next window or page of that machine with it before it loads.
  windowScheme: (request: { scheme: 'light' | 'dark'; machineId?: string }): Promise<{ recorded: boolean }> =>
    ipcRenderer.invoke('rooks:window-scheme', request),
  // One more window on this window's machine, at a route of this interface (V5): a path, never a URL.
  openWindow: (request: { route: string; machineId?: string }): Promise<{ opened: boolean }> => ipcRenderer.invoke('rooks:open-window', request),
  browser: {
    // `conversation`, `locale` and `scheme` tell the annotation bubble where to send and how to speak (TODO #481).
    attach: (request: { profileId: string; viewToken: string; bounds: { x: number; y: number; width: number; height: number };
      conversation?: { agent: string; mission: string | null }; locale?: string; scheme?: 'light' | 'dark' }): Promise<{ attached: boolean } | void> =>
      ipcRenderer.invoke('rooks:browser-attach', request),
    detach: (): Promise<void> => ipcRenderer.invoke('rooks:browser-detach'),
  },
  // A newer Rooks (docs/AUTO-UPDATE.md P2, P3): the shell downloads and installs the
  // installer the local daemon verified. No URL, path or version crosses from the page.
  updates: {
    state: (): Promise<unknown> => ipcRenderer.invoke('rooks:update-state'),
    start: (): Promise<unknown> => ipcRenderer.invoke('rooks:update-start'),
    cancel: (): Promise<unknown> => ipcRenderer.invoke('rooks:update-cancel'),
    open: (target: 'folder' | 'installer'): Promise<unknown> => ipcRenderer.invoke('rooks:update-open', { target }),
    // P3: installs the verified file; `confirmed` = « install anyway » past running missions.
    install: (confirmed: boolean): Promise<unknown> => ipcRenderer.invoke('rooks:update-install', { confirmed: confirmed === true }),
    onState: (listener: (state: unknown) => void): (() => void) => {
      const forward = (_event: unknown, payload: unknown): void => listener(payload);
      ipcRenderer.on('rooks:update-event', forward);
      return () => { ipcRenderer.removeListener('rooks:update-event', forward); };
    },
  },
  // The daemon decides which verified package; nothing crosses from the page.
  tailscale: {
    openInstaller: (): Promise<unknown> => ipcRenderer.invoke('rooks:tailscale-installer'),
    openApp: (): Promise<unknown> => ipcRenderer.invoke('rooks:tailscale-open-app'),
  },
});
