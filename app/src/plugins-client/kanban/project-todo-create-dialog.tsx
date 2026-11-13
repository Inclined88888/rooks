'use client';

/**
 * The quick entry of an idea: the product's `todo.form` in creation (TODO
 * #837), laid out on `DetailShell` inside the host's `DetailFrame`.
 *
 * Distinct from `project-todo-detail-dialog.tsx`, which edits an existing idea
 * and shows what became of it (author, promotion, dates): bending a reading
 * popup into a creation one would take a phantom item and as many "what if
 * the id does not exist" branches.
 *
 * What it must be: immediate. The title field has the focus on opening, Enter
 * adds, Escape closes (the frame sees to it) — otherwise it is no faster than
 * asking the agent, and that is its whole point.
 */

import { useState, type ReactElement, type ReactNode } from 'react';
import { toast } from 'sonner';
import { AttachmentsField, pastedFiles } from '@/components/attachments-field';
import { DetailShell } from '@/components/detail-shell';
import { useAttachmentItems } from '@/components/use-attachment-items';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { t } from '@/lib/i18n';
import type { TodoProgress, TodoUrgency } from '@/lib/project-todo-tags';
import { ProgressPicker, UrgencyPicker } from './project-todo-tag-chips';
import { RailGroup, TodoFormClose } from './todo-form-parts';
import { useTodoForm, type TodoFormValue } from './todo-form-context';

function Champ({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-[11px] font-medium text-muted-foreground first-letter:uppercase">{label}</label>
      {children}
    </div>
  );
}

export function ProjectTodoCreate(): ReactElement | null {
  const host = useTodoForm();
  if (!host) return null;
  return <Create host={host} />;
}

function Create({ host }: { host: TodoFormValue }): ReactElement {
  const [titre, setTitre] = useState('');
  // The project the screen opened on, still editable: an idea can be born in
  // one project's chat and concern another.
  const [slug, setSlug] = useState(host.defaultProject ?? '');
  const [description, setDescription] = useState('');
  const [enCours, setEnCours] = useState(false);
  const [urgency, setUrgency] = useState<TodoUrgency | null>(null);
  const [progress, setProgress] = useState<TodoProgress>('todo');
  // Held until the idea exists, then sent with its id.
  const files = useAttachmentItems(null, host.attachments, 'todo');
  const ids = { title: `${host.titleId}-text`, project: `${host.titleId}-project`, notes: `${host.titleId}-notes` };

  const creer = async () => {
    const text = titre.trim();
    if (!text) {
      toast.error(t('projectTodo.titleRequired'));
      return;
    }
    setEnCours(true);
    try {
      const result = await host.submit({
        text,
        project: slug.trim() || null,
        notes: description.trim() || null,
        urgency,
        progress,
      });
      if (!result.ok) {
        toast.error(t('projectTodo.createFailed'), { description: result.error });
        return;
      }
      const failed = await files.sendQueued(result.id);
      toast.success(t('projectTodo.created'));
      if (failed.length > 0) toast.error(t('projectTodo.attachments.partial', { names: failed.join(', ') }));
      host.finish();
    } finally {
      setEnCours(false);
    }
  };

  const header = (
    <div className="flex items-center gap-3">
      <h2 id={host.titleId} className="flex-1 text-[15px] font-semibold text-foreground">{t('projectTodo.newIdea')}</h2>
      <TodoFormClose onClose={host.close} />
    </div>
  );

  const rail = (
    <>
      <RailGroup label={t('projectTodo.fieldProject')}>
        <Input
          id={ids.project}
          aria-label={t('projectTodo.fieldProject')}
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void creer(); } }}
          placeholder={t('projectTodo.projectPlaceholder')}
          className="h-8 text-[12px]"
        />
      </RailGroup>
      <RailGroup label={t('projectTodo.fieldUrgency')}>
        <UrgencyPicker value={urgency} onChange={setUrgency} />
      </RailGroup>
      <RailGroup label={t('projectTodo.fieldProgress')}>
        <ProgressPicker value={progress} onChange={setProgress} />
      </RailGroup>
    </>
  );

  const footer = (
    <>
      <span className="text-[11.5px] text-muted-foreground">{t('projectTodo.submitHint')}</span>
      <Button type="button" disabled={enCours || !titre.trim()} onClick={() => void creer()}>
        {t('projectTodo.create')}
      </Button>
    </>
  );

  const attachments = (
    <AttachmentsField
      items={files.items}
      errors={files.errors}
      url={host.attachments.url}
      onAdd={files.add}
      onRemove={files.remove}
      onDismissErrors={files.dismissErrors}
      disabled={enCours}
      queuedLabel={t('projectTodo.attachments.queued')}
    />
  );

  // A pasted screenshot is attached wherever the focus is; a paste of text
  // carries no file and goes to its field.
  return (
    <div
      className="contents"
      onPaste={(e) => {
        const pasted = pastedFiles(e);
        if (pasted.length === 0) return;
        e.preventDefault();
        files.add(pasted);
      }}
    >
      <DetailShell
        header={header}
        rail={rail}
        footer={footer}
        attachments={attachments}
        attachmentsLabel={t('taskForm.attachments.label')}
      >
        <Champ label={t('projectTodo.fieldTitle')} htmlFor={ids.title}>
          <Input
            id={ids.title}
            autoFocus
            value={titre}
            onChange={(e) => setTitre(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void creer(); } }}
            placeholder={t('projectTodo.titlePlaceholder')}
            className="h-9 text-[13px]"
          />
        </Champ>

        {/* The description is optional: Enter adds a line, it is markdown.
            Ctrl/⌘+Enter adds the idea without leaving the field. */}
        <Champ label={t('projectTodo.fieldDescription')} htmlFor={ids.notes}>
          <Textarea
            id={ids.notes}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void creer(); }
            }}
            rows={12}
            placeholder={t('projectTodo.descriptionPlaceholder')}
            // code-font: markdown source being edited
            className="min-h-[12rem] font-mono text-[12px]"
          />
        </Champ>
      </DetailShell>
    </div>
  );
}
