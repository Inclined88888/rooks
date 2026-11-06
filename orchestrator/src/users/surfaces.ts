/**
 * Surface permissions (`docs/MULTI-USER.md` §4 and §7): `page:/kanban`,
 * `plugin:acme-crm`, `widget:dreams`, `theme:*`, `layout:*`, `nav:projects`.
 *
 * The kernel's `/api/capabilities` payload is the machine's truth (modules
 * running, host caps). This file is the per-viewer curtain: a surface the
 * caller cannot see is stripped before the JSON leaves, and the same check
 * hides the gallery, the client bundle, and the SSE echo. Hiding only in
 * the React tree would leave the data on the wire.
 *
 * Consume the M.2 evaluator (`userAllows` / `grantsAllow`). Do not
 * reimplement wildcards here.
 *
 * Historical: no viewer (empty users table, jobs) is unrestricted — the
 * product behaved as if everyone could see every surface. Superadmin (and
 * the daemon-token) carries `*` and so does a grant of `*` itself
 * (Administration preset).
 */
import { BUNDLED_IDENTITY } from '../plugins/bundled-identity.js';
import type { PluginPublic } from '../plugins/public.js';
import { userAllows } from './permissions.js';
import type { DbViewer } from './owned.js';

/**
 * Native Next routes that have no `bundled-identity` `route` — owned by no
 * plugin, so the permission catalogue keeps them in the core family view
 * rather than grouping them under a plugin card (`permission-catalog.ts`).
 */
export const EXTRA_PAGES = [
  '/',
  '/chat',
  '/multichat',
  '/messages',
  '/skills',
  '/mcp',
  '/pipelines',
  '/edit',
  '/events',
  '/license',
] as const;

export type SurfacesView =
  | { all: true }
  | {
      all?: false;
      pages: string[];
      widgets: string[];
      nav: string[];
      plugins: string[];
      themes: string[];
      layouts: string[];
    };

export function shortPluginId(id: string): string {
  const slash = id.lastIndexOf('/');
  return slash >= 0 ? id.slice(slash + 1) : id;
}

