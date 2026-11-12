'use client';

import { FormEvent, Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { t } from '@/lib/i18n';
import { fetchMe } from '@/lib/auth';
import { forgetAllChatMissions } from '@/lib/chat-mission-cache';
import { BrandLogo } from '@/components/brand-logo';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { apiErrorMessage } from '@/lib/api-error';
import { resolveInviteEndpoints, type InviteEndpoints } from '@/lib/invite-endpoints';

function InviteShell({ children }: { children: React.ReactNode }) {
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
          <BrandLogo className="h-11" alt="Rooks" />
        </div>
        <div className="rounded-xl border border-border bg-card p-6 shadow-elev-2 sm:p-7">
          {children}
        </div>
      </div>
    </div>
  );
}

function InviteForm() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token') ?? '';
  const [email, setEmail] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [missing, setMissing] = useState(false);
  const [endpoints, setEndpoints] = useState<InviteEndpoints | null>(null);

  useEffect(() => {
    let alive = true;
    if (!token) {
      setMissing(true);
      return;
    }
    void resolveInviteEndpoints()
      .then(async (resolved) => {
        if (alive) setEndpoints(resolved);
        // No plugin serves the accounts: no invitation can exist.
        return resolved ? fetch(resolved.lookup(token), { cache: 'no-store' }) : null;
      })
      .then(async (response) => {
        if (!alive) return;
        if (!response || !response.ok) {
          setMissing(true);
          return;
        }
        const payload = await response.json() as { email: string; name: string | null };
        setEmail(payload.email);
        setName(payload.name ?? '');
      });
    return () => { alive = false; };
  }, [token]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      if (!endpoints) throw new Error(t('invitePage.failed'));
      const response = await fetch(endpoints.accept, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, password, name }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) {
        throw new Error(apiErrorMessage(payload, t('invitePage.failed')));
      }
      // A session is set without a reload: a previous account's threads
      // must not be painted to this one (docs/CHAT-MISSION-CACHE.md).
      forgetAllChatMissions();
      await fetchMe();
      setSignedIn(true);
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (missing) {
    return (
      <InviteShell>
        <h1 className="text-lg font-semibold tracking-tight">{t('invitePage.title')}</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">{t('invitePage.invalid')}</p>
        <Link className={cn(buttonVariants({ variant: 'outline' }), 'mt-6 w-full')} href="/login">
          {t('loginPage.title')}
        </Link>
      </InviteShell>
    );
  }

  if (signedIn) {
    return (
      <InviteShell>
        <h1 className="text-lg font-semibold tracking-tight">{t('invitePage.title')}</h1>
        <Link className={cn(buttonVariants(), 'mt-6 w-full')} href="/">
          {t('invitePage.goHome')}
        </Link>
      </InviteShell>
    );
  }

  if (!email) {
    return (
      <InviteShell>
        <p className="text-sm text-muted-foreground">{t('loginPage.working')}</p>
      </InviteShell>
    );
  }

  return (
    <InviteShell>
      <h1 className="text-lg font-semibold tracking-tight">{t('invitePage.title')}</h1>
      <p className="mt-1.5 text-sm text-muted-foreground">
        {t('invitePage.description', { email })}
      </p>
      <form className="mt-6 space-y-4" onSubmit={(event) => { void submit(event); }}>
        <div className="space-y-1.5">
          <Label htmlFor="invite-name">{t('invitePage.name')}</Label>
          <Input
            id="invite-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="invite-password">{t('invitePage.password')}</Label>
          <Input
            id="invite-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            required
            minLength={8}
          />
        </div>
        <Button className="w-full" disabled={busy} type="submit">
          {busy ? t('invitePage.working') : t('invitePage.submit')}
        </Button>
      </form>
      {message && (
        <p
          className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="status"
        >
          {message}
        </p>
      )}
    </InviteShell>
  );
}

export default function InvitePage() {
  return (
    <Suspense fallback={null}>
      <InviteForm />
    </Suspense>
  );
}
