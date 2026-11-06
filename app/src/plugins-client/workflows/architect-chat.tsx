'use client';

/** The workflow's own orchestrator, with the ordinary chat and proposal review. */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Sparkles, SquarePen, X } from 'lucide-react';
import { toast } from 'sonner';
import dynamic from 'next/dynamic';
import { Button } from '@/components/ui/button';
import { t } from '@/lib/i18n';
import { sseOn } from '@/lib/sse-stream';
import { cn } from '@/lib/utils';
import { resolveArchitectAgent } from './architect-agent';
import { diffWorkflow, type Workflow, type WorkflowDefinition } from './types';

// Loaded on demand: statically imported, it weighed on every page of the app.
const ChatClient = dynamic(() => import('@/app/chat/chat-client').then((m) => m.ChatClient), { ssr: false });

type Proposal = { id: string; definition: WorkflowDefinition; rationale: string; created_at: number; mission_id?: string };

function DiffChips({ label, ids, tone }: { label: string; ids: string[]; tone: string }) {
  if (ids.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      {ids.map((id) => <span key={id} className={cn('rounded-md border px-1.5 py-px text-[10px]', tone)}>{id}</span>)}
    </div>
  );
}

/** What the agent must know to act on THIS screen. Sent once per thread — the
 *  draft it describes is the one on the canvas at the moment the user speaks;
 *  afterwards the agent rereads it with `workflow_get`. */
function contextFor(workflow: Workflow, definition: WorkflowDefinition): string {
  return [
    'You are the pilot agent of this workflow, answering in its canvas chat; its runs wake you and their sub-agents report to you.',
    `Workflow: "${workflow.name}" — slug \`${workflow.slug}\`, id \`${workflow.id}\`.`,
    '',
    'Read the `timon-workflow-author` skill before touching the graph — `timon skill get timon-workflow-author` prints it. It lists the node types, their ports, how edges are wired, where to place a card, and the exact contract to follow.',
    'Reread the live draft at any time with the `workflow_get` tool; the node catalogue is `workflow_node_types`.',
    'Submit changes with `workflow_propose(workflow_id, definition, rationale)` — one complete definition. Never PUT, publish or run the workflow yourself: the user reviews your diff on screen and accepts it.',
    '',
    'Draft as it stands now:',
    '```json',
    JSON.stringify(definition),
    '```',
  ].join('\n');
}

