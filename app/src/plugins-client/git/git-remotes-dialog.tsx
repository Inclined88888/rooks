'use client';

/**
 * The remotes of a project, from the Publish tab of the Git widget (TODO #278).
 *
 * `gh repo create` only covers GitHub; a project kept on GitLab, Gitea or a
 * server of one's own needs `git remote add` in a terminal. This dialog lists
 * every remote and adds, re-points or removes one. Secrets stay out of it: an
 * https URL with a user or a token is refused before it is sent (SSH keys and
 * git's credential helper exist for that), and a remote saved but unreachable
 * shows git's own words — a missing SSH key and an unknown host do not read
 * the same, and hiding which one it is would leave nothing to fix.
 */

import { useCallback, useEffect, useState } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useAccess } from '@/hooks/use-me';
import { gitRepoId, invalidateGit, setGitRemote, type GitRemoteChange, type GitRemoteEntry } from '@/lib/git-store';
import { t } from '@/lib/i18n';
import { responseErrorText } from '@/lib/permission-refusal';
import { cn } from '@/lib/utils';
import { remoteFormIssue, validRemoteName } from './git-remotes-form';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  slug: string;
  /** The nested repository whose remotes are edited; null = the project root. */
  repo?: string | null;
  /** The remote pushes go to, marked in the list. */
  publication: string | null;
};

type Notice = { tone: 'ok' | 'warn'; text: string; detail?: string };

const JSON_HEADERS = { 'content-type': 'application/json' };

