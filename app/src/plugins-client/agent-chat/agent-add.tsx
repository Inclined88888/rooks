'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Plus } from 'lucide-react';

import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { AgentPicker } from './agent-picker';
import type { AgentChoisissable, ProjetConnu } from './use-agents';
import { NativeViewCover } from '@/lib/native-view-cover';

const LARGEUR = 264;
const MARGE = 8;
/** Room the popover needs under the "+" before it opens above it instead. */
const HAUTEUR_UTILE = 300;

/**
 * The "+" at the end of the avatar row: one click, a search, the agent is on
 * the card — no detour through the config.
 *
 * The popover is portalled to `body` in fixed position: the card clips its
 * content (`overflow-hidden`), and a cockpit rail card is often shorter than
 * the list. It closes on a pick, on Escape, on a click outside, and when the
 * page scrolls or resizes under it (a fixed box would float off its button).
 */
export function AjoutAgent({
  agents,
  projets,
  exclus,
  onAdd,
}: {
  agents: readonly AgentChoisissable[];
  projets: readonly ProjetConnu[];
  exclus: ReadonlySet<string>;
  onAdd: (agent: string) => void;
}) {
  const bouton = useRef<HTMLButtonElement>(null);
  const panneau = useRef<HTMLDivElement>(null);
  const [ouvert, setOuvert] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});

  useEffect(() => {
    if (!ouvert) return;
    const dehors = (e: MouseEvent) => {
      const cible = e.target as Node;
      if (panneau.current?.contains(cible) || bouton.current?.contains(cible)) return;
      setOuvert(false);
    };
    // Scrolling inside the list is the list's business, not a reason to close.
    const defilement = (e: Event) => {
      if (panneau.current?.contains(e.target as Node)) return;
      setOuvert(false);
    };
    const fermer = () => setOuvert(false);
    document.addEventListener('mousedown', dehors);
    window.addEventListener('scroll', defilement, true);
    window.addEventListener('resize', fermer);
    return () => {
      document.removeEventListener('mousedown', dehors);
      window.removeEventListener('scroll', defilement, true);
      window.removeEventListener('resize', fermer);
    };
  }, [ouvert]);

  // Measured at the click: the popover closes on any scroll or resize, so the
  // button cannot move while it is open.
  const basculer = () => {
    if (ouvert || !bouton.current) { setOuvert(false); return; }
    const r = bouton.current.getBoundingClientRect();
    const left = Math.min(
      Math.max(r.left + r.width / 2 - LARGEUR / 2, MARGE),
      window.innerWidth - LARGEUR - MARGE,
    );
    const dessous = window.innerHeight - r.bottom;
    setPosition(
      dessous < HAUTEUR_UTILE && r.top > dessous
        ? { left, bottom: window.innerHeight - r.top + 6 }
        : { left, top: r.bottom + 6 },
    );
    setOuvert(true);
  };

  const refermer = () => {
    setOuvert(false);
    bouton.current?.focus();
  };

  return (
    <>
      <button
        ref={bouton}
        type="button"
        title={t('agentChat.addAgent')}
        aria-label={t('agentChat.addAgent')}
        aria-haspopup="dialog"
        aria-expanded={ouvert}
        onClick={basculer}
        className={cn(
          'grid size-7 shrink-0 place-items-center rounded-full border border-dashed outline-none transition-colors',
          'focus-visible:ring-2 focus-visible:ring-primary',
          ouvert
            ? 'border-primary/70 text-primary'
            : 'border-border text-muted-foreground/60 hover:border-primary/50 hover:text-primary',
        )}
      >
        <Plus className="size-3.5" />
      </button>
      {ouvert && createPortal(
        <div
          ref={panneau}
          role="dialog"
          aria-label={t('agentChat.addAgent')}
          style={{ ...position, width: LARGEUR }}
          className={cn(
            'fixed z-50 rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-xl',
            'animate-in fade-in-0 zoom-in-95 duration-150 motion-reduce:animate-none',
          )}
        >
          <NativeViewCover />
          <AgentPicker
            agents={agents}
            projets={projets}
            exclus={exclus}
            ouvert
            autoFocus
            onPick={(agent) => {
              onAdd(agent);
              refermer();
            }}
            onEscape={refermer}
          />
        </div>,
        document.body,
      )}
    </>
  );
}
