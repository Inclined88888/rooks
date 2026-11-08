import { api } from "./api";
import { type Appearance, followSystem, isDark, onAppearance, resolveTheme, THEMES } from "./appearance";
import { inDesktopShell, invoke } from "./desktop";

/**
 * Carries the chosen look beyond this page:
 *  - the backend keeps a copy (PUT /api/appearance) that the phone app reads when paired, and that Rooks Code and
 *    Rooks Browser read from ~/.ai-workspace/appearance.json for their terminal colours;
 *  - in the desktop app, the native window follows it: light or dark title bar, and the window background matches
 *    the theme's chrome so there is no white flash between pages.
 * Every call is best-effort: signed out, offline or in a plain browser, the page still restyles locally.
 */
let timer: ReturnType<typeof setTimeout> | undefined;

/** The backend (and Rooks Code, Rooks Browser and the phone that read it) still know the older theme names: Light is
 *  saved as "gallery" and Dark as "night"; High contrast and Match my computer keep their own. */
const REMOTE: Record<string, string> = { light: "gallery", dark: "night", contrast: "contrast", auto: "auto" };

export function saveAppearanceRemote(a: Appearance) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    const body = { ...a, theme: REMOTE[a.theme], resolved: REMOTE[resolveTheme(a.theme)], dark: isDark(a.theme), accent: "theme" };
    api("/appearance", { method: "PUT", body }).catch(() => undefined);
  }, 250);
}

export async function applyWindowChrome(a: Appearance) {
  if (!inDesktopShell()) return;
  const id = resolveTheme(a.theme);
  const bg = THEMES.find((t) => t.id === id)?.swatch.paper ?? "#fafaf9";
  const theme = isDark(a.theme) ? "dark" : "light";
  // Tauri 2 core window commands (granted in desktop/src-tauri/capabilities/default.json). Older shells ignore them.
  await invoke("plugin:window|set_theme", { label: "main", value: a.theme === "auto" ? null : theme }).catch(() => undefined);
  await invoke("plugin:window|set_background_color", { label: "main", value: bg }).catch(() => undefined);
}

/** Phone browsers colour their bar from <meta name="theme-color">. index.html follows the system; a theme picked in the
 *  app (or High contrast) replaces both tags with its own page colour, and Match my computer puts them back. */
export function applyBrowserBar(a: Appearance) {
  const metas = Array.from(document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'));
  if (!metas.length) return;
  if (a.theme === "auto") {
    metas.forEach((m) => {
      if (m.dataset.media === undefined) return;
      m.media = m.dataset.media; m.content = m.dataset.content ?? m.content;
      delete m.dataset.media; delete m.dataset.content;
    });
    return;
  }
  const bg = THEMES.find((t) => t.id === resolveTheme(a.theme))?.swatch.paper ?? "#fafaf9";
  metas.forEach((m) => {
    if (m.dataset.media === undefined) { m.dataset.media = m.media; m.dataset.content = m.content; m.removeAttribute("media"); }
    m.content = bg;
  });
}

/** Wire it up once at start-up. */
export function startThemeSync(initial: Appearance) {
  applyWindowChrome(initial);
  applyBrowserBar(initial);
  followSystem();
  onAppearance((a) => { applyWindowChrome(a); applyBrowserBar(a); saveAppearanceRemote(a); });
}
