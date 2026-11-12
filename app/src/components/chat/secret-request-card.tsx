'use client';

/**
 * A secret an agent asks its user for (`secret_request`), as a card in the
 * mission's conversation: a masked field, the reason, the lifetime, where the
 * value may go, Provide / Refuse.
 *
 * The thread paints the SLOT `chat.secret`, not this card: the product
 * occupies it by default (`fallback`, client half of `@rooks/secrets-vault`)
 * and a plugin that declares the slot takes its place. The host
 * (`ChatSecretRequestSlot`) owns the request's state and the two gestures; the
 * occupant reads them with `useSecretRequest()` and only draws. A replacement
 * therefore changes the dressing, never the road the value takes: `provide`
 * posts it once, in a request body, to the vault.
 *
 * The value lives in the occupant's input and nowhere else: not in the
 * request's state, not in an event, and the field is emptied as soon as it is
 * sent, whatever the answer.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type FormEvent, type ReactElement } from 'react';
import { Check, Clock, Eye, EyeOff, KeyRound, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { isModuleOn, useCapabilities } from '@/lib/capabilities';
import { t } from '@/lib/i18n';
import { SlotSingle } from '@/lib/plugin-host/render';
import { CHAT_SECRET_REQUEST_SLOT } from '@/lib/plugin-host/slots';
import {
  MAX_SECRET_VALUE_CHARS,
  provideSecretRequest,
  refuseSecretRequest,
  secretRequestExpired,
  type SecretAnswerOutcome,
  type SecretRequestView,
} from '@/lib/secret-requests';
import { cn } from '@/lib/utils';

export const SECRETS_VAULT_MODULE = '@rooks/secrets-vault';

/** What a `chat.secret` occupant is rendered for, and the only two gestures it has. */
export type SecretRequestValue = {
  request: SecretRequestView;
  /** True once the request's expiry passed while it was still pending. */
  expired: boolean;
  busy: boolean;
  highlighted: boolean;
  /** Sends the value to the vault. Resolves true when it was stored. */
  provide: (value: string) => Promise<boolean>;
  refuse: () => Promise<boolean>;
};

const SecretRequestContext = createContext<SecretRequestValue | null>(null);

/** Readable by a plugin that takes the slot. `null` outside a secret request card. */
export function useSecretRequest(): SecretRequestValue | null {
  return useContext(SecretRequestContext);
}

/** Re-renders when the expiry passes, so a card left open stops offering its field. */
function useExpired(request: SecretRequestView): boolean {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (request.status !== 'pending' || request.expiresAt <= 0) return;
    const wait = request.expiresAt - Date.now();
    if (wait <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(wait + 50, 2_147_000_000));
    return () => clearTimeout(timer);
  }, [request.status, request.expiresAt]);
  return secretRequestExpired(request, now);
}

export function ChatSecretRequestSlot({ request, highlighted = false }: { request: SecretRequestView; highlighted?: boolean }): ReactElement {
  const caps = useCapabilities();
  // The answer of this card, once given here: the events catch up a moment later.
  const [fresh, setFresh] = useState<SecretRequestView | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = fresh && fresh.id === request.id && request.status === 'pending' ? fresh : request;
  const expired = useExpired(shown);

  const settle = useCallback((outcome: SecretAnswerOutcome): boolean => {
    if (outcome.ok) { setFresh(outcome.request); return true; }
    if (outcome.error === 'expired') setFresh({ ...shown, status: 'expired', resolvedAt: Date.now() });
    toast.error(t(`secretRequest.errors.${outcome.error}`));
    return false;
  }, [shown]);

  const provide = useCallback(async (value: string): Promise<boolean> => {
    if (busy || shown.status !== 'pending' || !value) return false;
    setBusy(true);
    try { return settle(await provideSecretRequest(shown.id, value)); } finally { setBusy(false); }
  }, [busy, shown, settle]);

  const refuse = useCallback(async (): Promise<boolean> => {
    if (busy || shown.status !== 'pending') return false;
    setBusy(true);
    try { return settle(await refuseSecretRequest(shown.id)); } finally { setBusy(false); }
  }, [busy, shown, settle]);

  const value = useMemo<SecretRequestValue>(
    () => ({ request: shown, expired, busy, highlighted, provide, refuse }),
    [shown, expired, busy, highlighted, provide, refuse],
  );
  // Module switched off: its routes are gone, nothing could be answered.
  if (!isModuleOn(caps, SECRETS_VAULT_MODULE)) {
    return (
      <div className="flex min-w-0 flex-col gap-0.5 rounded-xl bg-card px-3.5 py-2.5 text-[12.5px] shadow-elev-1 dark:bg-surface-2" role="note">
        <span className="truncate font-medium text-foreground">{t('secretRequest.title', { agent: shown.agent, name: shown.name })}</span>
        <span className="text-muted-foreground">{t('secretRequest.unavailable')}</span>
      </div>
    );
  }
  return (
    <SecretRequestContext.Provider value={value}>
      <SlotSingle name={CHAT_SECRET_REQUEST_SLOT} />
    </SecretRequestContext.Provider>
  );
}

