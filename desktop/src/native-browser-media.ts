import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BrowserWindow, session, type WebContents } from 'electron';
import { BrowserCommandError, profileIdOf } from './native-browser-protocol.js';
import { mediaPage } from './native-browser-media-page.js';

export type BrowserMediaSource = { webContents: WebContents; width: number; height: number };
interface MediaSession {
  id: string; profileId: string; actor: string; tabId: number;
  window: BrowserWindow; expiresAt: number; reading: boolean;
  source: WebContents; onSourceDestroyed: () => void;
}

/** Capture only the authorized WebContents. Never capture the host screen, mic or system audio. */
export class NativeBrowserMedia {
  private readonly sessions = new Map<string, MediaSession>();
  private readonly sweep: ReturnType<typeof setInterval>;
  private pending = 0;
  private closed = false;
  private page: Promise<string> | null = null;
  private readonly captureSession = session.fromPartition('timon-browser-capture');
  private readonly captures = new Map<number, { window: BrowserWindow; source: WebContents; audio: boolean }>();
  private readonly starts = new Map<string, { profileId: string; window?: BrowserWindow; cancelled: boolean }>();
  constructor(private readonly home: string, private readonly source: (profileId: string) => BrowserMediaSource) {
    const permits = (wc: WebContents | null, permission: string) => !!wc && this.captures.has(wc.id)
      && (permission === 'media' || permission === 'display-capture');
    this.captureSession.setPermissionCheckHandler(permits);
    this.captureSession.setPermissionRequestHandler((wc, permission, callback) => callback(permits(wc, permission)));
    this.captureSession.setDisplayMediaRequestHandler((request, callback) => {
      const capture = [...this.captures.values()].find(value => !value.window.isDestroyed()
        && request.frame === value.window.webContents.mainFrame);
      if (!capture || capture.source.isDestroyed() || !request.videoRequested
        || request.audioRequested && !capture.audio) { callback({}); return; }
      callback({ video: capture.source.mainFrame,
        ...(request.audioRequested ? { audio: capture.source.mainFrame } : {}), enableLocalEcho: false });
    });
    this.sweep = setInterval(() => {
      for (const value of this.sessions.values()) {
        if (value.expiresAt <= Date.now() || value.window.isDestroyed()) this.stop(value.id);
      }
    }, 5000);
    this.sweep.unref();
  }

