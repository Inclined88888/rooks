import { MAIN_AGENT_WIDGET_ID } from '@/lib/main-agent-card';
import { ADD_WIDGET_IDS } from './add-widget';
import { fusionnerLayout, placementHerite, type ContraintesWidget, type WidgetLayout } from './widget-layout';

/**
 * What a view looks like before anyone has touched it.
 *
 * A starter is a full placement and not just a rail: the shipped cockpit and
 * the shipped chat are an arrangement that was built by hand, then captured
 * (frameless cards, stacked tabs, shares of the free height). Reducing it to
 * `[rail, rank, height]` would have lost exactly what makes it look composed.
 *
 * Only VISIBLE cards belong here. Absence IS removal below, so a starter
 * table that listed every widget would put back on screen the ones the
 * arrangement deliberately leaves in the palette.
 */
type Starter = Omit<WidgetLayout, 'id' | 'removed'>;

const [ADD_WIDGET, ADD_WIDGET_2] = ADD_WIDGET_IDS as [string, string];

/**
 * A fresh install's arrangements, kept short on purpose (the maintainer's request of
 * 05/11/2026): a few cards that say what each view is for, and a dashed
 * "Your widget here" (`add-widget.ts`) where the person's own will go.
 */
const STARTERS: Record<string, Record<string, Starter>> = {
  '/': {
    'plugin:@rooks/agents:notifications': { rail: 'gauche', rang: 0, hauteur: 520, heightMode: 'fill', fillPercent: 66, borderless: true, transparent: true },
    [ADD_WIDGET]: { rail: 'gauche', rang: 1, hauteur: 160, heightMode: 'fill', fillPercent: 34 },
    [MAIN_AGENT_WIDGET_ID]: { rail: 'centre', rang: 0, hauteur: 520, heightMode: 'fill', borderless: true, transparent: true },
    'plugin:@rooks/kanban:todo': { rail: 'droite', rang: 0, hauteur: 320, heightMode: 'fill', fillPercent: 50, borderless: true, transparent: true },
    'plugin:@rooks/agents:tasks': { rail: 'droite', rang: 1, hauteur: 400, heightMode: 'fill', fillPercent: 50, borderless: true, transparent: true },
  },
  // The agents canvas starts bare: one "Your widget here" at the foot of
  // each column, at its own height (`widget-zone.tsx`, `docked`).
  '/agents': {
    [ADD_WIDGET]: { rail: 'agents.left.widget', rang: 0, hauteur: 160 },
    [ADD_WIDGET_2]: { rail: 'agents.right.widget', rang: 0, hauteur: 160 },
  },
  // A project's chat: its missions and files on the left, its repository and
  // containers on the right. A card whose module is off on this install
  // simply never registers, and the column shares its height among the rest.
  '/chat': {
    'plugin:@rooks/missions:Missions': { rail: 'chat.left.widget', rang: 0, hauteur: 300, heightMode: 'fill', fillPercent: 50 },
    'plugin:@rooks/files-widget:Files': { rail: 'chat.left.widget', rang: 1, hauteur: 300, heightMode: 'fill', fillPercent: 50 },
    'plugin:@rooks/git:repository': { rail: 'chat.right.widget', rang: 0, hauteur: 320, heightMode: 'fill', fillPercent: 66 },
    'plugin:@rooks/docker-supervision:docker': { rail: 'chat.right.widget', rang: 1, hauteur: 260, heightMode: 'fill', fillPercent: 34 },
  },
};

/**
 * What a view shows, given what is known of its stored placement.
 *
 * `known` is the whole point: `raw === null` says "nothing stored" AND "not
 * read yet", and the two call for opposite paintings. Serving the STARTERS
 * before the scope has answered shows an arrangement that belongs to nobody
 * — factory cards, at factory heights — and replaces it a second later with
 * the user's own. An empty board for the length of one read is the honest
 * state: nothing is known, so nothing is claimed.
 */
export function workspaceWidgets(
  raw: unknown,
  known: boolean,
  constraints: readonly ContraintesWidget[],
  view: string,
  chatZonesMounted = false,
): WidgetLayout[] {
  return known ? mergeWorkspaceWidgets(raw, constraints, view, chatZonesMounted) : [];
}

const CHAT_VIEW = '/chat';
const CHAT_ZONES = ['chat.left.widget', 'chat.right.widget'];

/** A chat column, or one of its tabs (`<column>#<suffix>`, `chat-columns.ts`). */
export function isChatZone(zone: unknown): boolean {
  return typeof zone === 'string' && CHAT_ZONES.some((z) => zone === z || zone.startsWith(`${z}#`));
}

/**
 * Where the chat's cards start on a view that is not `/chat`, once a chat is
 * open there (ISLAND-WORKSPACE.md §7, Q14): the places of `/chat`, then the
 * view's own. Nothing is borrowed from `/chat`'s row — the host keeps one
 * source of layout — and only while a chat zone is mounted, or the first
 * gesture on a view without a chat would write chat places into its row.
 */
function chatStartersFor(view: string, chatZonesMounted: boolean): Record<string, Starter> {
  return chatZonesMounted && view !== CHAT_VIEW ? STARTERS[CHAT_VIEW] ?? {} : {};
}

/**
 * A stored card the chat's places apply to: taken out without ever having
 * been in a chat column of this view — the default of a card the view did not
 * place. One the user removed FROM a chat column keeps that column as its
 * rail, and stays out.
 */
function reseedFromChat(item: unknown, chatStarters: Record<string, Starter>): unknown {
  if (typeof item !== 'object' || item === null) return item;
  const entry = item as Partial<WidgetLayout>;
  const starter = typeof entry.id === 'string' ? chatStarters[entry.id] : undefined;
  if (!starter || entry.removed !== true || isChatZone(entry.rail)) return item;
  const { removed: _removed, ...rest } = entry;
  return { ...rest, ...starter };
}

/**
 * Existing placements win. New registrations remain available in the palette,
 * except a widget `placedByDefault`: it was on screen before it was a widget
 * (the top bar's bell), so it lands in its zone on every view that has not
 * placed or removed it yet — stored layout or not, starter or not. A widget
 * renamed since takes over the place its former id had.
 */
export function mergeWorkspaceWidgets(
  raw: unknown,
  constraints: readonly ContraintesWidget[],
  view: string,
  chatZonesMounted = false,
): WidgetLayout[] {
  const chatStarters = chatStartersFor(view, chatZonesMounted);
  if (Array.isArray(raw) && Object.keys(chatStarters).length > 0) raw = raw.map((item) => reseedFromChat(item, chatStarters));
  const existing = Array.isArray(raw);
  const known = new Set(existing ? (raw as unknown[]).map(item => (item as { id?: unknown } | null)?.id) : []);
  const starters = STARTERS[view] ?? {};
  const byId = new Map(constraints.map(c => [c.id, c]));
  const additions = fusionnerLayout(null, constraints).filter(widget => !known.has(widget.id)).map(widget => {
    const constraint = byId.get(widget.id);
    const inherited = placementHerite(raw, constraint?.formerIds ?? [], widget.id);
    if (inherited) return inherited;
    const initial = (!existing ? starters[widget.id] : undefined) ?? chatStarters[widget.id];
    if (!initial) return constraint?.placedByDefault ? widget : { ...widget, removed: true };
    return { ...widget, ...initial, hauteur: Math.max(initial.hauteur, constraints.find(c => c.id === widget.id)?.hauteurMin ?? 0) };
  });
  return fusionnerLayout(existing ? [...(raw as unknown[]), ...additions] : additions, constraints);
}
