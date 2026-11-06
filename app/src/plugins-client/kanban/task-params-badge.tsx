'use client';

import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { ModelPickerPopover, type CatalogTarget, type ModelPick } from '@/components/model-picker';
import { BrandMark } from '@/components/brand-mark';
import { backendShortName, useBackendCatalog } from '@/lib/backends';
import { taskModelMark } from '@/lib/kanban-card';
import { t as i18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  canEditTaskModel,
  saveTaskModel,
  taskModelPick,
  withTaskModel,
} from '@/lib/task-model-pick';

/** The task fields the chip reads (the board's `Task` row carries them all). */
export type TaskParamsSource = {
  id: string;
  status: string;
  backend_override?: string | null;
  model_override?: string | null;
  permission_mode_override?: string | null;
  effective_backend?: string | null;
  effective_model?: string | null;
  extra_skills?: string | null;
  extra_mcp_servers?: string | null;
  extra_allowed_tools?: string | null;
};

type Task = TaskParamsSource;

const CHIP_CLASS = 'inline-flex max-w-full items-center gap-1.5 rounded-md bg-muted/60 px-1.5 py-0.5 tabular-nums text-[11px] text-muted-foreground';

/** Compact "LLM" chip for Kanban cards. Shows the logo and model ACTUALLY
 *  assigned to the task (resolved server-side: override → role →
 *  agent config → default), visible on EVERY task regardless of its column.
 *  While the task is PENDING or BLOCKED, a hover dropdown details the full
 *  model, permission_mode, skills, MCP, tools, and a click opens the
 *  ModelPicker; a pick is saved at once (`onSaved` re-reads the board). Once
 *  the task left the queue the chip is a plain label: the popup holds the rest. */