export function GitRemotesDialog({ open, onOpenChange, slug, repo = null, publication }: Props) {
  const [remotes, setRemotes] = useState<GitRemoteEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // null = the form adds a remote; a name = it re-points that one.
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  // Listing is a read; adding, re-pointing and removing are `projects:manage`.
  const manage = useAccess('projects:manage');

  const base = `/api/ui/git-remote/${encodeURIComponent(slug)}/remotes`;
  const q = repo ? `?repo=${encodeURIComponent(repo)}` : '';

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setRemotes(null);
    setLoadError(null);
    setEditing(null);
    setUrl('');
    setError(null);
    setNotice(null);
    setConfirming(null);
    void (async () => {
      try {
        const r = await fetch(`${base}${q}`, { cache: 'no-store' });
        const j = (await r.json()) as { remotes?: GitRemoteEntry[]; error?: string };
        if (!alive) return;
        if (r.ok && j.remotes) {
          setRemotes(j.remotes);
          // The name everyone expects for a first remote.
          setName(j.remotes.length ? '' : 'origin');
        } else {
          setLoadError(responseErrorText(j, `HTTP ${r.status}`));
        }
      } catch (e) {
        if (alive) setLoadError(String(e));
      }
    })();
    return () => { alive = false; };
  }, [open, base, q]);

  const apply = useCallback((change: GitRemoteChange) => {
    setRemotes(change.remotes);
    setGitRemote(gitRepoId(slug, repo), change.git);
    // The header, the branches and the composer read the same remote.
    invalidateGit();
  }, [slug, repo]);

  const backToAdd = useCallback(() => {
    setEditing(null);
    setName('');
    setUrl('');
    setError(null);
  }, []);

  const startEdit = (r: GitRemoteEntry) => {
    setEditing(r.name);
    setUrl(r.url ?? '');
    setError(null);
    setNotice(null);
    setConfirming(null);
  };

  const save = async () => {
    const target = editing ?? name.trim();
    setBusy('save');
    setError(null);
    setNotice(null);
    try {
      const r = editing
        ? await fetch(`${base}/${encodeURIComponent(editing)}${q}`, {
            method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ url: url.trim() }),
          })
        : await fetch(`${base}${q}`, {
            method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ name: target, url: url.trim() }),
          });
      const j = (await r.json()) as Partial<GitRemoteChange> & { error?: string };
      if (!r.ok || !j.git || !j.remotes) {
        setError(responseErrorText(j, `HTTP ${r.status}`));
        return;
      }
      apply({ git: j.git, remotes: j.remotes, check: j.check ?? null });
      if (j.check && !j.check.ok) {
        // Saved but unreachable: stay on it, the URL is what usually needs fixing.
        setEditing(target);
        setNotice({ tone: 'warn', text: t('gitWidget.remotes.unreached', { name: target }), detail: j.check.error });
      } else {
        backToAdd();
        setNotice({ tone: 'ok', text: t(j.check ? 'gitWidget.remotes.reached' : 'gitWidget.remotes.saved', { name: target }) });
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (target: string) => {
    setBusy(`remove:${target}`);
    setError(null);
    setNotice(null);
    try {
      const r = await fetch(`${base}/${encodeURIComponent(target)}${q}`, { method: 'DELETE' });
      const j = (await r.json()) as Partial<GitRemoteChange> & { error?: string };
      if (!r.ok || !j.git || !j.remotes) {
        setError(responseErrorText(j, `HTTP ${r.status}`));
        return;
      }
      apply({ git: j.git, remotes: j.remotes, check: null });
      if (editing === target) backToAdd();
      setNotice({ tone: 'ok', text: t('gitWidget.remotes.removed', { name: target }) });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  };

  const issue = remoteFormIssue(editing ? '' : name, url);
  const canSave = manage.allowed && busy === null && remotes !== null && !issue && url.trim() !== ''
    && (editing !== null || validRemoteName(name.trim()));

  return (
    <Dialog open={open} onOpenChange={(o) => busy === null && onOpenChange(o)}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="text-[15px]">{t('gitWidget.remotes.title')}</DialogTitle>
          <DialogDescription className="text-[12px]">{t('gitWidget.remotes.intro')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            {remotes === null && !loadError && (
              <p className="text-[12px] text-muted-foreground">{t('gitWidget.remotes.loading')}</p>
            )}
            {loadError && <p className="break-words text-[11.5px] text-red-400">{loadError}</p>}
            {remotes?.length === 0 && (
              <p className="text-[12px] text-muted-foreground">{t('gitWidget.remotes.empty')}</p>
            )}
            {remotes?.map((r) => (
              <div
                key={r.name}
                className={cn(
                  'flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px]',
                  editing === r.name ? 'bg-muted/70' : 'bg-muted/30',
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-medium">{r.name}</span>
                    {r.name === publication && (
                      <span className="shrink-0 rounded-full bg-primary/15 px-1.5 text-[10px] text-primary">
                        {t('gitWidget.remotes.publication')}
                      </span>
                    )}
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground" title={r.url ?? undefined}>
                    {r.url ?? '—'}
                  </div>
                  {r.push_url && (
                    <div className="truncate text-[11px] text-muted-foreground/80" title={r.push_url}>
                      {t('gitWidget.remotes.pushUrl', { url: r.push_url })}
                    </div>
                  )}
                </div>
                {confirming === r.name ? (
                  <>
                    <Button
                      variant="destructive"
                      size="sm"
                      className="h-6 px-2 text-[11px]"
                      disabled={busy !== null}
                      onClick={() => void remove(r.name)}
                    >
                      {busy === `remove:${r.name}` ? t('gitWidget.remotes.removing') : t('gitWidget.remotes.confirmRemove')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-[11px]"
                      disabled={busy !== null}
                      onClick={() => setConfirming(null)}
                    >
                      {t('common.cancel')}
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6 shrink-0"
                      disabled={busy !== null || !manage.allowed}
                      title={manage.denied ?? t('gitWidget.remotes.edit')}
                      aria-label={t('gitWidget.remotes.edit')}
                      onClick={() => startEdit(r)}
                    >
                      <Pencil className="size-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6 shrink-0 text-muted-foreground hover:text-red-400"
                      disabled={busy !== null || !manage.allowed}
                      title={manage.denied ?? t('gitWidget.remotes.remove')}
                      aria-label={t('gitWidget.remotes.remove')}
                      onClick={() => { setNotice(null); setConfirming(r.name); }}
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  </>
                )}
              </div>
            ))}
          </div>

          <div className="space-y-2 rounded-md bg-muted/20 p-2.5">
            <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
              {editing ? t('gitWidget.remotes.editTitle', { name: editing }) : t('gitWidget.remotes.addTitle')}
            </div>
            {!editing && (
              <div className="space-y-1">
                <label className="text-[11px] text-muted-foreground" htmlFor="git-remote-name">
                  {t('gitWidget.remotes.name')}
                </label>
                <Input
                  id="git-remote-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={!manage.allowed}
                  className="h-8 text-[12px]"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            )}
            <div className="space-y-1">
              <label className="text-[11px] text-muted-foreground" htmlFor="git-remote-url">
                {t('gitWidget.remotes.url')}
              </label>
              <Input
                id="git-remote-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                disabled={!manage.allowed}
                onKeyDown={(e) => { if (e.key === 'Enter' && canSave) void save(); }}
                placeholder={t('gitWidget.remotes.urlPlaceholder')}
                className="h-8 text-[12px]"
                autoComplete="off"
                spellCheck={false}
                autoFocus
              />
            </div>
            <p className={cn('text-[11px]', issue && !manage.denied ? 'text-amber-400' : 'text-muted-foreground/70')}>
              {manage.denied ?? (issue ? t(`gitWidget.remotes.issue.${issue}`) : t('gitWidget.remotes.urlHint'))}
            </p>
          </div>

          {notice && (
            <div
              className={cn(
                'rounded-md p-2 text-[11.5px]',
                notice.tone === 'warn' ? 'bg-amber-500/10 text-amber-400' : 'bg-emerald-500/10 text-emerald-400',
              )}
              role="status"
            >
              <p>{notice.text}</p>
              {notice.detail && (
                <p className="mt-1 whitespace-pre-wrap break-words text-foreground/80">{notice.detail}</p>
              )}
            </div>
          )}
          {error && <p className="whitespace-pre-wrap break-words text-[11.5px] text-red-400">{error}</p>}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-[11px]"
            disabled={busy !== null}
            onClick={() => (editing ? backToAdd() : onOpenChange(false))}
          >
            {editing ? t('gitWidget.remotes.cancelEdit') : t('gitWidget.remotes.close')}
          </Button>
          <Button
            size="sm"
            className="h-7 text-[11px]"
            disabled={!canSave}
            title={manage.denied ?? undefined}
            onClick={() => void save()}
          >
            {busy === 'save'
              ? t('gitWidget.remotes.saving')
              : editing
                ? t('gitWidget.remotes.save')
                : t('gitWidget.remotes.add')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
