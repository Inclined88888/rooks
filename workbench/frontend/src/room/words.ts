/**
 * The Room in plain words (docs/design/0003-workroom.md, sections 4 and 5), and the two mappings a person's hand needs
 * when they step in: a click on the scaled picture to the Room's own pixels, and a key press to the Room's key names.
 * Pure: no React, no network, so the tests run it.
 */
import { roomScreenLive, type RoomStatus as WatchStatus } from "../chat/watch";

export type Checkpoint = { name: string; path?: string; label?: string; created?: string };

/** GET /api/room/status (section 8). `driver` and `home` are for the Advanced view only. */
export type RoomStatus = WatchStatus & {
  isolation?: string;
  driver?: string | null;
  home?: string | null;
  offline?: boolean;
  last_checkpoint?: { name?: string; label?: string; created?: string } | null;
  checkpoints?: Checkpoint[];
  checkpoint_limit?: number | null;
  pruned?: { removed?: string[]; at?: string } | null;
};

export { roomScreenLive };

/** Honesty rule 2: the pane says what a private folder and shell is. */
export const HONEST_LINE = "Commands run as you, in a folder of its own. It is not a locked off computer.";
/** A service that does not have the Room's route at all (an older install). */
export const NOT_HERE_LINE = "Not on this computer yet.";
/** The longest a command may run in the Room, in seconds (the service caps it at the same number). */
export const RUN_TIMEOUT_S = 120;

const ISOLATION: Record<string, string> = {
  none: "Not locked off",
  namespace: "Files and network kept apart",
  vm: "A separate computer",
};

/** How separate the Room is, in plain words. Anything unknown is never oversold. */
export function isolationWords(isolation: string | null | undefined): string {
  return ISOLATION[String(isolation || "").toLowerCase()] ?? ISOLATION.none;
}

/** One word for the badge: Not installed, Off, On. */
export function roomStateWords(s: Pick<RoomStatus, "available" | "running"> | null | undefined): string {
  if (!s || s.available === false) return "Not installed";
  return s.running ? "On" : "Off";
}

/** The line under the command view: the honest line for a folder and shell, the driver's own note for a separate computer. */
export function commandViewLine(s: Pick<RoomStatus, "isolation" | "note"> | null | undefined): string {
  if (s?.isolation === "vm") return (s.note || "").trim() || "A separate computer. Commands run inside it, apart from your files.";
  return HONEST_LINE;
}

/** The Advanced details on the Room page: the kind of Room and its folder, never on a normal screen. */
export function advancedDetails(s: RoomStatus | null | undefined): { kind: string; folder: string } {
  return { kind: String(s?.driver || ""), folder: String(s?.home || "") };
}

/** What the view says instead of a picture when the Room is off. */
export function offLine(s: Pick<RoomStatus, "screen"> | null | undefined): string {
  return s?.screen ? "The Room is off. Start it to see its screen." : "The Room is off. Start it to run commands.";
}

// ---------------------------------------------------------------------------------------------- saved points
const POINT = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})-(.+)$/;

/** A saved point's folder name is "<stamp>-<label>[-<counter>]"; a person sees the label and when it was saved. */
export function describePoint(name: string): { label: string; date: Date | null } {
  const m = POINT.exec(name || "");
  if (!m) return { label: (name || "").replace(/[-_]+/g, " ").trim(), date: null };
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  const label = m[7].replace(/-\d{2}$/, "").replace(/[-_]+/g, " ").trim() || "save";
  return { label, date: Number.isNaN(date.getTime()) ? null : date };
}

export function pointLine(name: string): string {
  const { label, date } = describePoint(name);
  if (!date) return label;
  return `${label} · ${date.toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}`;
}

// ---------------------------------------------------------------------------------------------- stepping in
export type Point = { x: number; y: number };
export type Box = { left: number; top: number; width: number; height: number };
export type Size = { width: number; height: number };

/**
 * Where a click on the scaled picture lands on the Room's own screen. The picture keeps its shape inside the box
 * (object-fit: contain), so a strip above and below or left and right may be empty; a click there is nothing.
 */
export function toScreenPoint(client: Point, box: Box, natural: Size): Point | null {
  if (!natural.width || !natural.height || !box.width || !box.height) return null;
  const scale = Math.min(box.width / natural.width, box.height / natural.height);
  const w = natural.width * scale;
  const h = natural.height * scale;
  const left = box.left + (box.width - w) / 2;
  const top = box.top + (box.height - h) / 2;
  const x = (client.x - left) / scale;
  const y = (client.y - top) / scale;
  if (x < 0 || y < 0 || x >= natural.width || y >= natural.height) return null;
  return { x: Math.floor(x), y: Math.floor(y) };
}

export type KeyPress = { kind: "type"; text: string } | { kind: "key"; keys: string };
export type KeyLike = { key: string; ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean; shiftKey?: boolean };

const NAMED: Record<string, string> = {
  Enter: "Return", Backspace: "BackSpace", Tab: "Tab", Escape: "Escape", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left",
  ArrowRight: "Right", Delete: "Delete", Insert: "Insert", Home: "Home", End: "End", PageUp: "Page_Up", PageDown: "Page_Down", " ": "space",
};
const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "NumLock", "ScrollLock", "AltGraph", "Fn", "OS", "Hyper", "Super"]);

/** A key you press while stepped in: a character is typed as text; anything else is a named key with its modifiers. */
export function keyFor(e: KeyLike): KeyPress | null {
  const key = e.key;
  if (!key || MODIFIERS.has(key)) return null;
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("ctrl");
  if (e.altKey) mods.push("alt");
  if (e.metaKey) mods.push("super");
  const printable = [...key].length === 1;
  if (printable && !mods.length) return { kind: "type", text: key };
  let name: string | null;
  if (NAMED[key]) name = NAMED[key];
  else if (/^F\d{1,2}$/.test(key)) name = key;
  else if (printable) name = key.toLowerCase();
  else name = null;
  if (name === null) return null;
  if (e.shiftKey && (!printable || mods.length)) mods.push("shift");
  return { kind: "key", keys: [...mods, name].join("+") };
}

/** The Room counts scrolling up as positive, so a wheel that moves the page down (deltaY > 0) scrolls it down. */
export function wheelSteps(deltaY: number): number {
  if (deltaY > 0) return -3;
  if (deltaY < 0) return 3;
  return 0;
}
