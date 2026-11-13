'use client';

/**
 * Optional local account. Email and password are never required to reach the
 * desk — Skip continues. Creating an account is always local on this machine:
 * no email-code request, no mail-relay / internet gate. Confirmation mail is
 * never part of first-run setup.
 */
import { useCallback, useEffect, useId, useState, type FormEvent, type ReactElement, type ReactNode } from 'react';
import { ArrowRight, Loader2, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AgentMascotHost } from '@/components/mascot/agent-mascot';
import { PasswordInput } from '@/components/auth/password-input';
import { accountName, looksLikeEmail, passwordPairReady, passwordProblem, MIN_PASSWORD } from '@/components/auth/auth-form';
import { createAccount } from '@/components/email-code/email-code-api';
import { failureText, type CodeFailure } from '@/components/email-code/email-code-failure';
import { fetchMe } from '@/lib/auth';
import { firstRunScheme } from '@/lib/first-run-gate';
import { t } from '@/lib/i18n';
import { useOnboarding } from '../onboarding-context';

const LOOK = { shape: 'round', color: '#ff8a2a', eyes: 'big' } as const;

export type AccountDraft = { name: string; email: string; password: string; confirm: string; setupToken: string };

const EMPTY: AccountDraft = { name: '', email: '', password: '', confirm: '', setupToken: '' };

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }): ReactElement {
  return (
    <div>
      <Label htmlFor={id} className="mb-1.5 ml-0.5 block text-[12.5px] font-semibold text-muted-foreground">
        {label}
        <span className="ml-1.5 font-normal text-muted-foreground/80">({t('onboarding.account.optional')})</span>
      </Label>
      {children}
      {hint && <p id={`${id}-hint`} className="ml-0.5 mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function AccountStep(): ReactElement {
  const { next, goTo } = useOnboarding();
  const ids = useId();
  const [draft, setDraft] = useState<AccountDraft>(EMPTY);
  const [shown, setShown] = useState(false);
  const [needsToken, setNeedsToken] = useState(false);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<CodeFailure | null>(null);

  useEffect(() => {
    let alive = true;
    void fetchMe().then((me) => {
      if (!alive) return;
      if (me.user) {
        next();
        return;
      }
      // Stay on optional create + Skip while the daemon is warming
      // (needsSetup true) or still unknown. Only a definitive
      // "setup already done" answer leaves for Welcome-back sign-in.
      if (me.needsSetup) {
        setNeedsToken(me.setupRequiresToken === true);
        return;
      }
      goTo('signin');
    }).catch(() => {
      // Network blip / daemon starting: keep create + Skip, never scare.
    });
    return () => { alive = false; };
  }, [next, goTo]);

  const set = (field: keyof AccountDraft) => (e: { target: { value: string } }) => {
    const value = e.target.value;
    setDraft((d) => ({ ...d, [field]: value }));
  };

  const email = draft.email.trim();
  const problem = passwordProblem(draft.password, draft.confirm);
  const waiting = failureText(failure, Date.now());
  const hasCredentials = looksLikeEmail(email) && passwordPairReady(draft.password, draft.confirm);
  const ready = hasCredentials && (!needsToken || draft.setupToken.trim() !== '');

  const createLocal = useCallback(async (): Promise<CodeFailure | null> => {
    const scheme = firstRunScheme();
    const answer = await createAccount({
      email,
      name: accountName(draft.name, email),
      password: draft.password,
      ...(scheme ? { scheme } : {}),
      ...(needsToken ? { setupToken: draft.setupToken.trim() } : {}),
    });
    return answer.ok ? null : answer.failure;
  }, [email, draft.name, draft.password, draft.setupToken, needsToken]);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!ready || sending) return;
    setSending(true);
    setFailure(null);
    // Always local: never POST /setup/email-code, never gate on mail relay.
    const local = await createLocal();
    setSending(false);
    if (!local) next();
    else setFailure(local);
  };

  const line = waiting ?? (problem === 'mismatch' ? t('onboarding.account.mismatch') : problem === 'short' ? t('onboarding.account.tooShort', { min: MIN_PASSWORD }) : null);
  const toggle = () => setShown((s) => !s);

  return (
    <div className="relative mx-auto flex w-full max-w-[440px] flex-col items-start px-8 py-8 text-left">
      <div className="rooks-onboarding-rise">
        <AgentMascotHost look={LOOK} size={56} />
      </div>
      <h1 className="rooks-onboarding-rise mt-3 text-[22px] font-semibold leading-tight tracking-[-0.025em]" style={{ animationDelay: '60ms' }}>
        {t('onboarding.account.title')}
      </h1>
      <p className="rooks-onboarding-rise mt-1.5 text-[13.5px] leading-relaxed text-muted-foreground" style={{ animationDelay: '100ms' }}>
        {t('onboarding.account.subtitle')}
      </p>
      <form noValidate aria-busy={sending} className="rooks-onboarding-rise mt-[18px] flex w-full flex-col gap-2.5 text-left" style={{ animationDelay: '140ms' }} onSubmit={(e) => { void submit(e); }}>
        <Field id={`${ids}-name`} label={t('onboarding.account.name')} hint={t('onboarding.account.nameHint')}>
          <Input
            id={`${ids}-name`}
            autoFocus
            autoComplete="given-name"
            value={draft.name}
            onChange={set('name')}
            aria-required={false}
            aria-describedby={`${ids}-name-hint`}
            className="h-10"
          />
        </Field>
        <Field id={`${ids}-email`} label={t('onboarding.account.email')} hint={t('onboarding.account.emailHint')}>
          <Input
            id={`${ids}-email`}
            type="email"
            autoComplete="username"
            placeholder={t('onboarding.account.emailPlaceholder')}
            value={draft.email}
            onChange={set('email')}
            aria-required={false}
            aria-describedby={`${ids}-email-hint`}
            className="h-10"
          />
        </Field>
        <Field id={`${ids}-password`} label={t('onboarding.account.password')}>
          <PasswordInput
            id={`${ids}-password`}
            autoComplete="new-password"
            value={draft.password}
            onChange={set('password')}
            shown={shown}
            onToggleShown={toggle}
            aria-required={false}
            className="h-10"
          />
        </Field>
        <Field id={`${ids}-confirm`} label={t('onboarding.account.confirm')}>
          <PasswordInput
            id={`${ids}-confirm`}
            autoComplete="new-password"
            value={draft.confirm}
            onChange={set('confirm')}
            shown={shown}
            onToggleShown={toggle}
            aria-required={false}
            aria-invalid={problem !== null}
            className="h-10"
          />
        </Field>
        {needsToken && (
          <Field id={`${ids}-token`} label={t('loginPage.setupToken')}>
            <Input
              id={`${ids}-token`}
              type="password"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={draft.setupToken}
              onChange={set('setupToken')}
              className="h-10"
            />
            <p className="ml-0.5 mt-1 text-xs text-muted-foreground">
              {t('loginPage.setupTokenHint')}{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-[11.5px] text-foreground">rooks setup-token</code>
            </p>
          </Field>
        )}
        <p role="status" aria-live="polite" data-account-status="" className="ml-0.5 min-h-4 text-[12.5px] leading-4 tabular-nums text-destructive">
          {line}
        </p>
        <Button type="submit" size="lg" className="h-11 w-full gap-2" disabled={!ready || sending}>
          {sending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          {t('onboarding.account.create')}
          {!sending && <ArrowRight className="h-4 w-4" aria-hidden />}
        </Button>
      </form>
      <button
        type="button"
        data-account-skip
        className="rooks-onboarding-fade mt-3 text-[13px] text-muted-foreground underline-offset-4 transition-colors duration-150 hover:text-foreground hover:underline"
        style={{ animationDelay: '220ms' }}
        onClick={next}
      >
        {t('onboarding.account.skip')}
      </button>
      <p className="mt-4 flex items-start gap-2 text-left text-[12.5px] leading-[1.45] text-muted-foreground">
        <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>{t('onboarding.account.privacy')}</span>
      </p>
    </div>
  );
}
