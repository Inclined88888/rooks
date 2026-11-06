/** Public plugin types, extracted from the host implementations (TODO #512). */
import type { WriteOrigin as TodoOrigin } from './origin.js';
import type { TaskType } from './tasks.js';

// Moved from `triggers/test-run.ts`, which re-exports it (TODO #512, volet 3).
export type TriggerTestResult =
  | { status: 'ignored'; reason: 'filter' }
  | { status: 'dry_run'; outcomes: ActionOutcome[] }
  | { status: 'error' | 'received'; outcomes: ActionOutcome[] };

// Moved from `triggers/actions.ts`, which re-exports it (TODO #512, volet 3).
export type ActionOutcome =
  | { type: TriggerAction['type']; ok: true; id: string | number | null; preview?: Record<string, unknown> }
  | { type: TriggerAction['type']; ok: false; error: string };

// Spelled out from the zod schemas of `triggers/schema.ts` and `triggers/filter.ts`, which prove at
// compilation that both agree (TODO #512, volet 3).
export type TriggerAction =
  | { type: 'todo'; text: string; notes?: string | undefined; project?: string | undefined; urgency?: string | undefined }
  | {
    type: 'task'; agent: string; prompt: string; title?: string | undefined; task_type?: TaskType | undefined;
    project?: string | null | undefined; priority?: number | undefined; raw?: boolean | undefined;
    silent_return?: boolean | undefined;
  }
  | {
    type: 'notify'; title: string; body?: string | undefined; level?: 'report' | 'alert' | undefined;
    urgent?: boolean | undefined;
  }
  | { type: 'workflow'; workflow: string; node: string }
  | { type: 'webhook'; url: string }
  | {
    type: 'script'; command: string; cwd: string; args?: string[] | undefined; env?: string[] | undefined;
    timeout_s?: number | undefined; overlap?: 'skip' | 'allow' | undefined; notify_on_failure?: boolean | undefined;
  };

export type FilterLeaf =
  | { op: 'exists'; path: string }
  | { op: 'missing'; path: string }
  | { op: 'equals'; path: string; value: string | number | boolean | null }
  | { op: 'not_equals'; path: string; value: string | number | boolean | null }
  | { op: 'contains'; path: string; value: string | number | boolean }
  | { op: 'in'; path: string; values: (string | number | boolean | null)[] }
  | { op: 'regex'; path: string; pattern: string; flags?: '' | 'i' | undefined };
export type Filter =
  | FilterLeaf
  | { all: Filter[] }
  | { any: Filter[] }
  | { not: Filter };

type TriggerCoalesce = { key: string; quiet_ms: number; max_ms?: number | undefined };

/** Definition of a trigger, everything but its identity and bookkeeping. A schedule has no filter. */
export type TriggerDefinition =
  | {
    source: 'schedule'; name: string; actions: TriggerAction[];
    config: { cron: string; tz?: string | undefined };
    enabled?: boolean | undefined;
  }
  | {
    source: 'webhook'; name: string; actions: TriggerAction[]; slug: string;
    config: {
      auth: 'github' | 'gitlab' | 'standard' | 'generic' | 'none';
      rate_limit?: number | undefined; coalesce?: TriggerCoalesce | undefined;
    };
    enabled?: boolean | undefined; filter?: Filter | null | undefined;
  }
  | {
    source: 'event'; name: string; actions: TriggerAction[];
    config: {
      event: 'mission_complete' | 'task_done' | 'task_blocked' | 'agent_message' | 'notification' | 'todo_done' | 'todo_resolved';
      rate_limit?: number | undefined; coalesce?: TriggerCoalesce | undefined;
    };
    enabled?: boolean | undefined; filter?: Filter | null | undefined;
  };

// Moved from `plugins/automation-events.ts`, which re-exports it (TODO #512, volet 3).
/** Who caused the change: `user` (account id), `agent` (name), `plugin` (id), `system`. */
export type AutomationOrigin = TodoOrigin;

// Moved from `workflows/native-triggers.ts`, which re-exports it (TODO #512, volet 3).
export type EntryNode = { id: string; type: string; label: string | null };

