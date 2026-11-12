/**
 * "Sign in with Chrome" (TODO #276): an installed Chrome opens in its own
 * window on an isolated profile, the user signs in where Google accepts it,
 * and the resulting cookies are copied into the embedded browser's session.
 *
 * Electron's Chromium is the engine Google rejects at sign-in, so the sign-in
 * itself has to happen elsewhere; everything after it (the agent, the panel,
 * the saved tabs) keeps running on the Electron session. The cookies never
 * leave this process: the daemon only names the binary to launch.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { CookiesSetDetails } from 'electron';
import { BrowserCommandError, browserUrlOf, profileIdOf } from './native-browser-protocol.js';
import {
  acceptableChromeExecutable, chromeEnvironment, chromeLaunchArguments, DEFAULT_SIGNIN_URL, electronCookieFrom, framePipeMessage,
  PipeFrames, type ChromeCookie,
} from './native-browser-chrome.js';

export interface ChromeSigninStatus {
  state: 'idle' | 'open' | 'finished' | 'failed';
  /** Cookies copied into the browser session by the last sign-in. */
  imported?: number;
  /** Cookies left behind because their scope cannot be rebuilt (partitioned, malformed). */
  skipped?: number;
  error?: string;
}

/** What Electron's `session.cookies` offers; the only thing the import needs. */
export interface CookieJar { set(details: CookiesSetDetails): Promise<void> }

/** A launched browser reduced to its DevTools pipe, so tests drive it without a real process. */
export interface ChromeChild {
  /** Messages to the browser (its file descriptor 3). */
  input: Writable;
  /** Messages from the browser (its file descriptor 4). */
  output: Readable;
  onExit(listener: () => void): void;
  kill(): void;
}
export type ChromeSpawn = (executable: string, args: string[]) => ChromeChild;

const POLL_MS = 2_000;
const COMMAND_TIMEOUT_MS = 8_000;
const EXIT_TIMEOUT_MS = 5_000;

interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
interface Session {
  child: ChromeChild;
  jar: CookieJar;
  frames: PipeFrames;
  pending: Map<number, Pending>;
  nextId: number;
  /** The latest cookies read while the window was open: the only copy once the window is gone. */
  snapshot: ChromeCookie[] | null;
  poll: ReturnType<typeof setInterval> | null;
  polling: boolean;
  /** `open` until the import is decided; `closing` while finish/cancel run. */
  phase: 'open' | 'closing' | 'ended';
  exited: boolean;
  exitWaiters: Array<() => void>;
}

