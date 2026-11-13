'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Ban, Lock, Plus, ScrollText, Search, SquareSlash } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { prepareSkillWrite } from '@/lib/skill-save';
import { onSkillsChanged, openSkillIsland } from '@/lib/skill-island-content';
import { type Skill, type SkillSource } from '@/lib/skill-sources';
import { formatRelativeTime } from '@/lib/intl';
import { PageTocLayout } from '@/components/page-toc/page-toc';
import { skillReachesMissions } from '@/lib/skill-import';
import { BRAND } from '@/lib/brand';

/** Sections displayed in order: the key of their label and of its hint. */
const SECTIONS: { source: SkillSource; key: string }[] = [
  { source: 'rooks', key: 'sectionRooks' },
  { source: 'claude-user', key: 'sectionUser' },
  { source: 'project', key: 'sectionProject' },
  { source: 'plugin', key: 'sectionPlugin' },
];

/** The tile of a skill takes its source's colour: the section it sits in, at a glance. */
const SKILL_SOURCE_TILE: Record<SkillSource, string> = {
  rooks: 'bg-primary/15 text-primary',
  'claude-user': 'bg-sky-500/15 text-sky-500',
  project: 'bg-emerald-500/15 text-emerald-500',
  plugin: 'bg-amber-500/15 text-amber-500',
};

const NEW_SKILL_PATH = '~/.rooks/skills/<id>/SKILL.md';

/**
 * The skills catalog. A skill opens in the island workspace
 * (`components/skills/skill-island.tsx`), previewed, with the shared editor
 * one click away; this page only lists them and creates a new one.
 * `leading` opens the toolbar row: the Capabilities page puts its tabs there.
 */
export function SkillsClient({ leading }: { leading?: ReactNode } = {}) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);

  const fetchSkills = useCallback(async () => {
    try {
      const r = await fetch('/api/ui/skills', { cache: 'no-store' });
      const j = r.ok ? await r.json() : { skills: [] };
      setSkills(j.skills || []);
    } catch {
      setSkills([]);
    }
  }, []);

  useEffect(() => {
    void fetchSkills();
    return onSkillsChanged(() => { void fetchSkills(); });
  }, [fetchSkills]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter(
      (s) =>
        s.id.toLowerCase().includes(q)
        || (s.title || '').toLowerCase().includes(q)
        || (s.description || '').toLowerCase().includes(q),
    );
  }, [skills, query]);

  const grouped = useMemo(
    () => SECTIONS.map((sec) => ({ ...sec, items: visible.filter((s) => s.source === sec.source) }))
      .filter((sec) => sec.items.length > 0),
    [visible],
  );

  const brand = { brand: BRAND.displayName };

  return (
    <>
      <div className={cn('flex flex-wrap items-center gap-2 pb-4', !leading && 'mt-5')}>
        {leading}
        <div className="flex items-center gap-1.5 rounded-lg border border-border bg-muted/30 px-2.5 py-1.5 text-[12.5px]">
          <Search className="size-3.5 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('skillsPage.search')}
            aria-label={t('skillsPage.search')}
            className="border-0 bg-transparent text-[12.5px] outline-none placeholder:text-muted-foreground/70"
          />
        </div>
        <div className="flex-1" />
        <span className="text-[12.5px] tabular-nums text-muted-foreground">
          {t('skillsPage.count', { count: skills.length })}
        </span>
        <Button
          size="sm"
          onClick={() => setCreating(true)}
          className="h-8 gap-1.5 font-semibold"
        >
          <Plus className="size-3.5" /> {t('skillsPage.newSkill', brand)}
        </Button>
      </div>

      {grouped.length ? (
        <PageTocLayout>
          <div className="flex flex-col gap-6">
            {grouped.map((sec) => {
              const label = t(`skillsPage.${sec.key}`, brand);
              return (
                <section key={sec.source} aria-labelledby={`skills-${sec.source}`}>
                  <h2
                    id={`skills-${sec.source}`}
                    data-toc={label}
                    data-toc-count={sec.items.length}
                    className="m-0 text-[13px] font-semibold"
                  >
                    {label} <span className="ml-1 font-normal tabular-nums text-muted-foreground">{sec.items.length}</span>
                  </h2>
                  <p className="m-0 mb-1.5 mt-0.5 text-[12px] text-muted-foreground">{t(`skillsPage.${sec.key}Hint`, brand)}</p>
                  <div className="grid grid-cols-1 gap-x-8 gap-y-0.5 xl:grid-cols-2">
                    {sec.items.map((s) => <SkillRow key={s.source + ':' + s.id} skill={s} />)}
                  </div>
                </section>
              );
            })}
          </div>
        </PageTocLayout>
      ) : (
        <p className="m-0 mt-4 text-[13px] text-muted-foreground">
          {t('skillsPage.empty', { ...brand, path: NEW_SKILL_PATH })}
        </p>
      )}

      <NewSkillDialog
        open={creating}
        onOpenChange={setCreating}
        taken={(id) => skills.some((s) => s.source === 'rooks' && s.id === id)}
        onCreated={(id) => {
          setCreating(false);
          void fetchSkills();
          openSkillIsland(id, 'edit');
        }}
      />
    </>
  );
}

