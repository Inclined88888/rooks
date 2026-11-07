/**
 * Every keyboard shortcut, in one list (docs/design/0003-workroom.md, section 6, principle 5: keyboard first). The
 * command menu shows a shortcut's keys beside the action it runs, the Keyboard shortcuts sheet lists them all, and the
 * shell's key handler (App.tsx) reads the same list, so the three can never disagree. Pure: no React, no DOM writes.
 */

/** "Mod" is ⌘ on a Mac and Ctrl elsewhere; "Shift" is ⇧ on a Mac. */
export type Key = "Mod" | "Shift" | "Alt" | string;

export type Shortcut = {
  id: string;
  /** Pressed together. A `then` shortcut is pressed one after the other (g, then c). */
  keys: Key[];
  then?: boolean;
  label: string;
  group: "Anywhere" | "Go to" | "In a chat";
  /** For a Go to shortcut: where it goes. */
  to?: string;
  /** Not while typing in a field (letters and ? would type instead). */
  notTyping?: boolean;
};

export const SHORTCUTS: Shortcut[] = [
  { id: "palette", keys: ["Mod", "K"], label: "Search or jump anywhere", group: "Anywhere" },
  { id: "shortcuts", keys: ["?"], label: "Keyboard shortcuts", group: "Anywhere", notTyping: true },
  { id: "new-chat", keys: ["Mod", "Shift", "O"], label: "New chat", group: "Anywhere" },
  { id: "go-chat", keys: ["G", "C"], then: true, label: "Go to Chat", group: "Go to", to: "/assistant", notTyping: true },
  { id: "go-room", keys: ["G", "R"], then: true, label: "Go to the Room", group: "Go to", to: "/room", notTyping: true },
  { id: "go-jobs", keys: ["G", "J"], then: true, label: "Go to Jobs", group: "Go to", to: "/jobs", notTyping: true },
  { id: "go-tasks", keys: ["G", "T"], then: true, label: "Go to Tasks", group: "Go to", to: "/tasks", notTyping: true },
  { id: "go-mail", keys: ["G", "M"], then: true, label: "Go to Mail", group: "Go to", to: "/mail", notTyping: true },
  { id: "go-settings", keys: ["G", "S"], then: true, label: "Go to Settings", group: "Go to", to: "/settings", notTyping: true },
  { id: "focus-composer", keys: ["Mod", "/"], label: "Write a message", group: "In a chat" },
  { id: "stop", keys: ["Esc"], label: "Stop the reply", group: "In a chat" },
  { id: "close", keys: ["Esc"], label: "Close a menu or sheet", group: "Anywhere" },
];

export const SHORTCUT_GROUPS: Shortcut["group"][] = ["Anywhere", "Go to", "In a chat"];

/** How long the second key of a `then` shortcut may wait for. */
export const THEN_MS = 1500;

export function shortcut(id: string): Shortcut | undefined {
  return SHORTCUTS.find((s) => s.id === id);
}

/** The shortcut that goes to this page, if any (the command menu shows its keys beside the page). */
export function shortcutForPath(path: string): Shortcut | undefined {
  return SHORTCUTS.find((s) => s.to === path);
}

/** The keys as people see them: ⌘ ⇧ on a Mac, Ctrl Shift elsewhere. */
export function keyCaps(s: Pick<Shortcut, "keys">, mac: boolean): string[] {
  return s.keys.map((k) => (k === "Mod" ? (mac ? "⌘" : "Ctrl") : k === "Shift" ? (mac ? "⇧" : "Shift") : k === "Alt" ? (mac ? "⌥" : "Alt") : k));
}

/** One line for a hint: "⌘K", "Ctrl+Shift+O", "G then C". */
export function keyHint(s: Pick<Shortcut, "keys" | "then">, mac: boolean): string {
  const caps = keyCaps(s, mac);
  if (s.then) return caps.join(" then ");
  return mac ? caps.join("") : caps.join("+");
}

type KeyLike = { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; target?: unknown };

/** True while the person is typing in a field: a letter or ? must type, not jump. */
export function typingIn(target: unknown): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean; type?: string } | null;
  if (!el || typeof el !== "object") return false;
  if (el.isContentEditable) return true;
  const tag = (el.tagName || "").toUpperCase();
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  return !["button", "checkbox", "radio", "submit", "reset", "range", "color", "file"].includes((el.type || "text").toLowerCase());
}

function chord(s: Shortcut, e: KeyLike): boolean {
  const mod = s.keys.includes("Mod"), shift = s.keys.includes("Shift"), alt = s.keys.includes("Alt");
  if (mod !== (e.metaKey || e.ctrlKey) || alt !== e.altKey) return false;
  const main = s.keys.filter((k) => k !== "Mod" && k !== "Shift" && k !== "Alt");
  if (main.length !== 1) return false;
  const want = main[0];
  if (want === "?") return e.key === "?"; // Shift is how ? is typed on most layouts
  if (shift !== e.shiftKey) return false;
  if (want === "Esc") return e.key === "Escape";
  return e.key.toLowerCase() === want.toLowerCase();
}

/**
 * The shell's key reader: feed it every keydown and it answers with the shortcut that key completes, or null. It
 * remembers the first key of a `then` shortcut (g) for THEN_MS. Only "Anywhere" and "Go to" shortcuts are answered;
 * the chat reads its own ("In a chat") from the same list.
 */
export function createKeyReader(list: Shortcut[] = SHORTCUTS) {
  let first: { key: string; at: number } | null = null;
  return (e: KeyLike, now: number): Shortcut | null => {
    const typing = typingIn(e.target);
    if (first && now - first.at > THEN_MS) first = null;
    if (first && !e.metaKey && !e.ctrlKey && !e.altKey && !typing) {
      const k = e.key.toLowerCase();
      const hit = list.find((s) => s.then && s.keys[0].toLowerCase() === first!.key && s.keys[1].toLowerCase() === k);
      first = null;
      if (hit) return hit;
    }
    for (const s of list) {
      if (s.group === "In a chat" || s.then || s.id === "close") continue;
      if (s.notTyping && typing) continue;
      if (chord(s, e)) return s;
    }
    if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && list.some((s) => s.then && s.keys[0].toLowerCase() === e.key.toLowerCase())) {
      first = { key: e.key.toLowerCase(), at: now };
    }
    return null;
  };
}

/** True when this key press is that "In a chat" shortcut (the chat page asks). */
export function isShortcut(id: string, e: KeyLike): boolean {
  const s = shortcut(id);
  return !!s && chord(s, e);
}
