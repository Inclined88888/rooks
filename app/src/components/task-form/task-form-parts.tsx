'use client';

/**
 * The pieces of the product's task form (`task-form.tsx`): each field group
 * of the tabs, kept apart so the form itself reads as its layout.
 *
 * Rule 16 throughout: the product's own type, no separator line — groups
 * are told apart by spacing and surface contrast, the active choice by a fill.
 */

import { useEffect, useId, useMemo, useRef, useState, type ComponentType, type KeyboardEvent, type ReactNode } from 'react';
import { Check, ChevronDown, Eye, Pencil, Search } from 'lucide-react';
import { AnchoredPopover } from '@/components/anchored-popover';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { mdToSafeHtml } from '@/lib/markdown';
import { AgentAvatar, agentIdentity } from '@/components/agent-avatar';
import { useProjectMeta } from '@/hooks/use-project-meta';
import { resolveRole, agentRoleKey } from '@/lib/roles';
import { Field, PAPER_CLASS } from '@/components/form-field';
import type { TaskFormAgent } from './task-form-context';
import { matchesFilter, type TaskStatus } from './task-form-model';

// Moved out so the TO DO idea's popup paints the same field; the task form keeps its imports.
export { Field, PAPER_CLASS } from '@/components/form-field';
export { AttachmentsField, type AttachmentItem } from '@/components/attachments-field';

export const INPUT_CLASS =
  'w-full rounded-lg bg-muted/50 px-3 py-1.5 text-[13px] text-foreground placeholder:text-muted-foreground/70 outline-none transition-colors hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60';

/** A control of the right column: white on the block's tint in the light theme, a shade darker on hover. */
export const FIELD_PAPER_CLASS = 'bg-white hover:bg-white/60 dark:bg-muted/50 dark:hover:bg-muted/80';

/** A toggle button of a choice row: the pressed one takes the primary fill. */
export function ChoiceButton({ pressed, onClick, children, className, style }: {
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      style={style}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        pressed ? 'bg-primary/15 text-foreground ring-1 ring-primary/50' : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground',
        className,
      )}
    >
      {children}
    </button>
  );
}

// ─── Description ────────────────────────────────────────────────────────────

