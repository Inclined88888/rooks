'use client';

/**
 * The code screen (docs/EMAIL-CODE-UI.md): six boxes for the digits an email
 * brought, "Change email", "Resend" after 60 s. Two screens mount it — the
 * onboarding's account step and the login's forgotten password — through
 * `EmailCodeHost`, which keeps the state and paints the `email.code` slot:
 * a plugin's replacement, or `ProductEmailCode`.
 *
 * The host knows nothing of what the code is for: the screen gives it
 * `verify` (create the account, or just keep the digits) and `resend`.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { ArrowLeft, Check, Loader2, RotateCw } from 'lucide-react';
import { SlotSingle, useSlotEntries } from '@/lib/plugin-host/render';
import { EMAIL_CODE_SLOT } from '@/lib/plugin-host/slots';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { BrandLogo } from '@/components/brand-logo';
import { EmailCodeProvider, useEmailCode, type EmailCodePurpose, type EmailCodeState, type EmailCodeValue } from './email-code-context';
import { CODE_LENGTH, clock, digitsOnly, failureText, secondsLeft, type CodeFailure } from './email-code-failure';

export type EmailCodeVerdict = { ok: true } | { ok: false; failure: CodeFailure };
export type EmailCodeResent = { ok: true; resendAt: number } | { ok: false; failure: CodeFailure };

export type EmailCodeHostProps = {
  purpose: EmailCodePurpose;
  email: string;
  /** When "Resend" opens (ms, this browser's clock). */
  resendAt: number;
  /** Checks six digits. */
  verify: (code: string) => Promise<EmailCodeVerdict>;
  resend: () => Promise<EmailCodeResent>;
  /** After an accepted code, once "confirmed" has shown for `settleMs`. */
  onVerified: () => void;
  changeEmail: () => void;
  /** A refusal learnt elsewhere: the reset checks its code with the new password, then comes back here. */
  failure?: CodeFailure | null;
  /** How long the accepted code shows before `onVerified`; `0` moves on at once. */
  settleMs?: number;
};

/** The daemon's "wrong code", which keeps the code alive with fewer tries. */
const WRONG_CODE = 'email_code_invalid';

function stateOf(failure: CodeFailure | null | undefined): EmailCodeState {
  if (!failure) return 'idle';
  return failure.code === WRONG_CODE ? 'bad' : 'failed';
}

/**
 * The time of this render, the component redrawn twice a second: countdowns
 * tick without a timer each, and a refusal that just arrived is counted from
 * its own moment, not from the last tick.
 */
export function useNow(): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 500);
    return () => window.clearInterval(id);
  }, []);
  return Date.now();
}

export function EmailCodeHost({
  purpose, email, resendAt: initialResendAt, verify, resend, onVerified, changeEmail, failure: initialFailure = null, settleMs = 900,
}: EmailCodeHostProps): ReactElement {
  const claimed = useSlotEntries(EMAIL_CODE_SLOT).length > 0;
  const now = useNow();
  const [digits, setDigits] = useState('');
  const [state, setState] = useState<EmailCodeState>(() => stateOf(initialFailure));
  const [failure, setFailure] = useState<CodeFailure | null>(initialFailure);
  const [resendAt, setResendAt] = useState(initialResendAt);
  const [resending, setResending] = useState(false);
  const alive = useRef(true);
  const busy = useRef(false);
  const settle = useRef<number | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (settle.current !== null) window.clearTimeout(settle.current);
    };
  }, []);

  const check = useCallback(async (code: string): Promise<void> => {
    busy.current = true;
    setState('checking');
    setFailure(null);
    const verdict = await verify(code);
    if (!alive.current) return;
    busy.current = false;
    if (verdict.ok) {
      setState('ok');
      if (settleMs <= 0) onVerified();
      else settle.current = window.setTimeout(onVerified, settleMs);
      return;
    }
    setDigits('');
    setFailure(verdict.failure);
    setState(stateOf(verdict.failure));
    if (verdict.failure.retryUntil !== null) setResendAt((at) => Math.max(at, verdict.failure.retryUntil ?? at));
  }, [verify, onVerified, settleMs]);

  const input = useCallback((value: string): void => {
    if (busy.current || state === 'ok') return;
    const next = digitsOnly(value);
    setDigits(next);
    // Typing again answers a wrong code; a wait keeps counting until it is over.
    if (next && failure?.retryUntil == null) {
      setFailure(null);
      setState('idle');
    } else if (next && state === 'sent') {
      setState('idle');
    }
    if (next.length === CODE_LENGTH) void check(next);
  }, [state, failure, check]);

  const resendIn = secondsLeft(resendAt, now);

  const doResend = useCallback((): void => {
    if (resending || busy.current || state === 'ok' || resendIn > 0) return;
    setResending(true);
    void resend().then((answer) => {
      if (!alive.current) return;
      setResending(false);
      setDigits('');
      if (answer.ok) {
        setResendAt(answer.resendAt);
        setFailure(null);
        setState('sent');
        return;
      }
      setFailure(answer.failure);
      setState(stateOf(answer.failure));
      if (answer.failure.retryUntil !== null) setResendAt((at) => Math.max(at, answer.failure.retryUntil ?? at));
    });
  }, [resending, state, resendIn, resend]);

  const message = state === 'bad' || state === 'failed' ? failureText(failure, now) : null;
  // A wait that is over leaves nothing to say: back to typing.
  const shown: EmailCodeState = state === 'failed' && message === null ? 'idle' : state;

  const value = useMemo<EmailCodeValue>(() => ({
    purpose,
    email,
    length: CODE_LENGTH,
    digits,
    input,
    state: shown,
    attemptsLeft: failure?.attemptsLeft ?? null,
    message,
    resendIn,
    resending,
    resend: doResend,
    changeEmail,
  }), [purpose, email, digits, input, shown, failure, message, resendIn, resending, doResend, changeEmail]);

  return (
    <EmailCodeProvider value={value}>
      {claimed ? <SlotSingle name={EMAIL_CODE_SLOT} /> : <ProductEmailCode />}
    </EmailCodeProvider>
  );
}

