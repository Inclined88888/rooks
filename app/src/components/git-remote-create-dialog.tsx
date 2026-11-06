'use client';

/**
 * Remote repo creation modal, opened from the "Git publishing" block.
 *
 * It exists because `gh repo create` is irreversible on GitHub's side: the
 * repo name (derived from the FOLDER, not the TIMON slug) and visibility
 * must be readable and editable before the click, not guessed afterwards.
 * The modal also shows what will be pushed and under which account — the
 * other two possible surprises.
 */

import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Lock, Globe } from 'lucide-react';
import { t } from '@/lib/i18n';

export type CreateRemoteOptions = {
  name: string;
  private: boolean;
  description: string;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-filled name, derived from the folder on the orchestrator side. */
  defaultName: string;
  branch: string | null;
  /** Commits that will leave with the initial `--push`. */
  commits: number | null;
  ghAccount: string | null;
  busy: boolean;
  /** Error from the last attempt — the modal stays open to fix it (name
   *  already taken, in particular, the most frequent failure case). */
  error: string | null;
  onSubmit: (opts: CreateRemoteOptions) => void;
};

/** GitHub constraint: anything outside this alphabet becomes a dash. */
function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '-');
}

export function GitRemoteCreateDialog({
  open, onOpenChange, defaultName, branch, commits, ghAccount, busy, error, onSubmit,
}: Props) {
  const [name, setName] = useState(defaultName);
  const [isPrivate, setIsPrivate] = useState(true);
  const [description, setDescription] = useState('');

  // The default name only arrives with the first status: re-sync on each
  // open, otherwise the modal keeps an empty field on the first render.
  useEffect(() => {
    if (open) setName(defaultName);
  }, [open, defaultName]);

  const clean = sanitize(name.trim());
  const valid = clean.length > 0;

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="text-[15px]">{t('gitRemoteCreate.title')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground" htmlFor="repo-name">
              {t('gitRemoteCreate.repoName')}
            </label>
            <Input
              id="repo-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-8 text-[12px]"
              autoFocus
            />
            <p className="text-[11px] text-muted-foreground/70">
              {ghAccount ? `${ghAccount}/${clean || '…'}` : clean || '…'}
              {clean && clean !== name.trim() && ` · ${t('gitRemoteCreate.charsReplaced')}`}
            </p>
          </div>

          <div className="space-y-1">
            <span className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
              {t('gitRemoteCreate.visibility')}
            </span>
            <div className="flex gap-1.5">
              <Button
                type="button"
                variant={isPrivate ? 'default' : 'outline'}
                size="sm"
                className="h-7 flex-1 gap-1 text-[11px]"
                onClick={() => setIsPrivate(true)}
              >
                <Lock className="size-3" /> {t('gitRemoteCreate.private')}
              </Button>
              <Button
                type="button"
                variant={!isPrivate ? 'default' : 'outline'}
                size="sm"
                className="h-7 flex-1 gap-1 text-[11px]"
                onClick={() => setIsPrivate(false)}
              >
                <Globe className="size-3" /> {t('gitRemoteCreate.public')}
              </Button>
            </div>
            {!isPrivate && (
              <p className="text-[11px] text-amber-400">
                {t('gitRemoteCreate.publicWarning')}{' '}
                <code /* code-font: file name */ className="font-mono">.gitignore</code> {t('gitRemoteCreate.publicWarningEnd')}
              </p>
            )}
          </div>

          <div className="space-y-1">
            <label className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground" htmlFor="repo-desc">
              {t('gitRemoteCreate.description')} <span className="normal-case tracking-normal">({t('gitRemoteCreate.optional')})</span>
            </label>
            <Textarea
              id="repo-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="resize-none text-[12px]"
            />
          </div>

          <div className="rounded border border-border/60 bg-muted/30 p-2 text-[11px] text-muted-foreground">
            <div>
              {t('gitRemoteCreate.branchPushed')} : <span className="text-foreground/90">{branch ?? '—'}</span>
              {branch && ` — ${t('gitRemoteCreate.becomesDefault')}`}
            </div>
            {commits !== null && (
              <div>
                {t('gitRemoteCreate.commitsWillLeave', { count: commits })}
              </div>
            )}
            <div>
              {t('gitRemoteCreate.account')} : <span className="text-foreground/90">{ghAccount ?? t('gitRemoteCreate.unknown')}</span>
            </div>
          </div>

          {error && <p className="break-words text-[11.5px] text-red-400">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" className="h-7 text-[11px]" disabled={busy} onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            size="sm"
            className="h-7 text-[11px]"
            disabled={busy || !valid}
            onClick={() => onSubmit({ name: clean, private: isPrivate, description: description.trim() })}
          >
            {busy ? t('gitRemoteCreate.creating') : t('gitRemoteCreate.createAndPush')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
