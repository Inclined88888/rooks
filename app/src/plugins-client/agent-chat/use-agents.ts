'use client';

import { useEffect, useState } from 'react';

import { logoFallbackFor, logoUrlFor } from '@/app/multichat/types';
import { isIconUrl } from '@/lib/project-visual';
import { avatarModeOf, lookOfAgent } from '@/components/agent-avatar';
import type { AgentLook } from '@/components/mascot/agent-look';

/** What the card needs of an agent: how to name it, how to picture it, and
 *  what to search it by. */
export type AgentChoisissable = {
  name: string;
  icon_url?: string | null;
  emoji?: string | null;
  color?: string | null;
  role?: string | null;
  project?: string | null;
  team?: string | null;
  ephemeral?: boolean;
  /** Mascot look and picked head (`config.look`, `config.avatar`), as the daemon lists them. */
  look?: unknown;
  avatar?: unknown;
};

/** What the card needs of a project: an agent without an icon of its own
 *  wears its project's, as it does in Multichat. */
export type ProjetConnu = {
  slug: string;
  name?: string;
  icon?: string | null;
  color?: string;
};

/** One-shot fetch of a list the card only borrows from. A failure is an empty
 *  list: the card falls back to initials, it never waits on the daemon. */
function useListe<T>(url: string, cle: string): T[] {
  const [liste, setListe] = useState<T[]>([]);

  useEffect(() => {
    let vivant = true;
    void (async () => {
      try {
        const r = await fetch(url, { cache: 'no-store' });
        if (!r.ok) return;
        const j = (await r.json()) as Record<string, unknown>;
        const valeur = j[cle];
        if (vivant && Array.isArray(valeur)) setListe(valeur as T[]);
      } catch {
        // Daemon unreachable: initials instead of icons, free typing instead
        // of a list.
      }
    })();
    return () => { vivant = false; };
  }, [url, cle]);

  return liste;
}

/**
 * The installed agents, fetched once per mount.
 *
 * The list is only there to *choose* from and to borrow an avatar: a card whose
 * agent has since been deleted keeps showing its thread — the chat says what it
 * has to say about a missing agent far better than a widget that would blank
 * itself on a slow fetch.
 */
export function useAgents(): AgentChoisissable[] {
  return useListe<AgentChoisissable>('/api/ui/agents', 'agents');
}

/** The projects, for the icon an agent borrows from its own. */
export function useProjets(): ProjetConnu[] {
  return useListe<ProjetConnu>('/api/ui/projects', 'projects');
}

/** Agent record matching a configured name. Agent names are compared without
 *  case: `Alice.main` and `alice.main` are the same agent on disk. */
export function trouverAgent(
  agents: readonly AgentChoisissable[],
  nom: string,
): AgentChoisissable | undefined {
  const cible = nom.toLowerCase();
  return agents.find((a) => a.name.toLowerCase() === cible);
}

export function trouverProjet(
  projets: readonly ProjetConnu[],
  slug: string | null | undefined,
): ProjetConnu | undefined {
  if (!slug) return undefined;
  const cible = slug.toLowerCase();
  return projets.find((p) => p.slug.toLowerCase() === cible);
}

/** How an agent is pictured: an image, its mascot, or a glyph in a colour. */
export type Visage = { image: string | null; glyphe: string; couleur: string; look?: AgentLook | null };

/**
 * The avatar of an agent, resolved the way Multichat resolves it
 * (`logoUrlFor` / `logoFallbackFor`): its own icon, else its project's, else
 * its emoji or initial. `explicite` is the image the daemon wrote on the card
 * itself at onboarding, which wins.
 */
export function visageAgent(
  nom: string,
  agents: readonly AgentChoisissable[],
  projets: readonly ProjetConnu[],
  explicite?: string,
): Visage {
  const agent = trouverAgent(agents, nom);
  const projet = trouverProjet(projets, agent?.project);
  const propre = explicite && isIconUrl(explicite) ? explicite : null;
  const couleur = agent?.color || projet?.color || 'hsl(var(--primary))';
  // The head the agent picked (docs/AGENT-AVATAR.md), unless the card carries
  // its own photo. Without a pick, or without the pick's setting, this view's
  // order stays as it was: no agent changes face here by itself.
  if (agent && !explicite) {
    const mode = avatarModeOf(agent.avatar);
    const look = lookOfAgent(agent);
    const glyphe = logoFallbackFor(agent, undefined);
    if (mode === 'mascot' && look) return { image: null, glyphe, couleur, look };
    if (mode === 'emoji' && agent.emoji?.trim()) return { image: null, glyphe: agent.emoji.trim(), couleur };
    if (mode === 'image' && agent.icon_url && isIconUrl(agent.icon_url)) return { image: agent.icon_url, glyphe, couleur };
  }
  return {
    image: propre || logoUrlFor(agent, projet),
    // A customised photo can be an emoji: it stands in for the glyph.
    glyphe: explicite && !propre ? explicite : logoFallbackFor(agent ?? { name: nom }, projet),
    couleur,
  };
}
