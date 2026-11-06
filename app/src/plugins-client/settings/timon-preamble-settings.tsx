'use client';

import { useEffect, useState } from 'react';

import { formatTokens, type AgentInjections } from '@/lib/agent-injections';
import { t } from '@/lib/i18n';
import { agentPrincipal, type AgentInstalle } from '../agent-chat/instances';
import { Body } from '../agent-injections/injection-detail';
import { readError } from '../agent-injections/use-agent-injections';

type Loaded = { content: string; tokens: number };

async function readPreamble(): Promise<Loaded | null> {
  const listRes = await fetch('/api/ui/agents', { cache: 'no-store' });
  if (!listRes.ok) throw new Error(await readError(listRes));
  const list = await listRes.json() as { agents?: AgentInstalle[] };
  const agent = agentPrincipal(Array.isArray(list.agents) ? list.agents : []);
  if (!agent) return null;
  const res = await fetch(`/api/ui/agents/${encodeURIComponent(agent)}/injections`, { cache: 'no-store' });
  if (!res.ok) throw new Error(await readError(res));
  const block = (await res.json() as AgentInjections).blocks.find((b) => b.id === 'preamble');
  return block ? { content: block.content, tokens: block.tokens } : null;
}

/** The Timon preamble as the daemon builds it at spawn: read-only. */
export function TimonPreambleSettings() {
  const [loaded, setLoaded] = useState<Loaded | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    readPreamble().then(
      (value) => { if (alive) setLoaded(value); },
      (err: Error) => { if (alive) setError(err.message); },
    );
    return () => { alive = false; };
  }, []);

  return (
    <section className="flex flex-col gap-3 py-4" aria-label={t('timonPreamble.title')}>
      <h3 className="text-[13px] font-medium">{t('timonPreamble.title')}</h3>
      <p className="max-w-2xl text-xs text-muted-foreground">{t('timonPreamble.description')}</p>
      {error && <p role="alert" className="text-xs text-destructive">{t('timonPreamble.error', { message: error })}</p>}
      {loaded === undefined && !error && <p className="text-xs text-muted-foreground">{t('timonPreamble.loading')}</p>}
      {loaded === null && <p className="text-xs text-muted-foreground">{t('timonPreamble.empty')}</p>}
      {loaded && (
        <div className="flex max-w-3xl flex-col gap-2">
          <p className="text-[11px] tabular-nums text-muted-foreground">{t('agentInjections.tokens', { n: formatTokens(loaded.tokens) })}</p>
          <Body content={loaded.content} note={null} editableText={null} target={null} onSaved={() => undefined} fill />
        </div>
      )}
    </section>
  );
}
