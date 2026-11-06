'use client';

/**
 * Lands here from the confirmation link. Public, like `/invite`: the link is
 * followed from a mail client, which carries no session cookie of ours — the
 * token in the URL is the whole credential.
 *
 * Confirming is a POST and not a side effect of loading the page: a link
 * prefetcher or a mail scanner following it must not consume the token behind
 * its owner's back. Hence the button.
 */

import Link from 'next/link';
import { useState, type ReactElement } from 'react';
import { BrandLogo } from '@/components/brand-logo';
import { Button, buttonVariants } from '@/components/ui/button';
import { BRAND } from '@/lib/brand';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { apiErrorMessage } from '@/lib/api-error';

function Shell({ children }: { children: React.ReactNode }): ReactElement {
  return (
    <div className="relative flex min-h-screen w-full items-center justify-center overflow-auto bg-background px-4 py-10">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            'radial-gradient(ellipse 55% 45% at 50% 15%, hsl(var(--primary) / 0.10), transparent 70%)',
        }}
      />
      <div className="relative w-full max-w-sm">
        <div className="mb-8 flex justify-center">
          <BrandLogo className="h-11" alt={BRAND.displayName} />
        </div>
        <div className="rounded-xl border border-border bg-card p-6 shadow-elev-2 sm:p-7">
          {children}
        </div>
      </div>
    </div>
  );
}

export function ConfirmEmailClient({ token }: { token: string }): ReactElement {
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [email, setEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function confirm(): Promise<void> {
    setState('busy');
    setError(null);
    try {
      const response = await fetch('/api/ui/auth/email/confirm', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const body = await response.json().catch(() => ({})) as { email?: string; error?: string };
      if (!response.ok) {
        setError(apiErrorMessage(body, t('confirmEmail.failed')));
        setState('idle');
        return;
      }
      setEmail(body.email ?? null);
      setState('done');
    } catch {
      setError(t('confirmEmail.failed'));
      setState('idle');
    }
  }

  if (state === 'done') {
    return (
      <Shell>
        <h1 className="m-0 text-lg font-semibold">{t('confirmEmail.doneTitle')}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {t('confirmEmail.doneBody', { email: email ?? '' })}
        </p>
        <Link href="/login" className={cn(buttonVariants({ size: 'sm' }), 'mt-4 no-underline')}>
          {t('confirmEmail.signIn')}
        </Link>
      </Shell>
    );
  }

  return (
    <Shell>
      <h1 className="m-0 text-lg font-semibold">{t('confirmEmail.title')}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{t('confirmEmail.body')}</p>
      {error && <p className="mt-3 text-sm text-destructive" role="alert">{error}</p>}
      <Button
        type="button"
        size="sm"
        className="mt-4"
        disabled={state === 'busy'}
        onClick={() => { void confirm(); }}
      >
        {state === 'busy' ? t('confirmEmail.confirming') : t('confirmEmail.confirm')}
      </Button>
    </Shell>
  );
}
