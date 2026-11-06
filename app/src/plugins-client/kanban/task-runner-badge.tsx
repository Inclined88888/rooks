'use client';

import { Shuffle } from 'lucide-react';
import { t as i18n } from '@/lib/i18n';
import { runByReasonKey, type TaskRunBy } from '@/lib/task-runner';

/** Kanban card chip for a task run by another agent than the one it names
 *  (TIM-0109); the reason stays in the tooltip. */
export function TaskRunnerBadge({ named, runBy }: { named: string; runBy: TaskRunBy }) {
  const vars = { named, agent: runBy.agent };
  const title = i18n('kanbanPage.runBy.title', { ...vars, reason: i18n(runByReasonKey(runBy.reason), vars) });
  return (
    <span
      title={title}
      aria-label={title}
      data-task-runner={runBy.agent}
      className="inline-flex max-w-[180px] items-center gap-1 rounded-md bg-warning/10 px-1.5 py-0.5 text-[10.5px] text-warning"
    >
      <Shuffle className="size-3 flex-none" aria-hidden />
      <span className="truncate">{i18n('kanbanPage.runBy.label', vars)}</span>
    </span>
  );
}
