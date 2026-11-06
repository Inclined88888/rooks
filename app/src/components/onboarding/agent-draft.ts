/**
 * The agent step, pure (docs/ONBOARDING-AGENT.md): what the three creation
 * views edit (`AgentDraft`), the look the agent wears until someone styles it,
 * when "Create" opens, and what the creation writes to the daemon.
 *
 * The step itself (`steps/agent.tsx`) only draws this; keeping the decisions
 * here lets them be tested without a browser.
 */
import {
  defaultLookFor, ROLES,
  type AgentLook, type MascotMission, type MascotRole,
} from '@/components/mascot/agent-look';
import type { BackendCatalog, BackendName } from '@/lib/backends';
import type { AgentCreationView } from './onboarding-profile';
import { pick, type Random } from '@/components/mascot/random-look';

export type { Random } from '@/components/mascot/random-look';

/** In the switcher's order: the simplest first. */
export const AGENT_VIEWS: readonly AgentCreationView[] = ['templates', 'interview', 'sheet'];

/* ---------- Templates (beginner) ---------- */

/** The six ready-made profiles, and the missions each brings. */
export const TEMPLATES = {
  assist: ['mail', 'agenda'],
  dev: ['code'],
  watch: ['watch', 'research'],
  write: ['write'],
  research: ['research'],
  blank: [],
} as const satisfies Record<string, readonly MascotMission[]>;
export type TemplateId = keyof typeof TEMPLATES;
export const TEMPLATE_IDS = Object.keys(TEMPLATES) as TemplateId[];

/* ---------- Interview (automation) ---------- */

export const INTERVIEW_TOOLS = ['gmail', 'gcal', 'gdrive', 'slack', 'notion', 'telegram', 'github', 'browser', 'files', 'webhook'] as const;
export type InterviewTool = typeof INTERVIEW_TOOLS[number];
/** Picked for the person when they leave the first question: the tools their missions need. */
export const TOOLS_FOR: Readonly<Record<MascotMission, readonly InterviewTool[]>> = {
  mail: ['gmail'], agenda: ['gcal'], code: ['github', 'files'], watch: ['browser'], write: ['gdrive', 'notion'], research: ['browser'],
};
export const TRIGGERS = ['chat', 'daily', 'mail', 'hook'] as const;
export type InterviewTrigger = typeof TRIGGERS[number];
export const AUTONOMY = ['ask', 'report', 'silent'] as const;
export type Autonomy = typeof AUTONOMY[number];
export const NOTIFY = ['timon', 'telegram', 'email'] as const;
export type NotifyChannel = typeof NOTIFY[number];
export const INTERVIEW_QUESTIONS = 5;

/* ---------- Sheet (developer) ---------- */

/**
 * The sheet's "main line of work", the pilot first. It is never the agent's
 * `config.role`: the main agent stays `orchestrator` whatever is picked here,
 * or the daemon drops its pilot preamble and no longer seats it
 * (`chooseMainAgent`, `mainSeatCandidates`). The pick only styles the agent
 * and adds one directive line (docs/ONBOARDING-AGENT.md).
 */
export const DEV_ROLES: readonly MascotRole[] = ['orchestrator', ...ROLES.filter((r) => r !== 'orchestrator')];
/** The CLI's own permission modes, written as they are. */
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'] as const;
export type PermissionMode = typeof PERMISSION_MODES[number];
export const DEV_TABS = ['base', 'engine', 'perms', 'tools'] as const;
export type DevTab = typeof DEV_TABS[number];

/**
 * What "before an important action" means for the agent's permission mode:
 * asking keeps every sensitive tool behind a card; acting lets Timon's
 * classifier decide, a card only when unsure. "Act silently" is the same
 * mode — the silence is in what it reports, never a bypass of the checks.
 */
export const AUTONOMY_PERMISSION: Readonly<Record<Autonomy, PermissionMode>> = { ask: 'default', report: 'auto', silent: 'auto' };

/* ---------- The draft ---------- */

