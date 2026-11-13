'use client';

import { ISLAND_ICON_FILE } from '@/lib/island-tab-icons';
import { t } from '@/lib/i18n';
import { isWidgetSurfaceAllowed } from '@/lib/capabilities';
import dynamic from 'next/dynamic';
import { FILE_ISLAND_KEY, parseFileIslandParams } from '@/lib/file-island-content';
import type { IslandParams, TabId } from '@/lib/island-tree';
import type { BundledClientPlugin } from './types';

const FILES_WIDGET = '@rooks/files-widget';

// Lazy like the island itself: the draft store lives with the editor chunk, and
// a tab restored before it ever loaded has no draft to ask about.
const confirmDocumentClose = (params: IslandParams, tabId: TabId) =>
  import('@/components/chat/file-island').then((m) => m.confirmDocumentClose(params, tabId));
const forgetDocumentDraft = (params: IslandParams, tabId: TabId) => {
  void import('@/components/chat/file-island').then((m) => m.forgetDocumentDraft(params, tabId));
};

/** The viewer and editor (previews, CodeMirror, markdown) load with the first
 *  file tab, not with the root layout (docs/BUNDLE-SIZE.md). */
const FileIsland = dynamic(() => import('@/components/chat/file-island').then((m) => m.FileIsland), { ssr: false });

/** Client half of `@rooks/files-widget`: a file as a content of the island
 *  workspace — the only form a file opens in. The Files card itself still registers with the chat columns
 *  (`components/chat/chat-rails.tsx`). */
export const filesWidgetClient: BundledClientPlugin = {
  module: FILES_WIDGET,
  apply(ctx) {
    // The same curtain as the Files card: a viewer not granted it gets neither.
    if (!isWidgetSurfaceAllowed(ctx.caps, FILES_WIDGET, 'Files')) return;
    // Same slot, same contract as a third-party content: no privilege (§5).
    ctx.register({
      slot: 'island.content',
      key: FILE_ISLAND_KEY,
      island: {
        title: t('islands.file.title'),
        icon: ISLAND_ICON_FILE,
        parseParams: parseFileIslandParams,
        params: {
          agentId: { type: 'string', required: true, maxLength: 128, description: 'Name of the agent whose folder holds the file (letters, digits, `.`, `_`, `-`).' },
          path: { type: 'string', required: true, maxLength: 900, description: 'Path of the file: relative to the agent\'s folder and never climbing out of it, or absolute when `external` is true.' },
          mode: { type: 'string', enum: ['preview', 'edit'], description: 'Opens the file previewed (default) or in the editor.' },
          external: { type: 'boolean', description: 'True for a file outside the agent\'s folder; `path` is then absolute.' },
        },
        // One tab per file of an agent, whether it is previewed or edited.
        singletonBy: ['agentId', 'path', 'external'],
        minWidth: 320,
        // Files of one agent open as tabs of the same island, and drag out one by one.
        groupBy: 'agentId',
        // Unsaved changes ask before the tab closes (TIM-0128).
        beforeClose: confirmDocumentClose,
        onClose: forgetDocumentDraft,
      },
    }, FileIsland);
  },
};
