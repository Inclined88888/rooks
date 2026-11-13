'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CircleUserRound, Copy, Crown, OctagonX, Settings2, Trash2, UserPen } from 'lucide-react';

import { openAgentEditor } from '@/components/agent-editor/agent-editor-modal';
import { useCan } from '@/hooks/use-me';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { NativeViewCover } from '@/lib/native-view-cover';

export type AgentMenuTarget = { agent: string; x: number; y: number };

/**
 * The "Change avatar" gesture of the card's menu: the agent's face is its
 * config, so only an account that may edit agents (`agents:manage`) gets it;
 * `undefined` hides the entry. It opens the editor on its Avatar tab.
 */
export function useChangeAvatar(): ((agent: string) => void) | undefined {
  const allowed = useCan('agents:manage') === true;
  return allowed ? (agent: string) => openAgentEditor({ agent, tab: 'avatar' }) : undefined;
}

const ITEM =
  'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] outline-none transition-colors hover:bg-muted focus-visible:bg-muted';

/**
 * The right-click menu of an avatar of the card: gestures on one agent, for
 * this card only (nickname and photo, removal) or for the agent itself (its
 * head everywhere, its config, and the technical stop of everything it is
 * running). "Customize" changes the card only; "Change avatar" opens the
 * editor's Avatar tab and changes the agent's face in every view.
 *
 * Hand-rolled like the graph's `NodeMenu` — the product has no context-menu
 * primitive, and a dependency for three rows is not worth it (rule 12). It is
 * portaled to the body so the card's `overflow-hidden` cannot clip it.
 */
export function AgentContextMenu({
  target,
  onCustomize,
  onChangeAvatar,
  onEdit,
  onDuplicate,
  onRemove,
  onStop,
  onMakeMain,
  onClose,
}: {
  target: AgentMenuTarget;
  onCustomize: () => void;
  /** Absent for whoever may not edit the agent: the entry is then not shown. */
  onChangeAvatar?: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onStop: () => void;
  onMakeMain: () => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: target.x, top: target.y });

  // Keep the menu inside the window, whichever corner was clicked.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(8, Math.min(target.x, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(target.y, window.innerHeight - r.height - 8)),
    });
    el.querySelector<HTMLButtonElement>('button')?.focus();
  }, [target.x, target.y]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    // Capture phase: an element that stops the mousedown's propagation would
    // hide the click from a bubbling listener (TIM-0123).
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) onClose(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  const pick = (action: () => void) => () => { onClose(); action(); };

  return createPortal(
    <div
      ref={box}
      role="menu"
      aria-label={target.agent}
      style={{ left: pos.left, top: pos.top }}
      onContextMenu={(e) => e.preventDefault()}
      className="fixed z-[80] min-w-48 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-elev-3"
    >
      <NativeViewCover />
      <button type="button" role="menuitem" className={ITEM} onClick={pick(onCustomize)}>
        <UserPen className="size-4" aria-hidden />
        {t('agentChat.menu.customize')}
      </button>
      {onChangeAvatar && (
        <button type="button" role="menuitem" data-menu-change-avatar className={ITEM} onClick={pick(onChangeAvatar)}>
          <CircleUserRound className="size-4" aria-hidden />
          {t('agentChat.menu.changeAvatar')}
        </button>
      )}
      <button type="button" role="menuitem" className={ITEM} onClick={pick(onEdit)}>
        <Settings2 className="size-4" aria-hidden />
        {t('agentChat.menu.edit')}
      </button>
      <button type="button" role="menuitem" className={ITEM} onClick={pick(onDuplicate)}>
        <Copy className="size-4" aria-hidden />
        {t('agentChat.menu.duplicate')}
      </button>
      <button type="button" role="menuitem" className={ITEM} onClick={pick(onMakeMain)}>
        <Crown className="size-4" aria-hidden />
        {t('agentChat.menu.makeMain')}
      </button>
      <button type="button" role="menuitem" className={cn(ITEM, 'mt-2 text-destructive hover:text-destructive')} onClick={pick(onStop)}>
        <OctagonX className="size-4" aria-hidden />
        {t('agentChat.menu.stop')}
      </button>
      <button type="button" role="menuitem" className={cn(ITEM, 'text-destructive hover:text-destructive')} onClick={pick(onRemove)}>
        <Trash2 className="size-4" aria-hidden />
        {t('agentChat.menu.remove')}
      </button>
    </div>,
    document.body,
  );
}