export type ModelChoice = { backend: BackendName; model: string };

export type AgentDraft = {
  name: string;
  /** The name was drawn, not typed: picking a template may draw another one. */
  nameAuto: boolean;
  /** The look picked by hand ("Random", "Customise"); `null` while the job decides it. */
  customLook: AgentLook | null;
  template: TemplateId | null;
  missions: MascotMission[];
  other: string;
  tools: InterviewTool[];
  triggers: InterviewTrigger[];
  /** `HH:MM` of the daily start. */
  at: string;
  autonomy: Autonomy;
  notify: NotifyChannel[];
  /** The interview's current question, 1 to 5; 6 once answered. */
  question: number;
  tab: DevTab;
  role: MascotRole;
  folder: string;
  model: ModelChoice | null;
  permission: PermissionMode;
  skills: string[];
  mcp: string[];
  rules: string;
};

export function initialDraft(): AgentDraft {
  return {
    name: '', nameAuto: false, customLook: null,
    template: null, missions: [], other: '',
    tools: [], triggers: ['chat'], at: '08:00', autonomy: 'ask', notify: ['timon'], question: 1,
    tab: 'base', role: 'orchestrator', folder: '', model: null, permission: 'acceptEdits', skills: [], mcp: [], rules: '',
  };
}

/** The missions the agent gets in this view (none in the sheet: a developer's agent has a role). */
export function missionsOf(view: AgentCreationView, draft: AgentDraft): MascotMission[] {
  if (view === 'templates') return draft.template ? [...TEMPLATES[draft.template]] : [];
  if (view === 'interview') return draft.missions;
  return [];
}

/**
 * The look on the identity card: the one picked by hand once someone styled
 * the agent, else the job's (`defaultLookFor`) — its role in the sheet, its
 * missions elsewhere, accessory included.
 */
export function lookOf(view: AgentCreationView, draft: AgentDraft): AgentLook {
  if (draft.customLook) return draft.customLook;
  return view === 'sheet' ? defaultLookFor(draft.role) : defaultLookFor(missionsOf(view, draft));
}

/** The look a template's tile wears: its missions', the blank one asleep. */
export function templateLook(id: TemplateId): AgentLook {
  const look = defaultLookFor([...TEMPLATES[id]]);
  return id === 'blank' ? { ...look, shape: 'round', color: '#a8826a', eyes: 'sleepy' } : look;
}

/** "Create" opens once the view has what it needs; a missing name is drawn at creation. */
export function readyToCreate(view: AgentCreationView, draft: AgentDraft): boolean {
  if (view === 'templates') return draft.template !== null;
  if (view === 'interview') return draft.question > INTERVIEW_QUESTIONS;
  return true;
}

export function toggled<T>(list: readonly T[], item: T): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

/** Leaving the first question adds the tools its missions need, as the mockup's interview does. */
export function nextQuestion(draft: AgentDraft): AgentDraft {
  const tools = draft.question === 1
    ? [...new Set([...draft.tools, ...draft.missions.flatMap((m) => TOOLS_FOR[m])])]
    : draft.tools;
  return { ...draft, tools, question: Math.min(draft.question + 1, INTERVIEW_QUESTIONS + 1) };
}

/* ---------- Draws ---------- */

/** A name from the language's pool (`onboarding.agent.names`), never the one shown. */
export function randomName(pool: readonly string[], avoid: string, rng: Random = Math.random): string {
  const names = pool.map((n) => n.trim()).filter(Boolean);
  if (names.length === 0) return avoid;
  const others = names.filter((n) => n !== avoid);
  return pick(others.length ? others : names, rng);
}

/** `onboarding.agent.names` is one comma-separated line per language. */
export function namePool(line: string): string[] {
  return line.split(',').map((n) => n.trim()).filter(Boolean);
}

/* ---------- Models (from the daemon's catalogue, never a list here) ---------- */

export type ModelOption = ModelChoice & { label: string; vendor: string; brand?: string; icon?: string };

