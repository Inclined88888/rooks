/**
 * TIM-0109 — the agent that ran a Kanban task, when the dispatcher sent it to
 * another one than the task names (a role pinned in `roles.json`, an agent of
 * another project…). The daemon adds `run_by` to the task row only then.
 */

export type TaskRunBy = {
  agent: string;
  source: string | null;
  reason: string | null;
};

/** The agent whose chat holds the task's mission. */
export function taskRunAgent(task: { agent_name: string; run_by?: TaskRunBy | null }): string {
  return task.run_by?.agent ?? task.agent_name;
}

const REASON_KEYS: Record<string, string> = {
  pinned: 'kanbanPage.runBy.reasonPinned',
  missing: 'kanbanPage.runBy.reasonMissing',
  other_project: 'kanbanPage.runBy.reasonOtherProject',
  orchestrator: 'kanbanPage.runBy.reasonOrchestrator',
  other_role: 'kanbanPage.runBy.reasonOtherRole',
};

/** i18n key of the sentence that says why; an unknown or missing reason has a generic one. */
export function runByReasonKey(reason: string | null | undefined): string {
  return (reason && REASON_KEYS[reason]) || 'kanbanPage.runBy.reasonUnknown';
}
