'use client';

import dynamic from 'next/dynamic';
import { Plug, Waypoints } from 'lucide-react';
import { t } from '@/lib/i18n';
import { AGENTS_LEFT_ZONE, AGENTS_RIGHT_ZONE } from '@/app/agents/agents-widget-rails';
import { registerWidget } from './widget';
import { SKILL_ISLAND_KEY, parseSkillIslandParams } from '@/lib/skill-island-content';
import type { IslandParams, TabId } from '@/lib/island-tree';
import { ISLAND_ICON_SKILL } from '@/lib/island-tab-icons';
import { isNavSurfaceAllowed } from '@/lib/capabilities';
import { CAPABILITY_ROUTES, CapabilitiesPage, type CapabilityTabId } from './capabilities/capabilities-page';
import { registerNavItem } from './nav';
import { registerPage } from './page';
import type { BundledClientPlugin } from './types';
import { widgetPicto } from './widget-pictos';
import { TOPBAR_CENTER_ZONE } from '@/components/widget-host/widget-catalog';
import { WorkingAgentsWidget } from './working-agents/working-agents-widget';
import { AGENT_LOOK_STYLER_SLOT, AGENT_MASCOT_SLOT } from '@/lib/plugin-host/slots';
import { ProductAgentMascot } from '@/components/mascot/agent-mascot';
import { ProductLookStyler } from '@/components/mascot/look-styler/look-styler';

// Loaded on demand (docs/BUNDLE-SIZE.md): statically imported, every page of the app paid for it.
// The skill viewer embeds the file editor (CodeMirror, markdown): first skill tab only.
const SkillIsland = dynamic(() => import('@/components/skills/skill-island').then((m) => m.SkillIsland), { ssr: false });
// Lazy like the island itself: the draft store lives with the editor chunk, and
// a tab restored before it ever loaded has no draft to ask about.
const confirmDocumentClose = (params: IslandParams, tabId: TabId) =>
  import('@/components/chat/file-island').then((m) => m.confirmDocumentClose(params, tabId));
const forgetDocumentDraft = (params: IslandParams, tabId: TabId) => {
  void import('@/components/chat/file-island').then((m) => m.forgetDocumentDraft(params, tabId));
};
const QueueRail = dynamic(() => import('@/app/agents/queue-rail').then((m) => m.QueueRail), { ssr: false });
const NotificationRail = dynamic(() => import('@/app/agents/notification-rail').then((m) => m.NotificationRail), { ssr: false });
const AgentInjectionsCard = dynamic(() => import('./agent-injections/agent-injections-card').then((m) => m.AgentInjectionsCard), { ssr: false });
const AgentTrashPanel = dynamic(() => import('./agent-trash/agent-trash-panel').then((m) => m.AgentTrashPanel), { ssr: false });

