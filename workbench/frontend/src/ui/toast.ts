/**
 * One toast stack for the whole app. A module store (not React context) so the second React root of the Beside
 * pane and pages mounted before the shell (sign in, the ask bar) can all push into it. The shell mounts one
 * ToastHost; when no host is mounted the first page that asked for a toast renders the stack itself.
 */
export type ToastKind = "ok" | "err" | "info";
export type ToastItem = { id: number; kind: ToastKind; text: string; leaving: boolean };

let items: ToastItem[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const hosts: symbol[] = [];
const timers = new Map<number, ReturnType<typeof setTimeout>[]>();

function notify() {
  for (const fn of listeners) fn();
}

export function subscribeToasts(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function getToasts(): ToastItem[] {
  return items;
}

export function dismissToast(id: number) {
  for (const t of timers.get(id) ?? []) clearTimeout(t);
  timers.delete(id);
  if (!items.some((t) => t.id === id)) return;
  items = items.filter((t) => t.id !== id);
  notify();
}

/** Show a short line. Errors stay longer and are read out as alerts. At most four at once. */
export function pushToast(kind: ToastKind, text: string): number {
  const id = ++seq;
  const ttl = kind === "err" ? 6000 : 4000;
  items = [...items.slice(-3), { id, kind, text: text || (kind === "err" ? "Something went wrong." : "Done."), leaving: false }];
  const leave = setTimeout(() => {
    items = items.map((t) => (t.id === id ? { ...t, leaving: true } : t));
    notify();
  }, ttl - 220);
  const gone = setTimeout(() => dismissToast(id), ttl);
  timers.set(id, [leave, gone]);
  notify();
  return id;
}

export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "Something went wrong.";
}

/** The host that renders the stack. The shell registers as primary; page fallbacks queue behind it. */
export function registerToastHost(id: symbol, primary = false): () => void {
  if (primary) hosts.unshift(id); else hosts.push(id);
  notify();
  return () => {
    const i = hosts.indexOf(id);
    if (i >= 0) hosts.splice(i, 1);
    notify();
  };
}

export function isPrimaryToastHost(id: symbol): boolean {
  return hosts[0] === id;
}
