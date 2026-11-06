/**
 * Triggers page model (TODO #216): the shapes the daemon's `/api/triggers`
 * answers with, the three tabs, and the editor draft ↔ API body conversion.
 *
 * Kept free of React so the conversions are tested on their own. The daemon
 * validates everything again with zod; this side only catches what a form can
 * get wrong before a round trip, and keeps what it cannot show.
 */

/** Kept here, not with the page: `routines.tsx` reads it at registration and
 *  must not load the page to do so. */
export const TRIGGERS_MODULE = '@timon/triggers';
export const TRIGGERS_ROUTE = '/triggers';
/** The page's former address, kept so links and bookmarks still land. */
export const LEGACY_ROUTINES_ROUTE = '/routines';

export const TRIGGER_TABS = ['routines', 'webhooks', 'events'] as const;
export type TriggerTab = (typeof TRIGGER_TABS)[number];

export const TRIGGER_SOURCES = ['schedule', 'webhook', 'event'] as const;
export type TriggerSource = (typeof TRIGGER_SOURCES)[number];

export const TAB_SOURCE: Record<TriggerTab, TriggerSource> = {
  routines: 'schedule',
  webhooks: 'webhook',
  events: 'event',
};

export const AUTH_SCHEMES = ['github', 'gitlab', 'standard', 'generic', 'none'] as const;
export type AuthScheme = (typeof AUTH_SCHEMES)[number];

export const EVENT_KINDS = ['task_done', 'task_blocked', 'mission_complete', 'agent_message', 'notification', 'todo_done', 'todo_resolved'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const TASK_TYPES = ['code', 'review', 'merge', 'research', 'doc', 'chore'] as const;
export const URGENCIES = ['critical', 'bug', 'minor', 'idea'] as const;
export const ACTION_TYPES = ['todo', 'task', 'notify', 'workflow', 'webhook', 'script'] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export const FILTER_OPS = ['equals', 'not_equals', 'contains', 'in', 'regex', 'exists', 'missing'] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

/** Mirrors the daemon's `SLUG_RE`. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** Mirrors the daemon's `PATH_RE`. */
export const PATH_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)*$/;
export const MAX_ACTIONS = 5;

type Scalar = string | number | boolean | null;

export type FilterLeaf =
  | { op: 'exists' | 'missing'; path: string }
  | { op: 'equals' | 'not_equals'; path: string; value: Scalar }
  | { op: 'contains'; path: string; value: string | number | boolean }
  | { op: 'in'; path: string; values: Scalar[] }
  | { op: 'regex'; path: string; pattern: string; flags?: '' | 'i' };

export type Filter = FilterLeaf | { all: Filter[] } | { any: Filter[] } | { not: Filter };

export type TodoAction = { type: 'todo'; text: string; notes?: string; project?: string; urgency?: string };
export type TaskAction = {
  type: 'task'; agent: string; prompt: string; title?: string; task_type?: string;
  project?: string | null; priority?: number; raw?: boolean; silent_return?: boolean;
};
export type NotifyAction = { type: 'notify'; title: string; body?: string; level?: 'report' | 'alert'; urgent?: boolean };
/** Offered only while the Workflows module runs; it starts the workflow at an entry node. */
export type WorkflowAction = { type: 'workflow'; workflow: string; node: string };
/** POSTs the payload to an https URL, signed with the trigger's outbound secret. */
export type WebhookAction = { type: 'webhook'; url: string };
/** Runs a program on the host without an agent; needs `scripts:run`, never granted to an agent. */
export type ScriptAction = {
  type: 'script'; command: string; args?: string[]; cwd: string; env?: string[];
  timeout_s?: number; overlap?: 'skip' | 'allow'; notify_on_failure?: boolean;
};
export type TriggerAction = TodoAction | TaskAction | NotifyAction | WorkflowAction | WebhookAction | ScriptAction;
/** Mirrors the daemon's `SECRET_NAME_RE` and `SCRIPT_MAX_TIMEOUT_S`. */
export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
export const SCRIPT_MAX_TIMEOUT_S = 3600;

