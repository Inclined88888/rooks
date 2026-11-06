/**
 * The views of the annotation bubble and its pins (TODO #481), laid over the page's view in the
 * window that presents the browser. Never a node in the page: the page cannot see, style or click
 * them, and what is typed in the bubble never reaches it (focus emulation keeps the page focused).
 *
 * One renderer for everything: the bubble's view is created once and reused (spike #481: 3-4 ms
 * reused against 35-65 ms created, about 92 MB per renderer), and each pin is a window the bubble's
 * document opens, so all of them live in its process. Closing ends that renderer for good:
 * `removeChildView` alone would leave it running.
 *
 * Stacking: the last child of the window's content view is on top. Re-presenting the page (an
 * attach, a tab or popup shown) adds the page's view again, above the overlay: `raise()` follows.
 */

import { session as electronSession, WebContentsView, type BrowserWindow, type IpcMainEvent, type Rectangle, type Session, type WebContents } from 'electron';
import {
  BUBBLE_MAX_QUEUE, BUBBLE_PINS_CHANNEL, BUBBLE_SHOW_CHANNEL, BUBBLE_STATE_CHANNEL, PIN_FRAME,
  type BubbleShow, type BubbleSurface, type PanelRect,
} from './native-browser-bubble.js';

/** In memory, no persistence: the bubble keeps nothing of its own between runs. */
export const BUBBLE_PARTITION = 'timon-annotation-bubble';

const configured = new WeakSet<Session>();

/** The bubble's session reaches nothing: no request leaves it, no permission is granted. */
function bubbleSession(): Session {
  const ses = electronSession.fromPartition(BUBBLE_PARTITION);
  if (configured.has(ses)) return ses;
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !details.url.startsWith('data:') && details.url !== 'about:blank' });
  });
  configured.add(ses);
  return ses;
}

const VIEW_PREFERENCES = {
  sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false,
  webviewTag: false, backgroundThrottling: false, spellcheck: false, navigateOnDragDrop: false, safeDialogs: true,
} as const;

interface Pin { view: WebContentsView | null; bounds: Rectangle | null; number: number }

export interface AnnotationOverlayOptions {
  /** Absolute path of the bubble's preload. */
  preload: string;
  /** The bubble's document, built when its view is created (language and scheme of that moment). */
  document: () => string;
  /** The bubble's view went away on its own (renderer gone): the controller forgets it was shown. */
  onGone?: () => void;
}

export class AnnotationOverlay implements BubbleSurface {
  private bubble: WebContentsView | null = null;
  private ready: Promise<void> | null = null;
  private markReady: (() => void) | null = null;
  private window: BrowserWindow | null = null;
  private bubbleBounds: Rectangle | null = null;
  private bubbleShown = false;
  private readonly pins = new Map<string, Pin>();
  private wanted: Array<{ key: string; number: number }> = [];

  constructor(private readonly options: AnnotationOverlayOptions) {}

  /** The bubble's own main frame, and nothing else: not a pin, not the page, not the UI. */
  isBubbleSender(event: Pick<IpcMainEvent, 'sender' | 'senderFrame'>): boolean {
    const contents = this.bubble?.webContents;
    return !!contents && !contents.isDestroyed() && event.sender === contents && event.senderFrame === contents.mainFrame;
  }

  /** The bubble's first message: its listeners are set, what it is sent now is not lost. */
  bubbleReady(): void { this.markReady?.(); this.markReady = null; }

  get bubbleContents(): WebContents | null { return this.bubble && !this.bubble.webContents.isDestroyed() ? this.bubble.webContents : null; }

  /** The views the overlay shows, in stacking order (for the smoke test and diagnostics). */
  views(): { bubble: WebContentsView | null; pins: WebContentsView[] } {
    return { bubble: this.bubbleShown ? this.bubble : null, pins: [...this.pins.values()].flatMap((pin) => (pin.view && pin.bounds ? [pin.view] : [])) };
  }

  /** Presented in `window` (again): what is shown is put back on top of the page. */
  attach(window: BrowserWindow): void {
    if (this.window && this.window !== window) this.detach();
    this.window = window;
    if (this.wanted.length && !this.bubble) this.ensure();
    this.raise();
  }

  /** The page is no longer presented (a dialog, a drag, the panel closed): the views leave the window, alive. */
  detach(): void {
    const window = this.window;
    this.window = null;
    if (!window || window.isDestroyed()) return;
    if (this.bubble) window.contentView.removeChildView(this.bubble);
    for (const pin of this.pins.values()) if (pin.view) window.contentView.removeChildView(pin.view);
  }

  /** Above the page's view, pins first and the bubble last: the bubble covers a pin, never the reverse. */
  raise(): void {
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    for (const pin of this.pins.values()) {
      if (!pin.view) continue;
      if (pin.bounds) { window.contentView.addChildView(pin.view); pin.view.setBounds(pin.bounds); }
      else window.contentView.removeChildView(pin.view);
    }
    if (this.bubble && this.bubbleShown && this.bubbleBounds) {
      window.contentView.addChildView(this.bubble);
      this.bubble.setBounds(this.bubbleBounds);
    }
  }

  showBubble(bounds: PanelRect, show: BubbleShow): void {
    const view = this.ensure();
    if (!view) return;
    this.bubbleBounds = bounds;
    this.bubbleShown = true;
    this.raise();
    view.webContents.focus();
    this.post(BUBBLE_SHOW_CHANNEL, show);
  }

