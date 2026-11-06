'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { apiErrorMessage } from '@/lib/api-error';

type Step = {
  id: string;
  agent: string;
  type?: string;
  prompt: string;
  deps_on?: string[];
};
type Pipeline = {
  id: string;
  name: string;
  description: string | null;
  definition: { steps: Step[] };
  created_at: number;
  updated_at: number;
};

type RunStatus = {
  run: { run_id: string; pipeline_id: string; pipeline_name: string; started_at: number; input: unknown };
  steps: Array<{
    step_id: string;
    task_id: string;
    title: string;
    agent: string;
    type: string;
    status: string;
    mission_id: string | null;
  }>;
};

const STATUS_TONE: Record<string, string> = {
  PENDING: 'bg-muted text-muted-foreground border-border',
  IN_PROGRESS: 'bg-primary/10 text-primary border-primary/30',
  DONE: 'bg-[hsl(var(--success)/0.10)] text-[hsl(var(--success))] border-[hsl(var(--success)/0.25)]',
  BLOCKED: 'bg-destructive/10 text-destructive border-destructive/25',
};

export function PipelinesClient({ initialRun }: { initialRun?: string }) {
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [runDialog, setRunDialog] = useState<{ open: boolean; id: string } | null>(null);
  const [inputJson, setInputJson] = useState('{}');
  const [run, setRun] = useState<RunStatus | null>(null);
  const [currentRunId, setCurrentRunId] = useState<string | null>(initialRun ?? null);

  const fetchPipelines = useCallback(async () => {
    try {
      const r = await fetch('/api/ui/pipelines', { cache: 'no-store' });
      const j = await r.json();
      setPipelines(j.pipelines || []);
      if (!selectedId && j.pipelines?.length) setSelectedId(j.pipelines[0].id);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }, [selectedId]);

  const fetchRun = useCallback(async () => {
    if (!currentRunId) {
      setRun(null);
      return;
    }
    try {
      const r = await fetch(`/api/ui/pipelines/runs/${currentRunId}`, { cache: 'no-store' });
      if (!r.ok) {
        setRun(null);
        return;
      }
      setRun(await r.json());
    } catch { /* ignore */ }
  }, [currentRunId]);

  useEffect(() => {
    fetchPipelines();
  }, [fetchPipelines]);

  useEffect(() => {
    fetchRun();
    if (!currentRunId) return;
    const id = setInterval(fetchRun, 3000);
    return () => clearInterval(id);
  }, [fetchRun, currentRunId]);

  const selected = useMemo(
    () => pipelines.find((p) => p.id === selectedId) ?? null,
    [pipelines, selectedId],
  );

  const launchRun = useCallback(async () => {
    if (!runDialog) return;
    let input: unknown = {};
    try { input = JSON.parse(inputJson || '{}'); }
    catch (err) { toast.error('Invalid JSON: ' + (err as Error).message); return; }
    try {
      const r = await fetch(`/api/ui/pipelines/${runDialog.id}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(apiErrorMessage(j, { status: r.status }));
      toast.success(`Run ${j.run_id.slice(0, 8)} created (${j.steps.length} tasks)`);
      setRunDialog(null);
      setCurrentRunId(j.run_id);
    } catch (err) {
      toast.error((err as Error).message);
    }
  }, [runDialog, inputJson]);

  const openInCanvas = useCallback(async (id: string) => {
    const response = await fetch(`/api/ui/workflows/import/pipeline/${id}`, { method: 'POST' });
    const value = await response.json();
    if (!response.ok) { toast.error(apiErrorMessage(value, 'Could not import pipeline')); return; }
    location.assign(`/workflows/${value.workflow.slug}`);
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      {/* sidebar */}
      <aside className="w-full shrink-0 bg-muted/20 md:w-72">
        <div className="px-4 py-3">
          <h2 className="text-sm font-medium">Pipelines</h2>
          <p className="text-[11px] text-muted-foreground">Templates de workflow multi-agents</p>
        </div>
        <ul className="space-y-0.5 px-1.5 pb-2">
          {pipelines.length === 0 && (
            <li className="px-4 py-3 text-xs text-muted-foreground">No pipelines yet.</li>
          )}
          {pipelines.map((p) => (
            <li key={p.id}>
              <button
                onClick={() => setSelectedId(p.id)}
                className={cn(
                  'flex w-full flex-col items-start gap-1 rounded-md px-2.5 py-2.5 text-left transition-colors',
                  selectedId === p.id ? 'bg-primary/10' : 'hover:bg-muted/40',
                )}
              >
                <span className="text-sm font-medium">{p.name}</span>
                <span className="text-[11px] text-muted-foreground">
                  {p.definition.steps.length} steps
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      {/* detail */}
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        {!selected ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Pick a pipeline.
          </div>
        ) : (
          <div className="flex flex-col gap-5 p-5">
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-lg font-medium">{selected.name}</h1>
              <Badge variant="outline" className="tabular-nums text-[10px]">
                {selected.id.slice(0, 8)}
              </Badge>
              <span className="ml-auto flex items-center gap-2">
                <Button size="sm" onClick={() => setRunDialog({ open: true, id: selected.id })}>
                  Run
                </Button>
                <Button size="sm" variant="outline" onClick={() => openInCanvas(selected.id)}>{t('workflows.openInCanvas')}</Button>
              </span>
            </div>
            {selected.description && (
              <p className="text-sm text-muted-foreground">{selected.description}</p>
            )}

            <section>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Steps
              </h3>
              <ol className="space-y-2">
                {selected.definition.steps.map((step) => (
                  <li
                    key={step.id}
                    className="rounded-md border border-border bg-card px-3 py-2"
                  >
                    <div className="flex flex-wrap items-center gap-2 text-[11px]">
                      <Badge variant="outline" className="text-[10px]">{step.id}</Badge>
                      {step.type && (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                          {step.type}
                        </span>
                      )}
                      <span className="text-muted-foreground">→ {step.agent}</span>
                      {step.deps_on && step.deps_on.length > 0 && (
                        <span className="text-[10px] text-muted-foreground/70">
                          ↑ deps: {step.deps_on.join(', ')}
                        </span>
                      )}
                    </div>
                    <pre className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-words text-[11.5px] text-muted-foreground">
                      {step.prompt}
                    </pre>
                  </li>
                ))}
              </ol>
            </section>

            {run && run.run.pipeline_id === selected.id && (
              <section>
                <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Latest run · {run.run.run_id.slice(0, 8)} · {new Date(run.run.started_at).toISOString().slice(0, 16).replace('T', ' ')}
                </h3>
                <ul className="space-y-1.5">
                  {run.steps.map((s) => (
                    <li
                      key={s.step_id}
                      className="flex items-center gap-3 rounded border border-border bg-card px-3 py-1.5"
                    >
                      <Badge variant="outline" className="text-[10px]">{s.step_id}</Badge>
                      <span className="flex-1 text-xs">{s.title}</span>
                      <Badge variant="outline" className={cn('h-5 px-1.5 text-[10px]', STATUS_TONE[s.status] ?? '')}>
                        {s.status}
                      </Badge>
                      <Link href={`/trace/${run.run.run_id}`} className="text-[10px] text-primary hover:underline">{t('workflows.trace')}</Link>
                      {s.mission_id ? (
                        <Link
                          href={`/missions?selected=${s.mission_id}`}
                          className="text-[10px] text-primary hover:underline"
                        >
                          mission
                        </Link>
                      ) : (
                        <Link
                          href={`/kanban?task=${s.task_id}`}
                          className="text-[10px] text-[hsl(var(--info))] hover:underline"
                        >
                          task
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}
      </div>

      <Dialog
        open={!!runDialog?.open}
        onOpenChange={(open) => { if (!open) setRunDialog(null); }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Run pipeline</DialogTitle>
            <DialogDescription>
              Provide input JSON. Available in step prompts via{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-[10.5px]">{'{{input.foo}}'}</code>.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={inputJson}
            onChange={(e) => setInputJson(e.target.value)}
            rows={6}
            /* code-font: JSON input */ className="font-mono text-xs"
            placeholder='{"feature":"X"}'
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRunDialog(null)}>Cancel</Button>
            <Button onClick={launchRun}>Launch</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
  );
}
