'use client';

/**
 * "Bring your agent to life" (mockup screen `agent`, docs/ONBOARDING-AGENT.md).
 * One shell for every profile: the identity card on the left, the profile's
 * view on the right, the button always in the same place under it. The view
 * follows the profile chosen just before (`agentViewFor`); a switcher in the
 * corner opens the two others, a star on the recommended one.
 *
 * The creation writes the main agent for real: its name (the seed is renamed
 * and recorded as the main agent), then its look, role, model, permission
 * mode, skills, MCP servers and directives in one config PATCH. "Discover Rooks"
 * follows (`steps/discover.tsx`), then the TIMs page, where the agent, named,
 * opens its welcome conversation.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { ArrowRight, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useDirectoryPicker } from '@/components/directory-browser';
import { isAgentLook, normalizeAgentLook } from '@/components/mascot/agent-look';
import { usePrefersReducedMotion } from '@/components/mascot/agent-mascot';
import { useBackendCatalog } from '@/lib/backends';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  AGENT_VIEWS, creationName, creationPatch, initialDraft, INTERVIEW_QUESTIONS, missionsOf, namePool,
  randomName, readyToCreate, shownModel, TEMPLATES, type AgentDraft, type TemplateId,
} from '../agent-draft';
import { createMainAgent, loadMainAgent, loadSheetCatalogs, type MainAgentState, type SheetCatalogs } from '../agent-create';
import { IdentityCard } from '../agent/identity-card';
import { InterviewView, interviewAnswer, triggerLabel } from '../agent/interview-view';
import { Capabilities, SummaryRow, type UpdateDraft } from '../agent/parts';
import { SheetView } from '../agent/sheet-view';
import { TemplatesView } from '../agent/templates-view';
import { useOnboarding, useOnboardingBack } from '../onboarding-context';
import { agentViewFor, useOnboardingProfile, type AgentCreationView } from '../onboarding-profile';

/** Brief pause before Discover so the create feedback is visible. */
const LEAVE_MS = 320;

const SEED_NAMES = new Set(['_main', 'rooks.main']);

