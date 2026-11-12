'use client';

import { useState } from 'react';

import { tokensByOrigin, type InjectionBlock, type SkillReads } from '@/lib/agent-injections';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { BlockBadges, BlockDetail, OnDemandNote, OriginBar, tokensLabel } from './injection-detail';
import { useAgentInjections } from './use-agent-injections';

function Step({ block, selected, reads, onPick }: { block: InjectionBlock; selected: boolean; reads: SkillReads | null; onPick: () => void }) {
  const measured = block.injected_by === 'rooks';
  return (
    <li className="relative pl-9">
      {/* No spine between the steps (AGENTS.md rule 16): the numbered dot orders
          them, and a candidate of the CLI is told apart by its dashed dot. */}
      <span aria-hidden className={cn(
        'absolute left-0 top-2 grid size-5 place-items-center rounded-full text-[10px] tabular-nums',
        measured ? 'bg-primary/15 text-primary' : 'border border-dashed border-border text-muted-foreground',
        selected && measured && 'ring-2 ring-primary/60',
      )}>
        {measured ? block.order : '·'}
      </span>
      <button type="button" aria-current={selected} onClick={onPick}
        className={cn(
          'mb-2 flex w-full flex-col gap-1 rounded-lg border px-2.5 py-2 text-left hover:border-primary/50',
          selected ? 'border-primary/60 bg-primary/5' : 'border-border bg-card/40',
        )}>
        <span className="break-words text-xs font-medium">{block.label}</span>
        <span className="flex flex-wrap items-center gap-1.5">
          <BlockBadges block={block} reads={reads} />
          <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground/80">{tokensLabel(block.tokens)}</span>
        </span>
      </button>
    </li>
  );
}

/**
 * The "Injections" tab of the agent editor: a timeline of everything Rooks
 * injects at spawn, in the order it is sent, and the text of the step picked —
 * rendered, or edited where its source is editable. It reads what is SAVED:
 * a form field not yet saved is not in it.
 */
export function AgentInjectionsTab({ agent }: { agent: string }) {
  const { load, data, reload, reads } = useAgentInjections(agent);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const picked = data?.blocks.find((b) => b.id === pickedId) ?? data?.blocks[0] ?? null;

  if (load.state === 'error') return <p role="alert" className="text-sm text-destructive">{t('agentInjections.error', { message: load.message })}</p>;
  if (!data) return <p className="text-sm text-muted-foreground">{t('agentInjections.loading')}</p>;
  return (
    <div className="grid gap-6 md:grid-cols-[17rem_minmax(0,1fr)]">
      <aside className="flex flex-col gap-3">
        <ol aria-label={t('agentInjections.timelineLabel')}>
          {data.blocks.map((b, i) => (
            <Step key={b.id} block={b} selected={picked?.id === b.id} reads={reads} onPick={() => setPickedId(b.id)} />
          ))}
        </ol>
        <div className="mt-1 flex flex-col gap-1.5 rounded-lg bg-muted/30 px-2.5 py-2">
          <p className="flex items-center justify-between text-xs font-medium">
            <span>{t('agentInjections.total')}</span>
            <span className="tabular-nums">{tokensLabel(data.prompt_tokens)}</span>
          </p>
          <OnDemandNote tokens={data.on_demand_tokens} />
          <OriginBar origins={tokensByOrigin(data.blocks)} />
        </div>
      </aside>
      <section className="min-w-0">
        {picked
          ? <BlockDetail key={picked.id} agent={data.agent} block={picked} onSaved={reload} reads={reads} />
          : <p className="text-sm text-muted-foreground">{t('agentInjections.pickStep')}</p>}
      </section>
    </div>
  );
}
