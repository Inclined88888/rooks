/**
 * The Room's browser, pure (docs/design/0007-room-browser-and-native-app.md, sections 1.3, 1.5 and 1.6): the words the
 * Browser window says when it is off and why, how a click on the picture maps to the page, how a key becomes a message
 * for the page, which keys stay with the app, and copy through a ClipboardItem. No React, no network, so the tests run it.
 */

/** Why the Room has no browser here (status.can.browser_off_reason). */
export type BrowserOffReason = "no_engine" | "windows" | "helper" | "switched_off";
export const BROWSER_OFF_REASONS: BrowserOffReason[] = ["no_engine", "windows", "helper", "switched_off"];

/** One tab, as the browser's state (and status.browser.tabs) lists it. */
export type BrowserTab = { id: string; url?: string | null; title?: string | null; asleep?: boolean; loading?: boolean; blocked?: string | null };

/** The socket's state message and GET /api/room/browser. */
export type BrowserState = {
  open?: boolean;
  tabs: BrowserTab[];
  active: string | null;
  notes?: string[];
  note?: string | null;
  reopened?: string[];
  walled?: boolean;
  back?: boolean;
  forward?: boolean;
  max?: number;
  view?: [number, number];
  rooks?: boolean;
  rooks_words?: string;
  taken?: boolean;
};

export type Size = { width: number; height: number };
export type Point = { x: number; y: number };

export const TABS_FULL = "Eight tabs are open. Close one to open another.";
export const ROOKS_USING = "Rooks is using the browser";
export const ROOKS_USING_LINE = "Click or type in the page to take it back.";
export const TAKEN_LINE = "You took the browser back. Rooks asks before its next step.";
export const NOT_LOCKED = "Not locked off: this browser runs as you.";
export const WALLED = "Runs inside the Room's wall, with the Room's folder as its home.";
export const BROWSER_LABEL = "A real browser inside the Room. Sign-ins made here stay in the Room.";
export const PHONE_LINE = "On a phone you can tap, scroll and type. Dragging, hovering and shortcuts need the computer.";
export const OPENING = "Opening the Room's browser…";
export const STILL_EVERY_MS = 2000;
/** Under Advanced: what the browser does not keep apart (design 1.2). */
export const BROWSER_LIMITS = "Programs in the Room's terminal can read the browser's profile, sign-ins included. Pages reach the local network as any browser's do.";
export const BROWSER_CHECKS = "Before a purchase, a form sent to a site you did not ask for, or a click on another site's frame, Rooks asks in Needs you. Not checked: a page's own scripts sending data on an ordinary click or as you type, button words the English patterns miss, and your own input.";

const OFF: Record<BrowserOffReason, { title: string; line: string }> = {
  no_engine: { title: "The Room has no browser yet.", line: "Install Chrome, Edge or Chromium on this computer, then check again. The Room uses it only as an engine, with a profile of its own." },
  switched_off: { title: "The Room's browser is switched off in Settings.", line: "Switch it on there to browse inside the Room." },
  windows: { title: "The Room's browser is not on Windows yet.", line: "The terminal and Files work. Use your own browser for now." },
  helper: { title: "The Room runs elsewhere, so its browser is not here.", line: "Open the Room on the computer it runs on to use its browser." },
};

type OffStatus = {
  running?: boolean;
  available?: boolean;
  can?: { browser?: boolean; browser_off_reason?: string | null } | null;
};

/**
 * What the Browser window says instead of a page, or null when the browser can open here. The Room off comes first
 * (Start opens it again, and its tabs and sign-ins are kept); then the reason the Room has no browser.
 */
export function browserOff(s: OffStatus | null | undefined): { title: string; line: string; reason: BrowserOffReason | "off" | "none" } | null {
  if (!s) return { title: "Checking the Room…", line: "", reason: "none" };
  const why = s.can?.browser_off_reason;
  if (s.can?.browser !== true) {
    if (why && (BROWSER_OFF_REASONS as string[]).includes(why)) return { ...OFF[why as BrowserOffReason], reason: why as BrowserOffReason };
    return { title: "This Room has no browser of its own.", line: "Use its screen.", reason: "none" };
  }
  if (!s.running) return { title: "The Room is off. Everything in it is kept.", line: "Start it to open the browser. Your tabs and sign-ins are kept.", reason: "off" };
  return null;
}