export type Coalesce = { key: string; quiet_ms: number; max_ms?: number };
export type ScheduleConfig = { cron: string; tz?: string };
export type WebhookConfig = { auth: AuthScheme; rate_limit?: number; coalesce?: Coalesce };
export type EventConfig = { event: EventKind; rate_limit?: number; coalesce?: Coalesce };

/** `publicTrigger` of the daemon: everything but the secret. */
export type TriggerPublic = {
  id: string;
  name: string;
  slug: string | null;
  source: TriggerSource;
  enabled: boolean;
  config: ScheduleConfig | WebhookConfig | EventConfig | null;
  filter: Filter | null;
  actions: TriggerAction[] | null;
  created_by: string;
  creator_agent: string | null;
  has_secret: boolean;
  /** Signs what its `webhook` actions send; absent on an older daemon. */
  has_outbound_secret?: boolean;
  url: string | null;
  last_run_at: number | null;
  next_run_at: number | null;
  created_at: number;
  updated_at: number;
};

export const DELIVERY_STATUSES = ['received', 'ignored', 'duplicate', 'coalesced', 'error', 'rejected', 'test'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export type ActionOutcome =
  | { type: ActionType; ok: true; id: string | number | null; preview?: Record<string, unknown> }
  | { type: ActionType; ok: false; error: string };

export type Delivery = {
  id: number;
  at: number;
  status: DeliveryStatus;
  reason: string | null;
  delivery_key: string | null;
  excerpt: string | null;
  /** The outcomes of a call, or — keyed `script:<run id>` — how a script run ended. */
  result: ActionOutcome[] | ScriptRun | null;
};

export type ScriptRun = {
  type: 'script'; run_id: string; code: number | null; signal: string | null; timed_out: boolean;
  duration_ms: number; stdout_tail: string; stderr_tail: string;
};

export function isScriptRun(value: unknown): value is ScriptRun {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && (value as { type?: unknown }).type === 'script';
}

// ── tabs ─────────────────────────────────────────────────────────────────────

export function isTriggerTab(value: unknown): value is TriggerTab {
  return typeof value === 'string' && (TRIGGER_TABS as readonly string[]).includes(value);
}

/** The tab a `?tab=` asks for, if it is shown; the first shown one otherwise. */
export function tabFromSearch(search: string, available: readonly TriggerTab[]): TriggerTab | null {
  const asked = new URLSearchParams(search).get('tab');
  if (isTriggerTab(asked) && available.includes(asked)) return asked;
  return available[0] ?? null;
}

export function tabHref(tab: TriggerTab): string {
  return `${TRIGGERS_ROUTE}?tab=${tab}`;
}

/** Which tabs make sense: routines need either module, the others `triggers`. */
export function availableTabs(modules: { routines: boolean; triggers: boolean }): TriggerTab[] {
  const tabs: TriggerTab[] = [];
  if (modules.routines || modules.triggers) tabs.push('routines');
  if (modules.triggers) tabs.push('webhooks', 'events');
  return tabs;
}

/** Full address of a webhook, on the origin the page is served from. */
export function hookUrl(trigger: Pick<TriggerPublic, 'url'>, origin: string): string | null {
  return trigger.url ? new URL(trigger.url, origin).href : null;
}

// ── editor draft ─────────────────────────────────────────────────────────────

export type ConditionDraft = { op: FilterOp; path: string; value: string; caseInsensitive: boolean };

export type FilterDraft = {
  /** `json` holds what the simple form cannot show (`not`, nesting). */
  mode: 'none' | 'simple' | 'json';
  combine: 'all' | 'any';
  conditions: ConditionDraft[];
  json: string;
};

export type ActionDraft = {
  type: ActionType;
  // todo
  text: string; notes: string; project: string; urgency: string;
  // task
  agent: string; prompt: string; title: string; taskType: string; priority: string;
  /** Kept as found: a prompt saved verbatim stays verbatim. */
  raw?: boolean;
  /** The task's work return never goes up to the orchestrator. */
  silentReturn: boolean;
  // notify
  notifyTitle: string; body: string; level: 'report' | 'alert'; urgent: boolean;
  // workflow
  workflow: string; node: string;
  // webhook
  url: string;
  // script — `scriptArgs` one argument per line, `scriptEnv` comma-separated secret names
  command: string; scriptArgs: string; cwd: string; scriptEnv: string; timeoutS: string;
  allowOverlap: boolean; notifyOnFailure: boolean;
};

export type TriggerDraft = {
  source: TriggerSource;
  name: string;
  enabled: boolean;
  cron: string;
  tz: string;
  slug: string;
  auth: AuthScheme;
  event: EventKind;
  rateLimit: string;
  coalesceKey: string;
  /** Seconds, decimals allowed: the daemon counts milliseconds. */
  coalesceQuietS: string;
  coalesceMaxS: string;
  filter: FilterDraft;
  actions: ActionDraft[];
};

export function emptyAction(type: ActionType, agent = ''): ActionDraft {
  return {
    type, text: '', notes: '', project: '', urgency: '',
    agent, prompt: '', title: '', taskType: 'chore', priority: '', silentReturn: false,
    notifyTitle: '', body: '', level: 'report', urgent: false,
    workflow: '', node: '', url: '',
    command: '', scriptArgs: '', cwd: '', scriptEnv: '', timeoutS: '', allowOverlap: false, notifyOnFailure: true,
  };
}

export function emptyCondition(): ConditionDraft {
  return { op: 'equals', path: '', value: '', caseInsensitive: false };
}

function isLeaf(filter: Filter): filter is FilterLeaf {
  return 'op' in filter;
}

function leafToCondition(leaf: FilterLeaf): ConditionDraft {
  switch (leaf.op) {
    case 'exists': case 'missing': return { op: leaf.op, path: leaf.path, value: '', caseInsensitive: false };
    case 'in': return { op: 'in', path: leaf.path, value: leaf.values.map((v) => String(v)).join(', '), caseInsensitive: false };
    case 'regex': return { op: 'regex', path: leaf.path, value: leaf.pattern, caseInsensitive: leaf.flags === 'i' };
    default: return { op: leaf.op, path: leaf.path, value: leaf.value === null ? '' : String(leaf.value), caseInsensitive: false };
  }
}

/** Structural equality of two JSON values, key order aside. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  return ka.every((key) => Object.hasOwn(rb, key) && sameJson(ra[key], rb[key]));
}

/**
 * The simple form only holds trimmed strings, so it cannot carry `null`, a
 * number, a comma inside an `in` value or a blank one. A filter is shown there
 * only if saving the form untouched gives it back exactly; otherwise it opens
 * as JSON, because an edit of the name alone must not change which payloads
 * fire the actions.
 */
export function filterToDraft(filter: Filter | null | undefined): FilterDraft {
  const base: FilterDraft = { mode: 'none', combine: 'all', conditions: [emptyCondition()], json: '' };
  if (!filter) return base;
  const json = JSON.stringify(filter, null, 2);
  let simple: FilterDraft | null = null;
  if (isLeaf(filter)) simple = { ...base, mode: 'simple', conditions: [leafToCondition(filter)], json };
  else if ('all' in filter || 'any' in filter) {
    const children = 'all' in filter ? filter.all : filter.any;
    if (children.every(isLeaf)) {
      simple = { mode: 'simple', combine: 'all' in filter ? 'all' : 'any', conditions: children.map(leafToCondition), json };
    }
  }
  if (simple && sameJson(draftFilter(simple), filter)) return simple;
  return { ...base, mode: 'json', json };
}

function actionToDraft(action: TriggerAction): ActionDraft {
  const draft = emptyAction(action.type);
  switch (action.type) {
    case 'todo':
      return { ...draft, text: action.text, notes: action.notes ?? '', project: action.project ?? '', urgency: action.urgency ?? '' };
    case 'task':
      return {
        ...draft, agent: action.agent, prompt: action.prompt, title: action.title ?? '',
        taskType: action.task_type ?? 'chore', project: action.project ?? '',
        priority: action.priority === undefined ? '' : String(action.priority), raw: action.raw,
        silentReturn: action.silent_return ?? false,
      };
    case 'notify':
      return { ...draft, notifyTitle: action.title, body: action.body ?? '', level: action.level ?? 'report', urgent: action.urgent ?? false };
    case 'workflow':
      return { ...draft, workflow: action.workflow, node: action.node };
    case 'webhook':
      return { ...draft, url: action.url };
    case 'script':
      return {
        ...draft, command: action.command, scriptArgs: (action.args ?? []).join('\n'), cwd: action.cwd,
        scriptEnv: (action.env ?? []).join(', '), timeoutS: action.timeout_s === undefined ? '' : String(action.timeout_s),
        allowOverlap: action.overlap === 'allow', notifyOnFailure: action.notify_on_failure !== false,
      };
  }
}

export function draftFromTrigger(trigger: TriggerPublic | null, source: TriggerSource, defaultAgent = ''): TriggerDraft {
  const config = (trigger?.config ?? {}) as Partial<ScheduleConfig & WebhookConfig & EventConfig>;
  const actions = trigger?.actions?.length ? trigger.actions.map(actionToDraft) : [emptyAction(source === 'schedule' ? 'task' : 'todo', defaultAgent)];
  return {
    source: trigger?.source ?? source,
    name: trigger?.name ?? '',
    enabled: trigger?.enabled ?? true,
    cron: config.cron ?? '0 9 * * *',
    tz: config.tz ?? '',
    slug: trigger?.slug ?? '',
    auth: config.auth ?? 'github',
    event: config.event ?? 'task_done',
    rateLimit: config.rate_limit === undefined ? '' : String(config.rate_limit),
    coalesceKey: config.coalesce?.key ?? '',
    coalesceQuietS: config.coalesce ? msToSeconds(config.coalesce.quiet_ms) : '',
    coalesceMaxS: config.coalesce?.max_ms === undefined ? '' : msToSeconds(config.coalesce.max_ms),
    filter: filterToDraft(trigger?.filter),
    actions,
  };
}

/** A translation key + its variables: the form shows it under the step. */
export type DraftProblem = { step: 0 | 1 | 2; key: string; vars?: Record<string, string | number> };

function conditionToLeaf(condition: ConditionDraft): FilterLeaf | DraftProblem {
  const path = condition.path.trim();
  if (!PATH_RE.test(path)) return { step: 1, key: 'triggersPage.errors.path', vars: { path: path || '…' } };
  switch (condition.op) {
    case 'exists': case 'missing': return { op: condition.op, path };
    case 'in': {
      const values = condition.value.split(',').map((v) => v.trim()).filter(Boolean);
      if (!values.length) return { step: 1, key: 'triggersPage.errors.value', vars: { path } };
      return { op: 'in', path, values };
    }
    case 'regex':
      if (!condition.value) return { step: 1, key: 'triggersPage.errors.value', vars: { path } };
      return { op: 'regex', path, pattern: condition.value, ...(condition.caseInsensitive ? { flags: 'i' as const } : {}) };
    case 'contains':
      if (!condition.value) return { step: 1, key: 'triggersPage.errors.value', vars: { path } };
      return { op: 'contains', path, value: condition.value };
    default:
      return { op: condition.op, path, value: condition.value };
  }
}

function isProblem(value: unknown): value is DraftProblem {
  return typeof value === 'object' && value !== null && 'key' in value && 'step' in value;
}

export function draftFilter(draft: FilterDraft): Filter | null | DraftProblem {
  if (draft.mode === 'none') return null;
  if (draft.mode === 'json') {
    if (!draft.json.trim()) return null;
    try {
      const parsed: unknown = JSON.parse(draft.json);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { step: 1, key: 'triggersPage.errors.filterJson' };
      // The daemon validates the tree; this side only knows it is an object.
      return parsed as Filter;
    } catch {
      return { step: 1, key: 'triggersPage.errors.filterJson' };
    }
  }
  const leaves: FilterLeaf[] = [];
  for (const condition of draft.conditions) {
    const leaf = conditionToLeaf(condition);
    if (isProblem(leaf)) return leaf;
    leaves.push(leaf);
  }
  if (!leaves.length) return null;
  if (leaves.length === 1) return leaves[0]!;
  return draft.combine === 'all' ? { all: leaves } : { any: leaves };
}

function draftAction(action: ActionDraft, index: number): TriggerAction | DraftProblem {
  const n = index + 1;
  const opt = (value: string) => (value.trim() ? value.trim() : undefined);
  switch (action.type) {
    case 'todo':
      if (!action.text.trim()) return { step: 2, key: 'triggersPage.errors.todoText', vars: { n } };
      return strip({ type: 'todo', text: action.text.trim(), notes: opt(action.notes), project: opt(action.project), urgency: opt(action.urgency) });
    case 'task': {
      if (!action.agent) return { step: 2, key: 'triggersPage.errors.taskAgent', vars: { n } };
      if (!action.prompt.trim()) return { step: 2, key: 'triggersPage.errors.taskPrompt', vars: { n } };
      const priority = action.priority ? Number(action.priority) : undefined;
      return strip({
        type: 'task', agent: action.agent, prompt: action.prompt.trim(), title: opt(action.title),
        task_type: action.taskType || undefined, project: opt(action.project), priority, raw: action.raw,
        silent_return: action.silentReturn || undefined,
      });
    }
    case 'notify':
      if (!action.notifyTitle.trim()) return { step: 2, key: 'triggersPage.errors.notifyTitle', vars: { n } };
      return strip({
        type: 'notify', title: action.notifyTitle.trim(), body: opt(action.body),
        level: action.level, urgent: action.urgent || undefined,
      });
    case 'workflow':
      if (!action.workflow || !action.node) return { step: 2, key: 'triggersPage.errors.workflowTarget', vars: { n } };
      return { type: 'workflow', workflow: action.workflow, node: action.node };
    case 'webhook':
      if (!isWebhookUrl(action.url.trim())) return { step: 2, key: 'triggersPage.errors.webhookUrl', vars: { n } };
      return { type: 'webhook', url: action.url.trim() };
    case 'script': {
      if (!action.command.trim()) return { step: 2, key: 'triggersPage.errors.scriptCommand', vars: { n } };
      if (!isAbsolutePath(action.cwd.trim())) return { step: 2, key: 'triggersPage.errors.scriptCwd', vars: { n } };
      const env = action.scriptEnv.split(',').map((name) => name.trim()).filter(Boolean);
      const bad = env.find((name) => !SECRET_NAME_RE.test(name));
      if (bad) return { step: 2, key: 'triggersPage.errors.scriptEnv', vars: { n, name: bad } };
      const timeout = action.timeoutS.trim() ? Number(action.timeoutS) : undefined;
      if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 1 || timeout > SCRIPT_MAX_TIMEOUT_S)) {
        return { step: 2, key: 'triggersPage.errors.scriptTimeout', vars: { n, max: SCRIPT_MAX_TIMEOUT_S } };
      }
      // One argument per line, kept verbatim: no shell splits them.
      const args = action.scriptArgs.split(/\r?\n/).filter((line) => line.length > 0);
      return strip({
        type: 'script', command: action.command.trim(), args: args.length ? args : undefined, cwd: action.cwd.trim(),
        env: env.length ? env : undefined, timeout_s: timeout,
        overlap: action.allowOverlap ? 'allow' as const : undefined,
        notify_on_failure: action.notifyOnFailure ? undefined : false,
      });
    }
  }
}

