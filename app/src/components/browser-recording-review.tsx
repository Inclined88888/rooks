'use client';

/**
 * Review drawer of a browser recording (TODO #461), the `browser.drawer`
 * entry of `@timon/browser-recording`. The owner settles every step before
 * anything reaches a model: mask a value, mark it as a parameter, rename,
 * delete. Steps the detector flagged come first in attention and block Learn
 * until each is masked, kept or deleted. Edits are destructive on the daemon
 * side: a masked value is overwritten, never kept aside.
 *
 * Learn starts the conversion mission and opens it; once that mission is
 * done, a card offers to attach the skill it wrote to an agent that uses
 * this browser profile. Attaching is the operator's gesture, never automatic.
 */

import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Check, EyeOff, GraduationCap, Loader2, MessageSquare, Pencil, Puzzle, RotateCw, ShieldAlert, Trash2, Variable, X } from 'lucide-react';
import { useBrowserChrome } from '@/components/browser-chrome';
import { useBrowserRecording } from '@/hooks/use-browser-recording';
import {
  browserRecordingApi, maskableValue, PARAMETER_NAME, replaceBrowserRecording, stepCount,
  type BrowserRecordingDetail, type BrowserRecordingLearnAgent, type BrowserRecordingMeta, type BrowserRecordingOp, type RecordedStep,
} from '@/lib/browser-recording';
import { chatHref, chatIslandContent } from '@/lib/chat-island-params';
import { openInIsland } from '@/lib/island-bus';
import { requestNavigation } from '@/lib/navigate-proposals';
import { t } from '@/lib/i18n';
import { formatDateTime } from '@/lib/intl';
import { cn } from '@/lib/utils';
import { apiErrorMessage } from '@/lib/api-error';

const iconButton = 'rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40';
const action = 'inline-flex items-center gap-1 rounded-md bg-background px-2 py-1 text-xs hover:bg-muted disabled:opacity-40';
const primary = 'inline-flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-40';
const field = 'min-w-0 rounded-md border border-input bg-background px-2 py-1 text-xs';
const FINISHED_MISSION = new Set(['completed', 'failed', 'terminated']);

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...init });
  const value = await response.json().catch(() => ({})) as { error?: unknown };
  if (!response.ok) throw new Error(apiErrorMessage(value, { status: response.status }));
  return value as T;
}

type MissionStatus = { agent_name?: string; status?: string; turn_complete?: boolean };

/** The conversion mission in the chat: a floating island when the workspace can host one, the chat page otherwise. */
export async function openLearnMission(missionId: string): Promise<void> {
  const mission = await getJson<MissionStatus>(`/api/ui/missions/${encodeURIComponent(missionId)}?view=status`);
  if (typeof mission.agent_name !== 'string') throw new Error(t('browserPanel.recording.missionUnavailable'));
  if (!openInIsland(chatIslandContent(mission.agent_name, missionId), { edge: 'float', pinned: true })) {
    requestNavigation(chatHref(mission.agent_name, missionId));
  }
}

function formatDate(ms: number): string {
  return formatDateTime(ms, { dateStyle: 'medium', timeStyle: 'short' });
}

function statusLabel(meta: BrowserRecordingMeta): string {
  return t(`browserPanel.recording.status.${meta.status}`);
}

export function BrowserRecordingReview() {
  const chrome = useBrowserChrome();
  const recording = useBrowserRecording();
  if (!chrome || !recording) return null;
  const selected = recording.selectedId;
  return (
    <div data-browser-recording-review="" className="flex min-h-full flex-col gap-3 p-3">
      <header className="flex items-center gap-2">
        {selected && <button type="button" className={iconButton} aria-label={t('browserPanel.recording.allRecordings')} onClick={() => recording.openReview(null)}><ArrowLeft className="size-4" /></button>}
        <h2 className="flex-1 text-sm font-medium">{t('browserPanel.recording.reviewHeading')}</h2>
        <button type="button" className={iconButton} aria-label={t('browserPanel.native.close')} onClick={chrome.closeDrawer}><X className="size-4" /></button>
      </header>
      {recording.owner === false ? <p className="text-xs text-muted-foreground">{t('browserPanel.recording.notOwner')}</p>
        : selected ? <RecordingDetail key={selected} id={selected} />
          : <RecordingList />}
    </div>
  );
}

