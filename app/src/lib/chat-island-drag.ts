'use client';

/**
 * An agent or a mission as a source of the island workspace
 * (`docs/ISLAND-WORKSPACE.md` §6, step 8): the top bar's agent chips, the
 * mission rail, the multichat's rail and cells.
 *
 * One drag, two readers: the multichat's grid reads `text/agent-name`, the
 * workspace its own type. The multichat's type is set FIRST, so a drop on a
 * grid cell works as it always did.
 */

import { AGENT_DRAG_TYPE } from '@/app/multichat/slot-drop-zone';
import { openInIsland, type IslandBusSnapshot } from './island-bus';
import { startIslandDrag, type StartIslandDragOptions } from './island-drag';
import type { DropRegion } from './island-tree';
import { chatIslandContent } from './chat-island-params';
import { t } from './i18n';

type DragLike = Pick<DragEvent, 'dataTransfer'>;

/** Edges offered by "Open in a split", relative to the focused island (§11). */
export const SPLIT_EDGES: readonly (DropRegion | 'float')[] = ['right', 'left', 'bottom', 'top', 'center', 'float'];

/** Whether a source may start a drag towards the workspace: one is on screen, and wide enough to split (§10). */
export function canDragToIsland(bus: IslandBusSnapshot): boolean {
  return bus.present && !bus.narrow;
}

/**
 * Call from the source's `onDragStart`, only when `canDragToIsland`. The label
 * defaults to the chat's title; `hold` and `onDropped` are the workspace's own
 * (the multichat holds its grid, and a cell gives its chat away).
 */
export function startChatIslandDrag(event: DragLike, agent: string, missionId: string | null = null, options: StartIslandDragOptions = {}): void {
  event.dataTransfer?.setData(AGENT_DRAG_TYPE, agent);
  startIslandDrag(event, chatIslandContent(agent, missionId), { ...options, label: options.label ?? t('islands.chat.titleOf', { agent }) });
}

export type SplitAction = { key: string; label: string; onSelect: () => void };

/**
 * The "Open in a split" entries of a flat context menu: one per edge, a single
 * "Open in the workspace" below 768 px (it adds a tab there). None while no
 * workspace is on screen. `onOpened` runs once the workspace took the chat
 * (a multichat cell gives it away).
 */
export function chatSplitActions(bus: IslandBusSnapshot, agent: string, missionId: string | null = null, onOpened?: () => void): SplitAction[] {
  if (!bus.present) return [];
  const content = chatIslandContent(agent, missionId);
  return (bus.narrow ? (['center'] as const) : SPLIT_EDGES).map((edge) => ({
    key: `island-${edge}`,
    label: bus.narrow ? t('islands.openIn.narrow') : t(`islands.openIn.split.${edge}`),
    onSelect: () => { if (openInIsland(content, { edge })) onOpened?.(); },
  }));
}