/** One skill: its tile, name and description, and when it last changed; it opens previewed in the island. */
function SkillRow({ skill: s }: { skill: Skill }) {
  const command = s.format === 'claude-cmd';
  const Icon = command ? SquareSlash : ScrollText;
  // A masked entry opens its own file, not the one masking it.
  const open = () => openSkillIsland(s.id, 'preview', s.shadowed ? { source: s.source, format: s.format } : undefined);
  return (
    <article
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      }}
      className={cn(
        'flex cursor-pointer items-center gap-3 rounded-xl px-2 py-2 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        s.shadowed && 'opacity-55',
      )}
    >
      <span
        title={t(command ? 'skillIsland.command' : 'skillIsland.skill')}
        className={cn('inline-flex size-10 shrink-0 items-center justify-center rounded-[10px]', SKILL_SOURCE_TILE[s.source])}
      >
        <Icon className="size-[18px]" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13.5px] font-medium">/{s.id}</span>
          {!s.editable && <Lock className="size-3 shrink-0 text-muted-foreground/60" aria-label={t('skillsPage.readOnly')} />}
          {!skillReachesMissions(s.source) && (
            <span title={t('skillMission.unavailableHint', { brand: BRAND.displayName })} className="inline-flex shrink-0">
              <Ban className="size-3 text-muted-foreground/60" aria-hidden />
              <span className="sr-only">{t('skillMission.unavailable')}</span>
            </span>
          )}
        </div>
        <div className="truncate text-[12.5px] text-muted-foreground">{s.description || s.title || s.id}</div>
      </div>
      <span className="shrink-0 px-2 text-[12px] tabular-nums text-muted-foreground">
        {s.shadowed ? t('skillsPage.shadowed') : formatRelativeTime(s.updated_at)}
      </span>
    </article>
  );
}

/**
 * Names the new skill, writes it from a template, and hands it to the island
 * in the editor. The island reads an existing file by its id (its params must
 * still mean something after a reload), so the file exists before it opens.
 */
function NewSkillDialog({ open, onOpenChange, taken, onCreated }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  taken: (id: string) => boolean;
  onCreated: (id: string) => void;
}) {
  const [id, setId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const brand = { brand: BRAND.displayName };

  useEffect(() => {
    if (!open) return;
    setId('');
    setError('');
    const timer = setTimeout(() => inputRef.current?.focus(), 60);
    return () => clearTimeout(timer);
  }, [open]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const trimmed = id.trim();
    const prepared = prepareSkillWrite({ id: trimmed, content: t('skillsPage.template', { id: trimmed }) });
    if (!prepared.ok) {
      setError(t('skillForm.idError'));
      return;
    }
    if (taken(trimmed)) {
      setError(t('skillsPage.exists', brand));
      return;
    }
    setError('');
    setBusy(true);
    try {
      const r = await fetch('/api/ui/skills', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(prepared.payload),
      });
      if (!r.ok) {
        setError(t(r.status === 401 ? 'skillForm.unauthorized' : r.status === 403 ? 'skillForm.forbidden' : 'skillForm.failed'));
        return;
      }
      onCreated(trimmed);
    } catch {
      setError(t('skillForm.network'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[440px]">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t('skillsPage.createTitle', brand)}</DialogTitle>
            <DialogDescription>{t('skillsPage.createHint', { path: NEW_SKILL_PATH })}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Input
              ref={inputRef}
              aria-label={t('skillForm.idLabel')}
              aria-invalid={!!error}
              aria-describedby={error ? 'new-skill-error' : undefined}
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="skill-id"
              autoComplete="off"
              spellCheck={false}
            />
            {error && <p id="new-skill-error" role="alert" className="text-sm text-destructive">{error}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t('skillsPage.cancel')}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? t('skillsPage.creating') : t('skillsPage.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