export function spawnChrome(executable: string, args: string[]): ChromeChild {
  // Chrome reads DevTools commands on fd 3 and answers on fd 4.
  const child = nodeSpawn(executable, args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'], windowsHide: false, env: chromeEnvironment(process.env) });
  child.on('error', () => { /* Reported through the exit listener. */ });
  return {
    input: child.stdio[3] as Writable,
    output: child.stdio[4] as Readable,
    onExit: (listener) => { child.once('exit', listener); child.once('error', listener); },
    kill: () => { try { child.kill(); } catch { /* already gone */ } },
  };
}

export class ChromeSignin {
  private readonly sessions = new Map<string, Session>();
  private readonly results = new Map<string, ChromeSigninStatus>();

  constructor(private readonly options: {
    home: string;
    spawn?: ChromeSpawn;
    platform?: NodeJS.Platform;
    exists?: (file: string) => boolean;
    pollMs?: number;
    /** How long a browser gets to close on its own before it is killed. */
    exitGraceMs?: number;
    log?: (line: string) => void;
  }) {}

  private get log(): (line: string) => void { return this.options.log ?? ((line) => console.log(`[native-browser] ${line}`)); }

  status(profileId: string): ChromeSigninStatus {
    const id = profileIdOf(profileId);
    if (this.sessions.has(id)) return { state: 'open' };
    return this.results.get(id) ?? { state: 'idle' };
  }

  async start(profileId: string, request: { executable: unknown; url?: unknown }, jar: CookieJar): Promise<ChromeSigninStatus> {
    const id = profileIdOf(profileId);
    if (this.sessions.has(id)) return { state: 'open' };
    const platform = this.options.platform ?? process.platform;
    if (!acceptableChromeExecutable(request.executable, platform)) {
      throw new BrowserCommandError('This browser cannot be used to sign in.', 422);
    }
    const exists = this.options.exists ?? ((file: string) => { try { return statSync(file).isFile(); } catch { return false; } });
    if (!exists(request.executable)) throw new BrowserCommandError('The browser is no longer installed at the detected location.', 409);
    const url = request.url === undefined ? DEFAULT_SIGNIN_URL : browserUrlOf(request.url);
    // A dedicated directory, never the user's own Chrome profile: recent Chrome ignores remote
    // debugging flags on the default profile, and the sign-in must not touch personal data.
    const userDataDir = join(this.options.home, 'browser-profiles', id, 'chrome');
    if (!existsSync(userDataDir)) mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
    const child = (this.options.spawn ?? spawnChrome)(request.executable, chromeLaunchArguments(userDataDir, url));
    const session: Session = {
      child, jar, frames: new PipeFrames(), pending: new Map(), nextId: 1, snapshot: null,
      poll: null, polling: false, phase: 'open', exited: false, exitWaiters: [],
    };
    this.sessions.set(id, session);
    this.results.delete(id);
    child.output.on('data', (chunk: Buffer) => this.receive(session, chunk));
    child.output.on('error', () => { /* The exit listener reports it. */ });
    child.input.on('error', () => { /* Same: a closed pipe means the browser is gone. */ });
    child.onExit(() => void this.exited(id, session));
    session.poll = setInterval(() => void this.collect(session), this.options.pollMs ?? POLL_MS);
    session.poll.unref?.();
    void this.collect(session);
    return { state: 'open' };
  }

  /** Copies the cookies read so far into the browser session, then closes the window. */
  async finish(profileId: string): Promise<ChromeSigninStatus> {
    return this.close(profileIdOf(profileId), true);
  }

  /** Closes the window and drops what it held. */
  async cancel(profileId: string): Promise<ChromeSigninStatus> {
    return this.close(profileIdOf(profileId), false);
  }

  /** App quit: a sign-in that is not finished yet is not lost. */
  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.sessions.keys()].map((id) => this.close(id, true)));
  }

  private async close(id: string, keep: boolean): Promise<ChromeSigninStatus> {
    const session = this.sessions.get(id);
    if (!session || session.phase !== 'open') return this.status(id);
    session.phase = 'closing';
    if (session.poll) clearInterval(session.poll);
    session.poll = null;
    let cookies = session.snapshot;
    if (keep && !session.exited) {
      try { cookies = await this.fetchCookies(session); } catch { /* the previous reading stands */ }
    }
    if (!session.exited) {
      void this.send(session, 'Browser.close').catch(() => {});
      await this.waitForExit(session, this.options.exitGraceMs ?? EXIT_TIMEOUT_MS);
      if (!session.exited) session.child.kill();
    }
    // Finishing with nothing read is a failure the user must hear about, not a silent no-op.
    return this.end(id, session, keep ? cookies : null, keep);
  }

  private async exited(id: string, session: Session): Promise<void> {
    session.exited = true;
    for (const [, pending] of session.pending) { clearTimeout(pending.timer); pending.reject(new Error('The browser closed.')); }
    session.pending.clear();
    for (const waiter of session.exitWaiters.splice(0)) waiter();
    // The user closed the window themselves: what the last reading saw is what they signed in with.
    if (session.phase === 'open') {
      if (session.poll) clearInterval(session.poll);
      session.poll = null;
      session.phase = 'closing';
      await this.end(id, session, session.snapshot, true);
    }
  }

  private async end(id: string, session: Session, cookies: ChromeCookie[] | null, windowClosed = false): Promise<ChromeSigninStatus> {
    if (session.phase === 'ended') return this.status(id);
    session.phase = 'ended';
    let result: ChromeSigninStatus;
    if (cookies === null && windowClosed && session.snapshot === null) {
      result = { state: 'failed', error: 'No sign-in could be read from the browser.' };
    } else if (cookies === null) {
      result = { state: 'idle' };
    } else {
      const now = Date.now();
      const details = cookies.map((cookie) => electronCookieFrom(cookie, now));
      const accepted = details.filter((entry): entry is CookiesSetDetails => entry !== null);
      const stored = await Promise.allSettled(accepted.map((entry) => session.jar.set(entry)));
      const imported = stored.filter((entry) => entry.status === 'fulfilled').length;
      result = { state: 'finished', imported, skipped: cookies.length - imported };
      this.log(`Chrome sign-in finished for ${id}: ${imported} cookie(s) copied, ${result.skipped} left behind`);
    }
    this.sessions.delete(id);
    if (result.state !== 'idle') this.results.set(id, result);
    else this.results.delete(id);
    return result;
  }

  private async collect(session: Session): Promise<void> {
    if (session.polling || session.exited || session.phase !== 'open') return;
    session.polling = true;
    try { session.snapshot = await this.fetchCookies(session); }
    catch { /* The browser is starting or closing; the next tick tries again. */ }
    finally { session.polling = false; }
  }

  private async fetchCookies(session: Session): Promise<ChromeCookie[]> {
    const result = await this.send(session, 'Storage.getCookies') as { cookies?: unknown };
    return Array.isArray(result?.cookies) ? result.cookies as ChromeCookie[] : [];
  }

  private send(session: Session, method: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (session.exited) { reject(new Error('The browser closed.')); return; }
      const id = session.nextId++;
      const timer = setTimeout(() => {
        session.pending.delete(id);
        reject(new Error(`${method} timed out.`));
      }, COMMAND_TIMEOUT_MS);
      session.pending.set(id, { resolve, reject, timer });
      try { session.child.input.write(framePipeMessage({ id, method, params: {} })); }
      catch (error) {
        clearTimeout(timer); session.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private receive(session: Session, chunk: Buffer): void {
    let messages: string[];
    try { messages = session.frames.push(chunk); }
    catch { session.child.kill(); return; }
    for (const text of messages) {
      let message: { id?: unknown; result?: unknown; error?: { message?: unknown } };
      try { message = JSON.parse(text); } catch { continue; }
      if (typeof message.id !== 'number') continue;
      const pending = session.pending.get(message.id);
      if (!pending) continue;
      session.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(String(message.error.message ?? 'DevTools error.')));
      else pending.resolve(message.result);
    }
  }

  private waitForExit(session: Session, timeoutMs: number): Promise<void> {
    if (session.exited) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      session.exitWaiters.push(() => { clearTimeout(timer); resolve(); });
    });
  }
}
