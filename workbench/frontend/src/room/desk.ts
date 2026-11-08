/**
 * The Room's desk (docs/design/0006-room-desktop.md, sections 2 and 3), pure: which windows exist, which are open,
 * where they sit, and the small mappings the Terminal and Files windows need. No React, no network, so the tests run it.
 *
 * What exists comes from the Room's status only (windowsFor): the Screen window only when the service says the Room has
 * a real screen, the Terminal only when it can open one, Files only when its folder is on this computer. The browser
 * remembers just which windows are open (rooks.room.desk), a convenience; a remembered window status does not offer
 * is dropped.
 */

export type WindowId = "screen" | "terminal" | "commands" | "files" | "points";

/** The part of the Room's status the desk reads. */
export type DeskStatus = {
  checked?: boolean;
  available?: boolean;
  screen?: boolean;
  can?: { terminal?: boolean; files?: boolean } | null;
};

export const DESK_KEY = "rooks.room.desk";

/** Each window's title. */
export const WINDOW_TITLE: Record<WindowId, string> = {
  screen: "Screen", terminal: "Terminal", commands: "Commands", files: "Files", points: "Saved points",
};

/** Each dock item's name. */
const DOCK_LABEL: Record<WindowId, string> = {
  screen: "Screen", terminal: "Terminal", commands: "Commands", files: "Files", points: "Points",
};

/** The windows the Room offers, primary first (Screen, else Terminal or Commands), then Files and Saved points. */
export function windowsFor(status: DeskStatus | null | undefined): WindowId[] {
  if (!status || status.checked === false || !status.available) return [];
  const out: WindowId[] = [];
  if (status.screen === true) out.push("screen");
  out.push(status.can?.terminal === true ? "terminal" : "commands");
  if (status.can?.files === true) out.push("files");
  out.push("points");
  return out;
}

/** What opens when nothing is remembered: the primary window, Files and Saved points. */
export function defaultOpen(status: DeskStatus | null | undefined): WindowId[] {
  const offered = windowsFor(status);
  if (!offered.length) return [];
  return offered.filter((w, i) => i === 0 || w === "files" || w === "points");
}

/** The dock's items, in its fixed order: Terminal (or Commands), Files, Points, Screen. */
export function dockItems(status: DeskStatus | null | undefined): { id: WindowId; label: string }[] {
  const offered = windowsFor(status);
  const order: WindowId[] = ["terminal", "commands", "files", "points", "screen"];
  return order.filter((w) => offered.includes(w)).map((id) => ({ id, label: DOCK_LABEL[id] }));
}

type Store = { getItem: (k: string) => string | null; setItem?: (k: string, v: string) => void } | null;