export function TaskParamsBadge({ task: stored, onSaved, target }: {
  task: Task;
  /** Re-reads the board; the chip shows its pick until this settles. */
  onSaved?: () => Promise<void> | void;
  /** The agent that will run the task: it is offered what it could run on. */
  target?: CatalogTarget | null;
}) {
  const catalog = useBackendCatalog();
  const [open, setOpen] = useState(false);
  // The pick shown before the daemon answers; dropped on a refusal.
  const [optimistic, setOptimistic] = useState<{ pick: ModelPick | null } | null>(null);
  const task = optimistic ? withTaskModel(stored, optimistic.pick) : stored;
  const editable = canEditTaskModel(stored.status);

  async function choose(pick: ModelPick | null) {
    setOptimistic({ pick });
    const result = await saveTaskModel(stored.id, pick);
    if (result.ok) await onSaved?.();
    else toast.error(i18n('kanbanPage.modelSaveFailed', { error: result.error }));
    setOptimistic(null);
  }

  const parseList = (raw: string | null | undefined): string[] => {
    if (!raw) return [];
    try {
      const j = JSON.parse(raw);
      return Array.isArray(j) ? j.filter((x) => typeof x === 'string') : [];
    } catch { return []; }
  };
  const skills = parseList(task.extra_skills);
  const mcps = parseList(task.extra_mcp_servers);
  const tools = parseList(task.extra_allowed_tools);
  // Effective backend + model (nothing is shown if the server hasn't returned
  // the field yet — stale cache, etc.).
  // An account instance reads as its nickname, never as `claude@<id>`.
  const backend = backendShortName(catalog, task.effective_backend ?? '');
  const model = task.effective_model ?? task.model_override ?? null;
  const mode = task.permission_mode_override;
  // Compact model display (claude-opus-4-7 → opus, gpt-5.5 → gpt-5.5).
  // Keeps the chip from taking up 80% of the card's width.
  const shortModel = model
    ? model.replace(/^claude-/, '').replace(/-\d+-\d+$/, '')
    : null;
  const extrasCount = (mode ? 1 : 0) + skills.length + mcps.length + tools.length;

  const mark = taskModelMark(catalog, task);
  // The backend name moves to the details: the logo already says who serves it.
  const summary: ReactNode = (
    <>
      {mark.empty ? (
        <span className="text-muted-foreground">{i18n('kanbanPage.card.modelInherited')}</span>
      ) : (
        <>
          <BrandMark
            icon={mark.icon}
            brand={mark.brand}
            slug={mark.slug}
            fallbackIcon={mark.fallbackIcon}
            fallbackBrand={mark.fallbackBrand}
            className="size-3.5"
          />
          <span className={cn('min-w-0 truncate', mark.inherited ? 'text-muted-foreground' : 'text-foreground/90')}>
            {shortModel ?? backend}
          </span>
        </>
      )}
      {extrasCount > 0 && (
        <span className="text-muted-foreground/70">+{extrasCount}</span>
      )}
      {editable && <span className="text-muted-foreground/40" aria-hidden>▾</span>}
    </>
  );

  // Hover dropdown — invisible by default so it doesn't intercept the click
  // on the card, shown on hover (and on focus for the editable chip). Hidden
  // while the picker is open: it would sit over the panel's first rows.
  const details = (
    <span
      role="tooltip"
      className={cn(
        'invisible absolute left-0 top-[calc(100%+4px)] z-20 w-[220px] rounded-md border border-border bg-popover px-2.5 py-2 text-left tabular-nums text-[10.5px] text-foreground/80 shadow-xl opacity-0 transition-opacity',
        !open && 'group-hover/params:visible group-hover/params:opacity-100 group-focus-within/params:visible group-focus-within/params:opacity-100',
      )}
    >
      <div className="mb-1">
        <span className="text-muted-foreground/60">backend:</span>{' '}
        <span className="text-foreground">{backend}</span>
      </div>
      <div className="mb-1">
        <span className="text-muted-foreground/60">model:</span>{' '}
        <span className="text-foreground">{model ?? i18n('kanbanPage.defaultModel', { backend })}</span>
      </div>
      {mark.inherited && (
        <div className="mb-1 text-muted-foreground/80">{i18n('kanbanPage.card.modelInheritedHint')}</div>
      )}
      {mode && (
        <div className="mb-1">
          <span className="text-muted-foreground/60">perm:</span>{' '}
          <span className="text-foreground">{mode}</span>
        </div>
      )}
      {skills.length > 0 && (
        <div className="mb-1">
          <span className="text-muted-foreground/60">skills:</span>{' '}
          <span className="text-foreground">{skills.join(', ')}</span>
        </div>
      )}
      {mcps.length > 0 && (
        <div className="mb-1">
          <span className="text-muted-foreground/60">mcp:</span>{' '}
          <span className="text-foreground">{mcps.join(', ')}</span>
        </div>
      )}
      {tools.length > 0 && (
        <div>
          <span className="text-muted-foreground/60">tools:</span>{' '}
          <span className="text-foreground">{tools.join(', ')}</span>
        </div>
      )}
    </span>
  );

  if (!editable) {
    return (
      <span className={CHIP_CLASS} data-task-params="read-only">
        {summary}
      </span>
    );
  }

  return (
    // The card opens on click: nothing here may reach it, the panel included
    // (portalled, but React events still bubble up the component tree).
    <span
      className="group/params relative inline-flex"
      data-task-params="editable"
      onClick={(e) => e.stopPropagation()}
    >
      <ModelPickerPopover
        value={taskModelPick(catalog, task.backend_override, task.model_override)}
        onChange={(pick) => { void choose(pick); }}
        target={target}
        inherit={{ label: i18n('taskForm.modelInherit'), hint: i18n('taskForm.modelInheritHint') }}
        align="start"
        open={open}
        onOpenChange={setOpen}
        disabled={optimistic !== null}
        renderTrigger={(trigger) => (
          <button
            type="button"
            {...trigger}
            aria-label={i18n('kanbanPage.modelChange', { model: [backend, model].filter(Boolean).join(' / ') })}
            className={cn(CHIP_CLASS, 'cursor-pointer transition-colors hover:bg-muted hover:text-foreground disabled:cursor-wait disabled:opacity-70')}
          >
            {summary}
          </button>
        )}
      />
      {details}
    </span>
  );
}
