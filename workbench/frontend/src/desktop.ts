/**
 * Bridge to the native desktop shell (desktop/src-tauri). Everything here is a no-op in a browser, so the Docker
 * install is unaffected. Tauri injects `__TAURI_INTERNALS__` into pages it loads, including this one, which the
 * shell serves from the local backend on 127.0.0.1 (granted in desktop/src-tauri/capabilities/default.json).
 */
type TauriInternals = { invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T> };

function internals(): TauriInternals | undefined {
  return (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
}

export const inDesktopShell = () => internals() !== undefined;

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const t = internals();
  if (!t) throw new Error("Only available in the desktop app");
  return t.invoke<T>(cmd, args);
}

export type AppInfo = {
  version: string;
  platform: string;
  arch: string;
  data_dir: string;
  log_dir: string;
  workbench_url: string | null;
  updater: boolean;
};

export type Sidecar = { name: string; binary: string; description: string; phase: number; enabled: boolean; status: string };

export const appInfo = () => invoke<AppInfo>("app_info");
export const listSidecars = () => invoke<Sidecar[]>("list_sidecars");
export const openDataDir = () => invoke<void>("open_data_dir");
export const openLogs = () => invoke<void>("open_logs");

/** True when the user isn't looking at this page (another app or tab in front, or the window hidden to the tray). */
export const inBackground = () => document.hidden || !document.hasFocus();

/** Ask for browser notification permission. Call from a click or key press: browsers ignore it otherwise. */
export function askNotifyPermission() {
  if (inDesktopShell() || typeof Notification === "undefined") return;
  if (Notification.permission === "default") void Notification.requestPermission().catch(() => {});
}

/** OS notification: native in the desktop app, the Web Notification API in a browser (only once allowed).
 *  onClick runs when a browser notification is clicked; the desktop app brings its window up from the tray. */
export async function notify(title: string, body = "", opts: { tag?: string; onClick?: () => void } = {}): Promise<void> {
  if (inDesktopShell()) {
    try { await invoke<void>("notify", { title, body }); } catch { /* notifications switched off for the app */ }
    return;
  }
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  const n = new Notification(title, { body, tag: opts.tag });
  n.onclick = () => { window.focus(); opts.onClick?.(); n.close(); };
}

/** Where an aiworkspace:// link or the tray menu sends the page (desktop/src-tauri/src/native.rs). */
export type DesktopLink = { path: string; draft?: string };
export const desktopReady = () => invoke<DesktopLink | null>("desktop_ready");

/** Native approve / deny prompt. Outside the desktop app it falls back to the browser's confirm(). */
export async function requestApproval(title: string, detail: string, risk: "low" | "medium" | "high" = "medium"): Promise<boolean> {
  if (!inDesktopShell()) return window.confirm(`${title}\n\n${detail}`);
  return invoke<boolean>("request_approval", { request: { title, detail, risk, source: "workbench" } });
}

/* ---- What the Rooks app's webview (WebKit) does not do on its own (docs/design/0007 2.4) ----------------------- */

/** Open a web address outside this window: sign-ins, plans, help pages. In the Rooks app it goes to the person's own
 *  browser (WebKit opens no window for window.open); in a browser, a new tab. */
export async function openExternal(url: string): Promise<void> {
  if (inDesktopShell()) {
    const abs = new URL(url, window.location.href).href;
    try { await invoke<void>("open_external", { url: abs }); return; } catch { /* not a web address: nothing opens */ return; }
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/** Save a file the app made (a report, an export). A download link works in every browser and, in the Rooks app,
 *  the shell saves it to the Downloads folder and says so. Never a new window: WebKit would open none. */
export function download(url: string, name = ""): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** In the Rooks app, links that would open a new window go to the person's browser, and the app's own files are
 *  saved instead (a new window would not open, or would not be signed in). Elsewhere, links behave as usual.
 *  Call once at start; returns the function that removes the handler. */
export function routeLinks(doc: Document = document): () => void {
  const onClick = (e: MouseEvent) => {
    if (!inDesktopShell() || e.defaultPrevented || e.button !== 0) return;
    const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a) return;
    const href = a.href;
    const sameOrigin = (() => { try { return new URL(href).origin === window.location.origin; } catch { return false; } })();
    if (a.hasAttribute("download")) {
      if (sameOrigin || href.startsWith("blob:") || href.startsWith("data:")) return; // the shell saves it (on_download)
      e.preventDefault();
      void openExternal(href);
      return;
    }
    if (a.getAttribute("target") === "_blank" || a.matches("a[target=_blank]")) {
      e.preventDefault();
      if (sameOrigin && new URL(href).pathname.startsWith("/api/")) download(href); // a file from the app: save it
      else void openExternal(href);
    }
  };
  doc.addEventListener("click", onClick, true);
  return () => doc.removeEventListener("click", onClick, true);
}

/** Copy text that arrives after a round trip to the server. WebKit refuses clipboard.writeText once an await has
 *  passed since the click; a ClipboardItem whose content is a promise keeps the click's permission. Returns whether
 *  the text reached the clipboard. */
export async function copyLater(text: Promise<string>): Promise<boolean> {
  const ClipboardItem = (window as unknown as { ClipboardItem?: new (items: Record<string, Promise<Blob>>) => unknown }).ClipboardItem;
  const clip = navigator.clipboard as (Clipboard & { write?: (items: unknown[]) => Promise<void> }) | undefined;
  if (ClipboardItem && clip?.write) {
    try {
      await clip.write([new ClipboardItem({ "text/plain": text.then((t) => new Blob([t], { type: "text/plain" })) })]);
      return true;
    } catch { /* fall through: some browsers want the text itself */ }
  }
  try { await clip?.writeText(await text); return !!clip; } catch { return false; }
}