/** Splits a translated sentence around the email, to set it in bold. */
function aroundEmail(purpose: EmailCodePurpose): [string, string] {
  const marker = '\u0000';
  const [before = '', after = ''] = t(purpose === 'reset' ? 'emailCode.subtitleReset' : 'emailCode.subtitle', { email: marker }).split(marker);
  return [before, after];
}

/** The product's code screen: the mockup's six boxes in two groups of three. */
export function ProductEmailCode(): ReactElement | null {
  const code = useEmailCode();
  const field = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const [shakes, setShakes] = useState(0);
  const state = code?.state ?? 'idle';

  // A refused code shakes the boxes, and the field takes the next try at once.
  useEffect(() => {
    if (state === 'bad' || state === 'failed') setShakes((n) => n + 1);
    if (state === 'bad' || state === 'sent' || state === 'failed') field.current?.focus({ preventScroll: true });
  }, [state]);

  if (!code) return null;
  const [before, after] = aroundEmail(code.purpose);
  const boxes = Array.from({ length: code.length }, (_, i) => i);
  const groups = [boxes.slice(0, Math.ceil(code.length / 2)), boxes.slice(Math.ceil(code.length / 2))];

  return (
    <div className="flex w-full max-w-[560px] flex-col items-center text-center">
      <BrandLogo className="mb-7 h-12" alt="Rooks" />
      <h1 className="text-[28px] font-bold leading-tight tracking-[-0.02em]">{t('emailCode.title')}</h1>
      <p className="mt-2.5 text-[15px] text-muted-foreground">
        {before}<b className="font-semibold text-foreground">{code.email}</b>{after}
      </p>
      <div className="relative mb-2.5 mt-6">
        {/* Keyed apart from the field: the shake restarts without taking the focus away. */}
        <div key={shakes} data-email-code-boxes="" className={cn('flex items-center gap-[18px]', shakes > 0 && 'timon-code-shake')}>
        {groups.map((group, g) => (
          <div key={g} className="flex gap-1.5">
            {group.map((i) => {
              const digit = code.digits[i] ?? '';
              const caret = focused && state === 'idle' && i === code.digits.length;
              return (
                <div
                  key={i}
                  aria-hidden
                  data-email-code-box={digit}
                  style={state === 'checking' ? { animationDelay: `${i * 60}ms` } : undefined}
                  className={cn(
                    'grid h-14 w-[46px] place-items-center rounded-[9px] bg-muted/40 text-2xl font-semibold tabular-nums ring-1 ring-inset ring-border transition-colors',
                    digit && 'timon-code-filled bg-muted',
                    caret && 'timon-code-caret bg-muted ring-foreground/50',
                    state === 'checking' && 'timon-code-check',
                    state === 'ok' && 'bg-success/15 text-success ring-success/45',
                    (state === 'bad' || state === 'failed') && 'ring-destructive/50',
                  )}
                >
                  {digit}
                </div>
              );
            })}
          </div>
        ))}
        </div>
        <input
          ref={field}
          autoFocus
          value={code.digits}
          onChange={(e) => code.input(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          inputMode="numeric"
          autoComplete="one-time-code"
          aria-label={t('emailCode.label')}
          aria-invalid={state === 'bad' || state === 'failed'}
          disabled={state === 'checking' || state === 'ok'}
          className="absolute inset-0 h-full w-full cursor-text opacity-0"
        />
      </div>
      <div
        role="status"
        aria-live="polite"
        data-email-code-status={state}
        className={cn(
          'flex min-h-[22px] max-w-[440px] items-center justify-center gap-1.5 text-[12.5px] text-muted-foreground',
          state === 'ok' && 'text-success',
          (state === 'bad' || state === 'failed') && 'text-destructive',
        )}
      >
        {state === 'checking' && <><Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />{t('emailCode.checking')}</>}
        {state === 'ok' && <><Check className="h-3.5 w-3.5" aria-hidden />{t('emailCode.ok')}</>}
        {state === 'sent' && <><Check className="h-3.5 w-3.5" aria-hidden />{t('emailCode.sent')}</>}
        {(state === 'bad' || state === 'failed') && <span className="tabular-nums">{code.message}</span>}
        {state === 'idle' && t('emailCode.hint')}
      </div>
      <div className="mt-5 flex gap-[22px] text-[13.5px] text-muted-foreground">
        <button type="button" className="inline-flex items-center gap-1.5 rounded-md hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={code.changeEmail}>
          <ArrowLeft className="h-4 w-4" aria-hidden />
          {t('emailCode.change')}
        </button>
        <button
          type="button"
          data-email-code-resend=""
          disabled={code.resendIn > 0 || code.resending || state === 'checking' || state === 'ok'}
          onClick={code.resend}
          className="inline-flex items-center gap-1.5 rounded-md hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-45"
        >
          {code.resending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <RotateCw className="h-4 w-4" aria-hidden />}
          <span className="tabular-nums">{code.resendIn > 0 ? t('emailCode.resendIn', { time: clock(code.resendIn) }) : t('emailCode.resend')}</span>
        </button>
      </div>
      <p className="mt-6 text-[12.5px] text-muted-foreground">{t('emailCode.spam')}</p>
    </div>
  );
}
