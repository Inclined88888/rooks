'use client';

/**
 * The outcome of an idea, in the TO DO detail (`kanban.todo.detail`): what
 * became of it, a public note for its author, and the item it duplicates.
 *
 * Moved from the detail dialog when the outcome left the core. It saves on its
 * own button, through the same PATCH as the idea (`/api/ui/project-todo/:id`),
 * where the daemon hands these fields to `@timon/todo-outcomes`; only what
 * changed is sent, since each new outcome is announced to the author.
 */

import { useEffect, useState } from 'react';
import { CalendarClock, CircleCheck, CircleHelp, CircleX, Copy, Hammer, type LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { Picker } from '../kanban/project-todo-tag-chips';
import { useTodoDetail } from '../kanban/todo-detail-slot';
import {
  CLOSING_TODO_RESOLUTIONS, RESOLUTION_CLASS, TODO_DUPLICATE_OF_RE, TODO_PUBLIC_NOTE_MAX, TODO_RESOLUTIONS,
  type TodoResolution,
} from './vocabulary';
import { apiErrorMessage } from '@/lib/api-error';

type Outcome = { resolution: TodoResolution | null; public_note: string | null; duplicate_of: string | null };

const RESOLUTION_ICON: Record<TodoResolution, LucideIcon> = {
  fixed: CircleCheck, declined: CircleX, duplicate: Copy, needs_info: CircleHelp, in_progress: Hammer, planned: CalendarClock,
};

function Champ({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-medium text-muted-foreground first-letter:uppercase">
        {label}
      </span>
      <div className="text-[12.5px] text-foreground">{children}</div>
    </div>
  );
}

/** No outcome until one is chosen: clicking the active chip clears it. */
export function ResolutionPicker({ value, onChange }: { value: TodoResolution | null; onChange: (v: TodoResolution | null) => void }) {
  return (
    <Picker
      values={TODO_RESOLUTIONS} selected={value} onSelect={onChange} classes={RESOLUTION_CLASS}
      icons={RESOLUTION_ICON} labelKey="todoOutcomes.resolution" allowClear
    />
  );
}

export function OutcomeBlock() {
  const detail = useTodoDetail();
  const id = detail?.item.id;
  // Off unless the daemon enables it; a failed read keeps the block hidden.
  const [enabled, setEnabled] = useState(false);
  const [stored, setStored] = useState<Outcome | null>(null);
  const [resolution, setResolution] = useState<TodoResolution | null>(null);
  const [publicNote, setPublicNote] = useState('');
  const [duplicateOf, setDuplicateOf] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setStored(null);
    if (id === undefined) return;
    let alive = true;
    void (async () => {
      try {
        const config = await fetch('/api/ui/todo-outcomes/config');
        const on = config.ok && ((await config.json()) as { enabled?: boolean }).enabled === true;
        if (!alive) return;
        setEnabled(on);
        if (!on) return;
        const r = await fetch(`/api/ui/todo-outcomes/outcome/${id}`);
        if (!r.ok || !alive) return;
        const { outcome } = (await r.json()) as { outcome: Outcome };
        if (!alive) return;
        setStored(outcome);
        setResolution(outcome.resolution);
        setPublicNote(outcome.public_note ?? '');
        setDuplicateOf(outcome.duplicate_of ?? '');
      } catch { /* hidden */ }
    })();
    return () => { alive = false; };
  }, [id]);

  if (!detail || !enabled || !stored) return null;

  // The reference only exists for a duplicate; the daemon drops it otherwise.
  const duplicateRef = resolution === 'duplicate' ? duplicateOf.trim().toUpperCase() || null : null;
  const noteValue = publicNote.trim() || null;
  const resolutionChanged = resolution !== stored.resolution;
  const noteChanged = noteValue !== stored.public_note;
  const duplicateChanged = duplicateRef !== stored.duplicate_of;
  const duplicateInvalid = duplicateRef !== null && !TODO_DUPLICATE_OF_RE.test(duplicateRef);
  const noteTooLong = noteValue !== null && noteValue.length > TODO_PUBLIC_NOTE_MAX;
  const changed = resolutionChanged || noteChanged || duplicateChanged;
  // True when only the note changes on an already-announced resolution: the
  // daemon sends no notification in that case (todo_resolved fires on resolution
  // changes only), so the author won't see the update.
  const noteOnlyWarning = !resolutionChanged && resolution !== null && noteChanged;

  const save = async () => {
    setBusy(true);
    try {
      const r = await fetch(`/api/ui/project-todo/${detail.item.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          // Only sent when changed: a new outcome is announced to the author.
          ...(resolutionChanged ? { resolution } : {}),
          ...(noteChanged ? { public_note: noteValue } : {}),
          ...(duplicateChanged && resolution === 'duplicate' ? { duplicate_of: duplicateRef } : {}),
        }),
      });
      if (!r.ok) {
        const j = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(apiErrorMessage(j, { status: r.status }));
      }
      setStored({ resolution, public_note: noteValue, duplicate_of: duplicateRef });
      await detail.saved();
      toast.success(t('todoOutcomes.saved'));
    } catch (err) {
      toast.error(t('todoOutcomes.saveError'), { description: String((err as Error).message) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <Champ label={t('todoOutcomes.fieldResolution')}>
        <div className="flex flex-col gap-1.5">
          <ResolutionPicker value={resolution} onChange={setResolution} />
          <span className="text-[11px] text-muted-foreground">
            {resolution && CLOSING_TODO_RESOLUTIONS.includes(resolution)
              ? t('todoOutcomes.resolutionClosesHint')
              : t('todoOutcomes.resolutionHint')}
          </span>
        </div>
      </Champ>

      {resolution === 'duplicate' && (
        <Champ label={t('todoOutcomes.fieldDuplicateOf')}>
          <Input
            value={duplicateOf}
            onChange={(e) => setDuplicateOf(e.target.value)}
            placeholder="TIM-0001"
            aria-invalid={duplicateInvalid}
            className={cn('h-8 w-40 text-[12px]', duplicateInvalid && 'border-destructive')}
          />
          {duplicateInvalid && (
            <span className="mt-1 block text-[11px] text-destructive">{t('todoOutcomes.duplicateOfInvalid')}</span>
          )}
        </Champ>
      )}

      <Champ label={t('todoOutcomes.fieldPublicNote')}>
        <Textarea
          value={publicNote}
          onChange={(e) => setPublicNote(e.target.value)}
          rows={3}
          placeholder={t('todoOutcomes.publicNotePlaceholder')}
          aria-invalid={noteTooLong}
          className={cn('text-[12.5px]', noteTooLong && 'border-destructive')}
        />
        <div className="mt-1 flex items-baseline justify-between gap-3 text-[11px]">
          <span className="text-amber-500">{t('todoOutcomes.publicNoteWarning')}</span>
          <span className={cn('shrink-0 tabular-nums', noteTooLong ? 'text-destructive' : 'text-muted-foreground')}>
            {(noteValue ?? '').length}/{TODO_PUBLIC_NOTE_MAX}
          </span>
        </div>
        {noteOnlyWarning && (
          <span className="mt-0.5 block text-[11px] text-amber-600">{t('todoOutcomes.noteOnlyWarning')}</span>
        )}
      </Champ>

      <div className="flex justify-end">
        <Button size="sm" variant="secondary" onClick={() => void save()} disabled={!changed || busy || duplicateInvalid || noteTooLong}>
          {t('todoOutcomes.save')}
        </Button>
      </div>
    </div>
  );
}
