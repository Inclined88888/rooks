/** Which screens can sit beside the one you are using, and how that choice is remembered. */

export const BESIDE_KEY = "aiw.beside";

export const BESIDE_SCREENS = Object.freeze([
  { id: "chat", label: "Chat", path: "/assistant" },
  { id: "terminal", label: "Terminal", path: "/terminal" },
  { id: "practice", label: "Virtual computer", path: "/try" },
  { id: "files", label: "Files", path: "/files" },
  { id: "notes", label: "Notes", path: "/notes" },
  { id: "tasks", label: "Tasks", path: "/tasks" },
  { id: "calendar", label: "Calendar", path: "/calendar" },
  { id: "mail", label: "Mail", path: "/mail" },
  { id: "code", label: "Code", path: "/code" },
  { id: "browser", label: "Browser", path: "/browser" },
  { id: "desktop", label: "Desktop", path: "/computer" },
  { id: "automations", label: "Automations", path: "/automations" },
  { id: "customize", label: "Customize", path: "/customize" },
]);

/** A useful second screen for the page you are on. */
export function suggestBeside(pathname) {
  const path = pathname || "/";
  if (path === "/assistant" || path.startsWith("/assistant/")) return "/terminal";
  if (path === "/terminal") return "/assistant";
  if (path === "/code" || path.startsWith("/code/")) return "/terminal";
  return "/assistant";
}

/** Keep both sides wide enough to actually use. */
export function clampRatio(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return 0.5;
  return Math.min(0.8, Math.max(0.2, n));
}

/** The menu path for a screen, so a chat or a note still counts as that screen. */
export function screenPath(path) {
  const p = String(path || "");
  const hit = BESIDE_SCREENS.find((s) => p === s.path || p.startsWith(`${s.path}/`));
  return hit ? hit.path : p || "/assistant";
}

export function screenLabel(path) {
  const base = screenPath(path);
  const hit = BESIDE_SCREENS.find((s) => s.path === base);
  return hit ? hit.label : "This screen";
}

/** Paths that are safe to open beside this app (no scheme, no protocol-relative URL). */
export function safePath(path) {
  return typeof path === "string" && path.startsWith("/") && !path.startsWith("//") && !path.includes(":");
}

export function readStoredBeside(storage) {
  if (!storage) return null;
  let data;
  try {
    data = JSON.parse(storage.getItem(BESIDE_KEY) || "");
  } catch {
    return null;
  }
  if (!data || !safePath(data.path)) return null;
  return { path: data.path, ratio: clampRatio(Number(data.ratio)) };
}

export function writeStoredBeside(storage, value) {
  if (!storage) return;
  if (!value) {
    storage.removeItem(BESIDE_KEY);
    return;
  }
  if (!safePath(value.path)) return;
  storage.setItem(BESIDE_KEY, JSON.stringify({ path: value.path, ratio: clampRatio(Number(value.ratio)) }));
}