  async command(body: Record<string, unknown>): Promise<unknown> {
    const profileId = profileIdOf(body.profileId);
    const actor = body.mediaActor;
    if (typeof actor !== 'string' || actor.length < 8 || actor.length > 300) throw new BrowserCommandError('Invalid media viewer.', 403);
    if (body.action === 'mediaStart' || body.action === 'mediaOffer') {
      if (this.closed) throw new BrowserCommandError('Browser capture is shutting down.', 503);
      const key = `${profileId}:${actor}`;
      if (this.starts.has(key)) throw new BrowserCommandError('A browser stream is already starting.', 409);
      if (this.sessions.size + this.pending >= 12) throw new BrowserCommandError('Too many active browser streams.', 429);
      const offer = body.action === 'mediaOffer' ? body.offer as { type?: unknown; sdp?: unknown } : undefined;
      if (offer && (offer.type !== 'offer' || typeof offer.sdp !== 'string' || offer.sdp.length > 128_000)) throw new BrowserCommandError('Invalid browser stream offer.');
      if (body.action === 'mediaOffer' && !offer) throw new BrowserCommandError('A browser stream offer is required.');
      if (body.supportedMimeTypes !== undefined && (!Array.isArray(body.supportedMimeTypes) || body.supportedMimeTypes.length > 12
        || body.supportedMimeTypes.some(type => typeof type !== 'string' || type.length > 128))) throw new BrowserCommandError('Invalid browser video formats.');
      for (const value of this.sessions.values()) if (value.profileId === profileId && value.actor === actor) this.stop(value.id);
      this.pending++;
      const pending: { profileId: string; window?: BrowserWindow; cancelled: boolean } = { profileId, cancelled: false };
      this.starts.set(key, pending);
      let window: BrowserWindow | undefined;
      try {
        const source = this.source(profileId);
        const mediaId = randomUUID();
        window = new BrowserWindow({ show: false, skipTaskbar: true, width: 320, height: 240,
          webPreferences: { session: this.captureSession, sandbox: true, contextIsolation: true, nodeIntegration: false,
            backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
        pending.window = window;
        const captureId = window.webContents.id;
        this.captures.set(captureId, { window, source: source.webContents, audio: body.audio === true });
        window.once('closed', () => this.captures.delete(captureId));
        window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
        window.webContents.on('will-navigate', event => event.preventDefault());
        const file = await this.preparePage();
        if (pending.cancelled) throw new Error('Browser capture was cancelled.');
        await window.loadFile(file);
        const result = await this.bounded(window.webContents.executeJavaScript(
          `window.timonMedia.start(${body.audio === true},${JSON.stringify(offer ?? null)},${JSON.stringify(body.supportedMimeTypes ?? null)},${source.width},${source.height}).catch(error => { throw new Error([error?.name, error?.message].filter(Boolean).join(': ') || String(error)); })`, true), 15_000);
        if (pending.cancelled || source.webContents.isDestroyed()) throw new Error('Browser capture was cancelled.');
        const onSourceDestroyed = () => this.stop(mediaId);
        this.sessions.set(mediaId, { id: mediaId, profileId, actor, tabId: source.webContents.id, window, expiresAt: Date.now() + 60_000, reading: false,
          source: source.webContents, onSourceDestroyed });
        source.webContents.once('destroyed', onSourceDestroyed);
        return { ...result, mediaId, tabId: String(source.webContents.id), width: source.width, height: source.height };
      } catch (error) {
        if (window && !window.isDestroyed()) window.destroy();
        throw new BrowserCommandError(pending.cancelled ? 'Browser capture was cancelled.' : `Browser stream could not start: ${(error as Error)?.message || String(error)}`, 503);
      } finally { this.pending--; this.starts.delete(key); }
    }
    const media = typeof body.mediaId === 'string' ? this.sessions.get(body.mediaId) : undefined;
    if (!media || media.profileId !== profileId || media.actor !== actor || media.expiresAt <= Date.now()) {
      throw new BrowserCommandError('Browser stream not found or expired.', 404);
    }
    if (body.action === 'mediaStop') { this.stop(media.id); return { stopped: true }; }
    media.expiresAt = Date.now() + 60_000;
    if (body.action === 'mediaRenew') return { renewed: true };
    if (body.action !== 'mediaRead') throw new BrowserCommandError('Unknown browser stream command.');
    if (media.reading) throw new BrowserCommandError('A browser stream read is already pending.', 409);
    media.reading = true;
    try { return await this.bounded(media.window.webContents.executeJavaScript('window.timonMedia.read()'), 2000); }
    catch (error) { this.stop(media.id); throw new BrowserCommandError((error as Error).message, 503); }
    finally { media.reading = false; }
  }

  private bounded<T>(work: Promise<T>, timeout: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Browser capture timed out.')), timeout);
      work.then(resolve, reject).finally(() => clearTimeout(timer));
    });
  }
  private preparePage(): Promise<string> {
    if (!this.page) this.page = (async () => {
      const directory = join(this.home, 'browser-native');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const file = join(directory, 'capture.html');
      await writeFile(file, mediaPage, { mode: 0o600 });
      return file;
    })().catch(error => { this.page = null; throw error; });
    return this.page;
  }
  stop(id: string): void {
    const value = this.sessions.get(id);
    if (!value) return;
    this.sessions.delete(id);
    value.source.removeListener('destroyed', value.onSourceDestroyed);
    if (!value.window.isDestroyed()) value.window.destroy();
  }
  closeProfile(profileId: string): void {
    for (const value of this.starts.values()) if (value.profileId === profileId) {
      value.cancelled = true;
      if (value.window && !value.window.isDestroyed()) value.window.destroy();
    }
    for (const value of this.sessions.values()) if (value.profileId === profileId) this.stop(value.id);
  }
  close(): void {
    this.closed = true;
    for (const value of this.starts.values()) {
      value.cancelled = true;
      if (value.window && !value.window.isDestroyed()) value.window.destroy();
    }
    clearInterval(this.sweep);
    for (const id of this.sessions.keys()) this.stop(id);
  }
}