function StatePill({ status }: { status: SecretRequestView['status'] }): ReactElement {
  const provided = status === 'provided';
  const Icon = provided ? Check : status === 'expired' ? Clock : X;
  return (
    <span
      className={cn(
        'flex w-fit items-center gap-1 rounded px-2 py-0.5 text-[11px]',
        provided ? 'bg-[hsl(var(--success)/0.08)] text-[hsl(var(--success))]' : 'bg-muted text-muted-foreground',
      )}
      data-secret-request-state={status}
    >
      <Icon className="size-3" />
      {t(`secretRequest.state.${status}`)}
    </span>
  );
}

/** The product's occupant of `chat.secret`. Takes no props: everything comes from `useSecretRequest()`. */
export function SecretRequestCard(): ReactElement | null {
  const ctx = useSecretRequest();
  const [value, setValue] = useState('');
  const [visible, setVisible] = useState(false);
  if (!ctx) return null;
  const { request, expired, busy, highlighted, provide, refuse } = ctx;
  const open = request.status === 'pending' && !expired;

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const typed = value;
    // Out of the field before the answer: a failure is typed again, never kept.
    setValue('');
    setVisible(false);
    await provide(typed);
  };

  return (
    <div
      className={cn(
        'flex flex-col gap-2 rounded-xl rounded-tl-sm border bg-card px-3.5 py-3 text-[13px] shadow-elev-1 transition-[border-color,box-shadow] duration-200 dark:bg-surface-2',
        open ? 'border-[hsl(var(--warning)/0.5)]' : request.status === 'provided' ? 'border-[hsl(var(--success)/0.5)]' : 'border-border',
        highlighted && 'ring-2 ring-[hsl(var(--warning))] shadow-[0_0_28px_hsl(var(--warning)/0.55)]',
      )}
      data-secret-request={request.status}
    >
      <div className="flex min-w-0 items-center gap-2 font-medium [overflow-wrap:anywhere]">
        <KeyRound className="size-3.5 shrink-0 text-[hsl(var(--warning))]" aria-hidden />
        <span>{t('secretRequest.title', { agent: request.agent, name: request.name })}</span>
      </div>
      <p className="text-[12.5px] text-foreground/90 [overflow-wrap:anywhere]">{request.reason}</p>
      <ul className="flex flex-col gap-0.5 text-[11.5px] text-muted-foreground [overflow-wrap:anywhere]">
        <li>{t(`secretRequest.lifetime.${request.lifetime}`)}</li>
        <li>
          {request.hosts
            ? t('secretRequest.hosts', { hosts: request.hosts.join(', '), header: request.header ?? 'Authorization' })
            : request.origin
              ? t('secretRequest.origin', { origin: request.origin })
              : t('secretRequest.environment')}
        </li>
      </ul>
      {open ? (
        <form className="flex flex-col gap-2" onSubmit={(e) => void submit(e)} autoComplete="off">
          <div className="flex min-w-0 items-center gap-1.5">
            <input
              type={visible ? 'text' : 'password'}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              maxLength={MAX_SECRET_VALUE_CHARS}
              autoComplete="off"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              aria-label={t('secretRequest.field', { name: request.name })}
              placeholder={t('secretRequest.placeholder')}
              disabled={busy}
              className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-secret-field
            />
            <button
              type="button"
              onClick={() => setVisible((v) => !v)}
              title={t(visible ? 'secretRequest.hide' : 'secretRequest.show')}
              aria-label={t(visible ? 'secretRequest.hide' : 'secretRequest.show')}
              aria-pressed={visible}
              className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {visible ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" className="h-7 gap-1.5" disabled={busy || value.length === 0} data-decision="provide">
              <Check className="size-3" />
              {t('secretRequest.provide')}
            </Button>
            <Button type="button" size="sm" variant="outline" className="h-7 gap-1.5 text-muted-foreground" disabled={busy} onClick={() => void refuse()} data-decision="refuse">
              <X className="size-3" />
              {t('secretRequest.refuse')}
            </Button>
            <span className="text-[11px] text-muted-foreground">{t('secretRequest.hint')}</span>
          </div>
        </form>
      ) : (
        <StatePill status={request.status === 'pending' ? 'expired' : request.status} />
      )}
    </div>
  );
}
