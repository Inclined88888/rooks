/**
 * The pages a person keeps in the side menu, and how they lay it out. Hiding
 * an entry takes it out of the menu, nothing else: the page still opens by its
 * address, and the menu offers to show every page again. The layout (TODO
 * #456) is the main list top to bottom (`order`) and the foot of the menu
 * above Settings (`footer`): paths and separators (`NAV_SEPARATOR`), the same
 * row `app/src/lib/nav-order.ts` writes.
 *
 * The menu is built in the browser from the plugins' `nav.item` entries, so
 * the daemon does not hold its list. `NAV_PAGES` mirrors the product's own
 * entries (`registerNavItem` calls in `app/src/plugins-client/`) to tell an
 * agent what it can hide; a path outside it is accepted when it is shaped like
 * a view, with a warning, like a plugin's page in `ui_navigate`.
 */
import { z } from 'zod';
import { CORE_ROUTES } from './navigate-model.js';
import { ViewPath, workspaceKey, type ProposalProblem } from './widget-model.js';

/** `NAV_SUFFIX` of `app/src/lib/workspace-scope.ts`: the account's menu row. */
export const NAV_SUFFIX = 'nav';

export function sharedNavKey(owner: string): string {
  return `${workspaceKey(owner, '', null)}.${NAV_SUFFIX}`;
}

/** The product's side-menu entries, in menu order. */
export const NAV_PAGES: ReadonlyArray<{ path: string; title: string }> = [
  { path: '/', title: 'Cockpit' },
  { path: '/brain', title: 'Brain' },
  { path: '/agents', title: 'Agents' },
  { path: '/bots', title: 'TIMs' },
  { path: '/projects', title: 'Projects' },
  { path: '/multichat', title: 'Multichat' },
  { path: '/kanban', title: 'Kanban' },
  { path: '/triggers', title: 'Triggers (routines and triggers)' },
  { path: '/workflows', title: 'Workflows' },
  { path: '/dreams', title: 'Dreams' },
  { path: '/activity', title: 'Activity' },
  { path: '/terminal', title: 'Terminal' },
  { path: '/capabilities', title: 'Capabilities' },
  { path: '/plugins', title: 'Plugins' },
];

const KNOWN = new Set([...NAV_PAGES.map((p) => p.path), ...CORE_ROUTES.map((r) => r.path)]);

export const NAV_HIDDEN_MAX = 64;
/** `MAX` of `app/src/lib/nav-order.ts`: paths and separators of one list. */
export const NAV_LIST_MAX = 96;
/** `NAV_SEPARATOR` of `app/src/lib/nav-order.ts`: a gap in the menu, never a page. */
export const NAV_SEPARATOR = '---';

const NavToken = z.union([ViewPath, z.literal(NAV_SEPARATOR)]);

/**
 * Declarative, each field optional, at least one: `hidden` is the complete
 * list of hidden entries once applied (`[]` shows them all); `order` replaces
 * the main list, `footer` the foot of the menu. A list left out keeps what the
 * menu has, minus the pages the other one moves.
 */
export const NavProposal = z.object({
  hidden: z.array(ViewPath).max(NAV_HIDDEN_MAX).optional(),
  order: z.array(NavToken).max(NAV_LIST_MAX).optional(),
  footer: z.array(NavToken).max(NAV_LIST_MAX).optional(),
}).strict().refine((p) => p.hidden !== undefined || p.order !== undefined || p.footer !== undefined, {
  message: 'give at least one of `hidden`, `order`, `footer`',
});
export type NavProposalPayload = z.infer<typeof NavProposal>;

export const NAV_PROPOSAL_MAX_BYTES = 8192;

export function validateNavProposal(p: NavProposalPayload): { problems: ProposalProblem[]; warnings: string[] } {
  const problems: ProposalProblem[] = [];
  const warnings: string[] = [];
  const hidden = p.hidden ?? [];
  if (new Set(hidden).size !== hidden.length) {
    problems.push({ code: 'duplicate_page', message: 'a page is listed twice in `hidden`' });
  }
  for (const path of hidden) {
    if (!KNOWN.has(path)) warnings.push(`${path} is not a menu entry of the product: it is hidden only if a plugin of the user adds it.`);
  }
  const placed = [...(p.order ?? []), ...(p.footer ?? [])].filter((t) => t !== NAV_SEPARATOR);
  if (new Set(placed).size !== placed.length) {
    problems.push({ code: 'duplicate_page', message: 'a page is placed twice across `order` and `footer`' });
  }
  for (const path of placed) {
    if (!KNOWN.has(path)) warnings.push(`${path} is not a menu entry of the product: it takes that place only if a plugin of the user adds it.`);
  }
  return { problems, warnings };
}

/**
 * The layout stored in the account's menu row; `null` lists when the person
 * never laid it out (`footer: null` alone: a row from before the foot, whose
 * only separator is the product's own between its two groups).
 */
export function readNavLayout(raw: string | undefined): { order: string[] | null; footer: string[] | null } {
  if (!raw) return { order: null, footer: null };
  try {
    const value = JSON.parse(raw) as { order?: unknown; footer?: unknown };
    const list = (v: unknown) => {
      const parsed = z.array(NavToken).max(NAV_LIST_MAX).safeParse(v);
      return parsed.success ? parsed.data : null;
    };
    return { order: list(value.order), footer: list(value.footer) };
  } catch {
    return { order: null, footer: null };
  }
}

/** The hidden entries stored in the account's menu row (`{pinned?, hidden?, order?, footer?}`). */
export function readHiddenNav(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as { hidden?: unknown };
    const parsed = z.array(ViewPath).max(NAV_HIDDEN_MAX).safeParse(value.hidden);
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}