export function navSlug(href: string): string {
  if (href === '/') return 'home';
  const trimmed = href.replace(/^\//, '');
  const first = trimmed.split('/')[0];
  return first && first.length > 0 ? first : 'home';
}

export function viewerSurfacesUnrestricted(viewer: DbViewer | null | undefined): boolean {
  if (!viewer) return true;
  if (viewer.isSuperadmin) return true;
  return userAllows({ is_superadmin: false }, viewer.permissions ?? [], '*');
}

export function viewerAllows(viewer: DbViewer | null | undefined, permission: string): boolean {
  if (!viewer) return true;
  return userAllows(
    { is_superadmin: viewer.isSuperadmin },
    viewer.permissions ?? [],
    permission,
  );
}

/**
 * A third-party plugin is visible with `plugin:<id>` (or `plugin:*` / `*`),
 * or — when it is a `kind: theme` / `kind: layout` — with the matching
 * `theme:<short>` / `layout:<short>` grant. That is the
 * assumed consequence of deny-by-default: a freshly installed package stays
 * invisible until a role carries one of the two. Bundled UI modules can
 * also be opened by any surface they declare (`page:/kanban`,
 * `widget:dreams`, `nav:projects`, `theme:<id>`).
 */
export function pluginVisible(plugin: PluginPublic, viewer: DbViewer | null | undefined): boolean {
  if (viewerSurfacesUnrestricted(viewer)) return true;
  if (viewerAllows(viewer, `plugin:${plugin.id}`)) return true;
  const short = shortPluginId(plugin.id);
  // Chrome surface grants cross the bundled line (`docs/MULTI-THEME.md`
  // §3.3): a role allowed to wear a third-party theme or layout must see it
  // in the gallery and receive its client half. The grant opens THAT chrome
  // only; other surfaces from the same package stay behind `plugin:<id>`.
  if (plugin.kind.includes('theme') && viewerAllows(viewer, `theme:${short}`)) return true;
  if (plugin.kind.includes('layout') && viewerAllows(viewer, `layout:${short}`)) return true;
  if (plugin.source !== 'bundled') return false;
  if (plugin.route && viewerAllows(viewer, `page:${plugin.route}`)) return true;
  if (plugin.kind.includes('widget') && viewerAllows(viewer, `widget:${short}`)) return true;
  if (plugin.kind.includes('theme') && viewerAllows(viewer, `theme:${short}`)) return true;
  if (plugin.slots.includes('nav.item')) {
    const slug = plugin.route ? navSlug(plugin.route) : short;
    if (viewerAllows(viewer, `nav:${slug}`)) return true;
  }
  return false;
}

export function filterGallery(
  plugins: readonly PluginPublic[],
  viewer: DbViewer | null | undefined,
): PluginPublic[] {
  if (viewerSurfacesUnrestricted(viewer)) return [...plugins];
  return plugins.filter((plugin) => pluginVisible(plugin, viewer));
}

export function declaredPages(plugins: readonly PluginPublic[] = []): string[] {
  const pages = new Set<string>(EXTRA_PAGES);
  for (const identity of Object.values(BUNDLED_IDENTITY)) {
    if (identity.route) pages.add(identity.route);
  }
  for (const plugin of plugins) {
    if (plugin.route) pages.add(plugin.route);
  }
  return [...pages].sort();
}

export function surfacesForViewer(
  viewer: DbViewer | null | undefined,
  plugins: readonly PluginPublic[] = [],
): SurfacesView {
  if (viewerSurfacesUnrestricted(viewer)) return { all: true };

  const pages = new Set<string>();
  const widgets = new Set<string>();
  const nav = new Set<string>();
  const pluginIds = new Set<string>();
  const themes = new Set<string>();
  const layouts = new Set<string>();

  for (const page of declaredPages(plugins)) {
    if (viewerAllows(viewer, `page:${page}`)) pages.add(page);
    const slug = navSlug(page);
    if (viewerAllows(viewer, `nav:${slug}`) || viewerAllows(viewer, `page:${page}`)) {
      nav.add(slug);
    }
  }

  for (const plugin of plugins) {
    if (pluginVisible(plugin, viewer)) pluginIds.add(plugin.id);
    if (plugin.source === 'bundled') {
      if (plugin.route && viewerAllows(viewer, `page:${plugin.route}`)) pages.add(plugin.route);
      const short = shortPluginId(plugin.id);
      if (plugin.kind.includes('widget') && viewerAllows(viewer, `widget:${short}`)) {
        widgets.add(short);
      }
      if (plugin.kind.includes('theme') && viewerAllows(viewer, `theme:${short}`)) {
        themes.add(short);
      }
      if (plugin.kind.includes('layout') && viewerAllows(viewer, `layout:${short}`)) {
        layouts.add(short);
      }
    } else {
      // Third-party pages only join the list when the whole package is
      // granted — otherwise `/api/capabilities` would advertise a route
      // whose client.js we refuse to serve. `plugin:<id>` is that grant;
      // A chrome grant alone contributes its theme/layout and nothing else.
      const whole = viewerAllows(viewer, `plugin:${plugin.id}`);
      const short = shortPluginId(plugin.id);
      if (whole && plugin.route) pages.add(plugin.route);
      if (whole && plugin.kind.includes('widget')) widgets.add(short);
      if (plugin.kind.includes('theme') && pluginVisible(plugin, viewer)) themes.add(short);
      if (plugin.kind.includes('layout') && pluginVisible(plugin, viewer)) layouts.add(short);
    }
  }

  return {
    pages: [...pages].sort(),
    widgets: [...widgets].sort(),
    nav: [...nav].sort(),
    plugins: [...pluginIds].sort(),
    themes: [...themes].sort(),
    layouts: [...layouts].sort(),
  };
}

/**
 * Pages no grant takes away: the account's own business. Mirror of
 * `SELF_SERVICE_PAGES` in `app/src/lib/capabilities.ts`, absent from the
 * permission catalogue on purpose.
 */
export const SELF_SERVICE_PAGES: readonly string[] = ['/profile'];

/**
 * Whether the app's page gate (`isPageSurfaceAllowed`) opens `path` for this
 * viewer. Same inputs as `/api/capabilities`, so a daemon-side listing never
 * offers a page the browser then paints as forbidden.
 */
export function pageOpenerFor(
  viewer: DbViewer | null | undefined,
  plugins: readonly PluginPublic[] = [],
): (path: string) => boolean {
  const surfaces = surfacesForViewer(viewer, plugins);
  const pages = surfaces.all === true ? null : new Set(surfaces.pages);
  return (path) => SELF_SERVICE_PAGES.includes(path) || pages === null || pages.has(path);
}

export function attachSurfaces<T extends object>(
  payload: T,
  viewer: DbViewer | null | undefined,
  plugins: readonly PluginPublic[] = [],
): T & { surfaces: SurfacesView } {
  return { ...payload, surfaces: surfacesForViewer(viewer, plugins) };
}

/**
 * The whole of a third-party package: its host API (`ctx.router`), and every
 * surface it declares. `plugin:<id>` (or `plugin:*` / `*`) is the only grant
 * that opens it — deny-by-default, 404 rather than 403 so a hidden plugin
 * does not confirm its existence.
 *
 * Chrome surface grants are deliberately NOT accepted here. They name a
 * theme or layout, not a package: a role allowed to wear third-party chrome
 * gets the browser half that paints it (`thirdPartyAssetVisible`) and nothing
 * else. Deciding from the id alone would also trust a permission string the catalogue never
 * minted — a hand-typed `layout:acme-crm` on a `kind: widget` package would
 * open its API.
 */
export function thirdPartyPluginVisible(
  viewer: DbViewer | null | undefined,
  id: string,
): boolean {
  if (viewerSurfacesUnrestricted(viewer)) return true;
  return viewerAllows(viewer, `plugin:${id}`);
}

/**
 * Third-party browser half (`client.js`) and gallery art (`cover`,
 * `still/<n>`): `plugin:<id>`, or a matching chrome surface grant when the
 * resolved package kind really contains `theme` / `layout`
 * (`docs/MULTI-THEME.md` §3.3).
 *
 * `kinds` is the resolved identity of that id, read from the loader at the
 * route (`plugins-bundled/plugins/routes.ts`), never inferred from the
 * permission. An id the loader does not know yields an empty list, which
 * falls back to the strict `plugin:<id>` curtain — absence of kind is never
 * a grant.
 *
 * Third-party ids carry no scope (`manifest.ts` forbids `/`), so the short id
 * is the id; `shortPluginId` is applied anyway to mirror the catalogue.
 */
export function thirdPartyAssetVisible(
  viewer: DbViewer | null | undefined,
  id: string,
  kinds: readonly string[] = [],
): boolean {
  if (thirdPartyPluginVisible(viewer, id)) return true;
  const short = shortPluginId(id);
  if (kinds.includes('theme') && viewerAllows(viewer, `theme:${short}`)) return true;
  if (kinds.includes('layout') && viewerAllows(viewer, `layout:${short}`)) return true;
  return false;
}

export type ChromeNature = 'theme' | 'layout';

/**
 * Whether this viewer may *choose* a theme or layout plugin (T.7 / MULTI-THEME.md §3.1).
 *
 * Superadmin / `*` / first-run: yes. Otherwise `plugin:<id>`, or the surface
 * grant (`theme:<short>` / `layout:<short>`). Refusal at PUT is 404, not 403:
 * a hidden third-party package must not confirm it exists (M.4).
 */
export function viewerMayChooseChrome(
  viewer: DbViewer | null | undefined,
  plugin: PluginPublic,
  nature: ChromeNature,
): boolean {
  if (viewerSurfacesUnrestricted(viewer)) return true;
  if (viewerAllows(viewer, `plugin:${plugin.id}`)) return true;
  const short = shortPluginId(plugin.id);
  return nature === 'theme'
    ? viewerAllows(viewer, `theme:${short}`)
    : viewerAllows(viewer, `layout:${short}`);
}

/**
 * Resolve a PUT `/api/prefs` `theme` / `layout` value against the gallery.
 * Unknown, inactive, wrong kind, or not granted → `null` (HTTP 404).
 */
export function resolveChromeChoice(
  plugins: readonly PluginPublic[],
  viewer: DbViewer | null | undefined,
  id: unknown,
  nature: ChromeNature,
): PluginPublic | null {
  if (typeof id !== 'string' || !id) return null;
  const plugin = plugins.find((row) => row.id === id);
  if (!plugin || plugin.state !== 'active') return null;
  if (!plugin.kind.includes(nature)) return null;
  if (!viewerMayChooseChrome(viewer, plugin, nature)) return null;
  return plugin;
}
