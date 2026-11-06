'use client';

import { useCallback, useEffect, useState } from 'react';

import { parseSkillReads, type AgentInjections, type SkillReads } from '@/lib/agent-injections';

export type Load =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; data: AgentInjections };

export async function readError(res: Response): Promise<string> {
  try {
    const body = await res.json() as { error?: string };
    if (body.error) return body.error;
  } catch { /* not JSON */ }
  return `HTTP ${res.status}`;
}

/**
 * The daemon's injections of `agent`, read again on demand (after a save).
 * `data` is never another agent's list under this agent's name, not even for
 * the render that precedes the effect starting the new read.
 */
export function useAgentInjections(agent: string | null, missionId: string | null = null): { load: Load; data: AgentInjections | null; reload: () => void; reads: SkillReads | null } {
  const [load, setLoad] = useState<Load>({ state: 'idle' });
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    if (!agent) return;
    let alive = true;
    setLoad((prev) => (prev.state === 'ready' && prev.data.agent === agent ? prev : { state: 'loading' }));
    void (async () => {
      try {
        const res = await fetch(`/api/ui/agents/${encodeURIComponent(agent)}/injections${missionId ? `?mission_id=${encodeURIComponent(missionId)}` : ''}`, { cache: 'no-store' });
        if (!alive) return;
        if (!res.ok) { setLoad({ state: 'error', message: await readError(res) }); return; }
        setLoad({ state: 'ready', data: await res.json() as AgentInjections });
      } catch (err) {
        if (alive) setLoad({ state: 'error', message: (err as Error).message });
      }
    })();
    return () => { alive = false; };
  }, [agent, missionId, version]);

  const reads = useSkillReads(agent, version);
  const data = load.state === 'ready' && load.data.agent === agent ? load.data : null;
  return { load, data, reload, reads };
}

/**
 * How often the agent's missions read each skill (30 days). Null while it
 * loads or when it cannot be read: the counter is a hint, its absence hides
 * the badges and nothing else.
 */
function useSkillReads(agent: string | null, version: number): SkillReads | null {
  const [state, setState] = useState<{ agent: string; reads: SkillReads } | null>(null);
  useEffect(() => {
    if (!agent) return;
    let alive = true;
    void (async () => {
      try {
        const res = await fetch(`/api/ui/agents/${encodeURIComponent(agent)}/skill-reads`, { cache: 'no-store' });
        const reads = res.ok ? parseSkillReads(await res.json()) : null;
        if (alive) setState(reads ? { agent, reads } : null);
      } catch {
        if (alive) setState(null);
      }
    })();
    return () => { alive = false; };
  }, [agent, version]);
  return state && state.agent === agent ? state.reads : null;
}
