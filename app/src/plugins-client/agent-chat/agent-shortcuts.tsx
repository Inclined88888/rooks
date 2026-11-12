'use client';

import { useRef, type KeyboardEvent, type MouseEvent } from 'react';

import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { FaceAgent, faceFrame } from './agent-avatar';
import type { ModeAgent } from './instances';
import { visageAgent, type AgentChoisissable, type ProjetConnu } from './use-agents';

/**
 * The row of agents on top of the card — the card's only picture of who it
 * talks to. The agent of the current thread is larger, ringed and haloed; the
 * others are smaller, and one click switches the thread to them.
 *
 * The row is there even for a lone agent: it replaced the big medallion that
 * used to sit under it, so it is what says who the card is.
 *
 * It wraps and, past a few lines, scrolls: the number of shortcuts is the
 * user's to choose, and a narrow card must not push the thread out of view.
 */
export function AgentShortcuts({
  modes,
  active,
  agents,
  projets = [],
  onSelect,
  onContextMenu,
}: {
  modes: readonly ModeAgent[];
  active: string;
  agents: readonly AgentChoisissable[];
  projets?: readonly ProjetConnu[];
  onSelect: (agent: string) => void;
  /** Right click (or the menu key) on an avatar. */
  onContextMenu?: (agent: string, event: MouseEvent) => void;
}) {
  const groupe = useRef<HTMLDivElement>(null);

  // Arrow keys walk the row, as in a toolbar; Enter or Space on the focused
  // avatar is the button's own click.
  const naviguer = (e: KeyboardEvent<HTMLDivElement>) => {
    const pas = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    const boutons = Array.from(groupe.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    if (boutons.length === 0) return;
    const courant = boutons.indexOf(document.activeElement as HTMLButtonElement);
    let cible: number;
    if (pas !== undefined) cible = (Math.max(courant, 0) + pas + boutons.length) % boutons.length;
    else if (e.key === 'Home') cible = 0;
    else if (e.key === 'End') cible = boutons.length - 1;
    else return;
    e.preventDefault();
    boutons[cible]?.focus();
  };

  return (
    <div
      ref={groupe}
      role="group"
      aria-label={t('agentChat.shortcuts')}
      onKeyDown={naviguer}
      className="flex max-h-[6.5rem] min-w-0 flex-wrap items-center justify-center gap-1.5 overflow-y-auto p-2"
    >
      {modes.map((mode) => (
        <ShortcutAvatar
          key={mode.value}
          mode={mode}
          visage={visageAgent(mode.value, agents, projets, mode.avatar)}
          pressed={mode.value === active}
          onSelect={onSelect}
          onContextMenu={onContextMenu}
        />
      ))}
    </div>
  );
}

function ShortcutAvatar({
  mode,
  visage,
  pressed,
  onSelect,
  onContextMenu,
}: {
  mode: ModeAgent;
  visage: ReturnType<typeof visageAgent>;
  pressed: boolean;
  onSelect: (agent: string) => void;
  onContextMenu?: (agent: string, event: MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      title={mode.label}
      aria-label={t('agentChat.shortcut', { name: mode.label })}
      aria-pressed={pressed}
      aria-current={pressed ? 'true' : undefined}
      // Roving focus: Tab lands on the current agent, the arrows do the rest.
      tabIndex={pressed ? 0 : -1}
      onClick={() => onSelect(mode.value)}
      onContextMenu={onContextMenu ? (e) => { e.preventDefault(); onContextMenu(mode.value, e); } : undefined}
      className={cn(
        'grid shrink-0 place-items-center rounded-full outline-none',
        faceFrame(visage, 'overflow-hidden border bg-card'),
        'transition-[width,height,opacity,box-shadow,border-color] duration-200 ease-out motion-reduce:transition-none',
        'focus-visible:ring-2 focus-visible:ring-primary',
        // A mascot says it is the current one by its size alone: no circle around it.
        pressed
          ? cn('size-10', faceFrame(visage, 'border-primary/70 shadow-[0_0_0_2px_hsl(var(--primary)/0.35),0_0_16px_-2px_hsl(var(--primary)/0.6)]'))
          : cn('size-7 opacity-65 hover:opacity-100 focus-visible:opacity-100', faceFrame(visage, 'border-border hover:border-primary/50')),
      )}
    >
      <FaceAgent visage={visage} agent={mode.value} className={pressed ? 'text-sm' : 'text-[11px]'} />
    </button>
  );
}