/**
 * The models of every provider that can run now — no account to sign in again
 * or out of quota, no provider known to be signed out. Account instances
 * (`claude@<id>`) are left out of a list (their models are their backend's,
 * the same rows twice) but found with `accounts`: the sheet's picker offers
 * them, and the card must name what was picked.
 */
export function modelOptions(catalog: BackendCatalog, { accounts = false }: { accounts?: boolean } = {}): ModelOption[] {
  return catalog.backends
    .filter((b) => (accounts || (!b.instanceOf && !b.id.includes('@'))) && b.signedIn !== false
      && b.account?.state !== 'reauth' && b.account?.state !== 'cooldown')
    .flatMap((b) => b.models.map((m) => ({
      backend: b.id, model: m.slug, label: m.label, vendor: b.vendor ?? b.label,
      ...(m.brand ?? b.brand ? { brand: m.brand ?? b.brand } : {}),
      ...(m.icon ?? b.icon ? { icon: m.icon ?? b.icon } : {}),
    })));
}

/**
 * The model the card shows: the one picked in the sheet, else the agent's own,
 * else the catalogue's default. `null` while nothing is known.
 */
export function shownModel(catalog: BackendCatalog, picked: ModelChoice | null, agent: Partial<ModelChoice> | null): ModelOption | null {
  const options = modelOptions(catalog);
  const every = modelOptions(catalog, { accounts: true });
  const find = (c: Partial<ModelChoice> | null | undefined): ModelOption | undefined => (c?.backend && c.model
    ? every.find((o) => o.backend === c.backend && o.model === c.model)
    : undefined);
  const fallbackBackend = agent?.backend ?? catalog.defaultBackend;
  const backendDefault = catalog.backends.find((b) => b.id === fallbackBackend)?.defaultModel ?? null;
  return find(picked) ?? find(agent) ?? find({ backend: fallbackBackend, model: backendDefault ?? undefined }) ?? options[0] ?? null;
}

/* ---------- What the creation writes ---------- */

/** English: they feed the agent's system prompt, whatever the interface language. */
const MISSION_BRIEF: Readonly<Record<MascotMission, string>> = {
  mail: 'read and sort their email',
  agenda: 'check and fill their calendar',
  code: 'work in their Git repositories',
  watch: 'run a news watch every morning',
  write: 'write documents and messages',
  research: 'search and compare on the web',
};
const TOOL_NAMES: Readonly<Record<InterviewTool, string>> = {
  gmail: 'Gmail', gcal: 'Google Calendar', gdrive: 'Google Drive', slack: 'Slack', notion: 'Notion',
  telegram: 'Telegram', github: 'GitHub', browser: 'the built-in browser', files: 'local files', webhook: 'webhooks',
};
const AUTONOMY_BRIEF: Readonly<Record<Autonomy, string>> = {
  ask: 'ask the user first',
  report: 'act, then tell the user what you did',
  silent: 'act without reporting, for safe routine work only',
};
const NOTIFY_BRIEF: Readonly<Record<NotifyChannel, string>> = { timon: 'in Timon', telegram: 'on Telegram', email: 'by email' };

function triggerBrief(trigger: InterviewTrigger, at: string): string {
  if (trigger === 'chat') return 'when the user talks to you';
  if (trigger === 'daily') return `every day at ${at}`;
  if (trigger === 'mail') return 'on every new email';
  return 'on an event (webhook)';
}

/** English, like the missions: the line the sheet's pick adds. The pilot needs none, it is the seat's own job. */
const ROLE_BRIEF: Readonly<Record<Exclude<MascotRole, 'orchestrator'>, string>> = {
  code: 'writing and changing code',
  review: 'reviewing changes before they land',
  research: 'searching, reading and comparing sources',
  chore: 'operations and upkeep: builds, dependencies, housekeeping',
};

/** `null` for the pilot. Says the seat does not change, so the agent never reads it as a demotion. */
export function roleLine(role: MascotRole): string | null {
  if (role === 'orchestrator') return null;
  return `Main line of work: ${ROLE_BRIEF[role]}. You remain the main agent and pilot: delegate what falls outside it.`;
}

