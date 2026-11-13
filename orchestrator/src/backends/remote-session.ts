/**
 * The session of a backend with no process (`RemoteDialect`), as the runner
 * receives it.
 *
 * A process dialect resolves its credentials in `buildSpawn`, before anything
 * runs. A remote one has no spawn: its credentials are resolved when the
 * session starts, and the dialect's driver is only built once they are known.
 * Until then this stand-in answers for it, so the runner holds a driver from the
 * first instant, exactly as it does over a process's pipes — and a key that
 * cannot be produced fails `start()`, where the runner shows it in the thread.
 */
import {
  REMOTE_RESUME_MAX_BYTES,
  type ImageAttachment, type RemoteResumeState, type SessionDriver, type SessionInfo, type TurnOutcome,
} from './types.js';

export function deferredDriver(open: () => Promise<SessionDriver>): SessionDriver {
  let inner: SessionDriver | null = null;
  let closed = false;
  return {
    get info(): SessionInfo | null {
      return inner?.info ?? null;
    },
    async start(): Promise<SessionInfo> {
      if (inner) return inner.start();
      const driver = await open();
      if (closed) {
        driver.close();
        throw new Error('the session was closed before it opened');
      }
      inner = driver;
      return driver.start();
    },
    prompt(text: string, images?: ImageAttachment[]): Promise<TurnOutcome> {
      if (!inner || closed) return Promise.reject(new Error('the session is not open'));
      return inner.prompt(text, images);
    },
    async cancel(): Promise<void> {
      await inner?.cancel();
    },
    async setModel(model: string): Promise<boolean> {
      return inner?.setModel && !closed ? inner.setModel(model) : false;
    },
    close(): void {
      if (closed) return;
      closed = true;
      inner?.close();
    },
  };
}

/** Env names that hold a credential, whatever the plugin calls them. */
const CREDENTIAL_NAME = /KEY|TOKEN|SECRET|PASSW|AUTH|CREDENTIAL|COOKIE/i;
/** Shorter values (a port, `true`) would match by accident. */
const MIN_CREDENTIAL_LENGTH = 8;

/** The values of `env` a resume state must never carry: those whose name says
 *  credential, and every vault secret injected under `injected` names. */
export function credentialValues(env: Readonly<Record<string, string>>, injected: readonly string[] = []): string[] {
  const vault = new Set(injected);
  return Object.entries(env)
    .filter(([name, value]) => value.length >= MIN_CREDENTIAL_LENGTH && (vault.has(name) || CREDENTIAL_NAME.test(name)))
    .map(([, value]) => value);
}

/**
 * The JSON the daemon persists for `RemoteSessionHost.saveResume`, once the
 * state is known to be a plain object, small enough, and free of the given
 * credentials. Throws a `TypeError` that names the rule, never the content: the
 * state may be exactly what must not reach a log.
 */
export function serializeResumeState(state: RemoteResumeState, credentials: readonly string[] = []): string {
  if (typeof state !== 'object' || state === null || Array.isArray(state)) {
    throw new TypeError('the resume state must be a plain JSON object');
  }
  let json: string | undefined;
  try {
    json = JSON.stringify(state);
  } catch {
    throw new TypeError('the resume state must be serializable to JSON');
  }
  if (typeof json !== 'string') throw new TypeError('the resume state must be serializable to JSON');
  if (Buffer.byteLength(json, 'utf8') > REMOTE_RESUME_MAX_BYTES) {
    throw new TypeError(`the resume state must stay under ${REMOTE_RESUME_MAX_BYTES} bytes once serialized`);
  }
  // Both forms: the raw value, and the value as JSON escapes it inside a string.
  for (const secret of credentials) {
    if (json.includes(secret) || json.includes(JSON.stringify(secret).slice(1, -1))) {
      throw new TypeError('the resume state must not carry a credential of the profile');
    }
  }
  return json;
}

/** The persisted JSON, read back. Null when it is not an object any more (a
 *  hand-edited row): the mission is then treated as having left no state. */
export function parseResumeState(json: string): RemoteResumeState | null {
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as RemoteResumeState : null;
  } catch {
    return null;
  }
}
