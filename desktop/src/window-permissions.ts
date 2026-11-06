/**
 * Web permissions of the Timon window (TODO #443).
 *
 * Without a handler Electron grants every request of the default session, to
 * any page the window ends up showing. The window only ever shows the Timon
 * client, so the handlers below grant only what that client uses, only to its
 * exact origin, only from its main frame:
 *
 * - `media` for the microphone (dictation, the chat visualizer, live voice),
 *   never the camera, and only once the OS lets the app record (macOS asks
 *   the user, Windows has a privacy switch);
 * - the clipboard (copy buttons, paste in the terminal and the browser
 *   panel), notifications (the push toggle) and fullscreen, which the client
 *   relied on before these handlers existed.
 *
 * Another loopback server (an app an agent runs on 127.0.0.1:5173), an iframe
 * (MCP apps) or the startup page asks for nothing it will get. The native
 * browser of the missions has its own sessions and handlers
 * (`native-browser.ts`), untouched by this file.
 *
 * Kept free of `electron` imports so the decisions are unit-tested.
 */

/** Permissions the Timon client uses besides the microphone. */
const CLIENT_PERMISSIONS = new Set(['clipboard-read', 'clipboard-sanitized-write', 'notifications', 'fullscreen']);

/** Whether `candidate` (an origin or a URL) is exactly the window's origin. */
export function isWindowOrigin(candidate: string | undefined, windowOrigin: string): boolean {
  if (!candidate || !windowOrigin) return false;
  try {
    const origin = new URL(candidate).origin;
    // Opaque origins (data:, about:, sandboxed frames) all print as "null".
    return origin !== 'null' && origin === new URL(windowOrigin).origin;
  } catch {
    return false;
  }
}

export type PermissionAsker = {
  /** The asking contents is the Timon window's, not the startup or update window. */
  isWindow: boolean;
  isMainFrame: boolean;
  /** Origin (or URL) of the asking frame. */
  origin: string | undefined;
  /** The window's origin when the request arrives; '' before it loaded the client. */
  windowOrigin: string;
};

function trusted(asker: PermissionAsker): boolean {
  return asker.isWindow && asker.isMainFrame && isWindowOrigin(asker.origin, asker.windowOrigin);
}

/**
 * What a permission request deserves. `microphone` means granted if the OS
 * lets the app record: the caller asks it before answering.
 */
export function requestVerdict(
  asker: PermissionAsker,
  permission: string,
  mediaTypes: readonly string[] | undefined,
): 'grant' | 'microphone' | 'deny' {
  if (!trusted(asker)) return 'deny';
  if (permission === 'media') {
    const types = mediaTypes ?? [];
    return types.length > 0 && types.every((type) => type === 'audio') ? 'microphone' : 'deny';
  }
  return CLIENT_PERMISSIONS.has(permission) ? 'grant' : 'deny';
}

/** Synchronous counterpart, for `setPermissionCheckHandler`: same answers, no OS prompt. */
export function checkVerdict(asker: PermissionAsker, permission: string, mediaType: string | undefined): boolean {
  if (!trusted(asker)) return false;
  if (permission === 'media') return mediaType === 'audio';
  return CLIENT_PERMISSIONS.has(permission);
}

/** What `getMediaAccessStatus('microphone')` reports, plus 'unknown' for anything else. */
export type MicrophoneStatus = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown';

/** The slice of Electron's `systemPreferences` the microphone gate uses. */
export interface SystemMediaAccess {
  getMediaAccessStatus(mediaType: 'microphone'): string;
  /** macOS only. */
  askForMediaAccess(mediaType: 'microphone'): Promise<boolean>;
}

function normalize(status: string): MicrophoneStatus {
  return status === 'granted' || status === 'denied' || status === 'restricted' || status === 'not-determined' ? status : 'unknown';
}

/** Whether a status lets a capture start. 'unknown' does: Chromium then reports the real failure. */
export function microphoneUsable(status: MicrophoneStatus): boolean {
  return status !== 'denied' && status !== 'restricted';
}

