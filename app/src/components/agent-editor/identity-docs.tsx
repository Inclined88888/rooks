'use client';

import { useState } from 'react';
import { FilePlus2, Pencil, Plus, X } from 'lucide-react';

import { Textarea } from '@/components/ui/textarea';
import { t } from '@/lib/i18n';
import { mdToSafeHtml } from '@/lib/markdown';
import { cn } from '@/lib/utils';

export const SYSTEM_PROMPT_DOC = 'system-prompt.md';

/** Files worth adding, offered while they do not exist. Every `.md` of the
 *  agent is sent to the model, so each one is a real lever, not a note. */
export const DOC_SUGGESTIONS: { name: string; template: string }[] = [
  { name: 'SOUL.md', template: '# Who you are\n\nName, personality, values, how you talk to the people you work with.\n' },
  { name: 'charter.md', template: '# Charter\n\n## Mission\n\nWhat you are here to do.\n\n## Out of scope\n\nWhat you never do, and who to hand it to.\n' },
  { name: 'rules.md', template: '# Rules\n\n- A hard rule you always follow.\n- Another one.\n' },
  { name: 'style.md', template: '# Style\n\n- Language and tone.\n- How long an answer should be.\n- Formats you use (lists, tables, code blocks).\n' },
  { name: 'glossary.md', template: '# Glossary\n\n- **Term** — what it means here.\n' },
  { name: 'examples.md', template: '# Examples\n\n## A request\n\n> What the user says.\n\n## A good answer\n\nWhat you reply.\n' },
];

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** A doc name typed by the user, made into a valid file name; null when it cannot be. */
export function docNameOf(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const name = trimmed.toLowerCase().endsWith('.md') ? trimmed : `${trimmed}.md`;
  return /^[\w.-]+\.md$/.test(name) ? name : null;
}

/** The list of docs the agent has, `system-prompt.md` first, then `SOUL.md`, then by name. */
export function orderedDocs(names: readonly string[]): string[] {
  const rank = (n: string): number => (same(n, 'soul.md') ? 0 : 1);
  return [SYSTEM_PROMPT_DOC, ...names.filter((n) => !same(n, SYSTEM_PROMPT_DOC)).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))];
}

export type IdentityDocsProps = {
  /** The saved agent, or null while it is not created: a doc is a file of its folder. */
  agent: string | null;
  systemPrompt: string;
  onSystemPrompt: (text: string) => void;
  /** The other `.md` files of the agent, by name. */
  docs: Record<string, string>;
  onDoc: (name: string, text: string) => void;
  /** Creates the file; false when it could not be (the parent says why). */
  onCreate: (name: string, template: string) => Promise<boolean>;
  onDelete: (name: string) => void;
};

/**
 * The "Identity docs" of an agent: its `.md` files in a column, the one picked
 * shown as rendered markdown, an Edit button to change it. Files that do not
 * exist yet are listed dimmed, with what they are for: one click creates them
 * from a starter.
 */
