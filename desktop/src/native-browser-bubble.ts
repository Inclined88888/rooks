/**
 * The comment bubble and the numbered pins of annotate mode on the desktop (TODO #481), without
 * Electron: placement, the bubble's messages, its document, and the queue it fills.
 *
 * The bubble is Timon's own view laid over the page (never a node in it): what the user types there
 * reaches neither the page nor its preload. A click on an element opens it anchored on that element;
 * Enter adds the annotation to the queue and leaves a numbered pin, Shift+Enter breaks the line,
 * Escape closes it; "Send (N)" adds the one being typed, then posts the whole queue as one turn of
 * the conversation the browser is open for (`POST …/:profileId/annotations/post`, volet 2).
 *
 * Every queued annotation is sealed by the daemon as a draft as soon as it is added: the desktop
 * hands it over with its comment (`annotateCollect`), under the capture's own id, so the bubble
 * edits and removes it by that name (`ba-<capture id>`) whoever collected it.
 */

import type { AnnotationCapture, AnnotationRect } from './native-browser-annotator.js';
import { ANNOTATION_MAX_PICKS } from './native-browser-annotator.js';
import { shellText } from './shell-i18n.js';

/** Bubble → main process; the main process checks the sender is the bubble's own main frame. */
export const BUBBLE_CHANNEL = 'timon:annotation-bubble';
/** Main process → bubble: what to show, a state change, the pins to draw. */
export const BUBBLE_SHOW_CHANNEL = 'timon:annotation-bubble-show';
export const BUBBLE_STATE_CHANNEL = 'timon:annotation-bubble-state';
export const BUBBLE_PINS_CHANNEL = 'timon:annotation-bubble-pins';
/** Tab preload: which picked elements to follow, and their rectangles as the page scrolls. */
export const BROWSER_ANNOTATE_TRACK_CHANNEL = 'timon:annotate-track';

export const BUBBLE_WIDTH = 320;
export const BUBBLE_DEFAULT_HEIGHT = 156;
export const BUBBLE_MIN_HEIGHT = 96;
export const BUBBLE_MAX_HEIGHT = 360;
/** Between the element and the bubble. */
export const BUBBLE_GAP = 8;
/** Kept between the bubble and the edge of the page's panel. */
export const BUBBLE_EDGE = 4;
/** A pin's view: a 22 px disc and room for its shadow. */
export const PIN_SIZE = 26;
/** The annotations one bubble queue holds; past it a new pick is refused, as the engine's picks are. */
export const BUBBLE_MAX_QUEUE = ANNOTATION_MAX_PICKS;
export const BUBBLE_TEXT_MAX = 4_000;
/** Pins and bubbles are named by the capture's UUID; anchors by the preload's counter. */
const CAPTURE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ANCHOR = /^a\d{1,6}$/;
export const PIN_FRAME = /^pin-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export interface PanelRect { x: number; y: number; width: number; height: number }

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

/**
 * Below the element, above it when there is no room, clamped inside the page's panel; window
 * coordinates. One CSS pixel of the page is one DIP of the window (the engine forces device scale 1).
 * An element scrolled out of view keeps its bubble at the panel's edge: what is being typed stays.
 */
export function bubbleBounds(anchor: AnnotationRect | null, panel: PanelRect, height = BUBBLE_DEFAULT_HEIGHT): PanelRect {
  const width = Math.max(120, Math.min(BUBBLE_WIDTH, panel.width - 2 * BUBBLE_EDGE));
  const tall = Math.max(BUBBLE_MIN_HEIGHT, Math.min(height, BUBBLE_MAX_HEIGHT, panel.height - 2 * BUBBLE_EDGE));
  const bottom = panel.height - BUBBLE_EDGE - tall;
  let x = BUBBLE_EDGE + 12;
  let y = BUBBLE_EDGE + 12;
  if (anchor) {
    const below = anchor.y + anchor.height + BUBBLE_GAP;
    const above = anchor.y - BUBBLE_GAP - tall;
    y = below <= bottom ? below : above >= BUBBLE_EDGE ? above : below;
    x = anchor.x;
  }
  return {
    x: panel.x + Math.round(clamp(x, BUBBLE_EDGE, panel.width - BUBBLE_EDGE - width)),
    y: panel.y + Math.round(clamp(y, BUBBLE_EDGE, bottom)),
    width: Math.round(width), height: Math.round(tall),
  };
}