export function AgentStep(): ReactElement {
  const { next } = useOnboarding();
  const { status, profile, reload } = useOnboardingProfile();
  const reduced = usePrefersReducedMotion();
  const catalog = useBackendCatalog();
  const directory = useDirectoryPicker();

  const [chosenView, setChosenView] = useState<AgentCreationView | null>(null);
  const recommended = agentViewFor(profile);
  const view = chosenView ?? recommended;
  const profileKnown = profile !== null || status === 'ready' || status === 'error';

  const [draft, setDraft] = useState<AgentDraft>(initialDraft);
  const update = useCallback<UpdateDraft>((change) => setDraft(change), []);
  const [agent, setAgent] = useState<MainAgentState | null>(null);
  const [catalogs, setCatalogs] = useState<SheetCatalogs | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const leaving = useRef<number | null>(null);
  const pool = namePool(t('onboarding.agent.names'));
  const poolRef = useRef(pool);
  poolRef.current = pool;

  // The agent as it stands: a name already given (a step back), a look already styled.
  useEffect(() => {
    let live = true;
    void loadMainAgent().then((state) => {
      if (!live) return;
      setAgent(state);
      setDraft((d) => {
        const named = state.named && state.name && !SEED_NAMES.has(state.name.toLowerCase()) ? state.name : null;
        const name = d.name || named || randomName(poolRef.current, '');
        return {
          ...d,
          name,
          nameAuto: d.name ? d.nameAuto : !named,
          customLook: d.customLook ?? (isAgentLook(state.look) ? normalizeAgentLook(state.look) : null),
        };
      });
    });
    return () => { live = false; };
  }, []);

  // The sheet's lists, read once it is shown; what the agent already had starts checked.
  useEffect(() => {
    if (view !== 'sheet' || catalogs) return;
    let live = true;
    void loadSheetCatalogs().then((lists) => { if (live) setCatalogs(lists); });
    return () => { live = false; };
  }, [view, catalogs]);
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !catalogs || !agent) return;
    seeded.current = true;
    setDraft((d) => ({
      ...d,
      skills: agent.skills.filter((id) => catalogs.skills.some((s) => s.id === id)),
      mcp: agent.mcpServers.filter((id) => catalogs.mcp.some((s) => s.id === id)),
    }));
  }, [catalogs, agent]);

  useEffect(() => () => { if (leaving.current !== null) window.clearTimeout(leaving.current); }, []);

  // "Back" walks the interview first, then leaves the step.
  useOnboardingBack(() => {
    if (view === 'interview' && draft.question > 1) { update((d) => ({ ...d, question: d.question - 1 })); return true; }
    return false;
  });

  const model = shownModel(catalog, draft.model, agent ? { backend: agent.backend ?? undefined, model: agent.model ?? undefined } : null);
  const ready = readyToCreate(view, draft) && !busy;

  const pickTemplate = (id: TemplateId): void => {
    setDraft((d) => (d.nameAuto || !d.name.trim()
      ? { ...d, template: id, name: randomName(pool, d.name), nameAuto: true }
      : { ...d, template: id }));
  };

  const pickFolder = async (): Promise<void> => {
    const picked = await directory.pick(draft.folder);
    if (picked.status === 'chosen') update((d) => ({ ...d, folder: picked.path }));
  };

  const create = async (): Promise<void> => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    const name = creationName(draft, pool);
    // The button says whose life starts, a drawn name included.
    setDraft((d) => ({ ...d, name }));
    const patch = creationPatch(view, draft, {
      current: { skills: agent?.skills ?? [], mcp_servers: agent?.mcpServers ?? [] },
      shownSkills: catalogs?.skills.map((s) => s.id) ?? [],
      shownMcp: catalogs?.mcp.map((s) => s.id) ?? [],
    });
    const result = await createMainAgent(name, patch);
    if (!result.ok) {
      setError(result.stage === 'name' ? t(`mainAgentSetup.${result.error}`) : t('onboarding.agent.configFailed', { name }));
      setBusy(false);
      return;
    }
    leaving.current = window.setTimeout(next, reduced ? 0 : LEAVE_MS);
  };

  const shownName = draft.name.trim();
  const roleLabel = view === 'templates'
    ? (draft.template ? { label: t(`onboarding.agent.templates.${draft.template}.title`) } : { label: t('onboarding.agent.templates.none'), empty: true })
    : view === 'interview'
      ? { label: [t('onboarding.agent.interview.role'), draft.missions[0] ? t(`onboarding.agent.mission.${draft.missions[0]}`) : null].filter(Boolean).join(' · ') }
      : { label: t(`onboarding.agent.sheet.role.${draft.role}.title`) };

  const right: ReactNode = !profileKnown
    ? (
      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden />{t('onboarding.agent.loading')}
      </p>
    )
    : view === 'templates'
      ? <TemplatesView picked={draft.template} onPick={pickTemplate} />
      : view === 'interview'
        ? <InterviewView draft={draft} update={update} />
        : (
          <SheetView
            draft={draft}
            update={update}
            shownModel={model}
            skills={catalogs?.skills ?? []}
            mcp={catalogs?.mcp ?? []}
            onPickFolder={() => { void pickFolder(); }}
          />
        );

  return (
    <section
      data-onboarding-step="agent"
      data-agent-view={view}
      className="flex max-h-full w-full min-w-0 max-w-[944px] flex-col overflow-y-auto px-3 pb-10 pt-1 sm:px-6 sm:pb-12"
    >
      <ViewSwitcher view={view} recommended={recommended} onPick={(v) => { setChosenView(v); setError(null); }} />
      {/* Timon grid restored; lg breakpoint so 1280×800 keeps two columns without crushing. */}
      <div className="grid w-full grid-cols-1 items-start gap-6 pt-2 sm:gap-[30px] lg:grid-cols-[minmax(240px,330px)_minmax(0,500px)] lg:justify-center">
        <IdentityCard
          name={draft.name}
          onName={(name) => update((d) => ({ ...d, name, nameAuto: false }))}
          onRollName={() => { update((d) => ({ ...d, name: randomName(pool, d.name), nameAuto: false })); }}
          role={roleLabel}
          model={model}
          disabled={busy}
          summary={<Summary view={view} draft={draft} />}
        />
        <div className="flex min-w-0 flex-col text-left">
          <header className="mb-4 mt-0.5 sm:mb-[18px]">
            <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.025em] sm:text-[26px]">
              {t(`onboarding.agent.${view}.title`)}
            </h1>
            <p className="mt-1.5 text-[13.5px] leading-relaxed text-muted-foreground sm:text-[15px]">
              {t(`onboarding.agent.${view}.subtitle`)}
            </p>
            {/* Intentional quiet note when profile is unavailable — not an error toast. */}
            {status === 'ready' && profile === null && view === 'templates' && (
              <p data-profile-fallback className="mt-2 text-xs text-muted-foreground">
                {t('onboarding.agent.profileFallback')}
              </p>
            )}
          </header>
          {right}
          <div className="sticky bottom-0 mt-1.5 bg-gradient-to-b from-transparent to-background to-45% pb-1.5 pt-[18px] text-center">
            <Button type="button" size="lg" className="w-full" data-create disabled={!ready} onClick={() => { void create(); }}>
              {busy
                ? <><Loader2 className="mr-2 size-4 animate-spin" aria-hidden />{t('onboarding.agent.creating', { name: shownName })}</>
                : <>{shownName ? t('onboarding.agent.create', { name: shownName }) : t('onboarding.agent.createNoName')}<ArrowRight className="ml-2 size-4" aria-hidden /></>}
            </Button>
            <p className={cn('mt-2 min-h-4 text-xs', error ? 'text-destructive' : 'text-muted-foreground')} role={error ? 'alert' : undefined} data-create-hint>
              {error ?? (readyToCreate(view, draft) ? '' : hintFor(view, draft))}
            </p>
          </div>
        </div>
      </div>
      {directory.dialog}
    </section>
  );
}

