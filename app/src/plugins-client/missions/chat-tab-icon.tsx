'use client';

/**
 * The tab picto of an agent's chat island: the agent's avatar, resolved the way
 * Multichat resolves it (its icon, else its project's, else its glyph).
 */
import type { ReactElement } from 'react';
import type { IslandParams } from '@/lib/island-tree';
import { cn } from '@/lib/utils';
import { FaceAgent, faceFrame } from '../agent-chat/agent-avatar';
import { trouverAgent, useAgents, useProjets, visageAgent } from '../agent-chat/use-agents';

export function ChatTabIcon({ params, className }: { params: IslandParams; className?: string }): ReactElement {
  const agent = typeof params.agent === 'string' ? params.agent : '';
  const agents = useAgents();
  const projets = useProjets();
  const visage = visageAgent(agent, agents, projets);
  const name = trouverAgent(agents, agent)?.name ?? agent;
  return (
    <span
      aria-hidden
      title={name}
      // The caller's `size-4 text-muted-foreground` frames it; the glyph keeps its own colour.
      className={cn(className, 'inline-flex items-center justify-center', faceFrame(visage, 'overflow-hidden rounded-full bg-muted'))}
    >
      {/* The island's header: its mascot shows what the agent is doing. */}
      <FaceAgent visage={visage} agent={name || undefined} className="text-[9px]" />
    </span>
  );
}