/** Whether any part of the element is inside the page's viewport. */
export function rectInView(rect: AnnotationRect, panel: Pick<PanelRect, 'width' | 'height'>): boolean {
  return rect.width >= 0 && rect.height >= 0 && rect.x + rect.width > 0 && rect.y + rect.height > 0
    && rect.x < panel.width && rect.y < panel.height;
}

/** A pin on the element's top-left corner, kept inside the panel; null while the element is out of view. */
export function pinBounds(anchor: AnnotationRect | null, panel: PanelRect): PanelRect | null {
  if (!anchor || !rectInView(anchor, panel)) return null;
  const half = PIN_SIZE / 2;
  return {
    x: panel.x + Math.round(clamp(anchor.x - half + 4, 0, panel.width - PIN_SIZE)),
    y: panel.y + Math.round(clamp(anchor.y - half + 4, 0, panel.height - PIN_SIZE)),
    width: PIN_SIZE, height: PIN_SIZE,
  };
}

// ---------------------------------------------------------------------------------------------
// Messages.

export type BubbleMessage =
  | { type: 'ready' }
  /** What is being typed, on every input: kept in memory so that a click elsewhere does not lose it. */
  | { type: 'draft'; text: string }
  /** Enter or "Add" (a new annotation), "Save" (one reopened from its pin). */
  | { type: 'add'; text: string }
  | { type: 'send'; text: string }
  | { type: 'cancel' }
  | { type: 'remove' }
  | { type: 'height'; height: number }
  | { type: 'pin'; key: string };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.length <= BUBBLE_TEXT_MAX * 2 ? value.slice(0, BUBBLE_TEXT_MAX) : null;
}

/** One message of the bubble's preload, or null: anything unexpected is dropped, never trimmed into something else. */
export function bubbleMessageOf(raw: unknown): BubbleMessage | null {
  if (!isPlainObject(raw) || typeof raw.type !== 'string') return null;
  switch (raw.type) {
    case 'ready': case 'cancel': case 'remove': return { type: raw.type };
    case 'draft': case 'add': case 'send': {
      const text = textOf(raw.text);
      return text === null ? null : { type: raw.type, text };
    }
    case 'height':
      return typeof raw.height === 'number' && Number.isFinite(raw.height) && raw.height > 0 && raw.height < 10_000
        ? { type: 'height', height: Math.round(raw.height) } : null;
    case 'pin':
      return typeof raw.key === 'string' && CAPTURE_ID.test(raw.key) ? { type: 'pin', key: raw.key } : null;
    default: return null;
  }
}

/** The preload's anchor of a pick (`a<n>`), or null. */
export function anchorOf(raw: unknown): string | null {
  const anchor = isPlainObject(raw) ? raw.anchor : undefined;
  return typeof anchor === 'string' && ANCHOR.test(anchor) ? anchor : null;
}

