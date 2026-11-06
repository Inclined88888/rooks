'use client';

/**
 * `/workflows` gallery: one card per workflow with its published version,
 * trigger state and last run. The builder lives in `builder.tsx`.
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Bot, ChevronRight, Plus, Workflow as WorkflowIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { RunStatusBadge } from './trace-panel';
import { EMPTY_DEFINITION, formatRelative, type Workflow } from './types';

export { WorkflowBuilder } from './builder';

const SLUG_RE = /^[a-z0-9._-]{1,64}$/;

function slugify(value: string): string {
  return value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try { return JSON.parse(text) as Record<string, unknown>; } catch { return {}; }
}

function WorkflowCard({ workflow }: { workflow: Workflow }) {
  const last = workflow.last_run ?? null;
  return (
    <Link href={`/workflows/${encodeURIComponent(workflow.slug)}`} className="group flex flex-col rounded-2xl border border-border bg-card p-4 shadow-elev-1 transition-colors hover:border-primary/50">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><WorkflowIcon className="size-4" /></span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-[14px] font-semibold">{workflow.name}</h2>
            <span className={cn('size-1.5 shrink-0 rounded-full', workflow.enabled === 1 ? 'bg-[hsl(var(--success))]' : 'bg-muted-foreground/40')} title={workflow.enabled === 1 ? t('workflows.enabled') : t('workflows.disabled')} />
          </div>
          <p className="mt-0.5 line-clamp-2 text-[12px] text-muted-foreground">{workflow.description || <span>{workflow.slug}</span>}</p>
        </div>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
      </div>
      <div className="mt-3 flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Bot className="size-3.5 shrink-0" />
        <span className={cn('truncate', !workflow.agent_name && 'text-destructive')}>{workflow.agent_name ?? t('workflows.noAgent')}</span>
      </div>
      <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="rounded-md border border-border px-1.5 py-px text-[10px] tabular-nums">{workflow.published_version ? `v${workflow.published_version}` : t('workflows.draftOnly')}</span>
        {last ? (
          <>
            <RunStatusBadge status={last.status} />
            <span>{formatRelative(last.started_at)}</span>
          </>
        ) : (
          <span>{t('workflows.neverRun')}</span>
        )}
        <span className="ml-auto">{t('workflows.runCount', { n: workflow.run_count ?? 0 })}</span>
      </div>
    </Link>
  );
}

export function WorkflowsPage() {
  const router = useRouter();
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [agents, setAgents] = useState<{ name: string }[]>([]);
  const [agent, setAgent] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    void (async () => {
      const response = await fetch('/api/ui/workflows', { cache: 'no-store' });
      const value = await readJson(response);
      setWorkflows(Array.isArray(value.workflows) ? (value.workflows as Workflow[]) : []);
    })();
  }, []);
  useEffect(() => { load(); }, [load]);
  // The pilot is picked from the live agent list: a workflow is never created without one.
  useEffect(() => {
    if (!open) return;
    void (async () => {
      const response = await fetch('/api/ui/agents', { cache: 'no-store' });
      const value = await readJson(response);
      const list = Array.isArray(value.agents) ? (value.agents as { name: string }[]).filter((item) => typeof item.name === 'string') : [];
      setAgents(list);
      setAgent((current) => current || list[0]?.name || '');
    })();
  }, [open]);

  function resetDialog() { setName(''); setSlug(''); setSlugTouched(false); setAgent(''); setError(null); setSaving(false); }

  async function create(event: React.FormEvent) {
    event.preventDefault();
    const trimmedName = name.trim();
    const nextSlug = slugify(slugTouched ? slug : trimmedName);
    if (!trimmedName || !SLUG_RE.test(nextSlug)) { setError(t('workflows.slugHint')); return; }
    if (!agent) { setError(t('workflows.agentRequired')); return; }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch('/api/ui/workflows', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug: nextSlug, name: trimmedName, agent_name: agent, draft: EMPTY_DEFINITION }) });
      const payload = await readJson(response);
      const created = payload.workflow as Workflow | undefined;
      if (!response.ok || !created || typeof created.slug !== 'string') throw new Error(typeof payload.error === 'string' ? payload.error : t('workflows.createError'));
      setOpen(false);
      resetDialog();
      router.push(`/workflows/${encodeURIComponent(created.slug)}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : t('workflows.createError');
      setError(message);
      toast.error(message);
      setSaving(false);
    }
  }

  return (
    <main className="mx-auto max-w-6xl p-6">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{t('workflows.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('workflows.description')}</p>
        </div>
        <Button onClick={() => { resetDialog(); setOpen(true); }}><Plus className="mr-1 size-4" />{t('workflows.new')}</Button>
      </div>
      {workflows === null && <p className="text-sm text-muted-foreground">{t('common.loading')}</p>}
      {workflows && workflows.length === 0 && (
        <div className="flex flex-col items-center rounded-2xl border border-dashed border-border px-6 py-16 text-center">
          <span className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary"><WorkflowIcon className="size-6" /></span>
          <h2 className="mt-4 text-sm font-semibold">{t('workflows.emptyTitle')}</h2>
          <p className="mt-1 max-w-md text-xs text-muted-foreground">{t('workflows.emptyHint')}</p>
          <Button className="mt-5" size="sm" onClick={() => { resetDialog(); setOpen(true); }}><Plus className="mr-1 size-4" />{t('workflows.new')}</Button>
        </div>
      )}
      {workflows && workflows.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {workflows.map((workflow) => <WorkflowCard key={workflow.id} workflow={workflow} />)}
        </div>
      )}
      <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) resetDialog(); }}>
        <DialogContent className="sm:max-w-md">
          <form onSubmit={(event) => { void create(event); }}>
            <DialogHeader><DialogTitle>{t('workflows.createTitle')}</DialogTitle></DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-1.5">
                <Label htmlFor="workflow-name">{t('workflows.name')}</Label>
                <Input id="workflow-name" value={name} autoFocus disabled={saving} onChange={(event) => { const next = event.target.value; setName(next); if (!slugTouched) setSlug(slugify(next)); }} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="workflow-slug">{t('workflows.slug')}</Label>
                <Input id="workflow-slug" value={slug} disabled={saving} onChange={(event) => { setSlugTouched(true); setSlug(event.target.value); }} />
                <p className="text-xs text-muted-foreground">{t('workflows.slugHint')}</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="workflow-agent">{t('workflows.agent')}</Label>
                <select id="workflow-agent" value={agent} disabled={saving} onChange={(event) => setAgent(event.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
                  {agents.length === 0 && <option value="">{t('workflows.noCatalogue')}</option>}
                  {agents.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
                </select>
                <p className="text-xs text-muted-foreground">{t('workflows.agentHint')}</p>
              </div>
              {error && <p className="text-sm text-destructive">{error}</p>}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={saving}>{t('common.cancel')}</Button>
              <Button type="submit" disabled={saving || name.trim().length === 0 || !agent}>{saving ? t('workflows.creating') : t('workflows.create')}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </main>
  );
}