export function ArchitectChat({ workflow, current, onAccept }: { workflow: Workflow; current: WorkflowDefinition; onAccept: (definition: WorkflowDefinition) => void }) {
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [identity, setIdentity] = useState<{ workflowId: string; agent: string } | null>(null);
  const [identityError, setIdentityError] = useState(false);
  const [retry, setRetry] = useState(0);
  const newestRun = useRef(0);
  const [runMission, setRunMission] = useState<string | undefined>();
  const agent = identity?.workflowId === workflow.id ? identity.agent : null;
  // Bumped by "new conversation": it keys `ChatClient`, so a click opens a
  // blank thread even several times in a row.
  const [thread, setThread] = useState(0);

  useEffect(() => {
    const abort = new AbortController();
    setIdentityError(false);
    setRunMission(undefined);
    newestRun.current = 0;
    setThread(0);
    void (async () => {
      try {
        const resolved = await resolveArchitectAgent(workflow, abort.signal);
        if (!abort.signal.aborted) setIdentity({ workflowId: workflow.id, agent: resolved });
      } catch { if (!abort.signal.aborted) setIdentityError(true); }
    })();
    return () => abort.abort();
  }, [workflow, retry]);

  useEffect(() => {
    let active = true;
    return (() => {
      const off = sseOn('workflow_run', (event) => {
        void (async () => {
          try {
            const { runId, nodeId, status } = JSON.parse(event.data) as { runId?: string; nodeId?: string; status?: string };
            if (!runId || nodeId || status !== 'running') return;
            const response = await fetch(`/api/ui/workflows/runs/${encodeURIComponent(runId)}`, { cache: 'no-store' });
            if (!response.ok) return;
            const body = await response.json() as { run?: { workflow_id: string; context: string; started_at: number } };
            if (!active || body.run?.workflow_id !== workflow.id) return;
            const context = JSON.parse(body.run.context) as { coordinatorMissionId?: string };
            if (context.coordinatorMissionId && body.run.started_at >= newestRun.current) {
              newestRun.current = body.run.started_at;
              setRunMission(context.coordinatorMissionId);
            }
          } catch { /* A later run event can retry the read. */ }
        })();
      });
      return () => { active = false; off(); };
    })();
  }, [workflow.id]);

  const load = useCallback(async () => {
    const response = await fetch(`/api/ui/workflows/${workflow.id}/proposals`, { cache: 'no-store' });
    if (!response.ok) return;
    const value = await response.json() as { proposals?: Proposal[] };
    const next = [...(value.proposals ?? [])].sort((a, b) => b.created_at - a.created_at)[0] ?? null;
    setProposal((previous) => (previous?.id === next?.id ? previous : next));
  }, [workflow.id]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => sseOn('workflow_proposal', (event) => {
    if (typeof document !== 'undefined' && document.hidden) return;
    try {
      const payload = JSON.parse(event.data) as { workflowId?: string };
      if (payload.workflowId === workflow.id) void load();
    } catch { /* ignore a malformed frame */ }
  }), [load, workflow.id]);

  const decide = useCallback(async (action: 'accept' | 'reject') => {
    if (!proposal) return;
    const response = await fetch(`/api/ui/workflows/${workflow.id}/proposals/${proposal.id}/${action}`, { method: 'POST' });
    if (!response.ok) { toast.error(t('workflows.architectError')); return; }
    if (action === 'accept') onAccept(proposal.definition);
    setProposal(null);
  }, [onAccept, proposal, workflow.id]);

  const diff = useMemo(() => (proposal ? diffWorkflow(current, proposal.definition) : null), [current, proposal]);
  // The context describes the draft at the moment the thread opens, so it must
  // not be rebuilt on every canvas edit — that would change `ChatClient`'s prop
  // on each keystroke for a block only the first turn ever carries.
  const context = useMemo(() => contextFor(workflow, current), [workflow, thread]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-3 py-2">
        <Sparkles className="size-3.5 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate text-[12px] font-semibold" title={agent ?? undefined}>{workflow.name}</span>
        <button
          type="button"
          onClick={() => { newestRun.current = Date.now(); setRunMission(undefined); setThread((n) => n + 1); }}
          title={t('agentChat.newConversation')}
          aria-label={t('agentChat.newConversation')}
          className="grid size-7 shrink-0 place-items-center rounded-lg border border-border bg-card/70 text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
        >
          <SquarePen className="size-3.5" />
        </button>
      </div>

      {proposal && diff && (
        <div className="shrink-0 p-3">
          <div className="rounded-xl border border-primary/30 bg-primary/5 p-3">
            <div className="flex items-center gap-1.5 text-[12px] font-semibold"><Sparkles className="size-3.5 text-primary" />{t('workflows.proposal')}</div>
            {proposal.rationale && <p className="mt-1.5 text-[11.5px] leading-snug text-muted-foreground">{proposal.rationale}</p>}
            <div className="mt-2.5 space-y-1.5">
              <DiffChips label={t('workflows.nodesAdded')} ids={diff.added} tone="border-[hsl(var(--success)/0.4)] bg-[hsl(var(--success)/0.12)] text-[hsl(var(--success))]" />
              <DiffChips label={t('workflows.nodesModified')} ids={diff.modified} tone="border-[hsl(var(--warning)/0.4)] bg-[hsl(var(--warning)/0.12)] text-[hsl(var(--warning))]" />
              <DiffChips label={t('workflows.nodesRemoved')} ids={diff.removed} tone="border-destructive/40 bg-destructive/10 text-destructive" />
              {diff.added.length + diff.modified.length + diff.removed.length === 0 && <p className="text-[10.5px] text-muted-foreground">{t('workflows.noDiff')}</p>}
            </div>
            <div className="mt-3 flex gap-2">
              <Button size="sm" className="flex-1" onClick={() => void decide('accept')}><Check className="mr-1 size-3.5" />{t('workflows.accept')}</Button>
              <Button size="sm" variant="outline" className="flex-1" onClick={() => void decide('reject')}><X className="mr-1 size-3.5" />{t('workflows.reject')}</Button>
            </div>
          </div>
        </div>
      )}

      {/* `key` remounts the thread on agent or conversation change: without it
          the mission, the messages and the stream would leak from one agent to
          the next. */}
      <div className="min-h-0 flex-1">
        {agent ? <Suspense fallback={null}>
          <ChatClient
            key={`${agent}:${workflow.id}:${runMission ?? thread}`}
            forcedAgent={agent}
            forcedMission={runMission}
            initialFresh={thread > 0}
            contextPrefix={context}
            compact
            chromeComplet
          />
        </Suspense> : <div className="p-4 text-sm text-muted-foreground">
          {identityError ? <><p>{t(workflow.agent_name ? 'workflows.chatAgentError' : 'workflows.runNeedsAgent')}</p>{workflow.agent_name && <Button variant="outline" size="sm" className="mt-3" onClick={() => setRetry((n) => n + 1)}>{t('workflows.retryChatAgent')}</Button>}</> : t('common.loading')}
        </div>}
      </div>
    </div>
  );
}