export function IdentityDocs({ agent, systemPrompt, onSystemPrompt, docs, onDoc, onCreate, onDelete }: IdentityDocsProps) {
  const [active, setActive] = useState(SYSTEM_PROMPT_DOC);
  const [editing, setEditing] = useState(false);
  const [naming, setNaming] = useState(false);
  const [draftName, setDraftName] = useState('');

  const names = orderedDocs(Object.keys(docs));
  const shown = names.includes(active) ? active : SYSTEM_PROMPT_DOC;
  const text = shown === SYSTEM_PROMPT_DOC ? systemPrompt : docs[shown] ?? '';
  const missing = DOC_SUGGESTIONS.filter((s) => !names.some((n) => same(n, s.name)));

  const pick = (name: string) => { setActive(name); setEditing(false); };
  const create = async (name: string, template: string) => {
    if (await onCreate(name, template)) { setActive(name); setEditing(template === ''); }
  };
  const submitName = async () => {
    const name = docNameOf(draftName);
    if (!name) return;
    setNaming(false);
    setDraftName('');
    await create(name, '');
  };

  return (
    <div className="grid gap-4 md:grid-cols-[14rem_minmax(0,1fr)]">
      <aside className="flex flex-col gap-3">
        <ul aria-label={t('identityDocs.list')} className="flex flex-col gap-1">
          {names.map((name) => (
            <li key={name} className="group relative">
              <button type="button" aria-current={shown === name} onClick={() => pick(name)}
                className={cn(
                  'flex w-full flex-col gap-0.5 rounded-lg border px-2.5 py-1.5 text-left',
                  shown === name ? 'border-primary/60 bg-primary/5' : 'border-border bg-card/40 hover:border-primary/40',
                )}>
                <span /* code-font: file name */ className="break-all font-mono text-[12px]">{name}</span>
                <span className="text-[10.5px] text-muted-foreground">{t(`identityDocs.what.${docKey(name)}`)}</span>
              </button>
              {name !== SYSTEM_PROMPT_DOC && (
                <button type="button" aria-label={t('identityDocs.delete', { name })} onClick={() => onDelete(name)}
                  className="absolute right-1.5 top-1.5 rounded p-0.5 text-muted-foreground/60 opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100">
                  <X className="size-3" />
                </button>
              )}
            </li>
          ))}
        </ul>

        {missing.length > 0 && (
          <div className="flex flex-col gap-1">
            <p className="px-0.5 text-[10.5px] uppercase tracking-wide text-muted-foreground/70">{t('identityDocs.canAdd')}</p>
            <ul aria-label={t('identityDocs.suggestions')} className="flex flex-col gap-1">
              {missing.map((s) => (
                <li key={s.name}>
                  <button type="button" disabled={!agent} onClick={() => void create(s.name, s.template)}
                    className="flex w-full items-start gap-2 rounded-lg border border-dashed border-border px-2.5 py-1.5 text-left opacity-70 hover:border-primary/50 hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-40">
                    <FilePlus2 className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span /* code-font: file name */ className="break-all font-mono text-[12px]">{s.name}</span>
                      <span className="text-[10.5px] text-muted-foreground">{t(`identityDocs.what.${docKey(s.name)}`)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {naming ? (
          <input
            autoFocus
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitName();
              if (e.key === 'Escape') { setNaming(false); setDraftName(''); }
            }}
            onBlur={() => { if (!draftName.trim()) setNaming(false); }}
            aria-label={t('identityDocs.newName')}
            placeholder={t('identityDocs.newName')}
            /* code-font: file name input */ className="rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[12px] outline-none focus:border-primary/60"
          />
        ) : (
          <button type="button" disabled={!agent} onClick={() => setNaming(true)}
            className="inline-flex items-center justify-center gap-1.5 rounded-md border border-border px-2 py-1.5 text-[12px] text-muted-foreground hover:border-primary/50 hover:text-primary disabled:cursor-not-allowed disabled:opacity-40">
            <Plus className="size-3.5" aria-hidden />
            {t('identityDocs.new')}
          </button>
        )}
        {!agent && <p className="text-[10.5px] text-muted-foreground/70">{t('identityDocs.saveFirst')}</p>}
      </aside>

      <section className="flex min-w-0 flex-col gap-2">
        <div className="flex items-center gap-2">
          <h3 /* code-font: file name */ className="min-w-0 flex-1 truncate font-mono text-[13px] font-semibold">{shown}</h3>
          <button type="button" aria-pressed={editing} onClick={() => setEditing((v) => !v)}
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:border-primary/50 hover:text-primary">
            <Pencil className="size-3" aria-hidden />
            {editing ? t('identityDocs.done') : t('identityDocs.edit')}
          </button>
        </div>
        {editing ? (
          <Textarea
            key={shown}
            /* code-font: markdown source editor */ className="min-h-[320px] resize-y bg-background/60 font-mono text-[12.5px] leading-relaxed"
            value={text}
            spellCheck={false}
            aria-label={t('identityDocs.editor', { name: shown })}
            onChange={(e) => (shown === SYSTEM_PROMPT_DOC ? onSystemPrompt(e.target.value) : onDoc(shown, e.target.value))}
          />
        ) : text.trim() ? (
          // `chat-bubble` carries the typography of rendered markdown (globals.css).
          <div className="chat-bubble max-h-[60vh] min-h-[10rem] overflow-y-auto rounded-md border border-border bg-background/40 px-3 py-2 text-[13px]"
            dangerouslySetInnerHTML={{ __html: mdToSafeHtml(text) }} />
        ) : (
          <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-[12px] text-muted-foreground">{t('identityDocs.empty')}</p>
        )}
        <p className="text-[11px] text-muted-foreground/70">
          {shown === SYSTEM_PROMPT_DOC ? t('identityDocs.savedWithForm') : t('identityDocs.autosaves')}
        </p>
      </section>
    </div>
  );
}

/** The locale key of what a file is for; a file of the user's own has none. */
function docKey(name: string): string {
  const known = ['system-prompt.md', 'soul.md', 'charter.md', 'rules.md', 'style.md', 'glossary.md', 'examples.md'];
  const hit = known.find((k) => same(k, name));
  return hit ? hit.replace(/\.md$/, '').replace('-', '') : 'other';
}