export type MicrophoneAccess = {
  /** The OS's answer, without prompting. */
  status(): MicrophoneStatus;
  /** Prompts on macOS when the user never answered; other OSes cannot prompt. */
  ensure(): Promise<MicrophoneStatus>;
};

/**
 * The OS gate in front of the microphone. On macOS a capture the user never
 * allowed records silence instead of failing, so the prompt comes before
 * `getUserMedia` resolves. Windows only reports its privacy switch; Linux
 * desktops have no such gate for an unsandboxed app.
 */
export function microphoneAccess(platform: NodeJS.Platform, prefs: SystemMediaAccess): MicrophoneAccess {
  let asking: Promise<MicrophoneStatus> | null = null;
  const status = (): MicrophoneStatus => {
    if (platform !== 'darwin' && platform !== 'win32') return 'granted';
    try {
      return normalize(prefs.getMediaAccessStatus('microphone'));
    } catch {
      return 'unknown';
    }
  };
  return {
    status,
    ensure() {
      const current = status();
      if (platform !== 'darwin' || current !== 'not-determined') return Promise.resolve(current);
      // Two captures starting together share one prompt.
      asking ??= prefs.askForMediaAccess('microphone')
        .then((granted): MicrophoneStatus => (granted ? 'granted' : 'denied'), (): MicrophoneStatus => 'denied')
        .finally(() => { asking = null; });
      return asking;
    },
  };
}

type RequestDetails = { isMainFrame: boolean; requestingUrl?: string; securityOrigin?: string; mediaTypes?: readonly string[] };
type CheckDetails = { isMainFrame: boolean; securityOrigin?: string; mediaType?: string };

/** The slice of an Electron `Session` the handlers are installed on. */
export interface PermissionSession<W> {
  setPermissionRequestHandler(handler: (contents: W, permission: string, callback: (granted: boolean) => void, details: RequestDetails) => void): void;
  setPermissionCheckHandler(handler: (contents: W | null, permission: string, requestingOrigin: string, details: CheckDetails) => boolean): void;
}

export type WindowPermissionDeps<W> = {
  /** Read on every call: the window loads its origin after the handlers are set. */
  windowOrigin: () => string;
  isWindow: (contents: W | null) => boolean;
  microphone: MicrophoneAccess;
  log: (line: string) => void;
};

export function installWindowPermissions<W>(session: PermissionSession<W>, deps: WindowPermissionDeps<W>): void {
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    // A media request names its frame's origin in `securityOrigin`.
    const origin = permission === 'media' ? details.securityOrigin ?? details.requestingUrl : details.requestingUrl;
    const asker = { isWindow: deps.isWindow(contents), isMainFrame: details.isMainFrame, origin, windowOrigin: deps.windowOrigin() };
    const verdict = requestVerdict(asker, permission, details.mediaTypes);
    if (verdict === 'grant') { callback(true); return; }
    if (verdict === 'deny') {
      deps.log(`[desktop] permission ${permission} refused to ${originOnly(origin)}`);
      callback(false);
      return;
    }
    void deps.microphone.ensure().then((status) => {
      if (!microphoneUsable(status)) deps.log(`[desktop] microphone blocked by the OS (${status})`);
      callback(microphoneUsable(status));
    }, () => callback(false));
  });
  session.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    const origin = permission === 'media' && details.securityOrigin ? details.securityOrigin : requestingOrigin;
    // The client's service worker (sw.js) shows notifications: Chromium checks
    // it with no contents and no main frame. Only that, only from Timon's origin.
    if (contents === null) return permission === 'notifications' && isWindowOrigin(origin, deps.windowOrigin());
    const asker = { isWindow: deps.isWindow(contents), isMainFrame: details.isMainFrame, origin, windowOrigin: deps.windowOrigin() };
    return checkVerdict(asker, permission, details.mediaType);
  });
}

/** Never log a full URL: a path or query can carry a token. */
function originOnly(candidate: string | undefined): string {
  if (!candidate) return 'an unknown origin';
  try { return new URL(candidate).origin; } catch { return 'an unparsable origin'; }
}
