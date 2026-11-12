'use client';

/**
 * "Project TO DO" — the notebook of ONE project.
 *
 * The project comes from the context when there is one: in an agent chat's
 * rail, it is the conversation's project (`useChatRail().slug`, derived from
 * the agent's project, else from the prefix of a `<project>.<role>` name).
 * Outside a chat, no page shows ONE project — the tile then asks the question
 * itself, with a picker whose choice is remembered per browser.
 *
 * What it never does: fall back to the whole notebook. A "Project TO DO" that
 * shows the ideas of other projects lies about its header; better a tile that
 * says it is waiting for a project.
 */

import { useEffect, useMemo, useState } from 'react';
import { useChatRail } from '@/components/chat/chat-rails';
import { t } from '@/lib/i18n';
import { sharedGet } from '@/lib/shared-read';
import type { WidgetProps } from '@/components/widget-host/widget-props';
import type { ClientRealtime } from '@/lib/plugin-host/realtime';
import { ProjectTodoTile } from './project-todo-tile';
import { machineScopedStorage } from '@/lib/machines/machine-storage';

/** The project picked by hand, per browser and per machine: the widget can be placed in
 *  several views, and the same notebook is expected in each. */
const CLE_CHOIX = 'rooks.project-todo.project';

type Projet = { slug: string; name?: string | null };

function lireChoix(): string | null {
  if (typeof window === 'undefined') return null;
  return machineScopedStorage(window.localStorage).getItem(CLE_CHOIX) || null;
}

export function ProjectTodoWidget(props: WidgetProps & { realtime: ClientRealtime }) {
  const chat = useChatRail();
  const [choix, setChoix] = useState<string | null>(null);
  const [projets, setProjets] = useState<Projet[]>([]);

  // Read after mounting: `localStorage` does not exist during the server render, and
  // reading it during the first client render would make hydration diverge.
  useEffect(() => { setChoix(lireChoix()); }, []);

  // The context wins over the manual choice — in a chat, the conversation's
  // project is the only right answer.
  const contexte = chat?.slug ?? null;
  const slug = contexte ?? choix;

  useEffect(() => {
    if (contexte) return;
    let vivant = true;
    void (async () => {
      try {
        const r = await sharedGet('/api/ui/projects');
        const j = (await r.json()) as { projects?: Projet[] };
        if (vivant) setProjets(j.projects ?? []);
      } catch {
        // The picker stays empty: the tile says it is waiting for a project.
      }
    })();
    return () => { vivant = false; };
  }, [contexte]);

  const selecteur = useMemo(() => {
    if (contexte) return null;
    return (
      <select
        value={choix ?? ''}
        aria-label={t('projectTodo.selectProject')}
        onChange={(e) => {
          const v = e.target.value || null;
          setChoix(v);
          if (v) machineScopedStorage(window.localStorage).setItem(CLE_CHOIX, v);
          else machineScopedStorage(window.localStorage).removeItem(CLE_CHOIX);
        }}
        className="max-w-[10rem] rounded border border-border bg-background/40 px-1 py-0.5 text-[10px] uppercase tracking-[0.1em] text-muted-foreground/80 outline-none transition-colors focus:border-primary/60"
      >
        <option value="">{t('projectTodo.noProjectOption')}</option>
        {projets.map((p) => (
          <option key={p.slug} value={p.slug}>{p.name || p.slug}</option>
        ))}
      </select>
    );
  }, [contexte, choix, projets]);

  return (
    <ProjectTodoTile
      {...props}
      scope={{ kind: 'project', slug }}
      titre={t('projectTodo.titleProject')}
      entete={selecteur}
    />
  );
}
