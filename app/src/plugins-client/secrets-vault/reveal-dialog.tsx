'use client';

/**
 * Re-display of a stored secret, behind the account password (amendment of the
 * write-only vault, 16/10/2026).
 *
 * The value lives ONLY in this component's state: never in the editor, never
 * in `SecretSummary`, so the PUT path cannot send it back and the write-only
 * model of `@/lib/secrets` keeps type-checking. It is wiped on close, on
 * timeout, and when the tab is hidden.
 */
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { t } from '@/lib/i18n';

/** How long a revealed value stays on screen. */
const AUTO_HIDE_MS = 30_000;

async function revealError(res: Response): Promise<string> {
  if (res.status === 401) return t('secretsPage.reveal.wrongPassword');
  if (res.status === 429) return t('secretsPage.reveal.tooMany');
  if (res.status === 403) return t('secretsPage.reveal.forbidden');
  return t('secretsPage.reveal.failed');
}

export function RevealDialog({
  secret,
  onClose,
}: {
  secret: { id: string; name: string } | null;
  onClose: () => void;
}) {
  const [password, setPassword] = useState('');
  const [value, setValue] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function wipe(): void {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setPassword('');
    setValue(null);
    setShown(false);
    setError(null);
  }

  function close(): void {
    wipe();
    onClose();
  }

  // A secret change (or unmount) never leaves a previous value behind.
  useEffect(() => wipe, [secret?.id]);

  useEffect(() => {
    if (value === null) return;
    const hide = (): void => {
      if (document.hidden) close();
    };
    document.addEventListener('visibilitychange', hide);
    return () => document.removeEventListener('visibilitychange', hide);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  async function submit(): Promise<void> {
    if (!secret || !password) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/ui/secrets/${encodeURIComponent(secret.id)}/reveal`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        setError(await revealError(res));
        setPassword('');
        return;
      }
      const data = (await res.json()) as { value?: string };
      setPassword('');
      setValue(data.value ?? '');
      timer.current = setTimeout(close, AUTO_HIDE_MS);
    } catch {
      setError(t('secretsPage.reveal.failed'));
    } finally {
      setBusy(false);
    }
  }

  async function copy(): Promise<void> {
    if (value === null) return;
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t('secretsPage.reveal.copied'));
    } catch {
      toast.error(t('secretsPage.reveal.copyFailed'));
    }
  }

  return (
    <Dialog open={secret !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('secretsPage.reveal.title', { name: secret?.name ?? '' })}</DialogTitle>
          <DialogDescription>
            {t(value === null ? 'secretsPage.reveal.askPassword' : 'secretsPage.reveal.autoHide', {
              seconds: String(AUTO_HIDE_MS / 1000),
            })}
          </DialogDescription>
        </DialogHeader>
        {value === null ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <Input
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              placeholder={t('secretsPage.reveal.passwordPlaceholder')}
              onChange={(e) => setPassword(e.target.value)}
            />
            {error ? <p className="text-[12px] text-destructive">{error}</p> : null}
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={close}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" disabled={busy || !password}>
                {t('secretsPage.reveal.confirm')}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="flex flex-col gap-3">
            {/* code-font: the value is a token to read character by character */}
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-3 font-mono text-[12px]">
              {shown ? value : '•'.repeat(Math.min(value.length, 40))}
            </pre>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShown((s) => !s)}>
                {t(shown ? 'secretsPage.reveal.hide' : 'secretsPage.reveal.show')}
              </Button>
              <Button type="button" variant="outline" onClick={() => void copy()}>
                {t('secretsPage.reveal.copy')}
              </Button>
              <Button type="button" onClick={close}>
                {t('secretsPage.reveal.close')}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