export const coreAgentsClient: BundledClientPlugin = {
  module: '@rooks/agents',
  apply(ctx) {
    // Default occupant of `agent.mascot` (a boot slot, docs/AGENT-MASCOT.md):
    // the agent's meerkat, wherever a screen mounts `AgentMascotHost`. A plugin
    // that takes the slot replaces it everywhere at once; with the module off,
    // each host still paints the product's drawing.
    ctx.register({ slot: AGENT_MASCOT_SLOT, fallback: true }, ProductAgentMascot);
    // Default occupant of `agent.lookstyler` (a boot slot, docs/AGENT-AVATAR.md):
    // the mascot configurator of the onboarding and of the editor's Avatar tab.
    // A plugin that takes the slot changes both at once.
    ctx.register({ slot: AGENT_LOOK_STYLER_SLOT, fallback: true }, ProductLookStyler);
    // The top bar's agent tabs, and the former "Agents list" card: one
    // widget, its options say what it lists (TODO #479). It was on screen
    // before it was a widget, so it lands in the middle of the top bar on
    // every view that never placed nor removed it (`placedByDefault`). No
    // `formerKeys: ['team']`: inheriting the list card's place took the strip
    // out of the bar, into a cockpit rail or a hidden chat tab, on every view
    // that had kept that card — the bar is what everyone had on screen.
    registerWidget(ctx, {
      key: 'working',
      widget: {
        title: t('widgetCatalog.workingAgents.title'), icon: widgetPicto('workingAgents'), description: t('widgetCatalog.workingAgents.description'),
        zone: TOPBAR_CENTER_ZONE, height: 300, minHeight: 120, frame: 'none', bar: true, placedByDefault: true,
      },
      Component: WorkingAgentsWidget,
    });
    registerWidget(ctx, { key: 'notifications', zone: 'agents.notifications', widget: { title: t('widgetCatalog.notificationCenter.title'), icon: widgetPicto('notificationCenter'), description: t('widgetCatalog.notificationCenter.description'), zone: AGENTS_LEFT_ZONE, height: 520, minHeight: 200, frame: 'none' }, Component: NotificationRail });
    registerWidget(ctx, { key: 'tasks', widget: { title: t('widgetCatalog.taskQueue.title'), icon: widgetPicto('taskQueue'), description: t('widgetCatalog.taskQueue.description'), zone: AGENTS_RIGHT_ZONE, height: 400, minHeight: 180, frame: 'none' }, Component: QueueRail });
    registerWidget(ctx, { key: 'injections', widget: { title: t('widgetCatalog.injections.title'), icon: widgetPicto('injections'), description: t('widgetCatalog.injections.description'), zone: 'droite', height: 420, minHeight: 200, frame: 'none' }, Component: AgentInjectionsCard });
    registerNavItem(ctx, { href: '/agents', labelKey: 'nav.agents', icon: Waypoints, order: 30, activeRoutes: ['/chat'] });
    // Deleted agents, under the trash settings (TODO #476). Same curtain as the
    // Agents page: a viewer who may not open it has no trash to see either.
    if (isNavSurfaceAllowed(ctx.caps, '/agents')) ctx.register({ slot: 'settings.agenttrash' }, AgentTrashPanel);
    // A skill opens in the island workspace, under the same curtain as its tab:
    // the permission, not the nav zone a layout may hide (`/skills` stays reachable).
    if (isNavSurfaceAllowed(ctx.caps, '/skills')) {
      ctx.register({
        slot: 'island.content',
        key: SKILL_ISLAND_KEY,
        island: {
          title: t('islands.skill.title'),
          icon: ISLAND_ICON_SKILL,
          parseParams: parseSkillIslandParams,
          params: {
            id: { type: 'string', required: true, maxLength: 128, description: 'Id of the skill, as listed by `skill_list` (letters, digits, `.`, `_`, `:`, `-`). The daemon resolves it to its file.' },
            mode: { type: 'string', enum: ['preview', 'edit'], description: 'Opens the skill previewed (default) or in the editor; a read-only skill stays previewed.' },
            source: { type: 'string', enum: ['rooks', 'claude-user', 'project', 'plugin'], description: 'Opens the entry of this source, even when another source of the same id masks it (`shadowed` in `skill_list`). Absent: the entry that wins.' },
            format: { type: 'string', enum: ['rooks', 'claude-skill', 'claude-cmd'], description: 'With `source`: a skill folder or a command of that source, when it has both under the id.' },
          },
          // A masked entry is another document than the winner of its id.
          singletonBy: ['id', 'source', 'format'],
          minWidth: 360,
          // Unsaved changes ask before the tab closes (TIM-0128).
          beforeClose: confirmDocumentClose,
          onClose: forgetDocumentDraft,
        },
      }, SkillIsland);
    }
    // Skills and MCP servers are agent configuration (/api/skills and /api/mcp
    // are routes of this module): one entry, a tab each. A tab follows its own
    // zone and permission, so hiding one leaves the other.
    const tabs = (['skills', 'mcp'] as const).filter((id: CapabilityTabId) => (
      ctx.zoneVisible(`nav.${id}`) && isNavSurfaceAllowed(ctx.caps, `/${id}`)
    ));
    if (tabs.length === 0) return;
    registerNavItem(ctx, { href: '/capabilities', labelKey: 'nav.capabilities', icon: Plug, order: 240, activeRoutes: CAPABILITY_ROUTES });
    registerPage(ctx, { route: '/capabilities', Component: function Capabilities() { return <CapabilitiesPage tabs={tabs} />; } });
  },
};