export type PluginTriggerInfo = {
  id: string;
  name: string;
  source: 'schedule' | 'webhook' | 'event';
  enabled: boolean;
  /** Webhook triggers only: the slug of `/api/triggers/hooks/<slug>`. */
  slug: string | null;
  /** Event triggers only: the event kind they listen to (`todo_done`). */
  event: string | null;
  /** Host (with port) of each `webhook` action, never the path or query. */
  actionHosts: string[];
  /** Created by THIS plugin: `remove` and `test` accept it. */
  mine: boolean;
};

/** A trigger this plugin owns: its definition too. No secret, ever. */
export type PluginOwnTrigger = PluginTriggerInfo & {
  mine: true;
  config: Record<string, unknown>;
  filter: unknown;
  actions: TriggerAction[];
  /** Permissions frozen on it: what its actions may do. */
  grants: string[];
  /** Webhook triggers only: `/api/triggers/hooks/<slug>`. */
  url: string | null;
  lastRunAt: number | null;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
};

/** A new trigger: the definition of the triggers page, plus a secret a sender imposes. */
export type PluginTriggerInput = TriggerDefinition & {
  /** Webhook only, 16 to 256 characters; generated when absent. */
  secret?: string;
};

/** What `create` returns: the secrets are in this reply and nowhere else. */
export type PluginTriggerCreated = {
  trigger: PluginOwnTrigger;
  /** Authenticated webhook: the secret the sender signs with. */
  secret?: string;
  /** A `webhook` action: the secret that signs what the trigger sends. */
  outboundSecret?: string;
};

export type PluginTriggerTestOptions = {
  payload?: unknown;
  headers?: Record<string, string>;
  /** Off by default: a test shows what would happen, it does not do it. Needs `triggers:execute`. */
  execute?: boolean;
};

/**
 * `invalid` (input), `not_found` (missing, or outside the caller's view),
 * `conflict` (name or slug taken), `forbidden` (visible but not this plugin's,
 * or a permission the plugin did not declare for what it asks), `quota`
 * (too many objects), `unavailable` (the module behind it is not running).
 */
export type PluginAutomationErrorCode = 'invalid' | 'not_found' | 'conflict' | 'forbidden' | 'quota' | 'unavailable';

export type PluginAutomationEventKind =
  | 'routine_created'
  | 'routine_updated'
  | 'routine_deleted'
  | 'trigger_created'
  | 'trigger_updated'
  | 'trigger_removed'
  | 'pipeline_created'
  | 'pipeline_updated'
  | 'pipeline_deleted'
  | 'pipeline_run_started'
  | 'workflow_run_started'
  | 'workflow_run_cancelled';

export type PluginRoutineEvent = Readonly<{
  kind: 'routine_created' | 'routine_updated' | 'routine_deleted';
  routineId: string;
  /** After the write; before it for `routine_deleted`. */
  routine: Readonly<PluginRoutine>;
  origin: AutomationOrigin;
}>;

export type PluginTriggerEvent = Readonly<{
  kind: 'trigger_created' | 'trigger_updated' | 'trigger_removed';
  triggerId: string;
  trigger: Readonly<PluginTriggerInfo | PluginOwnTrigger>;
  origin: AutomationOrigin;
}>;

export type PluginPipelineEvent = Readonly<{
  kind: 'pipeline_created' | 'pipeline_updated' | 'pipeline_deleted';
  pipelineId: string;
  pipeline: Readonly<PluginPipeline | PluginOwnPipeline>;
  origin: AutomationOrigin;
}>;

export type PluginPipelineRunStartedEvent = Readonly<{
  kind: 'pipeline_run_started';
  runId: string;
  pipelineId: string;
  steps: ReadonlyArray<Readonly<{ stepId: string; taskId: string }>>;
  origin: AutomationOrigin;
}>;

export type PluginWorkflowRunEvent = Readonly<{
  kind: 'workflow_run_started' | 'workflow_run_cancelled';
  runId: string;
  workflowId: string;
  run: Readonly<PluginWorkflowRun>;
  origin: AutomationOrigin;
}>;

export type PluginAutomationEvent =
  | PluginRoutineEvent | PluginTriggerEvent | PluginPipelineEvent | PluginPipelineRunStartedEvent | PluginWorkflowRunEvent;

