'use client';

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Search } from 'lucide-react';

import { t } from '@/lib/i18n';
import { foldText } from '@/lib/multichat-rail';
import { cn } from '@/lib/utils';
import { FramedFace } from './agent-avatar';
import {
  trouverProjet,
  visageAgent,
  type AgentChoisissable,
  type ProjetConnu,
} from './use-agents';

/**
 * The agents a query finds, sorted by name. Every word of the query must appear
 * in the agent's name, its role, its project (slug and name) or its team —
 * accents and case ignored, as in the Multichat search. Ephemeral agents are
 * one-shot missions, never something to keep a shortcut to.
 */
export function filtrerAgents(
  agents: readonly AgentChoisissable[],
  projets: readonly ProjetConnu[],
  requete: string,
): AgentChoisissable[] {
  const mots = foldText(requete).split(/\s+/).filter(Boolean);
  return agents
    .filter((a) => !a.ephemeral)
    .filter((a) => {
      if (mots.length === 0) return true;
      const projet = trouverProjet(projets, a.project);
      const botte = foldText([a.name, a.role ?? '', a.project ?? '', projet?.name ?? '', a.team ?? ''].join(' '));
      return mots.every((mot) => botte.includes(mot));
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/**
 * A search field over the installed agents, with its list: the one way to add
 * an agent to a card, from its config or from the "+" at the end of its row.
 *
 * Agents already on the card stay listed, greyed and out of reach, so a search
 * for one says "already there" instead of "not found".
 *
 * `ouvert` keeps the list visible (the "+" popover, which exists only to
 * pick); without it the list opens as the field is focused or typed into.
 */
export function AgentPicker({
  agents,
  projets,
  exclus,
  onPick,
  onEscape,
  ouvert: toujoursOuvert = false,
  autoFocus = false,
}: {
  agents: readonly AgentChoisissable[];
  projets: readonly ProjetConnu[];
  /** Lower-cased names of the agents already on the card. */
  exclus: ReadonlySet<string>;
  onPick: (agent: string) => void;
  /** Escape on a closed list (or on the always-open one): the host closes. */
  onEscape?: () => void;
  ouvert?: boolean;
  autoFocus?: boolean;
}) {
  const id = useId();
  const listeId = `${id}-liste`;
  const champ = useRef<HTMLInputElement>(null);
  const liste = useRef<HTMLUListElement>(null);
  const [requete, setRequete] = useState('');
  const [deplie, setDeplie] = useState(false);
  const [actif, setActif] = useState(-1);
  const visible = toujoursOuvert || deplie;

  const candidats = useMemo(() => filtrerAgents(agents, projets, requete), [agents, projets, requete]);
  const choisissable = (i: number) => {
    const a = candidats[i];
    return a !== undefined && !exclus.has(a.name.toLowerCase());
  };

  // A new query, or the list reloaded: the first agent one can add is the one
  // Enter adds.
  useEffect(() => {
    setActif(candidats.findIndex((a) => !exclus.has(a.name.toLowerCase())));
  }, [candidats, exclus]);

  useEffect(() => {
    if (autoFocus) champ.current?.focus();
  }, [autoFocus]);

  useEffect(() => {
    if (!visible || actif < 0) return;
    const option = liste.current?.querySelector<HTMLElement>(`[data-index="${actif}"]`);
    // Absent from jsdom; the list still works without it.
    option?.scrollIntoView?.({ block: 'nearest' });
  }, [actif, visible]);

  const choisir = (i: number) => {
    const a = candidats[i];
    if (!a || !choisissable(i)) return;
    onPick(a.name);
    setRequete('');
  };

  // Next option one can add, `pas` away, wrapping; greyed ones are skipped.
  const suivant = (depart: number, pas: 1 | -1): number => {
    const n = candidats.length;
    for (let k = 1; k <= n; k += 1) {
      const i = (((depart + pas * k) % n) + n) % n;
      if (choisissable(i)) return i;
    }
    return -1;
  };

  const clavier = (e: KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault();
        if (!visible) { setDeplie(true); return; }
        const pas: 1 | -1 = e.key === 'ArrowDown' ? 1 : -1;
        // From nowhere, Down lands on the first option and Up on the last.
        setActif((i) => suivant(i >= 0 ? i : pas === 1 ? -1 : 0, pas));
        return;
      }
      case 'Enter':
        // Never the form's submit: in the config, Enter here means "add",
        // not "save the card with half a search typed in".
        e.preventDefault();
        if (visible) choisir(actif);
        return;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        if (!toujoursOuvert && deplie) setDeplie(false);
        else onEscape?.();
        return;
      case 'Tab':
        setDeplie(false);
        return;
      default:
        return;
    }
  };

  const optionId = (i: number) => `${id}-option-${i}`;

  return (
    <div className="flex flex-col gap-1">
      <div className="relative">
        <Search aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground/70" />
        <input
          ref={champ}
          type="text"
          role="combobox"
          aria-expanded={visible}
          aria-controls={listeId}
          aria-autocomplete="list"
          aria-activedescendant={visible && actif >= 0 ? optionId(actif) : undefined}
          aria-label={t('agentChat.picker.label')}
          placeholder={t('agentChat.picker.placeholder')}
          autoComplete="off"
          spellCheck={false}
          value={requete}
          onChange={(e) => { setRequete(e.target.value); setDeplie(true); }}
          onFocus={() => setDeplie(true)}
          onBlur={() => setDeplie(false)}
          onClick={() => setDeplie(true)}
          onKeyDown={clavier}
          className="w-full rounded-lg border border-border bg-background/60 py-1.5 pl-8 pr-2.5 text-[12px] outline-none focus:border-primary/60"
        />
      </div>
      {visible && (
        <ul
          ref={liste}
          id={listeId}
          role="listbox"
          aria-label={t('agentChat.picker.label')}
          className={cn(
            'scrollbar-thin flex max-h-56 flex-col gap-px overflow-y-auto',
            // In the popover the list already sits in a framed box.
            toujoursOuvert ? 'p-0.5' : 'rounded-lg border border-border bg-popover p-1',
          )}
        >
          {candidats.length === 0 ? (
            <li role="presentation" className="px-2 py-1.5 text-[11.5px] text-muted-foreground/80">
              {t('agentChat.picker.empty')}
            </li>
          ) : (
            candidats.map((a, i) => {
              const exclu = exclus.has(a.name.toLowerCase());
              const projet = trouverProjet(projets, a.project);
              return (
                <li
                  key={a.name}
                  id={optionId(i)}
                  data-index={i}
                  role="option"
                  aria-selected={i === actif}
                  aria-disabled={exclu || undefined}
                  // Keeps the focus in the field: a click must not blur it
                  // (and close the list) before it lands.
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseMove={() => { if (!exclu && i !== actif) setActif(i); }}
                  onClick={() => choisir(i)}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px]',
                    exclu ? 'cursor-default opacity-45' : 'cursor-pointer',
                    i === actif && 'bg-primary/15 text-foreground',
                  )}
                >
                  <FramedFace visage={visageAgent(a.name, agents, projets)} className="size-6" glyphClassName="text-[10px]" />
                  <span className="min-w-0 flex-1 truncate">{a.name}</span>
                  <span className="max-w-[45%] shrink-0 truncate text-[10.5px] text-muted-foreground/75">
                    {exclu ? t('agentChat.picker.onCard') : (projet?.name || a.project || '')}
                  </span>
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}