function missionLine(missions: readonly MascotMission[], other: string): string | null {
  const parts = [...missions.map((m) => MISSION_BRIEF[m]), other.trim()].filter(Boolean);
  return parts.length ? `What the user expects from you: ${parts.join('; ')}.` : null;
}

/** The agent's extra directives, from what the view asked. Empty: nothing to write. */
export function directivesOf(view: AgentCreationView, draft: AgentDraft): string {
  if (view === 'sheet') return [roleLine(draft.role), draft.rules.trim()].filter(Boolean).join('\n');
  const missions = missionsOf(view, draft);
  if (view === 'templates') return missionLine(missions, '') ?? '';
  const lines = [
    missionLine(missions, draft.other),
    draft.tools.length ? `Tools the user allowed: ${draft.tools.map((tool) => TOOL_NAMES[tool]).join(', ')}.` : null,
    draft.triggers.length ? `When to start: ${draft.triggers.map((tr) => triggerBrief(tr, draft.at)).join('; ')}.` : null,
    `Before an important action: ${AUTONOMY_BRIEF[draft.autonomy]}.`,
    draft.notify.length ? `Where to let the user know: ${draft.notify.map((n) => NOTIFY_BRIEF[n]).join(', ')}.` : null,
  ].filter((line): line is string => line !== null);
  return ['Set up with the user during onboarding:', ...lines].join('\n');
}

/**
 * The config PATCH (`PATCH /api/ui/agents/:name/config`): the look always;
 * the model, permission mode, skills, MCP servers and folder from the sheet; the permission mode from the interview's autonomy; the directives
 * from whatever the view asked.
 *
 * Skills and MCP servers are whole sets on the daemon (`skills` replaces the
 * agent's attachments): the ones the sheet did not show are kept as they are,
 * so the creation never takes away a skill the product attached itself.
 *
 * No `role`, by type: the daemon seats the main agent as `orchestrator`
 * (`applyMainAgentName`) and this PATCH, sent right after, must not undo it.
 */
export type AgentConfigPatch = {
  look: AgentLook;
  backend?: BackendName;
  model?: string;
  permission_mode?: PermissionMode;
  skills?: string[];
  mcp_servers?: string[];
  directives?: string;
  cwd?: string;
};

export type CreationContext = {
  /** The agent's skills and MCP servers before the step. */
  current: { skills: readonly string[]; mcp_servers: readonly string[] };
  /** The ids the sheet listed: only those can have been unchecked. */
  shownSkills: readonly string[];
  shownMcp: readonly string[];
};

const keepHidden = (current: readonly string[], shown: readonly string[], checked: readonly string[]): string[] => (
  [...new Set([...current.filter((id) => !shown.includes(id)), ...checked])]
);

export function creationPatch(view: AgentCreationView, draft: AgentDraft, ctx: CreationContext): AgentConfigPatch {
  const patch: AgentConfigPatch = { look: lookOf(view, draft) };
  const directives = directivesOf(view, draft);
  if (directives) patch.directives = directives;
  if (view === 'interview') patch.permission_mode = AUTONOMY_PERMISSION[draft.autonomy];
  if (view !== 'sheet') return patch;
  patch.permission_mode = draft.permission;
  if (draft.model) { patch.backend = draft.model.backend; patch.model = draft.model.model; }
  if (draft.folder.trim()) patch.cwd = draft.folder.trim();
  patch.skills = keepHidden(ctx.current.skills, ctx.shownSkills, draft.skills);
  patch.mcp_servers = keepHidden(ctx.current.mcp_servers, ctx.shownMcp, draft.mcp);
  return patch;
}

/** The name the agent is created under: the one typed, else a drawn one. */
export function creationName(draft: AgentDraft, pool: readonly string[], rng: Random = Math.random): string {
  return draft.name.trim() || randomName(pool, '', rng);
}