/** The rectangles the preload reports for the anchors it follows; an element gone from the page is `null`. */
export function anchorRectsOf(raw: unknown): Array<{ anchor: string; rect: AnnotationRect | null }> | null {
  if (!isPlainObject(raw) || raw.type !== 'rects' || !Array.isArray(raw.rects) || raw.rects.length > BUBBLE_MAX_QUEUE + 1) return null;
  const out: Array<{ anchor: string; rect: AnnotationRect | null }> = [];
  for (const entry of raw.rects) {
    if (!isPlainObject(entry) || typeof entry.anchor !== 'string' || !ANCHOR.test(entry.anchor)) return null;
    if (entry.rect === null) { out.push({ anchor: entry.anchor, rect: null }); continue; }
    const rect = isPlainObject(entry.rect) ? entry.rect : null;
    const numbers = rect ? [rect.x, rect.y, rect.width, rect.height] : [];
    if (numbers.length !== 4 || !numbers.every((n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 1e6)) return null;
    const [x, y, width, height] = numbers as [number, number, number, number];
    out.push({ anchor: entry.anchor, rect: { x, y, width: Math.max(0, width), height: Math.max(0, height) } });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Copy and document.

export interface BubbleCopy {
  placeholder: string; add: string; save: string; remove: string; send: string; sending: string;
  hint: string; noConversation: string; sendFailed: string; saveFailed: string; pinTitle: string; full: string;
  /** `<html lang dir>` of the bubble: the language these words are in. */
  lang: string; dir: 'ltr' | 'rtl';
}

/**
 * The bubble speaks the app's language (sent with the presentation), the
 * shell's otherwise. `{count}` stays in `send` and `pinTitle`: the page
 * puts the number in itself.
 */
export function bubbleCopy(locale: string | null | undefined): BubbleCopy {
  const t = shellText(locale);
  return {
    placeholder: t('bubble.placeholder'), add: t('bubble.add'), save: t('bubble.save'), remove: t('bubble.remove'),
    send: t('bubble.send'), sending: t('bubble.sending'),
    hint: t('bubble.hint'),
    noConversation: t('bubble.noConversation'),
    sendFailed: t('bubble.sendFailed'), saveFailed: t('bubble.saveFailed'),
    pinTitle: t('bubble.pinTitle'), full: t('bubble.full'),
    lang: t.tag, dir: t.dir,
  };
}

export type BubbleScheme = 'light' | 'dark';

/** JSON inside a `<script>`: nothing in it can close the element. */
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

const PALETTE: Record<BubbleScheme, Record<string, string>> = {
  light: { surface: '#ffffff', text: '#1f2328', muted: '#5f6670', field: '#f3f4f6', accent: '#2563eb', accentText: '#ffffff', danger: '#b42318', shadow: 'rgba(15,23,42,.22)', ring: 'rgba(15,23,42,.08)' },
  dark: { surface: '#1f2430', text: '#e8eaf0', muted: '#a3a9b6', field: '#2a3040', accent: '#3b82f6', accentText: '#ffffff', danger: '#f97066', shadow: 'rgba(0,0,0,.5)', ring: 'rgba(255,255,255,.08)' },
};

/**
 * The bubble's document: self-contained, no network (`default-src 'none'`). Every word of the page
 * it shows (the element's label) is set as text, never as markup. The same renderer draws the pins:
 * each is a window it opens (`window.open`), so all of them share its one process.
 */
export function bubbleDocument(copy: BubbleCopy, scheme: BubbleScheme): string {
  const c = PALETTE[scheme];
    // The view clips at its bounds: shadows stay inside the card's 6 px margin, or their edge shows.
  const style = `html,body{margin:0;background:transparent;overflow:hidden}
*{box-sizing:border-box}
#card{margin:6px;border-radius:12px;background:${c.surface};color:${c.text};box-shadow:0 1px 4px ${c.shadow},0 0 0 1px ${c.ring};padding:10px;display:flex;flex-direction:column;gap:8px;font:13px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif}
#head{display:flex;align-items:center;gap:8px;min-width:0}
#number{flex:none;width:20px;height:20px;border-radius:10px;background:${c.accent};color:${c.accentText};font-size:11px;font-weight:600;display:flex;align-items:center;justify-content:center;font-variant-numeric:tabular-nums}
#label{color:${c.muted};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
#note{width:100%;min-height:44px;max-height:180px;resize:none;border:0;outline:0;border-radius:8px;background:${c.field};color:${c.text};padding:7px 9px;font:inherit}
#error{color:${c.danger};display:none}
#hint{color:${c.muted};font-size:11px}
#actions{display:flex;align-items:center;gap:6px}
#actions .grow{flex:1}
button{font:inherit;border:0;border-radius:8px;padding:5px 10px;cursor:pointer;background:${c.field};color:${c.text}}
button:disabled{opacity:.45;cursor:default}
#send{background:${c.accent};color:${c.accentText};font-variant-numeric:tabular-nums}
#remove{background:transparent;color:${c.danger};padding-left:4px;padding-right:4px;display:none}`;
  const pinStyle = `html,body{margin:0;background:transparent;overflow:hidden;cursor:pointer;user-select:none}
#pin{margin:2px;width:22px;height:22px;border-radius:11px;background:${c.accent};color:${c.accentText};box-shadow:0 1px 2px ${c.shadow};display:flex;align-items:center;justify-content:center;font:600 11px system-ui,-apple-system,"Segoe UI",sans-serif;font-variant-numeric:tabular-nums}`;
  const script = `(() => {
const copy = ${scriptJson(copy)};
const pinStyle = ${scriptJson(pinStyle)};
const api = window.timonBubble;
const $ = (id) => document.getElementById(id);
const note = $('note'), add = $('add'), send = $('send'), remove = $('remove'), error = $('error');
note.placeholder = copy.placeholder; $('hint').textContent = copy.hint; remove.textContent = copy.remove;
let state = { mode: 'new', queued: 0, canSend: true, busy: false, error: '' };
const count = () => state.queued + (state.mode === 'new' && note.value.trim() ? 1 : 0);
const render = () => {
  add.textContent = state.mode === 'edit' ? copy.save : copy.add;
  add.disabled = state.busy || !note.value.trim();
  send.textContent = state.busy ? copy.sending : copy.send.replace('{count}', String(count()));
  send.disabled = state.busy || !state.canSend || count() === 0;
  send.title = state.canSend ? '' : copy.noConversation;
  remove.style.display = state.mode === 'edit' ? 'inline-block' : 'none';
  remove.disabled = state.busy;
  note.readOnly = state.busy;
  const message = state.error || (state.canSend ? '' : copy.noConversation);
  error.textContent = message; error.style.display = message ? 'block' : 'none';
  requestAnimationFrame(() => api.height(Math.ceil($('card').getBoundingClientRect().height) + 12));
};
const fit = () => { note.style.height = 'auto'; note.style.height = Math.min(180, note.scrollHeight) + 'px'; };
const submit = () => { if (!state.busy && note.value.trim()) api.add(note.value); };
note.addEventListener('input', () => { fit(); api.draft(note.value); render(); });
note.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit(); }
  else if (event.key === 'Escape') { event.preventDefault(); api.cancel(); }
});
add.addEventListener('click', submit);
send.addEventListener('click', () => { if (!send.disabled) api.send(note.value); });
remove.addEventListener('click', () => { if (!state.busy) api.remove(); });
api.onShow((show) => {
  state = { mode: show.mode, queued: show.queued, canSend: show.canSend, busy: !!show.busy, error: show.error || '' };
  $('number').textContent = String(show.number);
  $('label').textContent = show.label;
  note.value = show.text;
  fit(); render();
  note.focus(); note.setSelectionRange(note.value.length, note.value.length);
});
api.onState((next) => {
  state = { ...state, ...next };
  if (typeof next.number === 'number') $('number').textContent = String(next.number);
  if (typeof next.text === 'string') { note.value = next.text; fit(); }
  render();
});
const pins = new Map();
api.onPins((list) => {
  const wanted = new Set(list.map((pin) => pin.key));
  for (const [key, win] of pins) if (!wanted.has(key)) { try { win.close(); } catch {} pins.delete(key); }
  for (const pin of list) {
    let win = pins.get(pin.key);
    if (!win || win.closed) {
      win = window.open('', 'pin-' + pin.key);
      if (!win) continue;
      const style = win.document.createElement('style'); style.textContent = pinStyle; win.document.head.append(style);
      const disc = win.document.createElement('div'); disc.id = 'pin'; win.document.body.replaceChildren(disc);
      win.document.addEventListener('mousedown', (event) => event.preventDefault());
      win.document.addEventListener('click', () => api.pin(pin.key));
      pins.set(pin.key, win);
    }
    win.document.getElementById('pin').textContent = String(pin.number);
    win.document.title = copy.pinTitle.replace('{count}', String(pin.number));
    win.document.body.title = win.document.title;
  }
});
api.ready();
})();`;
  return `<!doctype html><html lang="${copy.lang}" dir="${copy.dir}"><head><meta charset="utf-8">`
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; script-src \'unsafe-inline\'">'
    + `<style>${style}</style></head><body>`
    + '<div id="card"><div id="head"><span id="number"></span><span id="label"></span></div>'
    + '<textarea id="note" maxlength="4000" rows="2"></textarea><div id="error" role="alert"></div>'
    + '<div id="actions"><button id="remove" type="button"></button><span class="grow"></span>'
    + '<button id="add" type="button"></button><button id="send" type="button"></button></div>'
    + '<div id="hint"></div></div>'
    + `<script>${script}</script></body></html>`;
}

/** How the bubble names the element: tag, then its accessible name or its text. Page words, shown as text. */
export function bubbleLabel(capture: Pick<AnnotationCapture, 'target'>): string {
  const words = (capture.target.name || capture.target.text).replace(/\s+/g, ' ').trim();
  const short = words.length > 60 ? `${words.slice(0, 59)}…` : words;
  return short ? `<${capture.target.tag}> ${short}` : `<${capture.target.tag}>`;
}

// ---------------------------------------------------------------------------------------------
// The queue.

/** What the bubble is shown with. `queued` counts the annotations already in the queue. */
export interface BubbleShow {
  mode: 'new' | 'edit';
  number: number;
  label: string;
  text: string;
  queued: number;
  canSend: boolean;
  busy?: boolean;
  error?: string;
}

/** A capture queued from the bubble: the engine hands it to the daemon with its comment. */
export type QueuedCapture = AnnotationCapture & { comment: string; queued: true };

/** The conversation the browser is open for, as the app said when presenting it. */
export interface BubbleConversation {
  agent: string;
  mission: string | null;
  /** No mission and the chat is on "New conversation": the post starts a fresh session, not the agent's latest. */
  fresh?: boolean;
}

export interface RouteAnswer { status: number; body: unknown }
/** The daemon's annotation routes, called with the user's own session (`/api/ui/native-browser/…`). */
export type AnnotationRoutes = (method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown) => Promise<RouteAnswer>;

/** The only routes the bubble calls, with the methods it calls them with. */
const BUBBLE_ROUTES: ReadonlyArray<[RegExp, string]> = [
  [/^[a-z0-9_-]{1,128}\/annotation\/collect$/, 'POST'],
  [/^[a-z0-9_-]{1,128}\/annotations\/post$/, 'POST'],
  [/^annotations\/ba-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'PATCH'],
  [/^annotations\/ba-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'DELETE'],
];

/**
 * The bubble's routes over the Timon window's own session (its `timon_session` cookie): the daemon
 * sees the signed-in user and checks the profile is theirs, as for the app. Nothing but the four
 * annotation routes above can be reached this way.
 */
export function sessionAnnotationRoutes(fetch: (url: string, init: RequestInit) => Promise<Response>, origin: () => string): AnnotationRoutes {
  return async (method, path, body) => {
    if (!BUBBLE_ROUTES.some(([pattern, allowed]) => pattern.test(path) && allowed === method)) throw new Error(`Annotation route refused: ${method} ${path}`);
    const base = origin();
    if (!base) throw new Error('The Timon window is not open.');
    const response = await fetch(`${base}/api/ui/native-browser/${path}`, {
      method, credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(60_000),
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) as unknown };
  };
}

/** What the controller needs of the engine, for one profile. */
export interface BubbleHost {
  readonly profileId: string;
  /** The page's panel in window coordinates, or null while it is not presented. */
  panel(): PanelRect | null;
  conversation(): BubbleConversation | null;
  /** Hands a queued capture to the engine's picks, where `annotateCollect` finds it. */
  queuePick(capture: QueuedCapture): void;
  /** The queued capture still waiting on the desktop, not yet collected by the daemon. */
  pendingPick(id: string): QueuedCapture | undefined;
  dropPick(id: string): boolean;
  /** The anchors the preload of that tab must follow (the others follow none). */
  track(tabId: string, anchors: string[]): void;
  focusPage(): void;
  /** Typing in the bubble is activity: annotate mode must not end on idle meanwhile. */
  touch(): void;
  /** Annotate mode ends once the queue is sent. */
  stop(): void;
  routes: AnnotationRoutes | null;
}

/** What the controller draws, with the bubble's view and the pins' (Electron, `native-browser-annotation-overlay.ts`). */
export interface BubbleSurface {
  showBubble(bounds: PanelRect, show: BubbleShow): void;
  updateBubble(state: Partial<BubbleShow>): void;
  moveBubble(bounds: PanelRect): void;
  hideBubble(): void;
  setPins(pins: Array<{ key: string; number: number }>): void;
  movePin(key: string, bounds: PanelRect | null): void;
  close(): void;
}

interface QueueItem { id: string; tabId: string; anchor: string | null; rect: AnnotationRect | null; comment: string; label: string }
interface OpenNew {
  mode: 'new'; capture: Promise<AnnotationCapture | null>; tabId: string; anchor: string | null; rect: AnnotationRect | null; label: string;
  /** The tab's document it was picked in: added after a navigation, it keeps no anchor of the old one. */
  document: number;
  /** Set once it is being added: Enter twice, or Enter then Send, add it once. */
  result?: Promise<boolean>;
}
type Open = OpenNew | { mode: 'edit'; id: string };

const annotationId = (captureId: string) => `ba-${captureId}`;

function errorOf(answer: RouteAnswer, fallback: string): string {
  const body = answer.body;
  const message = isPlainObject(body) && typeof body.error === 'string' ? body.error.slice(0, 300) : '';
  return message || fallback;
}

/**
 * The bubble and its queue for one browser profile. Decides what a pick, a key, a button or a pin
 * click does; the engine (host) and the views (surface) carry it out.
 */
export class AnnotationBubbleController {
  private items: QueueItem[] = [];
  private open: Open | null = null;
  private text = '';
  private height = BUBBLE_DEFAULT_HEIGHT;
  private busy = false;
  private error = '';
  /** Between a pick in annotate mode and its end: only then are views drawn. */
  private live = false;
  /** The annotated tab: only its annotations have pins (an anchor names an element of one document). */
  private tabId = '';
  private readonly documents = new Map<string, number>();
  /** The collect in flight, which the next one waits for. */
  private collecting: Promise<boolean> | null = null;
  private copy: BubbleCopy;

  constructor(private readonly host: BubbleHost, private readonly surface: BubbleSurface, locale: string | null = null) {
    this.copy = bubbleCopy(locale);
  }

  setLocale(locale: string | null): void { this.copy = bubbleCopy(locale); }

  get queued(): number { return this.items.length; }
  get isOpen(): boolean { return this.open !== null; }
  /** The ids the daemon stores the queue under, in the order the user made it. */
  get annotationIds(): string[] { return this.items.map((item) => annotationId(item.id)); }

  /**
   * A click on an element. A bubble already open is settled first (decision of the night of
   * 27/10/2026): what was typed joins the queue, an empty draft is dropped. The capture may still be
   * running (source, thumbnail): the bubble shows at once and waits for it only when added.
   */
  picked(tabId: string, rect: AnnotationRect, label: string, anchor: string | null, capture: Promise<AnnotationCapture | null>): boolean {
    if (this.busy) return false;
    this.resume(tabId);
    this.settle();
    this.open = { mode: 'new', capture, tabId, anchor, rect, label, document: this.documents.get(tabId) ?? 0 };
    this.text = '';
    this.error = this.items.length >= BUBBLE_MAX_QUEUE ? this.copy.full : '';
    this.show();
    this.track();
    return true;
  }

  /** Annotate mode (re)started on a tab: the pins of its annotations come back where their elements are. */
  resume(tabId: string): void {
    if (this.live && this.tabId === tabId) return;
    if (this.tabId !== tabId) this.settle();
    this.live = true;
    this.tabId = tabId;
    this.pins();
  }

  message(message: BubbleMessage): void {
    this.host.touch();
    switch (message.type) {
      case 'ready': return;
      case 'draft': if (!this.busy) this.text = message.text; return;
      case 'height': {
        this.height = Math.max(BUBBLE_MIN_HEIGHT, Math.min(BUBBLE_MAX_HEIGHT, message.height));
        this.place();
        return;
      }
      case 'cancel': if (!this.busy) this.close(); return;
      case 'add': {
        if (this.busy || !message.text.trim()) return;
        this.text = message.text;
        void this.commit('close');
        return;
      }
      case 'remove': void this.remove(); return;
      case 'send': if (!this.busy) { this.text = message.text; void this.send(); } return;
      case 'pin': this.reopen(message.key); return;
    }
  }

  /** The rectangles the preload reports as the page scrolls or resizes. */
  rects(tabId: string, rects: Array<{ anchor: string; rect: AnnotationRect | null }>): void {
    for (const { anchor, rect } of rects) {
      for (const item of this.items) if (item.tabId === tabId && item.anchor === anchor) item.rect = rect;
      if (this.open?.mode === 'new' && this.open.tabId === tabId && this.open.anchor === anchor) this.open.rect = rect;
    }
    this.layout();
  }

  /** The panel moved or was presented again: everything is placed afresh. */
  layout(): void {
    if (!this.live) return;
    this.place();
    const panel = this.host.panel();
    for (const item of this.items) if (item.tabId === this.tabId) this.surface.movePin(item.id, panel ? pinBounds(item.rect, panel) : null);
  }

  /** A new document: the elements are gone. What was being typed joins the queue; the pins hide. */
  navigated(tabId: string): void {
    this.documents.set(tabId, (this.documents.get(tabId) ?? 0) + 1);
    if (this.open && (this.open.mode === 'edit' ? this.items.find((item) => item.id === (this.open as { id: string }).id)?.tabId : this.open.tabId) === tabId) {
      this.settle();
      if (this.live) this.surface.hideBubble();
    }
    for (const item of this.items) if (item.tabId === tabId) { item.rect = null; item.anchor = null; }
    this.layout();
    this.track();
  }

  /** Annotate mode ended: the bubble's draft joins the queue and the views go. The queue stays for the next time. */
  ended(): void {
    this.settle();
    this.open = null;
    this.track();
    this.live = false;
    this.surface.close();
  }

  /** Annotations sent or deleted elsewhere (the app's queue chip, its history) lose their pins. */
  unpin(ids: readonly string[]): number {
    const gone = new Set(ids);
    const before = this.items.length;
    this.items = this.items.filter((item) => !gone.has(annotationId(item.id)));
    const open = this.open;
    if (open?.mode === 'edit' && !this.items.some((item) => item.id === open.id)) this.close();
    if (this.items.length !== before) this.pins();
    return before - this.items.length;
  }

  // ---- internals ------------------------------------------------------------------------------

  private canSend(): boolean { return !!this.host.conversation() && !!this.host.routes; }

  private showState(): BubbleShow | null {
    const open = this.open;
    if (!open) return null;
    const editing = open.mode === 'edit' ? this.items.findIndex((item) => item.id === open.id) : -1;
    const item = editing >= 0 ? this.items[editing] : undefined;
    return {
      mode: open.mode, number: item ? editing + 1 : this.items.length + 1,
      label: item ? item.label : open.mode === 'new' ? open.label : '',
      text: this.text, queued: this.items.length, canSend: this.canSend(), busy: this.busy, error: this.error,
    };
  }

  private bounds(): PanelRect | null {
    const panel = this.host.panel();
    const open = this.open;
    if (!panel || !open) return null;
    const rect = open.mode === 'new' ? open.rect : this.items.find((item) => item.id === open.id)?.rect ?? null;
    return bubbleBounds(rect, panel, this.height);
  }

  private show(): void {
    const show = this.showState();
    const bounds = this.bounds();
    if (show && bounds && this.live) this.surface.showBubble(bounds, show);
  }

  private place(): void {
    const bounds = this.bounds();
    if (bounds && this.live) this.surface.moveBubble(bounds);
  }

  private update(): void {
    const show = this.showState();
    if (show && this.live) this.surface.updateBubble(show);
  }

  private close(): void {
    if (!this.open) return;
    this.open = null;
    this.text = '';
    this.error = '';
    if (this.live) {
      this.surface.hideBubble();
      this.host.focusPage();
    }
    this.track();
  }

  private track(): void {
    if (!this.tabId) return;
    const anchors = this.items.filter((item) => item.tabId === this.tabId).map((item) => item.anchor);
    if (this.open?.mode === 'new' && this.open.tabId === this.tabId) anchors.push(this.open.anchor);
    this.host.track(this.tabId, this.live ? [...new Set(anchors.filter((anchor): anchor is string => !!anchor))] : []);
  }

  /** Numbered in the queue's order, drawn for the annotated tab only. */
  private pins(): void {
    if (this.live) {
      this.surface.setPins(this.items.flatMap((item, index) => (item.tabId === this.tabId ? [{ key: item.id, number: index + 1 }] : [])));
    }
    this.layout();
    this.track();
  }

  /** What an open bubble holds goes to the queue (a non-empty new draft, a changed comment); then it is closed. */
  private settle(): void {
    const open = this.open;
    if (!open || this.busy) return;
    if (this.text.trim() && (open.mode === 'new' || this.changed(open.id))) void this.commit('none');
    this.open = null;
    this.text = '';
    this.error = '';
  }

  private changed(id: string): boolean {
    return this.items.find((item) => item.id === id)?.comment !== this.text;
  }

  /**
   * Adds the open new annotation to the queue, or saves the reopened one. `then` says what becomes
   * of the bubble if it is still the one shown: closed (Enter), kept on that annotation (Send).
   */
  private commit(then: 'close' | 'keep' | 'none'): Promise<boolean> {
    const open = this.open;
    const text = this.text.slice(0, BUBBLE_TEXT_MAX);
    if (!open || !text.trim()) return Promise.resolve(false);
    if (open.mode === 'new') {
      open.result ??= this.commitNew(open, text, then);
      return open.result;
    }
    return this.commitEdit(open, text, then);
  }

  /**
   * The daemon seals it as a draft at once; a failure to reach the daemon leaves the capture on the
   * desktop, where the next collect (or the browser's stop) still finds it.
   */
  private async commitNew(open: OpenNew, text: string, then: 'close' | 'keep' | 'none'): Promise<boolean> {
    if (this.items.length >= BUBBLE_MAX_QUEUE) { this.fail(this.copy.full); return false; }
    const capture = await open.capture.catch(() => null);
    if (!capture) { this.fail(this.copy.saveFailed); return false; }
    const current = (this.documents.get(open.tabId) ?? 0) === open.document;
    const item: QueueItem = { id: capture.id, tabId: open.tabId, anchor: current ? open.anchor : null, rect: current ? open.rect : null, comment: text, label: open.label };
    this.items.push(item);
    this.host.queuePick({ ...capture, comment: text, queued: true });
    if (this.open === open) {
      if (then === 'close') this.close();
      else if (then === 'keep') this.open = { mode: 'edit', id: item.id };
    }
    this.pins();
    void this.collect();
    return true;
  }

  private async commitEdit(open: { mode: 'edit'; id: string }, text: string, then: 'close' | 'keep' | 'none'): Promise<boolean> {
    const item = this.items.find((entry) => entry.id === open.id);
    if (!item) return false;
    const previous = item.comment;
    item.comment = text;
    const pending = this.host.pendingPick(item.id);
    if (!pending) {
      const answer = await this.call('PATCH', `annotations/${annotationId(item.id)}`, { comment: text });
      if (!answer || answer.status >= 300) {
        item.comment = previous;
        this.fail(answer ? errorOf(answer, this.copy.saveFailed) : this.copy.saveFailed);
        return false;
      }
    } else pending.comment = text;
    if (this.open === open && then === 'close') this.close();
    return true;
  }

  /**
   * The daemon seals what waits on the desktop; its answer is not needed, the ids are the captures'.
   * One collect at a time: the daemon takes the captures when a collect starts and seals them when it
   * answers, so a second one started meanwhile would find nothing waiting, answer at once, and let
   * Send post ids not stored yet (404).
   */
  private collect(): Promise<boolean> {
    const run = (this.collecting ?? Promise.resolve(true)).then(() => this.collectNow());
    const tail: Promise<boolean> = run.finally(() => { if (this.collecting === tail) this.collecting = null; });
    this.collecting = tail;
    return tail;
  }

  private async collectNow(): Promise<boolean> {
    if (!this.items.some((item) => this.host.pendingPick(item.id))) return true;
    const answer = await this.call('POST', `${encodeURIComponent(this.host.profileId)}/annotation/collect`, {});
    if (answer && answer.status < 300) return true;
    console.error('[native-browser] Annotation queue not sealed yet:', answer ? errorOf(answer, String(answer.status)) : 'no route');
    return false;
  }

  private async remove(): Promise<void> {
    const open = this.open;
    if (this.busy || open?.mode !== 'edit') return;
    const item = this.items.find((entry) => entry.id === open.id);
    if (item && !this.host.dropPick(item.id)) {
      const answer = await this.call('DELETE', `annotations/${annotationId(item.id)}`);
      // Already gone from the store (sent or deleted elsewhere) is gone all the same.
      if (!answer || (answer.status >= 300 && answer.status !== 404)) {
        this.fail(answer ? errorOf(answer, this.copy.saveFailed) : this.copy.saveFailed);
        return;
      }
    }
    this.items = this.items.filter((entry) => entry.id !== open.id);
    if (this.open === open) this.close();
    this.pins();
  }

  private reopen(key: string): void {
    if (this.busy) return;
    const item = this.items.find((entry) => entry.id === key);
    if (!item) return;
    if (this.open?.mode === 'edit' && this.open.id === key) { this.show(); return; }
    this.settle();
    this.open = { mode: 'edit', id: key };
    this.text = item.comment;
    this.error = '';
    this.show();
    this.track();
  }

  /** Adds what is being typed, then posts the whole queue as one turn of the conversation. */
  private async send(): Promise<void> {
    const conversation = this.host.conversation();
    if (!conversation || !this.host.routes) { this.fail(this.copy.noConversation); return; }
    const open = this.open;
    if (open && this.text.trim() && (open.mode === 'new' || this.changed(open.id))) {
      if (!await this.commit('keep')) return;
    }
    if (!this.items.length || this.busy) return;
    this.busy = true;
    this.error = '';
    this.update();
    const ids = this.annotationIds;
    let answer: RouteAnswer | null = null;
    if (await this.collect()) {
      answer = await this.call('POST', `${encodeURIComponent(this.host.profileId)}/annotations/post`, {
        ids, agent: conversation.agent,
        ...(conversation.mission ? { missionId: conversation.mission } : conversation.fresh ? { fresh: true } : {}),
      });
    }
    this.busy = false;
    if (!answer || answer.status >= 300) {
      this.fail(answer ? errorOf(answer, this.copy.sendFailed) : this.copy.sendFailed);
      return;
    }
    const sent = new Set(ids);
    this.items = this.items.filter((item) => !sent.has(annotationId(item.id)));
    this.close();
    this.pins();
    this.host.stop();
  }

  /** Shown in the bubble when one is open; otherwise kept for the next one. */
  private fail(message: string): void {
    this.error = message;
    if (this.open) this.update();
    else console.error(`[native-browser] ${message}`);
  }

  private async call(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<RouteAnswer | null> {
    const routes = this.host.routes;
    if (!routes) return null;
    try { return await routes(method, path, body); }
    catch (error) {
      console.error('[native-browser] Annotation route failed', error);
      return null;
    }
  }
}