function hintFor(view: AgentCreationView, draft: AgentDraft): string {
  if (view === 'templates') return t('onboarding.agent.templates.hint');
  if (view === 'interview') {
    return t('onboarding.agent.interview.hint', { current: Math.min(draft.question, INTERVIEW_QUESTIONS), total: INTERVIEW_QUESTIONS });
  }
  return '';
}

function Summary({ view, draft }: { view: AgentCreationView; draft: AgentDraft }): ReactElement {
  if (view === 'templates') {
    return draft.template
      ? <Capabilities missions={[...TEMPLATES[draft.template]]} />
      : <p className="text-xs text-muted-foreground">{t('onboarding.agent.templates.empty')}</p>;
  }
  if (view === 'interview') {
    const missions = missionsOf(view, draft);
    return (
      <>
        {(missions.length > 0 || draft.other.trim()) && <Capabilities missions={missions} />}
        {draft.tools.length > 0 && <SummaryRow label={t('onboarding.agent.interview.sum.tools')}>{interviewAnswer(2, draft)}</SummaryRow>}
        <SummaryRow label={t('onboarding.agent.interview.sum.starts')}>{draft.triggers.map((tr) => triggerLabel(tr, draft.at)).join(', ')}</SummaryRow>
        {draft.question > 4 && <SummaryRow label={t('onboarding.agent.interview.sum.autonomy')}>{interviewAnswer(4, draft)}</SummaryRow>}
        {draft.question > 5 && <SummaryRow label={t('onboarding.agent.interview.sum.notifies')}>{interviewAnswer(5, draft)}</SummaryRow>}
      </>
    );
  }
  return (
    <>
      <SummaryRow label={t('onboarding.agent.sheet.sum.project')}>
        {draft.folder || <span className="font-normal text-muted-foreground">{t('onboarding.agent.sheet.sum.toChoose')}</span>}
      </SummaryRow>
      <SummaryRow label={t('onboarding.agent.sheet.sum.permissions')}>
        {/* code-font: the CLI's permission mode id */}
        <code className="font-mono text-[12px]">{draft.permission}</code>
      </SummaryRow>
      <SummaryRow label={t('onboarding.agent.sheet.sum.skills')}><span className="tabular-nums">{draft.skills.length}</span></SummaryRow>
      <SummaryRow label={t('onboarding.agent.sheet.sum.mcp')}>{draft.mcp.join(', ') || '—'}</SummaryRow>
    </>
  );
}

function ViewSwitcher({ view, recommended, onPick }: {
  view: AgentCreationView; recommended: AgentCreationView; onPick: (view: AgentCreationView) => void;
}): ReactElement {
  return (
    <div
      role="radiogroup"
      aria-label={t('onboarding.agent.views.label')}
      data-view-switcher
      className="mb-3 flex max-w-full flex-wrap items-center gap-1 self-center rounded-lg border border-border bg-card p-1"
    >
      <span className="pl-2 pr-1.5 text-[11.5px] text-muted-foreground">{t('onboarding.agent.views.label')}</span>
      {AGENT_VIEWS.map((v) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={v === view}
          data-view={v}
          data-recommended={v === recommended ? 'true' : undefined}
          title={v === recommended ? t('onboarding.agent.views.recommended') : undefined}
          onClick={() => onPick(v)}
          className={cn(
            'inline-flex items-center rounded-md px-2.5 py-1.5 text-[12.5px] transition-colors',
            v === view ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
        >
          {t(`onboarding.agent.views.${v}`)}
          {v === recommended && <span className="sr-only">{t('onboarding.agent.views.recommended')}</span>}
        </button>
      ))}
    </div>
  );
}
