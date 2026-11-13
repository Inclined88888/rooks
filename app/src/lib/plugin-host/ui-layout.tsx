'use client';

import { TopBar } from '@/components/topbar';
import { WidgetZone } from '@/components/widget-host/widget-zone';
import { IslandWorkspace } from '@/components/islands/island-workspace';
import { Slot, SlotKeyed, SlotRegion } from './render';
import type { SlotChildren } from './slots';
import { NEXT_ROUTER_KEY } from './page-slot';
import { SETTINGS_GRAFT_SLOTS } from './settings-slots';
import { t } from '@/lib/i18n';

export const UI_LAYOUT_CHILD_SLOTS: SlotChildren = {
  // Keyed by route since U.10: the Next tree holds the reserved
  // `NEXT_ROUTER_KEY`, a page plugin holds its own `route`.
  page: 'keyed',
  'nav.item': 'list',
  // The foot of the nav, above the settings gear: a control that belongs to
  // the whole interface rather than to one page (the machine switcher of the
  // Machines plugin, TODO #329). Exact admission — no `.widget` suffix, so a
  // widget cannot land here, and declaring `nav.item` does not open it. The
  // nav paints nothing for it while it is empty.
  'nav.footer': 'list',
  'topbar.item': 'list',
  'cockpit.widget': 'list',
  'agents.view': 'keyed',
  'agents.left.widget': 'list',
  'agents.right.widget': 'list',
  // Controls a plugin adds to the action bar of `/agents` ("Import agents",
  // "Export"). Exact admission, and declared at boot: a client half
  // registers long before the page shows.
  'agents.toolbar': 'list',
  // Compact icon buttons a plugin adds to the foot of the `/bots` rail, beside
  // "New bot" ("Import"). Same admission and boot declaration.
  'bots.rail.action': 'list',
  // Entries a plugin adds to the menu of one agent ("…" or right click on a
  // row of the bots rail): the occupant reads the agent from `useAgentMenuItem()`.
  'agent.menu.item': 'list',
  // An alternative a plugin offers under the onboarding's agent step ("I
  // already have agents"). Declared at boot for the same reason: the setup
  // pages are reached before any other.
  'onboarding.agent': 'list',
  // `chat.panel` went away in U.5: the blocks of the chat's right rail are
  // cards of `chat.right.widget`, and nobody painted that slot any more once
  // the mission sheet was unmounted. A third-party panel registers in a
  // widget zone, like ours.
  'chat.composer.action': 'list',
  // Buttons under a chat bubble, beside Copy, Copy as Markdown, Reply and Read
  // aloud (client API 15): the occupant reads the bubble from `useChatMessage()`.
  'chat.message.action': 'list',
  // A plugin's own settings category (sidebar item + pane). Keyed by plugin
  // id. Do not rename: this is the exact slot a plugin occupies to appear as
  // a real category, not a dump at the bottom of `/settings`.
  'settings.section': 'keyed',
  // A plugin's own form for one of its connection types, keyed by the
  // qualified type id (`<plugin>:<name>@<version>`); `useConnectionForm()`
  // hands it the type and `submit`. Absent: the generic form.
  'settings.connection.form': 'keyed',
  // Graft into a native category. Exact admission — a widget cannot land
  // here, and declaring `settings.missions` does not open `settings.resources`.
  // Declared at boot (same reason as `kanban.column` / `settings.section`): a
  // client half registers at mount, before `/settings` is on screen.
  ...SETTINGS_GRAFT_SLOTS,
  // Columns added to the Kanban board, before the four statuses. Declared
  // here and not by the page: a client half registers when the application
  // mounts, long before `/kanban` is on screen, and a slot that only existed
  // while the page shows would refuse the registration. Same reason as
  // `settings.section`, whose page is `/settings`.
  'kanban.column': 'list',
  // Blocks a plugin adds to the detail of a TO DO idea, below its tags. Same
  // reason as `kanban.column`: declared at boot, the dialog opens much later.
  'kanban.todo.detail': 'list',
  // Badges a plugin adds to an idea, in every place its badges show (widget
  // lines, Kanban TO DO column, detail). Declared at boot for the same reason.
  'kanban.todo.badge': 'list',
  // Sections a plugin adds at the head of the MCP tab of Capabilities, above
  // the user's own servers (the official connectors of `@rooks/mcp-apps`).
  // Declared at boot for the same reason: the tab opens much later.
  'mcp.featured': 'list',
  // The built-in browser's chrome (`components/browser-chrome.tsx`): controls
  // in its address bar, drawers it opens over the page, and layers over the
  // page's picture. Declared at boot for the same reason: a client half
  // registers long before a browser opens.
  'browser.toolbar': 'list',
  'browser.drawer': 'keyed',
  'browser.surface': 'list',
  'mission.card.action': 'list',
  // Badges a plugin adds to a mission, wherever missions are listed (chat rail,
  // missions table and detail). Declared at boot: the lists mount much later.
  'mission.card.badge': 'list',
  // Generic widget hosts: unlike `nav.item`, these carry no
  // contract on what they hold — any cockpit-style widget can land there.
  // They are the destinations that make a widget movable out of the cockpit.
  // The `.widget` suffix is what opens them: see `slot-compat.ts`, a plugin
  // declaring any widget slot is admitted into all of them.
  'sidebar.left.widget': 'list',
  'sidebar.right.widget': 'list',
  // The top bar's own widget zone. A line, not a column: only a widget that
  // registers a flat form (`bar: true`) is let in — see `widget-dnd.ts`.
  // `topbar.item` above keeps its contract for plain controls.
  'topbar.widget': 'list',
  // In-app overlay layer, above the chrome and outside any widget host: a
  // mascot positions itself and is never dragged into a rail. Exact-match
  // admission — the name has no `.widget` suffix precisely so that a widget
  // cannot land here (see `slot-compat.ts`). Not an OS window.
  overlay: 'list',
  // Contents of the island workspace (`docs/ISLAND-WORKSPACE.md` §5). A list,
  // not keyed: the host derives the type id `<pluginId>:<key>` itself, so two
  // plugins may both register the key `view`. Exact admission — no `.widget`
  // suffix, an island content carries a contract widgets do not (stored
  // params, singleton). Declared at boot: a client half registers long before
  // a view mounts a workspace.
  'island.content': 'list',
  // Speech-to-text engines (`kind: dictation`, client API 14, TODO #484),
  // keyed by registration key; the product routes by engine id. Exact
  // admission, and `register` also wants `dictation:engine`. Declared at boot:
  // an engine registers long before anyone dictates.
  'dictation.engine': 'keyed',
};