/** The live page needs the socket, which opens only on the computer running Rooks; a touch screen gets the still too. */
export function stillMode(o: { loopback: boolean; coarse: boolean }): boolean {
  return !o.loopback || o.coarse;
}

/** A point on the picture (drawn at `shown`) to the page's own pixels (`view`), kept inside the page. */
export function toViewPoint(p: Point, shown: Size, view: Size): Point {
  const sx = shown.width > 0 ? view.width / shown.width : 1;
  const sy = shown.height > 0 ? view.height / shown.height : 1;
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max - 1, v));
  return { x: clamp(Math.round(p.x * sx), view.width), y: clamp(Math.round(p.y * sy), view.height) };
}

type Mods = { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean };

/** The DevTools protocol's modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export function modifiers(e: Mods): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

export type KeyMessage = { type: "key"; event: "down" | "up"; key: string; code: string; text: string; keyCode: number; modifiers: number };

/** A key on the page, as the socket's key message: a character carries its text, a shortcut does not. */
export function keyMessage(e: Mods & { type: string; key: string; code: string; keyCode?: number }): KeyMessage {
  const down = e.type === "keydown";
  const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey;
  return {
    type: "key", event: down ? "down" : "up", key: e.key, code: e.code || "",
    text: down && printable ? e.key : down && e.key === "Enter" && !e.ctrlKey && !e.metaKey ? "\r" : "",
    keyCode: e.keyCode || 0, modifiers: modifiers(e),
  };
}

/** Keys the app keeps: F6 leaves the page (as in the terminal), Ctrl or Cmd+V pastes through the paste event. */
export function keyStaysInApp(e: Mods & { key: string }): boolean {
  if (e.key === "F6") return true;
  if ((e.ctrlKey || e.metaKey) && (e.key === "v" || e.key === "V")) return true;
  return false;
}

/** Ctrl or Cmd+C: copy the page's selection. */
export function isCopy(e: Mods & { key: string }): boolean {
  return !!(e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "c" || e.key === "C");
}

/** What the address bar shows: the whole address the tab is at, nothing for a blank tab. */
export function addressShown(url: string | null | undefined): string {
  if (!url || url === "about:blank") return "";
  return url;
}

/** A tab's name: its title, else its site, else New tab. */
export function tabTitle(t: Pick<BrowserTab, "title" | "url">): string {
  const title = (t.title || "").trim();
  if (title) return title;
  const url = t.url || "";
  if (!url || url === "about:blank") return "New tab";
  try {
    const u = new URL(url);
    return u.hostname || u.pathname.split("/").pop() || url;
  } catch {
    return url.slice(0, 60);
  }
}

type ClipboardLike = { write: (items: unknown[]) => Promise<void> } | null | undefined;
type ItemCtor = new (items: Record<string, Promise<Blob>>) => unknown;

/**
 * Copy the page's selection: a ClipboardItem whose promise resolves with the text the service sends back. It is made
 * inside the key press, which is the one form WebKit allows when the text arrives after a round trip. Without a
 * clipboard nothing is pretended.
 */
export async function copySelection(clip: ClipboardLike, Item: ItemCtor | undefined, selection: () => Promise<string>): Promise<boolean> {
  if (!clip || typeof clip.write !== "function" || !Item) return false;
  const text = selection().then((t) => new Blob([t || ""], { type: "text/plain" }));
  try {
    await clip.write([new Item({ "text/plain": text })]);
    return true;
  } catch {
    return false;
  }
}

/** The socket closed: the words to show, from its reason (the service's own plain line), and whether to offer Open again. */
export function closedWords(code: number, reason: string): { line: string; again: boolean } {
  if (code === 1000 && /another window/i.test(reason || "")) return { line: "This browser was opened in another window.", again: true };
  if (reason) return { line: reason.replace(/\.?$/, "."), again: code !== 4403 && code !== 4401 };
  return { line: "The connection to the Room's browser dropped.", again: true };
}

/**
 * The click count of a press (1, 2 for a double click, 3 for a triple): pointer events carry none, so it is counted
 * here from the press before (within 500 ms and 5 px).
 */
export function clickCount(prev: { t: number; x: number; y: number; n: number } | null, now: { t: number; x: number; y: number }): number {
  if (!prev) return 1;
  const near = Math.abs(now.x - prev.x) <= 5 && Math.abs(now.y - prev.y) <= 5;
  return near && now.t - prev.t <= 500 ? Math.min(3, prev.n + 1) : 1;
}
