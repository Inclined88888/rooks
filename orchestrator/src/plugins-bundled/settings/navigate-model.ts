/**
 * Navigation an agent asks its owner to follow: "go to the Kanban",
 * "open the settings on Agents".
 *
 * A target is a **path of the app plus a few typed parameters**, never a free
 * URL: the browser rebuilds the address itself, so nothing here can point
 * outside the app (`javascript:`, `//host`, a query smuggled in the path).
 * Pages a plugin declares (`route` of its manifest, or of its bundled
 * identity) are listed too, but only those of an active plugin the owner's
 * grants open (`pluginPages`): a page the owner cannot see is not confirmed
 * to exist. The product's own pages are filtered by the same grants
 * (`CorePageAllowed`): their list is public, so a page the owner cannot open is
 * refused outright rather than raised as a card that would end on a forbidden
 * screen. A path outside both lists is still accepted when it is shaped like a
 * view, and flagged so the agent knows it was not verified.
 */
import { z } from 'zod';
import type { PluginPublic } from '../../plugins/public.js';
import { ViewPath, type ProposalProblem } from './widget-model.js';

/** Pages shipped with the product: path, what the user sees, parameters it takes. */
export const CORE_ROUTES: ReadonlyArray<{
  path: string;
  title: string;
  params?: Record<string, string>;
}> = [
  { path: '/', title: 'Cockpit' },
  { path: '/kanban', title: 'Kanban' },
  { path: '/terminal', title: 'Terminal' },
  { path: '/chat', title: 'Chat', params: { mission: 'Mission id to open', project: 'Project slug' } },
  { path: '/multichat', title: 'Multichat' },
  { path: '/agents', title: 'Agents' },
  { path: '/projects', title: 'Projects' },
  { path: '/events', title: 'Events' },
  { path: '/notifications', title: 'Notifications' },
  { path: '/missions', title: 'Missions' },
  { path: '/pipelines', title: 'Pipelines' },
  { path: '/skills', title: 'Skills' },
  { path: '/mcp', title: 'MCP servers' },
  { path: '/plugins', title: 'Plugins' },
  { path: '/messages', title: 'Messages' },
  { path: '/dashboard', title: 'Dashboard' },
  { path: '/profile', title: 'Profile' },
  { path: '/license', title: 'License' },
  { path: '/settings', title: 'Settings', params: { section: 'Settings section id' } },
];

const KNOWN = new Map(CORE_ROUTES.map((r) => [r.path, r]));

/** Titles of the bundled pages that are menu entries but not `CORE_ROUTES` (`NAV_PAGES` mirror). */
const BUNDLED_TITLES: Readonly<Record<string, string>> = {
  '/brain': 'Brain',
  '/bots': 'Bots',
  '/triggers': 'Triggers',
  '/workflows': 'Workflows',
  '/dreams': 'Dreams',
};

/** A page of a plugin, as `ui_routes` lists it. */
export type PluginPage = {
  path: string;
  title: string;
  /** `bundled`: a module of the product; `third-party`: a package the operator installed. */
  origin: 'bundled' | 'third-party';
  plugin: string;
};

/**
 * A third-party label is the package author's text, read by an agent: one line,
 * bounded, so it cannot carry a paragraph of instructions into the listing.
 */
const TITLE_MAX = 60;
function cleanTitle(raw: string | null, path: string): string {
  const line = (raw ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (line) return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
  const word = path.slice(1).split('/')[0] ?? '';
  return word ? word.charAt(0).toUpperCase() + word.slice(1) : path;
}

/**
 * The pages plugins add beyond `CORE_ROUTES`, for one owner: the plugin must be
 * active and `allowed` (the owner's grants, `allowedFor`), and its route a view
 * path `ui_navigate` would accept — a route with a query (`/agents?view=…`) is
 * left out rather than listed as something the agent cannot propose.
 */
export function pluginPages(plugins: readonly PluginPublic[], allowed: (pluginId: string) => boolean): PluginPage[] {
  const pages = new Map<string, PluginPage>();
  for (const p of plugins) {
    const path = p.route;
    if (!path || KNOWN.has(path) || pages.has(path)) continue;
    if (!ViewPath.safeParse(path).success) continue;
    if (p.state !== 'active' || !allowed(p.id)) continue;
    const bundled = p.source === 'bundled';
    pages.set(path, {
      path,
      title: cleanTitle(bundled ? BUNDLED_TITLES[path] ?? null : p.label, path),
      origin: bundled ? 'bundled' : 'third-party',
      plugin: p.id,
    });
  }
  return [...pages.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** Whether the owner's page gate opens a page of the product (`pageOpenerFor`). */
export type CorePageAllowed = (path: string) => boolean;
const ANY_CORE_PAGE: CorePageAllowed = () => true;

/** Parameter values are plain identifiers: they end up in a query string the browser builds. */
const ParamValue = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/);

export const NavigateProposal = z.object({
  path: ViewPath,
  params: z.record(z.string().regex(/^[a-z]{1,20}$/), ParamValue).refine((p) => Object.keys(p).length <= 4).optional(),
}).strict();
export type NavigateProposalPayload = z.infer<typeof NavigateProposal>;

export const NAVIGATE_PROPOSAL_MAX_BYTES = 2048;

/**
 * Problems that refuse the proposal, and warnings that go back to the agent.
 * `plugins` are the owner's plugin pages (`pluginPages`); without them (a stored
 * card revalidated) a plugin page is merely unverified, never refused. Likewise
 * `corePage`: a stored card is not refused for it, the browser's gate decides.
 */
export function validateNavigateProposal(
  p: NavigateProposalPayload,
  plugins: readonly PluginPage[] = [],
  corePage: CorePageAllowed = ANY_CORE_PAGE,
): { problems: ProposalProblem[]; warnings: string[] } {
  const problems: ProposalProblem[] = [];
  const warnings: string[] = [];
  const known = KNOWN.get(p.path);
  if (!known) {
    const page = plugins.find((x) => x.path === p.path);
    if (!page) {
      warnings.push(`${p.path} is not a page of the product nor of a plugin the user can open: it works only if something provides it.`);
    } else if (Object.keys(p.params ?? {}).length) {
      // A manifest declares no parameters: they go through, unverified, as plain identifiers.
      warnings.push(`${p.path} (plugin ${page.plugin}) declares no parameters: they are passed as they are.`);
    }
    return { problems, warnings };
  }
  if (!corePage(p.path)) {
    problems.push({ code: 'page_not_allowed', message: `the user's permissions do not open ${p.path}: they would see a "not allowed" screen` });
  }
  for (const key of Object.keys(p.params ?? {})) {
    if (!known.params || !(key in known.params)) {
      problems.push({ code: 'unknown_param', message: `${p.path} takes no "${key}" parameter` });
    }
  }
  return { problems, warnings };
}

export type DescribedRoute = {
  path: string;
  title: string;
  params: Record<string, string> | null;
  origin: 'core' | PluginPage['origin'];
  plugin: string | null;
};

/**
 * What `ui_routes` lists: the product's pages the owner can open, then the
 * owner's plugin pages, each marked by origin.
 */
export function describeRoutes(plugins: readonly PluginPage[] = [], corePage: CorePageAllowed = ANY_CORE_PAGE): DescribedRoute[] {
  return [
    ...CORE_ROUTES.filter((r) => corePage(r.path)).map((r) => ({ path: r.path, title: r.title, params: r.params ?? null, origin: 'core' as const, plugin: null })),
    ...plugins.map((p) => ({ path: p.path, title: p.title, params: null, origin: p.origin, plugin: p.plugin })),
  ];
}