/**
 * The overlay layer: full screen, transparent to clicks, only what its
 * occupants paint receives them.
 *
 * Pulled out as a constant to be checkable without mounting the whole chrome:
 * it is a contract towards the plugins (a mascot positions itself, `fixed`,
 * and must stay clickable), not a decoration. `z-[40]` puts it above the
 * chrome and below the modals (`z-50`): a layer covering a modal would make a
 * dialog unusable without anyone knowing where it comes from.
 */
export const OVERLAY_LAYER_CLASS =
  'pointer-events-none fixed inset-0 z-[40] [&>*]:pointer-events-auto';

export function AppFrame(): React.ReactElement {
  return (
    // WidgetHost lives on the root layout: Agents/Multichat/Chat render
    // TopBar → VerticalNav → WidgetZone without this frame, and a second
    // host here would split the drag context. A third-party `root` that
    // wants its own host still can; this frame just consumes the nearest.
    <div className="relative z-[1] flex h-dvh flex-col">
      {/* The global banners moved INTO the TopBar: they belong at the very
          top of the page, and their height has to count in
          `--rooks-topbar-h`. */}
      <TopBar />
      {/* The right gutter follows the browser side panel: it is `fixed`, so
          the content has to shift — same opt-in contract as `--rooks-nav-w`
          on the left. */}
      <main className="rooks-island-backdrop flex min-h-0 flex-1 gap-[var(--rooks-island-gap)] overflow-hidden pb-[var(--rooks-island-gap)] pl-[var(--rooks-nav-w)] pr-[var(--rooks-island-gap)]">
        {/* The page keeps the column it has always had; the right widget
            rail is a flex sibling, so it steals width from the page only
            once a widget is placed there. The island workspace is that
            column: until something is opened next to the page, it renders
            this very frame and nothing else (docs/ISLAND-WORKSPACE.md §1). */}
        <IslandWorkspace
          // `relative`: a clear island (glass, widgets scope) lays its copy of the wallpaper inside.
          className="rooks-island relative flex min-h-0 flex-1 flex-col"
          route={<SlotKeyed name="page" entryKey={NEXT_ROUTER_KEY} />}
        />
        {/* Chrome, like the nav rail: a compact zone, where the bell and the
            quota rings show as icons. Content zones (cockpit, chat columns)
            keep the cards. */}
        <WidgetZone
          zone="sidebar.right.widget"
          slot="sidebar.right.widget"
          compact
          hideWhenEmpty
          label={t('layout.rightWidgets')}
          className="rooks-island flex w-72 shrink-0 flex-col gap-3 overflow-y-auto bg-surface-1 p-3"
          emptyClassName="w-56 border-dashed bg-transparent"
        />
      </main>
      <SlotRegion name="overlay" label={t('layout.overlay')} className={OVERLAY_LAYER_CLASS} />
    </div>
  );
}