  updateBubble(state: Partial<BubbleShow>): void {
    if (this.bubbleShown) this.post(BUBBLE_STATE_CHANNEL, state);
  }

  moveBubble(bounds: PanelRect): void {
    this.bubbleBounds = bounds;
    if (this.bubbleShown && this.bubble && this.window) this.bubble.setBounds(bounds);
  }

  hideBubble(): void {
    this.bubbleShown = false;
    if (this.bubble && this.window && !this.window.isDestroyed()) this.window.contentView.removeChildView(this.bubble);
  }

  setPins(pins: Array<{ key: string; number: number }>): void {
    this.wanted = pins.slice(0, BUBBLE_MAX_QUEUE);
    const keys = new Set(this.wanted.map((pin) => pin.key));
    for (const [key, pin] of this.pins) {
      if (keys.has(key)) continue;
      this.dropPin(key, pin);
    }
    for (const { key, number } of this.wanted) {
      const pin = this.pins.get(key);
      if (pin) pin.number = number;
      else this.pins.set(key, { view: null, bounds: null, number });
    }
    // No pin, no bubble: nothing is created only to draw an empty list.
    if (!this.wanted.length && !this.bubble) return;
    if (!this.window) return;
    this.ensure();
    this.post(BUBBLE_PINS_CHANNEL, this.wanted);
  }

  movePin(key: string, bounds: PanelRect | null): void {
    const pin = this.pins.get(key);
    if (!pin) return;
    pin.bounds = bounds;
    const window = this.window;
    if (!pin.view || !window || window.isDestroyed()) return;
    if (!bounds) { window.contentView.removeChildView(pin.view); return; }
    if (!window.contentView.children.includes(pin.view)) {
      window.contentView.addChildView(pin.view);
      // A pin never goes over the open bubble.
      if (this.bubbleShown && this.bubble) window.contentView.addChildView(this.bubble);
    }
    pin.view.setBounds(bounds);
  }

  /** Annotate mode ended: every view leaves the window and the renderer ends. */
  close(): void {
    this.detach();
    for (const [key, pin] of this.pins) this.dropPin(key, pin);
    this.wanted = [];
    const view = this.bubble;
    this.bubble = null;
    this.ready = null;
    this.markReady = null;
    this.bubbleShown = false;
    if (view && !view.webContents.isDestroyed()) view.webContents.close();
  }

  private dropPin(key: string, pin: Pin): void {
    this.pins.delete(key);
    if (!pin.view) return;
    if (this.window && !this.window.isDestroyed()) this.window.contentView.removeChildView(pin.view);
    if (!pin.view.webContents.isDestroyed()) pin.view.webContents.close();
  }

  private post(channel: string, value: unknown): void {
    const ready = this.ready;
    const view = this.bubble;
    if (!ready || !view) return;
    void ready.then(() => { if (this.bubble === view && !view.webContents.isDestroyed()) view.webContents.send(channel, value); });
  }

  /** The bubble's view, created on first use and kept until `close()`. */
  private ensure(): WebContentsView | null {
    if (this.bubble && !this.bubble.webContents.isDestroyed()) return this.bubble;
    const view = new WebContentsView({ webPreferences: { ...VIEW_PREFERENCES, session: bubbleSession(), preload: this.options.preload } });
    view.setBackgroundColor('#00000000');
    const contents = view.webContents;
    this.bubble = view;
    this.ready = new Promise<void>((resolve) => { this.markReady = resolve; });
    contents.on('will-navigate', (event) => event.preventDefault());
    contents.on('will-redirect', (event) => event.preventDefault());
    contents.on('render-process-gone', () => {
      if (this.bubble !== view) return;
      this.close();
      this.options.onGone?.();
    });
    // A pin is a window of the bubble's document: same renderer, no URL, nothing it can navigate to.
    contents.setWindowOpenHandler(({ url, frameName }) => {
      const key = PIN_FRAME.exec(frameName)?.[1];
      const pin = key ? this.pins.get(key) : undefined;
      if (!key || !pin || pin.view || (url !== '' && url !== 'about:blank')) return { action: 'deny' };
      return {
        action: 'allow',
        createWindow: (options) => {
          // Electron supplies the window's own contents (not in its v33 public option type):
          // adopting it keeps the opener, hence the same renderer as the bubble.
          const guest = (options as typeof options & { webContents?: WebContents }).webContents;
          const child = new WebContentsView(guest ? { webContents: guest } : { webPreferences: { ...VIEW_PREFERENCES, session: bubbleSession() } });
          child.setBackgroundColor('#00000000');
          child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
          child.webContents.on('will-navigate', (event) => event.preventDefault());
          child.webContents.on('destroyed', () => { if (this.pins.get(key)?.view === child) this.pins.get(key)!.view = null; });
          const current = this.pins.get(key);
          if (current) {
            current.view = child;
            this.movePin(key, current.bounds);
          }
          return child.webContents;
        },
      };
    });
    void contents.loadURL(`data:text/html;base64,${Buffer.from(this.options.document()).toString('base64')}`).catch((error: Error) => {
      console.error('[native-browser] Annotation bubble did not load', error.message);
    });
    return view;
  }
}
