'use client';

/**
 * "Who receives this skill": the attachments of one Timon skill at every
 * scope (every agent, a project, an agent role, an agent), exclusions
 * included, with what to add, change or remove.
 *
 * Self-contained on a skill id, so another surface can mount it as is. The
 * controls are greyed from `/api/auth/me`, but the route is what refuses: its
 * answer is shown as it comes. A write reaches agents at their next start
 * (only an agent-scope one restarts a running mission), hence the notice.
 */

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { ChevronDown, ChevronRight, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { fetchMe, meCan } from '@/lib/auth';
import { BRAND } from '@/lib/brand';
import { t } from '@/lib/i18n';
import {
  ATTACHMENT_SCOPES, attachBody, attachFailure, attachmentGroups, attachmentKind, attachmentKinds, freeTargets, globalTaken,
  scopeWritable, type AttachFailure, type AttachmentGrants, type AttachmentKind, type AttachmentScope, type SkillAttachment,
} from '@/lib/skill-attachments';
import { cn } from '@/lib/utils';

type Targets = { project: string[]; role: string[]; agent: string[]; roleLabels: Record<string, string> };

const EMPTY_TARGETS: Targets = { project: [], role: [], agent: [], roleLabels: {} };

const UNKNOWN_GRANTS: AttachmentGrants = { manage: null, privileged: null };

const FIELD = 'h-7 rounded-md border border-input bg-background px-1.5 text-[11.5px] text-foreground disabled:cursor-not-allowed disabled:opacity-50';

async function readJson(url: string): Promise<unknown> {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

/** The names each scope can point at, read from the lists the daemon already serves. */
async function loadTargets(): Promise<Targets> {
  const settle = async <T,>(p: Promise<T>, fallback: T): Promise<T> => p.catch(() => fallback);
  const [projects, roles, agents] = await Promise.all([
    settle(readJson('/api/ui/projects'), null),
    settle(readJson('/api/ui/agent-roles'), null),
    settle(readJson('/api/ui/agents'), null),
  ]);
  const projectList = (projects as { projects?: { slug?: unknown }[] } | null)?.projects ?? [];
  const roleList = (roles as { roles?: { id?: unknown; label?: unknown }[] } | null)?.roles ?? [];
  const agentList = (agents as { agents?: { name?: unknown }[] } | null)?.agents ?? [];
  const roleLabels: Record<string, string> = {};
  for (const r of roleList) if (typeof r.id === 'string') roleLabels[r.id] = typeof r.label === 'string' ? r.label : r.id;
  return {
    project: projectList.map((p) => p.slug).filter((s): s is string => typeof s === 'string'),
    role: Object.keys(roleLabels),
    agent: agentList.map((a) => a.name).filter((n): n is string => typeof n === 'string'),
    roleLabels,
  };
}

function failureText(f: AttachFailure): string {
  return t(`skillAttach.error.${f.key}`, f.vars);
}

/** Why controls are greyed, the widest missing grant first; `null` when none is known missing. */
function lockedText(grants: AttachmentGrants): string | null {
  if (grants.manage === false) return t('skillAttach.needsManage');
  if (grants.privileged === false) return t('skillAttach.needsPrivileged');
  return null;
}

export function SkillRecipients({ skill, defaultOpen = false }: { skill: string; defaultOpen?: boolean }): ReactElement {
  const [open, setOpen] = useState(defaultOpen);
  const [rows, setRows] = useState<SkillAttachment[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [targets, setTargets] = useState<Targets>(EMPTY_TARGETS);
  const [grants, setGrants] = useState<AttachmentGrants>(UNKNOWN_GRANTS);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const body = await readJson(`/api/ui/skill-attachments?skill=${encodeURIComponent(skill)}`) as { attachments?: SkillAttachment[] };
      setRows(body.attachments ?? []);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, [skill]);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    void loadTargets().then((next) => { if (alive) setTargets(next); });
    void fetchMe()
      .then((me) => {
        if (alive) setGrants({ manage: meCan(me, 'agents:manage'), privileged: meCan(me, 'agents:privileged-config') });
      })
      // Unreadable: grey what needs the permissions, the route still decides.
      .catch(() => { if (alive) setGrants({ manage: false, privileged: false }); });
    return () => { alive = false; };
  }, [open]);

  const groups = useMemo(() => attachmentGroups(rows ?? [], skill), [rows, skill]);
  const count = groups.reduce((n, g) => n + g.rows.length, 0);

  /** Writes one attachment; `null` when it went through, else what to tell the user. */
  async function write(scope: AttachmentScope, target: string, kind: AttachmentKind): Promise<string | null> {
    try {
      const r = await fetch('/api/ui/skill-attachments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(attachBody(skill, scope, target, kind)),
      });
      if (!r.ok) return failureText(attachFailure(r.status, await r.json().catch(() => null), { scope, target }));
      return null;
    } catch {
      return t('skillAttach.error.network', { brand: BRAND.displayName });
    }
  }

  async function add(scope: AttachmentScope, target: string, kind: AttachmentKind): Promise<boolean> {
    setBusy(true);
    setFormError(null);
    const failure = await write(scope, target, kind);
    setBusy(false);
    if (failure) {
      setFormError(failure);
      // A target gone since the lists were read: read them again.
      void loadTargets().then(setTargets);
      return false;
    }
    toast.success(t('skillAttach.saved', { id: skill }));
    await reload();
    return true;
  }

  async function change(row: SkillAttachment, kind: AttachmentKind) {
    setBusy(true);
    const failure = await write(row.scope, row.target, kind);
    setBusy(false);
    if (failure) toast.error(failure);
    else toast.success(t('skillAttach.saved', { id: skill }));
    await reload();
  }

  async function remove(row: SkillAttachment) {
    setBusy(true);
    let failure: string | null = null;
    try {
      const r = await fetch(`/api/ui/skill-attachments/${row.id}`, { method: 'DELETE' });
      if (!r.ok) failure = failureText(attachFailure(r.status, await r.json().catch(() => null), row));
    } catch {
      failure = t('skillAttach.error.network', { brand: BRAND.displayName });
    }
    setBusy(false);
    if (failure) toast.error(failure);
    else toast.success(t('skillAttach.removed', { id: skill }));
    await reload();
  }

  function targetLabel(row: SkillAttachment): string {
    if (row.scope === 'global') return t('skillAttach.everyAgent');
    if (row.scope === 'role') return targets.roleLabels[row.target] ?? row.target;
    return row.target;
  }

  const lockedTitle = lockedText(grants);

  return (
    <section className="shrink-0 px-3 pb-1.5 text-[11.5px]" aria-label={t('skillAttach.title')}>
      <button
        type="button"
        className="flex items-center gap-1.5 rounded-md px-1 py-0.5 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
        <span className="font-medium">{t('skillAttach.title')}</span>
        {rows && <Badge variant="secondary" className="h-4 px-1.5 text-[10.5px] font-normal tabular-nums">{count}</Badge>}
      </button>
      {open && (
        <div className="mt-1.5 max-h-72 space-y-2.5 overflow-y-auto rounded-md bg-muted/30 p-2.5">
          <p className="text-muted-foreground">{t('skillAttach.hint')}</p>
          {lockedTitle && <p className="text-amber-600 dark:text-amber-400">{lockedTitle}</p>}
          {loadError && <p className="text-destructive">{t('skillAttach.loadFailed')}</p>}
          {!rows && !loadError && <p className="text-muted-foreground">{t('skillAttach.loading')}</p>}
          {rows && groups.length === 0 && <p className="text-muted-foreground">{t('skillAttach.empty')}</p>}
          {groups.map((g) => {
            const writable = scopeWritable(g.scope, grants) === true;
            return (
              <div key={g.scope} className="space-y-1">
                <div className="text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground">{t(`skillAttach.scope.${g.scope}`)}</div>
                <ul className="space-y-0.5">
                  {g.rows.map((row) => (
                    <li key={row.id} className="flex items-center gap-2 rounded-md px-1.5 py-0.5 hover:bg-muted/60">
                      <span className={cn('min-w-0 flex-1 truncate', row.exclude && 'text-muted-foreground line-through')} title={row.target || undefined}>
                        {targetLabel(row)}
                      </span>
                      <select
                        aria-label={t('skillAttach.kindOf', { target: targetLabel(row) })}
                        className={FIELD}
                        value={attachmentKind(row)}
                        disabled={busy || !writable}
                        title={writable ? undefined : lockedTitle ?? undefined}
                        onChange={(e) => void change(row, e.target.value as AttachmentKind)}
                      >
                        {attachmentKinds(row.scope).map((k) => <option key={k} value={k}>{t(`skillAttach.kind.${k}`)}</option>)}
                      </select>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-6"
                        disabled={busy || !writable}
                        onClick={() => void remove(row)}
                        aria-label={t('skillAttach.remove', { target: targetLabel(row) })}
                        title={writable ? t('skillAttach.remove', { target: targetLabel(row) }) : lockedTitle ?? undefined}
                      >
                        <X className="size-3.5" />
                      </Button>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          <AddAttachment
            skill={skill}
            rows={rows ?? []}
            targets={targets}
            grants={grants}
            busy={busy}
            error={formError}
            onAdd={add}
          />
        </div>
      )}
    </section>
  );
}

function AddAttachment({ skill, rows, targets, grants, busy, error, onAdd }: {
  skill: string;
  rows: SkillAttachment[];
  targets: Targets;
  grants: AttachmentGrants;
  busy: boolean;
  error: string | null;
  onAdd: (scope: AttachmentScope, target: string, kind: AttachmentKind) => Promise<boolean>;
}): ReactElement {
  const [scope, setScope] = useState<AttachmentScope>('agent');
  const [target, setTarget] = useState('');
  const [kind, setKind] = useState<AttachmentKind>('include');

  const writable = scopeWritable(scope, grants) === true;
  const free = scope === 'global' ? [] : freeTargets(scope, targets[scope], rows, skill);
  const kinds = attachmentKinds(scope);
  const ready = writable && !busy
    && (scope === 'global' ? !globalTaken(rows, skill) : free.includes(target))
    && kinds.includes(kind);

  function pickScope(next: AttachmentScope) {
    setScope(next);
    setTarget('');
    if (!attachmentKinds(next).includes(kind)) setKind('include');
  }

  async function submit() {
    if (!ready) return;
    if (await onAdd(scope, target, kind)) setTarget('');
  }

  return (
    <div className="space-y-1 pt-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <select aria-label={t('skillAttach.scopeLabel')} className={FIELD} value={scope} disabled={busy} onChange={(e) => pickScope(e.target.value as AttachmentScope)}>
          {ATTACHMENT_SCOPES.map((s) => (
            <option key={s} value={s} disabled={scopeWritable(s, grants) !== true}>{t(`skillAttach.scope.${s}`)}</option>
          ))}
        </select>
        {scope !== 'global' && (
          <select
            aria-label={t('skillAttach.targetLabel')}
            className={cn(FIELD, 'min-w-0 max-w-[14rem] flex-1')}
            value={target}
            disabled={busy || !writable || free.length === 0}
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value="">{free.length ? t('skillAttach.targetPlaceholder') : t('skillAttach.noTarget')}</option>
            {free.map((name) => (
              <option key={name} value={name}>{scope === 'role' ? (targets.roleLabels[name] ?? name) : name}</option>
            ))}
          </select>
        )}
        <select aria-label={t('skillAttach.kindLabel')} className={FIELD} value={kind} disabled={busy || !writable} onChange={(e) => setKind(e.target.value as AttachmentKind)}>
          {kinds.map((k) => <option key={k} value={k}>{t(`skillAttach.kind.${k}`)}</option>)}
        </select>
        <Button
          variant="secondary"
          size="sm"
          className="h-7 gap-1 px-2 text-[11.5px]"
          disabled={!ready}
          title={writable ? undefined : lockedText(grants) ?? undefined}
          onClick={() => void submit()}
        >
          <Plus className="size-3.5" aria-hidden />
          {busy ? t('skillAttach.adding') : t('skillAttach.add')}
        </Button>
      </div>
      {scope === 'global' && globalTaken(rows, skill) && <p className="text-muted-foreground">{t('skillAttach.globalTaken')}</p>}
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </div>
  );
}