function RecordingList() {
  const recording = useBrowserRecording();
  if (!recording) return null;
  if (recording.recordings.length === 0) return <p className="text-xs text-muted-foreground">{t('browserPanel.recording.empty')}</p>;
  return (
    <ul className="space-y-2">
      {recording.recordings.map((meta) => (
        <li key={meta.id}>
          <button type="button" className="flex w-full flex-col gap-0.5 rounded-lg bg-muted/40 p-2 text-left hover:bg-muted" onClick={() => recording.openReview(meta.id)}>
            <span className="truncate text-xs font-medium">{meta.title}</span>
            <span className="text-[11px] text-muted-foreground tabular-nums">{formatDate(meta.createdAt)} · {stepCount(meta.steps)} · {statusLabel(meta)}</span>
            {meta.flagged > 0 && <span className="text-[11px] text-amber-700 dark:text-amber-400">{t('browserPanel.recording.flaggedCount', { count: meta.flagged })}</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}

type Editing = { step: number; kind: 'rename' | 'param'; value: string };

function RecordingDetail({ id }: { id: string }) {
  const recording = useBrowserRecording();
  const [detail, setDetail] = useState<BrowserRecordingDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [title, setTitle] = useState('');
  const [confirmLearn, setConfirmLearn] = useState(false);
  const [autoSubmit, setAutoSubmit] = useState(false);
  // The agents the daemon lets this conversion run on (#469); null while it answers.
  const [learnAgents, setLearnAgents] = useState<BrowserRecordingLearnAgent[] | null>(null);
  const [learnAgent, setLearnAgent] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const read = recording?.read;
  useEffect(() => {
    if (!confirmLearn) return;
    let live = true;
    setLearnAgents(null);
    browserRecordingApi.learnAgents(id).then(({ agents }) => {
      if (!live) return;
      setLearnAgents(agents);
      setLearnAgent(agents[0]?.name ?? '');
    }, (err: Error) => { if (live) { setLearnAgents([]); setError(err.message); } });
    return () => { live = false; };
  }, [confirmLearn, id]);
  useEffect(() => {
    if (!read) return;
    let live = true;
    read(id).then((value) => { if (live) { setDetail(value); setTitle(value.recording.title); } }, (err: Error) => { if (live) setError(err.message); });
    return () => { live = false; };
  }, [id, read]);

  const patch = recording?.patch;
  const apply = useCallback(async (ops: BrowserRecordingOp[]) => {
    if (!patch) return;
    setWorking(true); setError(null);
    try {
      const next = await patch(id, ops);
      setDetail(next); setTitle(next.recording.title); setEditing(null);
    } catch (err) { setError((err as Error).message); }
    finally { setWorking(false); }
  }, [id, patch]);

  if (!recording) return null;
  if (!detail) return error ? <p role="alert" className="text-xs text-destructive">{error}</p> : <Loader2 className="size-4 animate-spin text-muted-foreground" />;
  const meta = detail.recording;
  const editable = meta.status !== 'learned' && !!detail.steps;
  const learnBlocked = meta.flagged > 0 ? t('browserPanel.recording.learnBlockedFlagged', { count: meta.flagged })
    : meta.steps === 0 ? t('browserPanel.recording.learnBlockedEmpty') : null;

  const learn = async () => {
    setWorking(true); setError(null);
    try {
      const learned = await recording.learn(id, { autoSubmit, agent: learnAgent });
      setDetail({ recording: learned.recording, steps: detail.steps });
      setConfirmLearn(false);
      await openLearnMission(learned.missionId);
    } catch (err) { setError((err as Error).message); }
    finally { setWorking(false); }
  };
  const remove = async () => {
    setWorking(true); setError(null);
    try { await recording.remove(id); }
    catch (err) { setError((err as Error).message); setWorking(false); }
  };
  const saveTitle = () => {
    const next = title.trim();
    if (editable && next && next !== meta.title) void apply([{ op: 'rename', title: next }]);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="space-y-1">
        <input className={cn(field, 'w-full text-sm font-medium')} aria-label={t('browserPanel.recording.titleLabel')} value={title} disabled={!editable || working} maxLength={120}
          onChange={(event) => setTitle(event.target.value)} onBlur={saveTitle} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); saveTitle(); } }} />
        <p className="truncate text-[11px] text-muted-foreground tabular-nums" title={meta.startUrl}>{formatDate(meta.createdAt)} · {stepCount(meta.steps)} · {statusLabel(meta)}{meta.startUrl ? ` · ${meta.startUrl}` : ''}</p>
        {meta.truncated && <p className="text-[11px] text-muted-foreground">{t('browserPanel.recording.truncated')}</p>}
      </div>
      {recording.alreadySaved && recording.selectedId === id && (
        <p role="status" data-already-saved="" className="rounded-md bg-muted/60 p-2 text-xs text-muted-foreground">{t('browserPanel.recording.alreadySaved')}</p>
      )}
      {error && <p role="alert" className="rounded-md bg-destructive/10 p-2 text-xs text-destructive">{error}</p>}
      {meta.flagged > 0 && editable && (
        <p data-flagged-notice="" className="flex items-start gap-2 rounded-lg bg-amber-500/10 p-2 text-xs text-amber-800 dark:text-amber-300">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />{t('browserPanel.recording.flaggedNotice', { count: meta.flagged })}
        </p>
      )}
      {detail.steps ? (
        <ol className="space-y-2">
          {detail.steps.map((step) => (
            <StepCard key={step.n} step={step} editable={editable} working={working} editing={editing?.step === step.n ? editing : null}
              setEditing={setEditing} apply={apply} />
          ))}
        </ol>
      ) : <p className="text-xs text-muted-foreground">{t('browserPanel.recording.stepsGone')}</p>}

      {meta.status === 'learned'
        ? <LearnedCard meta={meta} />
        : editable && (
          <section aria-label={t('browserPanel.recording.learn')} className="space-y-2 rounded-lg bg-muted/40 p-2">
            {!confirmLearn ? (
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className={primary} disabled={!!learnBlocked || working} onClick={() => setConfirmLearn(true)}><GraduationCap className="size-3.5" />{t('browserPanel.recording.learn')}</button>
                <span className="text-[11px] text-muted-foreground">{learnBlocked ?? t('browserPanel.recording.learnHint')}</span>
              </div>
            ) : (
              <>
                <label className="flex items-start gap-2 text-xs">
                  <input type="checkbox" className="mt-0.5" checked={autoSubmit} onChange={(event) => setAutoSubmit(event.target.checked)} />
                  <span><span className="font-medium">{t('browserPanel.recording.autoSubmit')}</span><span className="block text-[11px] text-muted-foreground">{t('browserPanel.recording.autoSubmitHint')}</span></span>
                </label>
                {learnAgents === null
                  ? <p className="flex items-center gap-2 text-[11px] text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />{t('browserPanel.recording.learnAgentsLoading')}</p>
                  : learnAgents.length === 0
                    ? <p role="status" data-no-safe-agent="" className="rounded-md bg-amber-500/10 p-2 text-xs text-amber-800 dark:text-amber-300">{t('browserPanel.recording.noSafeAgent')}</p>
                    : (
                      <label className="flex flex-col gap-1 text-xs">
                        <span className="font-medium">{t('browserPanel.recording.learnAgent')}</span>
                        <select className={field} value={learnAgent} disabled={working} onChange={(event) => setLearnAgent(event.target.value)}>
                          {learnAgents.map((agent) => <option key={agent.name} value={agent.name}>{agent.name}</option>)}
                        </select>
                        <span className="text-[11px] text-muted-foreground">{t('browserPanel.recording.learnAgentHint')}</span>
                      </label>
                    )}
                <div className="flex gap-2">
                  <button type="button" className={primary} disabled={!!learnBlocked || working || !learnAgent} onClick={() => void learn()}>
                    {working ? <Loader2 className="size-3.5 animate-spin" /> : <GraduationCap className="size-3.5" />}{t('browserPanel.recording.startLearning')}
                  </button>
                  <button type="button" className={action} disabled={working} onClick={() => setConfirmLearn(false)}>{t('browserPanel.native.cancel')}</button>
                </div>
              </>
            )}
          </section>
        )}

      <div className="flex justify-end">
        {!confirmDelete
          ? <button type="button" className={cn(action, 'text-destructive')} disabled={working} onClick={() => setConfirmDelete(true)}><Trash2 className="size-3.5" />{t('browserPanel.recording.deleteRecording')}</button>
          : <button type="button" className={cn(action, 'bg-destructive/10 text-destructive')} disabled={working} onClick={() => void remove()}><Trash2 className="size-3.5" />{t('browserPanel.recording.confirmDelete')}</button>}
      </div>
    </div>
  );
}

function stepDetail(step: RecordedStep): string | null {
  if (step.type === 'input') return step.value ?? null;
  if (step.type === 'navigate' || step.type === 'newTab') return step.url ?? null;
  if (step.type === 'credential') return step.origin ?? null;
  if (step.type === 'secret') return step.secret ? t(`browserPanel.recording.secretKind.${step.secret}`) : null;
  return null;
}

function StepCard({ step, editable, working, editing, setEditing, apply }: {
  step: RecordedStep; editable: boolean; working: boolean; editing: Editing | null;
  setEditing: (value: Editing | null) => void; apply: (ops: BrowserRecordingOp[]) => Promise<void>;
}) {
  const flagged = !!step.flagged;
  const label = step.name || step.text || step.selector || '';
  const detail = stepDetail(step);
  const maskable = maskableValue(step) !== null;
  const nameValid = editing?.kind === 'param' ? PARAMETER_NAME.test(editing.value) : true;
  const save = () => {
    if (!editing || !nameValid) return;
    void apply([editing.kind === 'param' ? { op: 'param', step: step.n, name: editing.value } : { op: 'rename', step: step.n, name: editing.value }]);
  };
  return (
    <li data-step={step.n} data-flagged={flagged ? step.flagged : undefined}
      className={cn('space-y-1.5 rounded-lg p-2 text-xs', flagged ? 'bg-amber-500/10 ring-1 ring-amber-500/50' : 'bg-muted/40')}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-muted-foreground tabular-nums">{step.n}</span>
        <span className="font-medium">{t(`browserPanel.recording.step.${step.type}`)}</span>
        {step.param && <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">{t('browserPanel.recording.paramBadge', { name: step.param })}</span>}
        {flagged && <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-800 dark:text-amber-300"><ShieldAlert className="size-3" />{t('browserPanel.recording.flagged')}</span>}
      </div>
      {label && <p className="break-words">{label}</p>}
      {detail && <p className="break-all text-muted-foreground">{detail}</p>}
      {editing && (
        <form className="flex flex-wrap items-center gap-1.5" onSubmit={(event) => { event.preventDefault(); save(); }}>
          <input autoFocus className={cn(field, 'flex-1')} aria-label={editing.kind === 'param' ? t('browserPanel.recording.paramName') : t('browserPanel.recording.stepName')}
            value={editing.value} maxLength={editing.kind === 'param' ? 64 : 120} onChange={(event) => setEditing({ ...editing, value: event.target.value })} />
          <button type="submit" className={primary} disabled={working || !nameValid}><Check className="size-3.5" />{t('browserPanel.recording.save')}</button>
          <button type="button" className={action} onClick={() => setEditing(null)}>{t('browserPanel.native.cancel')}</button>
          {!nameValid && <span className="w-full text-[11px] text-destructive">{t('browserPanel.recording.paramNameRule')}</span>}
        </form>
      )}
      {editable && !editing && (
        <div className="flex flex-wrap gap-1.5">
          {flagged ? (
            <>
              {/* A flagged value may be a secret: masking it is the proposed answer. */}
              <button type="button" className={primary} disabled={working} onClick={() => void apply([{ op: 'mask', step: step.n }])}><EyeOff className="size-3.5" />{t('browserPanel.recording.mask')}</button>
              <button type="button" className={action} disabled={working} onClick={() => void apply([{ op: 'unmask', step: step.n }])}>{t('browserPanel.recording.keep')}</button>
              {step.type === 'input' && <button type="button" className={action} disabled={working} onClick={() => setEditing({ step: step.n, kind: 'param', value: '' })}><Variable className="size-3.5" />{t('browserPanel.recording.param')}</button>}
            </>
          ) : (
            <>
              {maskable && <button type="button" className={action} disabled={working} onClick={() => void apply([{ op: 'mask', step: step.n }])}><EyeOff className="size-3.5" />{t('browserPanel.recording.mask')}</button>}
              {step.type === 'input' && !step.param && <button type="button" className={action} disabled={working} onClick={() => setEditing({ step: step.n, kind: 'param', value: '' })}><Variable className="size-3.5" />{t('browserPanel.recording.param')}</button>}
              <button type="button" className={action} disabled={working} onClick={() => setEditing({ step: step.n, kind: 'rename', value: step.name ?? '' })}><Pencil className="size-3.5" />{t('browserPanel.recording.rename')}</button>
            </>
          )}
          <button type="button" className={cn(action, 'text-destructive')} disabled={working} aria-label={t('browserPanel.recording.deleteStepLabel', { n: step.n })} onClick={() => void apply([{ op: 'drop', step: step.n }])}><Trash2 className="size-3.5" />{t('browserPanel.recording.deleteStep')}</button>
        </div>
      )}
    </li>
  );
}

type AgentRow = { name: string; browser_profile_id?: string | null; skills?: string[] };
type SkillRow = { id: string; title: string };

/**
 * After Learn: the conversion mission, then the skill it created. The daemon
 * records that skill on the recording (`learnedSkillId`, the one `browser-*`
 * skill the conversion mission may create): the card proposes exactly it, and
 * nothing while the recording names none.
 */
function LearnedCard({ meta }: { meta: BrowserRecordingMeta }) {
  const missionId = meta.learnMissionId;
  const [mission, setMission] = useState<MissionStatus | null>(null);
  const [skillId, setSkillId] = useState<string | null>(meta.learnedSkillId ?? null);
  /** The recording was re-read after the mission and still names no skill. */
  const [noSkill, setNoSkill] = useState(false);
  const [skill, setSkill] = useState<SkillRow | null>(null);
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [attaching, setAttaching] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const finished = !!skillId || (!!mission && (mission.turn_complete === true || FINISHED_MISSION.has(mission.status ?? '')));

  useEffect(() => {
    if (!missionId || finished) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () => {
      getJson<MissionStatus>(`/api/ui/missions/${encodeURIComponent(missionId)}?view=status`)
        .then((value) => { if (live) setMission(value); }, (err: Error) => { if (live) setError(err.message); })
        .finally(() => { if (live) timer = setTimeout(poll, 3000); });
    };
    poll();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [missionId, finished]);

  // The mission's turn is over: the recording now says which skill it created, if any.
  useEffect(() => {
    if (!finished || skillId) return;
    let live = true;
    browserRecordingApi.get(meta.id).then(({ recording }) => {
      if (!live) return;
      replaceBrowserRecording(recording.profileId, recording);
      setSkillId(recording.learnedSkillId ?? null);
      setNoSkill(!recording.learnedSkillId);
    }, (err: Error) => { if (live) setError(err.message); });
    return () => { live = false; };
  }, [finished, skillId, meta.id, round]);

  useEffect(() => {
    if (!skillId) return;
    let live = true;
    Promise.all([getJson<{ skills: SkillRow[] }>('/api/ui/skills'), getJson<{ agents: AgentRow[] }>('/api/ui/agents')])
      .then(([skillList, agentList]) => {
        if (!live) return;
        setSkill(skillList.skills.find((row) => row.id === skillId) ?? { id: skillId, title: skillId });
        setAgents(agentList.agents.filter((agent) => agent.browser_profile_id === meta.profileId));
      }, (err: Error) => { if (live) setError(err.message); });
    return () => { live = false; };
  }, [skillId, meta.profileId]);

  const attach = async (skill: string, agent: AgentRow) => {
    setAttaching(`${skill}:${agent.name}`); setError(null);
    const next = [...new Set([...(agent.skills ?? []), skill])];
    try {
      await getJson(`/api/ui/agents/${encodeURIComponent(agent.name)}/config`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ skills: next }),
      });
      setAgents((rows) => rows.map((row) => (row.name === agent.name ? { ...row, skills: next } : row)));
    } catch (err) { setError((err as Error).message); }
    finally { setAttaching(null); }
  };

  return (
    <section aria-label={t('browserPanel.recording.learnedHeading')} data-learned-card="" className="space-y-2 rounded-lg bg-muted/40 p-2 text-xs">
      <div className="flex items-center gap-2">
        <GraduationCap className="size-4 text-muted-foreground" />
        <p className="flex-1">{finished ? t('browserPanel.recording.learnedDone') : t('browserPanel.recording.learning')}</p>
        {!finished && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
        {missionId && <button type="button" className={action} onClick={() => { void openLearnMission(missionId).catch((err: Error) => setError(err.message)); }}><MessageSquare className="size-3.5" />{t('browserPanel.recording.openMission')}</button>}
      </div>
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {noSkill && !skillId && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <p className="flex-1">{t('browserPanel.recording.noSkillYet')}</p>
          <button type="button" className={action} onClick={() => setRound((value) => value + 1)}><RotateCw className="size-3.5" />{t('browserPanel.recording.refresh')}</button>
        </div>
      )}
      {skill && (
        <div data-skill={skill.id} className="space-y-1.5 rounded-md bg-background p-2">
          <p className="flex items-center gap-1.5 font-medium"><Puzzle className="size-3.5 text-muted-foreground" />{skill.title}<span className="font-normal text-muted-foreground">{skill.id}</span></p>
          {agents.length === 0
            ? <p className="text-muted-foreground">{t('browserPanel.recording.noAgentWithProfile')}</p>
            : (
              <div className="flex flex-wrap gap-1.5">
                {agents.map((agent) => {
                  const attached = agent.skills?.includes(skill.id) === true;
                  return (
                    <button key={agent.name} type="button" className={attached ? action : primary} disabled={attached || attaching !== null} onClick={() => void attach(skill.id, agent)}>
                      {attached ? <Check className="size-3.5" /> : attaching === `${skill.id}:${agent.name}` && <Loader2 className="size-3.5 animate-spin" />}
                      {attached ? t('browserPanel.recording.attached', { agent: agent.name }) : t('browserPanel.recording.attach', { agent: agent.name })}
                    </button>
                  );
                })}
              </div>
            )}
        </div>
      )}
    </section>
  );
}
