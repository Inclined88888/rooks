'use client';

import { useCallback, useRef, useSyncExternalStore } from 'react';
import dynamic from 'next/dynamic';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { confirmAction } from '@/components/confirm-dialog/confirm-dialog-context';
import { t } from '@/lib/i18n';
import type { AgentEditorTab } from './agent-editor';

/**
 * The form (six tabs, role manager, prompt editor) is fetched on first open:
 * this host sits on the root layout, which every page loads, and the store
 * below is imported from a dozen surfaces that only need `openAgentEditor`.
 */
const AgentEditor = dynamic(() => import('./agent-editor').then((m) => m.AgentEditor), {
  ssr: false,
  loading: () => (
    <div className="grid flex-1 place-items-center">
      <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden />
    </div>
  ),
});

/**
 * The agent editor opens ON TOP of wherever you are — cockpit, chat,
 * multichat. It is not a route: its entry points live in five different
 * layouts, and Next route interception only covers the ones that share the
 * layout holding the slot. A tiny store + one host mounted on the root
 * layout works from every page.
 *
 * `/edit` still renders the same editor full-page, so a bookmarked or
 * copy-pasted URL keeps working.
 */
type EditorTarget = {
  agent?: string | null;
  isNew?: boolean;
  /** The tab it opens on: "Change avatar" asks for `avatar`. Identity otherwise. */
  tab?: AgentEditorTab;
};
type EditorRequest = EditorTarget & { nonce: number };

let request: EditorRequest | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Opens the editor over the current page. `{ isNew: true }` = blank agent, `{ tab: 'avatar' }` = on its Avatar tab. */
export function openAgentEditor(target: EditorTarget = {}) {
  request = { agent: target.agent ?? null, isNew: target.isNew === true, tab: target.tab, nonce: Date.now() };
  emit();
}

export function closeAgentEditor() {
  request = null;
  emit();
}

export function AgentEditorModal() {
  const req = useSyncExternalStore(
    subscribe,
    () => request,
    () => null,
  );
  // A ref, not state: the host must read the CURRENT dirtiness inside the
  // close handler without re-rendering the form on every keystroke.
  const dirty = useRef(false);

  const close = useCallback(async () => {
    if (dirty.current && !(await confirmAction({ title: t('confirmDialog.discardChanges'), confirmLabel: t('confirmDialog.discard'), destructive: true }))) return;
    dirty.current = false;
    closeAgentEditor();
  }, []);

  const onDirtyChange = useCallback((value: boolean) => {
    dirty.current = value;
  }, []);

  if (!req) return null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        hideClose
        // Near-fullscreen: this form has six tabs and a prompt editor, it
        // does not fit a centred card.
        className="flex h-[92vh] w-[96vw] max-w-[1280px] flex-col gap-0 overflow-hidden p-0"
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogTitle className="sr-only">
          {req.isNew ? 'New agent' : req.agent || 'Agent'}
        </DialogTitle>
        <AgentEditor
          // Remounts on every open: the form must not reopen on the agent
          // (and the tab) left behind by the previous one.
          key={req.nonce}
          agent={req.agent}
          isNew={req.isNew}
          initialTab={req.tab}
          onClose={close}
          onDirtyChange={onDirtyChange}
        />
      </DialogContent>
    </Dialog>
  );
}