/** The events of one kind, for `ctx.events.on(kind, handler)`. */
export type PluginAutomationEventMap = {
  [K in PluginAutomationEventKind]: PluginAutomationEvent extends infer E
    ? E extends { kind: infer Kd } ? (K extends Kd ? E : never) : never
    : never;
};

export type PluginAutomationEventHandler = (ev: PluginAutomationEvent) => void | Promise<void>;

/** A step as a plugin writes it. */
export type PluginPipelineStep = {
  /** Lower-case letters, digits, `.`, `_`, `-`; unique in the pipeline. */
  id: string;
  /** An existing agent. */
  agent: string;
  /** The task's description; `{{input.key}}` is replaced by the run's input. */
  prompt: string;
  /** Default `chore`. */
  type?: TaskType;
  /** Ids of the steps that must be done first. */
  deps_on?: string[];
  /** 1 to 5, default 3. */
  priority?: number;
};

export type PluginPipelineInput = {
  name: string;
  description?: string | null;
  steps: PluginPipelineStep[];
};

/** A pipeline as any plugin sees it: no prompt. */
export type PluginPipeline = {
  id: string;
  name: string;
  description: string | null;
  stepCount: number;
  /** The keys the prompts read from a run's input (`{{input.key}}`). */
  inputs: string[];
  createdAt: number;
  updatedAt: number;
  mine: false;
};

/** A pipeline this plugin created: its steps too. */
export type PluginOwnPipeline = Omit<PluginPipeline, 'mine'> & { mine: true; steps: PluginPipelineStep[] };

export type PluginPipelineRun = {
  runId: string;
  pipelineId: string;
  startedAt: number;
  steps: Array<{ stepId: string; taskId: string }>;
};

export type PluginPipelineRunStatus = {
  runId: string;
  pipelineId: string;
  pipelineName: string;
  startedAt: number;
  input: unknown;
  steps: Array<{
    stepId: string;
    taskId: string;
    title: string;
    agent: string;
    type: string;
    status: string;
    missionId: string | null;
  }>;
};

/** A routine as a plugin sees it. */
export type PluginRoutine = {
  id: string;
  name: string;
  agent: string;
  prompt: string;
  taskType: TaskType;
  /** Cron expression, in the daemon's time zone. */
  cron: string;
  enabled: boolean;
  project: string | null;
  lastRunAt: number | null;
  nextRunAt: number | null;
  createdAt: number;
  /** Created by THIS plugin: `update` and `delete` accept it. */
  mine: boolean;
};

export type PluginRoutineInput = {
  name: string;
  /** An existing agent: the routine opens its tasks for it. */
  agent: string;
  prompt: string;
  cron: string;
  /** Default `chore`. */
  taskType?: TaskType;
  /** Default `true`. */
  enabled?: boolean;
  /** An existing project slug. */
  project?: string | null;
};

/** Fields of `PluginRoutineInput` to change. */
export type PluginRoutinePatch = Partial<PluginRoutineInput>;

export type PluginWorkflowRunSummary = {
  id: string;
  status: string;
  startedAt: number;
  endedAt: number | null;
};

export type PluginWorkflow = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  project: string | null;
  enabled: boolean;
  /** `null` until a version is published: such a workflow cannot be run. */
  publishedVersion: number | null;
  /** The agent woken as the pilot of every run; `null` on a workflow nobody has assigned yet. */
  agentName: string | null;
  createdAt: number;
  updatedAt: number;
  runCount: number;
  lastRun: PluginWorkflowRunSummary | null;
};

export type PluginWorkflowDetail = PluginWorkflow & {
  /** Root nodes of the published version. */
  entryNodes: EntryNode[];
};

export type PluginWorkflowRun = {
  id: string;
  workflowId: string;
  version: number;
  /** `pending`, `running`, `waiting`, `completed`, `failed` or `cancelled`. */
  status: string;
  startedAt: number;
  endedAt: number | null;
  error: string | null;
};

export type PluginWorkflowRunStatus = PluginWorkflowRun & {
  input: unknown;
  nodes: Array<{
    nodeId: string;
    status: string;
    error: string | null;
    output: unknown;
    startedAt: number | null;
    endedAt: number | null;
  }>;
};

export type { TriggerTestResult as PluginTriggerTestResult };