/** POSIX `/…`, Windows `C:\…` or `\\server\…`: the daemon resolves it on its own OS. */
export function isAbsolutePath(value: string): boolean {
  return /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(value);
}

/** Mirrors the daemon: https, no credentials in the address. */
export function isWebhookUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !!url.hostname;
  } catch {
    return false;
  }
}

/** Drops the keys left `undefined`: the daemon's objects are strict. */
function strip<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/** `1500` → `"1.5"`: shown in seconds, read back to the same millisecond. */
function msToSeconds(ms: number): string {
  return String(ms / 1000);
}

/** Mirrors the daemon's `coalesceSchema` bounds. */
const QUIET_MS = { min: 500, max: 3_600_000 };
const MAX_MS = { min: 500, max: 86_400_000 };

/** Seconds typed in the form → whole milliseconds within bounds, `null` if not. */
function secondsToMs(raw: string, bounds: { min: number; max: number }): number | null {
  const seconds = Number(raw.trim().replace(',', '.'));
  if (!raw.trim() || !Number.isFinite(seconds)) return null;
  const ms = Math.round(seconds * 1000);
  return ms >= bounds.min && ms <= bounds.max ? ms : null;
}

function positiveInt(raw: string): number | null | undefined {
  if (!raw.trim()) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * The body of `POST /api/triggers` (or of a PATCH, minus `source`). A problem
 * names the step it belongs to, so the editor can go back there.
 */
export function draftToBody(draft: TriggerDraft): { ok: true; body: Record<string, unknown> } | { ok: false; problem: DraftProblem } {
  const fail = (problem: DraftProblem) => ({ ok: false as const, problem });
  if (!draft.name.trim()) return fail({ step: 0, key: 'triggersPage.errors.name' });
  let config: Record<string, unknown>;
  if (draft.source === 'schedule') {
    if (!draft.cron.trim()) return fail({ step: 0, key: 'triggersPage.errors.cron' });
    config = strip({ cron: draft.cron.trim(), tz: draft.tz.trim() || undefined });
  } else {
    const rate = positiveInt(draft.rateLimit);
    if (rate === null) return fail({ step: 0, key: 'triggersPage.errors.rateLimit' });
    let coalesce: Coalesce | undefined;
    if (draft.coalesceKey.trim()) {
      const quiet = secondsToMs(draft.coalesceQuietS, QUIET_MS);
      const max = draft.coalesceMaxS.trim() ? secondsToMs(draft.coalesceMaxS, MAX_MS) : undefined;
      if (!PATH_RE.test(draft.coalesceKey.trim())) return fail({ step: 0, key: 'triggersPage.errors.path', vars: { path: draft.coalesceKey.trim() } });
      if (quiet === null) return fail({ step: 0, key: 'triggersPage.errors.coalesceQuiet' });
      if (max === null) return fail({ step: 0, key: 'triggersPage.errors.coalesceMax' });
      coalesce = strip({ key: draft.coalesceKey.trim(), quiet_ms: quiet, max_ms: max });
    }
    config = draft.source === 'webhook'
      ? strip({ auth: draft.auth, rate_limit: rate, coalesce })
      : strip({ event: draft.event, rate_limit: rate, coalesce });
  }
  if (draft.source === 'webhook' && !SLUG_RE.test(draft.slug)) return fail({ step: 0, key: 'triggersPage.errors.slug' });

  let filter: Filter | null = null;
  if (draft.source !== 'schedule') {
    const parsed = draftFilter(draft.filter);
    if (isProblem(parsed)) return fail(parsed);
    filter = parsed;
  }

  if (!draft.actions.length) return fail({ step: 2, key: 'triggersPage.errors.noAction' });
  const actions: TriggerAction[] = [];
  for (const [index, action] of draft.actions.entries()) {
    const built = draftAction(action, index);
    if (isProblem(built)) return fail(built);
    actions.push(built);
  }

  const body: Record<string, unknown> = {
    source: draft.source, name: draft.name.trim(), enabled: draft.enabled, config, actions,
  };
  if (draft.source === 'webhook') body.slug = draft.slug;
  if (draft.source !== 'schedule') body.filter = filter;
  return { ok: true, body };
}

/** A name typed in the first field, turned into a route name. */
export function slugify(name: string): string {
  return name
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

/** Template variables a schedule offers (`scheduleInput` of the daemon). */
export const SCHEDULE_VARIABLES = ['{now}', '{timestamp}', '{trigger.name}'] as const;

/** What an event's payload carries (`eventInput` of the daemon), for the hints. */
export const EVENT_VARIABLES: Record<EventKind, readonly string[]> = {
  task_done: ['{task.title}', '{task.agent}', '{task.project}', '{task.summary}', '{task.comment}', '{task.id}'],
  task_blocked: ['{task.title}', '{task.agent}', '{task.project}', '{task.reason}', '{task.id}'],
  mission_complete: ['{mission.agent}', '{mission.status}', '{mission.reason}', '{mission.id}'],
  agent_message: ['{message.from_agent}', '{message.to_agent}', '{message.kind}', '{message.text}'],
  notification: ['{notification.title}', '{notification.body}', '{notification.type}', '{notification.source}'],
  todo_done: ['{todo.text}', '{todo.project}', '{todo.previous_progress}', '{todo.urgency}', '{todo.id}'],
  todo_resolved: ['{todo.text}', '{todo.resolution}', '{todo.public_note}', '{todo.duplicate_of}', '{todo.project}', '{todo.id}'],
};
