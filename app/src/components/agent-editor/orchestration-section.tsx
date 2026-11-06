'use client';

import { useEffect, useMemo, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { FramedFace } from '@/plugins-client/agent-chat/agent-avatar';
import { visageAgent, type ProjetConnu } from '@/plugins-client/agent-chat/use-agents';

export type OrchestrationSource = 'explicit' | 'main' | 'orchestrator' | 'reports_to';

/** What the daemon says about one agent's delegation list. The UI never
 *  resolves the rule itself: `effective_orchestrates` is the answer. */
export type OrchestrationAgent = {
  name: string;
  /** Raw config value: `null`/absent = derived by the daemon. */
  orchestrates?: string[] | '*' | null;
  effective_orchestrates?: string[] | '*';
  orchestrates_source?: OrchestrationSource;
};

export type OrchestrationRosterEntry = {
  name: string;
  project?: string | null;
  role?: string | null;
  /** The look the agent has everywhere else (avatar). */
  icon_url?: string | null;
  emoji?: string | null;
  color?: string | null;
  /** Explicit manager, as the canvas sets it. */
  reports_to?: string | null;
  /** Id of the team of bots the agent belongs to. */
  team?: string | null;
};

export type OrchestrationTeam = { id: string; name: string; color?: string | null };

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The agents below `name` in the canvas (`reports_to`), directly or through
 *  another agent. Read here only to show it: the daemon still decides what an
 *  agent may orchestrate. A hand-edited cycle is walked once. */
export function canvasReports(name: string, roster: readonly OrchestrationRosterEntry[]): { direct: Set<string>; below: Set<string> } {
  const direct = new Set(roster.filter((a) => a.reports_to && same(a.reports_to, name)).map((a) => a.name));
  const below = new Set<string>();
  const queue = [name];
  const seen = new Set<string>([name.toLowerCase()]);
  while (queue.length) {
    const parent = queue.shift()!;
    for (const a of roster) {
      if (!a.reports_to || !same(a.reports_to, parent) || seen.has(a.name.toLowerCase())) continue;
      seen.add(a.name.toLowerCase());
      below.add(a.name);
      queue.push(a.name);
    }
  }
  return { direct, below };
}

/** What the operator picked, before it is written. */
export type Selection = { kind: 'inherit' } | { kind: 'all' } | { kind: 'list'; names: string[] };

export function selectionOf(raw: OrchestrationAgent['orchestrates']): Selection {
  if (raw === undefined || raw === null) return { kind: 'inherit' };
  return raw === '*' ? { kind: 'all' } : { kind: 'list', names: [...raw] };
}

/** The value the daemon route takes: `null` puts the agent back on its default. */
export function payloadOf(selection: Selection): string[] | '*' | null {
  if (selection.kind === 'inherit') return null;
  return selection.kind === 'all' ? '*' : [...selection.names].sort();
}

const sameSelection = (a: Selection, b: Selection): boolean =>
  JSON.stringify(payloadOf(a)) === JSON.stringify(payloadOf(b));

/** Agents ticked in the list for a selection. An inherited selection shows
 *  what the daemon resolved, so the inheritance is visible before it is
 *  overridden. */
export function checkedNames(
  selection: Selection,
  effective: OrchestrationAgent['effective_orchestrates'],
  roster: readonly string[],
): Set<string> {
  if (selection.kind === 'all') return new Set(roster);
  if (selection.kind === 'list') return new Set(selection.names);
  return effective === '*' ? new Set(roster) : new Set(effective ?? []);
}

async function refusalReason(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { reason?: unknown; error?: unknown };
    for (const value of [body.reason, body.error]) {
      if (typeof value === 'string' && value) return value;
    }
  } catch {}
  return t('orchestration.reasonUnknown');
}

export type OrchestrationSectionProps = {
  /** `null` for an agent not created yet: nothing to write to. */
  agent: OrchestrationAgent | null;
  /** Every agent of the install; the edited one is left out of the list. */
  roster: readonly OrchestrationRosterEntry[];
  /** The teams of bots, to name the team an agent belongs to. */
  teams?: readonly OrchestrationTeam[];
  /** The projects, for the avatar an agent without a picture borrows. */
  projects?: readonly ProjetConnu[];
  /** The daemon's answer after a write, to refresh what the editor holds. */
  onSaved?: (agent: OrchestrationAgent) => void;
  /** Whether a selection is picked but not applied yet, so the host can warn
   *  before it throws it away. `false` after Apply and for another agent. */
  onDirtyChange?: (dirty: boolean) => void;
};

function TeamTag({ team, mine }: { team: OrchestrationTeam | undefined; mine: boolean }) {
  if (!team) return null;
  return (
    <span
      data-orchestration-team-tag
      className={cn(
        'flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px]',
        mine ? 'border-primary/50 text-primary' : 'border-border text-muted-foreground',
      )}
    >
      <span aria-hidden className="size-1.5 rounded-full" style={{ background: team.color || 'currentColor' }} />
      {team.name}
    </span>
  );
}