/** The description, written in Markdown and previewed through the chat's sanitised renderer. */
export function DescriptionField({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) {
  // A stored description opens as it reads; an empty one opens ready to write.
  const [preview, setPreview] = useState(() => value.trim() !== '');
  // The same pipe as the chat bubbles: marked, then DOMPurify — never raw HTML.
  const html = useMemo(() => (preview && value.trim() ? mdToSafeHtml(value) : ''), [preview, value]);
  return (
    <Field
      label={t('taskForm.description')}
      htmlFor={preview ? undefined : id}
      aside={(
        // The file editor's toggle (`file-editor-overlay.tsx`): eye to read, pencil to edit.
        <div role="group" aria-label={t('taskForm.description')} className="inline-flex rounded-md bg-background/60 p-0.5 ring-1 ring-border">
          {([[true, Eye, 'taskForm.preview'], [false, Pencil, 'taskForm.write']] as const).map(([on, Icon, label]) => (
            <button
              key={String(on)}
              type="button"
              aria-pressed={preview === on}
              aria-label={t(label)}
              title={t(label)}
              onClick={() => setPreview(on)}
              className={cn(
                'grid size-6 place-items-center rounded transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                preview === on ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon className="size-3.5" aria-hidden />
            </button>
          ))}
        </div>
      )}
    >
      {preview ? (
        html ? (
          // `chat-bubble` carries the rendered Markdown's typography (globals.css).
          <div data-task-description-preview="" className={cn('chat-bubble min-h-[12rem] rounded-lg px-3.5 py-2.5 text-[13px] [&_h1]:text-[15px] [&_h2]:text-[14px] [&_h3]:text-[13px]', PAPER_CLASS)} dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <p className={cn('min-h-[12rem] rounded-lg px-3.5 py-2.5 text-[13px] text-muted-foreground', PAPER_CLASS)}>{t('taskForm.previewEmpty')}</p>
        )
      ) : (
        <textarea
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={10}
          placeholder={t('taskForm.descriptionPlaceholder')}
          className={cn(INPUT_CLASS, 'min-h-[12rem] resize-y px-3.5 py-2.5 leading-relaxed', PAPER_CLASS)}
        />
      )}
    </Field>
  );
}

// ─── Agents ─────────────────────────────────────────────────────────────────

/** The agent's job as its card names it: its role, else its project. */
export function agentRoleLabel(agent: TaskFormAgent): string | null {
  const key = agentRoleKey(agent.role);
  return (key ? resolveRole(key)?.label ?? agent.role : null) ?? agent.project ?? null;
}

export function AgentFace({ agent, size = 'md' }: { agent: TaskFormAgent; size?: 'sm' | 'md' }) {
  const projects = useProjectMeta();
  const identity = agentIdentity(agent, agent.project ? projects.get(agent.project) ?? null : null);
  // A form's picker: the bare look, still.
  return <AgentAvatar identity={identity} size={size} live={false} />;
}

/** One choice of a `ChoiceSelect`: its label, and the mark that tells it apart. */
export type ChoiceOption<V extends string | number> = {
  value: V;
  label: string;
  icon?: ComponentType<{ className?: string; style?: React.CSSProperties }>;
  /** Colours the icon (any CSS colour). */
  color?: string;
  /** Colours the label (a text utility), e.g. a high priority. */
  textClass?: string;
};

/**
 * A compact select drawn by the product: the trigger shows the picked choice
 * with its icon and colour, the list opens in the shared popover. Arrows move
 * between choices, Enter or a click picks, Escape closes.
 */
export function ChoiceSelect<V extends string | number>({ id, label, value, options, onChange, icon: TriggerIcon, className }: {
  id?: string;
  label: string;
  value: V;
  options: readonly ChoiceOption<V>[];
  onChange: (value: V) => void;
  /** Drawn before the label when the choice itself carries no icon. */
  icon?: ComponentType<{ className?: string }>;
  className?: string;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const listId = useId();
  const current = options.find((o) => o.value === value);
  const Icon = current?.icon;
  const close = () => { setOpen(false); anchor.current?.focus(); };
  const pick = (v: V) => { onChange(v); close(); };

  // The picked choice takes the focus when the list opens.
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => {
      list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus()
        ?? list.current?.querySelector<HTMLElement>('[role="option"]')?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [open]);

  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = Array.from(list.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? []);
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = e.key === 'ArrowDown' ? Math.min(items.length - 1, at + 1) : Math.max(0, at - 1);
    items[next]?.focus();
  };

  return (
    <>
      <button
        ref={anchor}
        id={id}
        type="button"
        data-choice-select=""
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`${label}: ${current?.label ?? ''}`}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'inline-flex h-7 min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-md bg-muted/50 px-2 text-[13px] text-foreground transition-colors hover:bg-muted/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          className,
        )}
      >
        {Icon ? <Icon className="size-3.5 flex-none" style={{ color: current?.color }} /> : TriggerIcon ? <TriggerIcon className="size-3.5 flex-none text-muted-foreground" /> : null}
        <span className={cn('min-w-0 truncate', current?.textClass)}>{current?.label ?? String(value)}</span>
        <ChevronDown className="size-3.5 flex-none text-muted-foreground" aria-hidden />
      </button>
      <AnchoredPopover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchor}
        align="end"
        width={240}
        maxHeight={320}
        label={label}
        className="overflow-hidden"
      >
        <div ref={list} id={listId} role="listbox" aria-label={label} onKeyDown={onListKey} className="max-h-[inherit] overflow-y-auto p-1.5">
          {options.map((o) => {
            const selected = o.value === value;
            const OptionIcon = o.icon;
            return (
              <button
                key={String(o.value)}
                type="button"
                role="option"
                aria-selected={selected}
                data-choice={String(o.value)}
                onClick={() => pick(o.value)}
                className={cn(
                  'flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  selected ? 'bg-primary/10' : 'hover:bg-muted/60',
                )}
              >
                {OptionIcon && <OptionIcon className="size-3.5 flex-none" style={{ color: o.color }} />}
                <span className={cn('min-w-0 flex-1 truncate', o.textClass ?? 'text-foreground')}>{o.label}</span>
                {selected && <Check className="size-3.5 flex-none text-primary" aria-hidden />}
              </button>
            );
          })}
        </div>
      </AnchoredPopover>
    </>
  );
}

/**
 * The agent the task goes to: a full-width trigger showing its face, and a
 * searchable list of every agent drawn the same way.
 */