function browserStore(): Store {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** The windows open on this browser, kept to what status offers; the default when nothing usable is remembered. */
export function readDesk(status: DeskStatus | null | undefined, store: Store = browserStore()): WindowId[] {
  const offered = windowsFor(status);
  let remembered: string[] = [];
  try {
    const raw = store?.getItem(DESK_KEY);
    const v = raw ? JSON.parse(raw) : null;
    if (v && Array.isArray(v.open)) remembered = v.open.filter((x: unknown) => typeof x === "string");
  } catch {
    remembered = [];
  }
  const kept = offered.filter((w) => remembered.includes(w));
  return kept.length ? kept : defaultOpen(status);
}

export function writeDesk(open: WindowId[], store: Store = browserStore()): void {
  try {
    store?.setItem?.(DESK_KEY, JSON.stringify({ open }));
  } catch {
    /* a private window: the desk still works, it is just not remembered */
  }
}

/** Open or close one window. The last open window stays open. */
export function toggleWindow(open: WindowId[], id: WindowId): WindowId[] {
  if (open.includes(id)) return open.length <= 1 ? open : open.filter((w) => w !== id);
  return [...open, id];
}

/**
 * Where the open windows sit: the primary one (Screen, else Terminal, else Commands) on the left, the rest stacked on
 * the right. With a screen the Terminal moves to the right column above Files. With no primary window open the right
 * column's windows fill the width.
 */
export function deskLayout(open: WindowId[]): { primary: WindowId | null; side: WindowId[] } {
  const primary = (["screen", "terminal", "commands"] as WindowId[]).find((w) => open.includes(w)) ?? null;
  const side = (["terminal", "commands", "files", "points"] as WindowId[]).filter((w) => w !== primary && open.includes(w));
  return { primary, side };
}

// ---------------------------------------------------------------------------------------------- the terminal
/** Inside the terminal every key goes to the shell, Escape included. F6 is the one key the pane keeps: it leaves. */
export function leavesTerminal(e: { type: string; key: string }): boolean {
  return e.type === "keydown" && e.key === "F6";
}

/** What the phone's key row sends: phone keyboards have none of these keys. */
export type PhoneKey = "Esc" | "Tab" | "Up" | "Down" | "Left" | "Right";
const PHONE_KEYS: Record<PhoneKey, string> = { Esc: "\x1b", Tab: "\t", Up: "\x1b[A", Down: "\x1b[B", Right: "\x1b[C", Left: "\x1b[D" };

export function phoneKey(k: PhoneKey): string {
  return PHONE_KEYS[k];
}

/** The phone's Ctrl latch: the next key is sent with Ctrl (c becomes the interrupt). Anything but one key is unchanged. */
export function withCtrl(data: string): string {
  if (data.length !== 1) return data;
  const c = data.toUpperCase().charCodeAt(0);
  if (c >= 64 && c <= 95) return String.fromCharCode(c & 0x1f);
  return data;
}

/** The tab that shows: the one picked if it is still listed, else the first open one, else the first. */
export function pickActive(terminals: { id: string; alive: boolean }[], chosen: string | null): string | null {
  if (chosen && terminals.some((t) => t.id === chosen)) return chosen;
  return (terminals.find((t) => t.alive) ?? terminals[0])?.id ?? null;
}

/** A shell's last lines for the phone's plain box: colour and cursor codes out, carriage returns settled. */
export function plainTail(text: string): string {
  return (text || "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .split("\n")
    .map((line) => { const parts = line.replace(/\r$/, "").split("\r"); return parts[parts.length - 1]; })
    .join("\n");
}

/** Text for xterm: every line ends with a carriage return too. */
export function toTermText(text: string): string {
  return (text || "").replace(/\r?\n/g, "\r\n");
}

/** The full terminal opens only on the computer running Rooks (the service refuses any other page). */
export function isLoopbackHost(host: string): boolean {
  const h = (host || "").toLowerCase();
  return h === "localhost" || h === "::1" || h === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** The line Show in terminal types: a folder under the Room's home, quoted so a name cannot break out. */
export function cdCommand(path: string): string {
  if (!path) return 'cd "$HOME"';
  return `cd "$HOME"/'${path.replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------------------------------------------- files
export type FileEntry = { name: string; kind: "folder" | "file" | "link" | string; size?: number | null; modified?: string | null };

/** Folders first, then files and links, A to Z; names that start with a dot last (shown, the seeded profile must be). */
export function sortEntries<T extends FileEntry>(entries: T[]): T[] {
  const rank = (e: FileEntry) => (e.name.startsWith(".") ? 2 : 0) + (e.kind === "folder" ? 0 : 1);
  return [...entries].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
}

/** "folder", "link", or the size in plain words. */
export function entryMeta(e: Pick<FileEntry, "kind" | "size">): string {
  if (e.kind === "folder") return "folder";
  if (e.kind === "link") return "link";
  const n = typeof e.size === "number" && e.size >= 0 ? e.size : 0;
  if (n < 1024) return n === 1 ? "1 byte" : `${n} bytes`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  const units: [number, string][] = [[1024 ** 3, "GB"], [1024 ** 2, "MB"]];
  for (const [size, unit] of units) {
    if (n >= size) {
      const v = n / size;
      return `${v < 10 ? Number(v.toFixed(1)) : Math.round(v)} ${unit}`;
    }
  }
  return `${n} bytes`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "today 14:02", "3 Nov", or "3 Nov 2025" for another year. */
export function whenWords(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) {
    return `today ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  const day = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  return d.getFullYear() === now.getFullYear() ? day : `${day} ${d.getFullYear()}`;
}

/** The breadcrumb: Home, then each folder down to this one. */
export function crumbs(path: string): { label: string; path: string }[] {
  const parts = (path || "").split("/").filter(Boolean);
  return [{ label: "Home", path: "" }, ...parts.map((p, i) => ({ label: p, path: parts.slice(0, i + 1).join("/") }))];
}

export function parentOf(path: string): string {
  const parts = (path || "").split("/").filter(Boolean);
  return parts.slice(0, -1).join("/");
}

export function joinPath(folder: string, name: string): string {
  return folder ? `${folder}/${name}` : name;
}