/** An agent as the list draws it: avatar, name, what it does, and the tags at the end. */
function Row({ agent, roster, projects, tags }: {
  agent: OrchestrationRosterEntry;
  roster: readonly OrchestrationRosterEntry[];
  projects: readonly ProjetConnu[];
  tags?: React.ReactNode;
}) {
  return (
    <>
      <FramedFace visage={visageAgent(agent.name, roster, projects)} className="size-7" glyphClassName="text-[11px]" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[12.5px] font-medium">{agent.name}</span>
        {(agent.project || agent.role) && (
          <span className="truncate text-[11px] text-muted-foreground">{[agent.role, agent.project].filter(Boolean).join(' · ')}</span>
        )}
      </span>
      {tags && <span className="flex shrink-0 items-center gap-1.5">{tags}</span>}
    </>
  );
}

export function OrchestrationSection({ agent: given, roster, teams = [], projects = [], onSaved, onDirtyChange }: OrchestrationSectionProps) {
  // What the daemon last said. Held here as well as by the editor so the list
  // is right the moment a write succeeds, whether or not the host passes the
  // answer back down.
  const [agent, setAgent] = useState(given);
  const initial = useMemo(() => selectionOf(agent?.orchestrates), [agent?.orchestrates]);
  const [selection, setSelection] = useState<Selection>(initial);
  const [filter, setFilter] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Another agent, or a list rewritten elsewhere (graph, another tab): start
  // over from what the daemon holds.
  // Only what this tab shows counts: the host hands over the whole agent, and
  // a Save of another tab must not wipe a selection still waiting for Apply.
  const givenKey = JSON.stringify(given ? [given.name, given.orchestrates ?? null, given.effective_orchestrates ?? null, given.orchestrates_source ?? null] : null);
  useEffect(() => {
    setAgent(given);
    setSelection(selectionOf(given?.orchestrates));
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [givenKey]);

  const dirty = !!agent && !sameSelection(selection, initial);
  // The tab unmounts on a tab switch and the selection goes with it: a flag left
  // raised would warn about an edit that no longer exists.
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => { if (dirty) onDirtyChange?.(false); };
  }, [dirty, onDirtyChange]);

  if (!agent) {
    return <p className="text-[12px] text-muted-foreground">{t('orchestration.saveFirst')}</p>;
  }
  if (agent.effective_orchestrates === undefined) {
    return <p className="text-[12px] text-muted-foreground">{t('orchestration.unavailable')}</p>;
  }

  const self = roster.find((a) => a.name === agent.name);
  const rest = roster.filter((a) => a.name !== agent.name);
  const names = rest.map((a) => a.name).sort((a, b) => a.localeCompare(b));
  const checked = checkedNames(selection, agent.effective_orchestrates, names);
  const { direct, below } = canvasReports(agent.name, roster);
  const teamOf = (id: string | null | undefined) => (id ? teams.find((x) => x.id === id) : undefined);
  const myTeam = teamOf(self?.team);
  const teammates = myTeam ? rest.filter((a) => a.team === myTeam.id).map((a) => a.name) : [];
  const everyone = selection.kind === 'all' || (selection.kind === 'inherit' && agent.effective_orchestrates === '*');
  // Who is in, the canvas reports first: what the operator drew comes before what was added by hand.
  const chosen = rest
    .filter((a) => checked.has(a.name))
    .sort((a, b) => Number(below.has(b.name)) - Number(below.has(a.name)) || a.name.localeCompare(b.name));
  const needle = filter.trim().toLowerCase();
  const candidates = needle
    ? rest.filter((a) => !checked.has(a.name) && [a.name, a.project, a.role].some((v) => v?.toLowerCase().includes(needle))).slice(0, 8)
    : [];
  const inherited = selection.kind === 'inherit';

  /** Ticks these agents on top of the current selection. */
  const addAll = (extra: Iterable<string>) => {
    const next = new Set([...checked, ...extra]);
    setSelection({ kind: 'list', names: names.filter((n) => next.has(n)) });
  };

  const remove = (name: string) => {
    const next = new Set(checked);
    next.delete(name);
    setSelection({ kind: 'list', names: names.filter((n) => next.has(n)) });
  };

  const apply = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/ui/agents/${encodeURIComponent(agent.name)}/orchestrates`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orchestrates: payloadOf(selection) }),
      });
      if (!res.ok) {
        const reason = await refusalReason(res);
        setError(t(res.status === 403 ? 'orchestration.denied' : 'orchestration.failed', { reason }));
        return;
      }
      const saved = (await res.json()) as OrchestrationAgent;
      setAgent(saved);
      setSelection(selectionOf(saved.orchestrates));
      onSaved?.(saved);
    } catch (e) {
      setError(t('orchestration.failed', { reason: String((e as Error).message || e) }));
    } finally {
      setSaving(false);
    }
  };

  const state = dirty
    ? t('orchestration.stateUnsaved')
    : t(inherited ? 'orchestration.stateInherited' : 'orchestration.stateOverridden');
  const explanation = inherited
    ? t(`orchestration.source.${agent.orchestrates_source ?? 'reports_to'}`)
    : selection.kind === 'all'
      ? t('orchestration.allNote')
      : selection.names.length === 0
        ? t('orchestration.noneNote')
        : t('orchestration.source.explicit');

  return (
    <div data-orchestration className="flex flex-col gap-3">
      <p className="text-[12px] text-muted-foreground">{t('orchestration.intro')}</p>

      <div className="flex flex-wrap items-center gap-2">
        <span
          data-orchestration-state={dirty ? 'unsaved' : inherited ? 'inherited' : 'explicit'}
          className={cn(
            'rounded-full border px-2 py-0.5 text-[11px] font-semibold',
            dirty ? 'border-amber-500/50 text-amber-600' : inherited ? 'border-border text-muted-foreground' : 'border-primary/50 text-primary',
          )}
        >
          {state}
        </span>
        <span className="text-[12px] text-muted-foreground">{explanation}</span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" data-orchestration-all onClick={() => setSelection({ kind: 'all' })}>
          {t('orchestration.all')}
        </Button>
        <Button type="button" size="sm" variant="outline" data-orchestration-none onClick={() => setSelection({ kind: 'list', names: [] })}>
          {t('orchestration.none')}
        </Button>
        <Button type="button" size="sm" variant="ghost" data-orchestration-restore disabled={inherited} onClick={() => setSelection({ kind: 'inherit' })}>
          {t('orchestration.restore')}
        </Button>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {t('orchestration.count', { count: checked.size, total: names.length })}
        </span>
      </div>

      {(below.size > 0 || teammates.length > 0) && (
        <div className="flex flex-wrap items-center gap-2">
          {below.size > 0 && (
            <Button type="button" size="sm" variant="outline" data-orchestration-canvas onClick={() => addAll(below)}>
              {t('orchestration.addCanvas', { count: below.size })}
            </Button>
          )}
          {myTeam && teammates.length > 0 && (
            <Button type="button" size="sm" variant="outline" data-orchestration-team onClick={() => addAll(teammates)}>
              {t('orchestration.addTeam', { team: myTeam.name, count: teammates.length })}
            </Button>
          )}
        </div>
      )}

      {rest.length === 0 ? (
        <p className="text-[12px] text-muted-foreground">{t('orchestration.empty')}</p>
      ) : everyone ? (
        <p data-orchestration-everyone className="rounded-lg border border-dashed border-border px-3 py-4 text-[12px] text-muted-foreground">
          {t('orchestration.everyoneNote')}
        </p>
      ) : (
        <>
          <div className="relative">
            <Input
              data-orchestration-search
              aria-label={t('orchestration.search')}
              placeholder={t('orchestration.search')}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            {needle && (
              <ul role="listbox" aria-label={t('orchestration.results')} className="absolute z-10 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-border bg-popover shadow-elev-3">
                {candidates.length === 0 && <li className="px-3 py-2 text-[12px] text-muted-foreground">{t('orchestration.noMatch')}</li>}
                {candidates.map((a) => (
                  <li key={a.name} role="option" aria-selected={false}>
                    <button type="button" data-orchestration-option={a.name}
                      onClick={() => { addAll([a.name]); setFilter(''); }}
                      className="flex w-full items-center gap-3 px-3 py-1.5 text-left hover:bg-muted/40">
                      <Row agent={a} roster={roster} projects={projects} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {chosen.length === 0 ? (
            <p data-orchestration-none-note className="rounded-lg border border-dashed border-border px-3 py-4 text-[12px] text-muted-foreground">
              {t('orchestration.nobodyYet')}
            </p>
          ) : (
            <ul aria-label={t('orchestration.chosen')} className="flex flex-col gap-0.5 rounded-lg bg-muted/30 p-1">
              {chosen.map((a) => (
                <li key={a.name} data-orchestration-row={a.name} className="flex items-center gap-3 rounded-md px-3 py-2">
                  <Row agent={a} roster={roster} projects={projects}
                    tags={<>
                      {below.has(a.name) && (
                        <span data-orchestration-canvas-tag className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {t(direct.has(a.name) ? 'orchestration.tagReports' : 'orchestration.tagBelow')}
                        </span>
                      )}
                      <TeamTag team={teamOf(a.team)} mine={!!myTeam && a.team === myTeam.id} />
                    </>} />
                  <button type="button" data-orchestration-remove={a.name} aria-label={t('orchestration.remove', { name: a.name })}
                    onClick={() => remove(a.name)}
                    className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
                    <Trash2 className="size-3.5" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {error && (
        <p role="alert" data-orchestration-error className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
          {error}
        </p>
      )}

      <div className="flex justify-end">
        <Button type="button" size="sm" data-orchestration-apply disabled={!dirty || saving} onClick={apply}>
          {saving ? t('orchestration.applying') : t('orchestration.apply')}
        </Button>
      </div>
    </div>
  );
}
