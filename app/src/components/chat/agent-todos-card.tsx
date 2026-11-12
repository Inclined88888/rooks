'use client';

import type { AgentTodo } from './chat-types';

/**
 * The agent's todo list, extracted verbatim from `MissionInfoPanel`.
 *
 * The counter was in the section title (`Todo agent (2/5)`); a card's title is
 * its registration key, so static. It moves to the top of the body, where it
 * stays live.
 */
export function AgentTodosCard({ agentTodos }: { agentTodos: AgentTodo[] }) {
  if (agentTodos.length === 0) return null;

  return (
    <div className="p-3">
      <div className="mb-2 flex items-center justify-end tabular-nums text-[10.5px] text-muted-foreground/70">
        {agentTodos.filter((t) => t.status === 'completed').length}/{agentTodos.length}
      </div>
      <ul className="space-y-1">
        {agentTodos.map((t) => {
          const done = t.status === 'completed';
          const cancelled = t.status === 'cancelled';
          const active = t.status === 'in_progress';
          return (
            <li
              key={t.id}
              className="flex items-start gap-2 text-[12px] leading-snug"
              title={t.description || ''}
            >
              <span
                className={
                  'mt-[3px] inline-flex size-3.5 flex-none items-center justify-center rounded-sm border ' +
                  (done
                    ? 'border-[hsl(var(--success))] bg-[hsl(var(--success))] text-background'
                    : cancelled
                      ? 'border-muted-foreground/40 bg-muted/40 text-muted-foreground/60'
                      : active
                        ? 'border-primary bg-primary/20 text-primary'
                        : 'border-border bg-background')
                }
              >
                {done ? (
                  <svg viewBox="0 0 12 12" className="size-2.5" aria-hidden="true">
                    <path d="M2 6.5 L5 9 L10 3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : cancelled ? (
                  <span className="text-[10px] leading-none">×</span>
                ) : active ? (
                  <span className="size-1.5 rounded-full bg-primary" />
                ) : null}
              </span>
              <span
                className={
                  (done || cancelled
                    ? 'text-muted-foreground/60 line-through'
                    : active
                      ? 'font-medium text-foreground'
                      : 'text-foreground/90')
                }
              >
                {t.subject}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
