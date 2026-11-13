'use client';

import { useEffect } from 'react';
import { t } from '@/lib/i18n';

/**
 * Safety net for every page of the UI.
 *
 * Without it, an isolated client exception — a cockpit widget, a 3D canvas —
 * bubbles up to Next's global error boundary, which replaces the whole app
 * with a black screen with no recourse besides F5. Here we keep the shell
 * (nav, theme) and offer a real retry button.
 */
export default function ErrorUI({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Without this, the error leaves no trace consultable in production.
    console.error('[ui] uncaught error', error);
  }, [error]);

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <span className="text-2xl">⚠️</span>
      <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground/60">
        {t('error.crashed')}
      </p>
      <p className="max-w-md text-sm text-muted-foreground">
        {error.message || t('error.unknown')}
        {error.digest ? ` (${error.digest})` : ''}
      </p>
      <button
        type="button"
        onClick={reset}
        className="rounded-lg border border-primary/40 px-4 py-1.5 text-sm text-primary transition-colors hover:bg-primary/10"
      >
        {t('error.retry')}
      </button>
    </div>
  );
}
