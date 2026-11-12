'use client';

/**
 * What a beta build shows once it can no longer run: its end date passed, or
 * the licence ended. The daemon answers 403 on everything but licence, health,
 * auth, the data export and the update offer, so this screen calls nothing
 * else — no cockpit, no plugin host, no event stream behind it. Three ways
 * out: a newer version when one is published (the only one for a build past
 * its end), a new key (where a key can help), and the export, which has to
 * keep working.
 *
 * The licence is the active machine's (TODO #329): on a remote machine whose
 * licence ended, this screen is that machine's, and it says so — with the way
 * back to this computer, whose licence is not affected.
 */
import { FormEvent, useState, type ReactElement } from 'react';
import { Button } from '@/components/ui/button';
import { BackToLocalButton } from '@/components/machines/back-to-local';
import { LockScreenUpdateOffer } from '@/components/updates/update-banner';
import { activationErrorMessage, isActivationKey, type BetaLock, type LicenseRejection } from '@/lib/license';
import { t } from '@/lib/i18n';
import { formatDate as formatCalendarDate } from '@/lib/intl';

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : formatCalendarDate(date, { year: 'numeric', month: 'numeric', day: 'numeric' });
}

export function lockMessage(lock: BetaLock): { title: string; body: string } {
  if (lock.kind === 'build_expired') {
    const date = formatDate(lock.buildExpiresAt);
    return {
      title: t('betaLock.build_expired_title'),
      body: date ? t('betaLock.build_expired', { date }) : t('betaLock.build_expired_undated'),
    };
  }
  return { title: t(`betaLock.${lock.kind}_title`), body: t(`betaLock.${lock.kind}`) };
}

export function BetaLockScreen({ lock, machine, onActivated = () => { window.location.reload(); } }: {
  lock: BetaLock;
  /** Set when the lock is a remote machine's, not this computer's. */
  machine?: { name: string | null };
  /** What follows a successful activation; injectable because a test cannot reload a page. */
  onActivated?: () => void;
}): ReactElement {
  const [key, setKey] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [exportMessage, setExportMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const { title, body } = lockMessage(lock);
  // A key cannot revive a build that ended: only a newer version can.
  const canEnterKey = lock.kind !== 'build_expired';

  async function activate(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const trimmed = key.trim();
      const response = isActivationKey(trimmed)
        ? await fetch('/api/ui/license/activate', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: trimmed }),
        })
        : await fetch('/api/ui/license', {
          method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: trimmed }),
        });
      if (response.status === 403) { setMessage(t('betaLock.notAdmin')); return; }
      if (!response.ok) {
        setMessage(activationErrorMessage(await response.json().catch(() => ({})) as LicenseRejection, t));
        return;
      }
      // The event stream is walled while locked: nothing else will say the
      // state changed.
      onActivated();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function exportData(): Promise<void> {
    setExporting(true);
    setExportMessage(null);
    try {
      const response = await fetch('/api/ui/export', { method: 'POST' });
      if (response.status === 403) { setExportMessage(t('betaLock.exportAdminOnly')); return; }
      const result = await response.json().catch(() => ({})) as { ok?: boolean; out?: string };
      setExportMessage(response.ok && result.ok && result.out ? t('betaLock.exported', { path: result.out }) : t('betaLock.exportFailed'));
    } catch {
      setExportMessage(t('betaLock.exportFailed'));
    } finally {
      setExporting(false);
    }
  }

  async function signOut(): Promise<void> {
    await fetch('/api/ui/auth/logout', { method: 'POST' }).catch(() => undefined);
    window.location.assign('/login');
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <div className="grid w-full max-w-lg gap-4">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{t('betaLock.eyebrow')}</div>
          <h1 className="mt-1 text-[22px] font-semibold -tracking-[0.01em]">{title}</h1>
          <p className="mt-2 text-sm" role="alert">{body}</p>
        </div>

        <LockScreenUpdateOffer />

        {machine && (
          <section className="grid gap-3 rounded-xl bg-muted/40 p-5">
            <p className="m-0 max-w-[65ch] text-sm leading-snug">
              {t('machines.lock.remote', { name: machine.name ?? t('machines.lock.unnamed') })}
            </p>
            <div><BackToLocalButton /></div>
          </section>
        )}

        {canEnterKey && (
          <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
            <h2 className="m-0 text-sm font-semibold">{t('betaLock.keyTitle')}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{t('betaLock.keyHint')}</p>
            <form className="mt-4 space-y-3" onSubmit={(event) => { void activate(event); }}>
              <textarea
                /* code-font: pasted license key */ className="min-h-24 w-full rounded-md border border-border bg-background p-3 font-mono text-xs"
                value={key}
                onChange={(event) => { setKey(event.target.value); }}
                placeholder="TMN-XXXX-XXXX-XXXX-XXXX"
                aria-label={t('betaLock.keyTitle')}
                required
              />
              <Button type="submit" size="sm" disabled={busy || !key.trim()}>
                {busy ? t('betaLock.checking') : t('betaLock.submit')}
              </Button>
            </form>
            {message && <p className="mt-3 rounded-md border border-border p-3 text-sm" role="status">{message}</p>}
          </section>
        )}

        <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
          <h2 className="m-0 text-sm font-semibold">{t('betaLock.dataTitle')}</h2>
          <p className="mt-1 text-xs text-muted-foreground">{t('betaLock.dataDescription')}</p>
          <Button className="mt-4" variant="outline" size="sm" disabled={exporting} onClick={() => { void exportData(); }}>
            {exporting ? t('betaLock.exporting') : t('betaLock.export')}
          </Button>
          {exportMessage && <p className="mt-3 break-all rounded-md border border-border p-3 text-sm" role="status">{exportMessage}</p>}
        </section>

        <div>
          <Button variant="ghost" size="sm" onClick={() => { void signOut(); }}>{t('betaLock.signOut')}</Button>
        </div>
      </div>
    </main>
  );
}