export function AgentPicker({ agents, value, onChange, invalid }: {
  agents: readonly TaskFormAgent[];
  value: string;
  onChange: (name: string) => void;
  invalid?: boolean;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const listId = useId();
  const current = agents.find((a) => a.name === value) ?? null;
  const job = current ? agentRoleLabel(current) : null;
  const shown = agents.filter((a) => matchesFilter(filter, a.name, a.role, a.project));
  const close = () => { setOpen(false); setFilter(''); anchor.current?.focus(); };
  const pick = (name: string) => { onChange(name); close(); };
  return (
    <>
      <button
        ref={anchor}
        type="button"
        data-agent-picker=""
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={t('taskForm.agent')}
        aria-invalid={invalid || undefined}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          FIELD_PAPER_CLASS,
          invalid && 'ring-2 ring-destructive/70',
        )}
      >
        {current ? <AgentFace agent={current} /> : null}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px] font-semibold text-foreground">{value || t('taskForm.summary.agentNone')}</span>
          {job && <span className="truncate text-xs text-muted-foreground">{job}</span>}
        </span>
        <ChevronDown className="size-4 flex-none text-muted-foreground" aria-hidden />
      </button>
      <AnchoredPopover
        open={open}
        onClose={() => { setOpen(false); setFilter(''); }}
        anchorRef={anchor}
        align="start"
        width={300}
        maxHeight={420}
        sheet
        label={t('taskForm.agent')}
        className="flex flex-col overflow-hidden"
      >
        <div className="flex flex-none items-center gap-2 px-3 py-2">
          <Search className="size-3.5 flex-none text-muted-foreground" aria-hidden />
          <input
            autoFocus
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); if (shown[0]) pick(shown[0].name); }
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
            }}
            data-agent-search=""
            aria-label={t('taskForm.agentFilter')}
            placeholder={t('taskForm.agentFilter')}
            className="h-7 min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground/70"
          />
        </div>
        <div id={listId} role="listbox" aria-label={t('taskForm.agent')} className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {agents.length === 0 && <p className="px-2 py-1.5 text-[13px] text-muted-foreground">{t('taskForm.loadingAgents')}</p>}
          {agents.length > 0 && shown.length === 0 && <p className="px-2 py-1.5 text-[13px] text-muted-foreground">{t('taskForm.noAgentMatch')}</p>}
          {shown.map((agent) => {
            const selected = agent.name === value;
            const role = agentRoleLabel(agent);
            return (
              <button
                key={agent.name}
                type="button"
                role="option"
                aria-selected={selected}
                data-agent-card={agent.name}
                onClick={() => pick(agent.name)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  selected ? 'bg-primary/10' : 'hover:bg-muted/60',
                )}
              >
                <AgentFace agent={agent} size="sm" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[13px] font-medium text-foreground">{agent.name}</span>
                  {role && <span className="truncate text-xs text-muted-foreground">{role}</span>}
                </span>
                {selected && <Check className="size-4 flex-none text-primary" aria-hidden />}
              </button>
            );
          })}
        </div>
      </AnchoredPopover>
    </>
  );
}

// ─── Lists ──────────────────────────────────────────────────────────────────

export const STATUS_DOT: Record<TaskStatus, string> = {
  PENDING: 'bg-muted-foreground/60',
  IN_PROGRESS: 'bg-primary',
  DONE: 'bg-[hsl(var(--success))]',
  BLOCKED: 'bg-destructive/80',
};

export function StatusLabel({ status }: { status: TaskStatus | null }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <i className={cn('size-1.5 flex-none rounded-full', status ? STATUS_DOT[status] : 'bg-muted-foreground/40')} aria-hidden />
      {status ? t(`taskForm.status.${status}`) : t('taskForm.status.new')}
    </span>
  );
}

export type DepCandidate = { id: string; title: string; status: TaskStatus };

/** The tasks this one may wait for, each a checkbox row with its status. */
export function DepsList({ candidates, selected, onToggle, filter }: {
  candidates: readonly DepCandidate[];
  selected: readonly string[];
  onToggle: (id: string) => void;
  filter: string;
}) {
  const shown = candidates.filter((c) => matchesFilter(filter, c.title, c.id));
  if (candidates.length === 0) return <p className="text-[13px] text-muted-foreground">{t('taskForm.deps.none')}</p>;
  if (shown.length === 0) return <p className="text-[13px] text-muted-foreground">{t('taskForm.deps.noMatch')}</p>;
  return (
    <ul className="flex flex-col gap-1">
      {shown.map((c) => {
        const checked = selected.includes(c.id);
        return (
          <li key={c.id}>
            <label
              data-dep={c.id}
              className={cn(
                'flex min-h-12 cursor-pointer items-center gap-3 rounded-lg px-3 py-2 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
                checked ? 'bg-primary/10' : 'hover:bg-muted/50',
              )}
            >
              <input type="checkbox" checked={checked} onChange={() => onToggle(c.id)} className="size-4 flex-none accent-[hsl(var(--primary))]" />
              <span className="w-16 flex-none text-xs tabular-nums text-muted-foreground">{c.id.slice(0, 8)}</span>
              <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{c.title}</span>
              <span className="flex-none text-xs text-muted-foreground"><StatusLabel status={c.status} /></span>
            </label>
          </li>
        );
      })}
    </ul>
  );
}

/** Toggle chips over a filtered list (skills, MCP servers). */
export function ChipToggles({ label, options, values, onToggle, empty, noMatch, filter }: {
  label: string;
  options: readonly string[];
  values: readonly string[];
  onToggle: (value: string) => void;
  empty: string;
  noMatch: string;
  filter: string;
}) {
  // A value the catalogue no longer lists stays visible, so it can be removed.
  const all = [...values.filter((v) => !options.includes(v)), ...options];
  const shown = all.filter((o) => values.includes(o) || matchesFilter(filter, o));
  if (all.length === 0) return <p className="text-[13px] text-muted-foreground">{empty}</p>;
  if (shown.length === 0) return <p className="text-[13px] text-muted-foreground">{noMatch}</p>;
  return (
    <div role="group" aria-label={label} className="flex max-h-56 flex-wrap gap-1.5 overflow-y-auto">
      {shown.map((opt) => (
        <ChoiceButton key={opt} pressed={values.includes(opt)} onClick={() => onToggle(opt)} className="h-8 px-2.5 text-xs">
          {opt}
        </ChoiceButton>
      ))}
    </div>
  );
}
