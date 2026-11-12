'use client';

import { useState } from 'react';
import { Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { t } from '@/lib/i18n';
import type { AuthScheme } from './model';
import { copyWithToast, TriggerModal, TriggerModalTitle } from './modal';

/**
 * The secret of a webhook, the one time the daemon hands it out (creation,
 * rotation, first signed scheme). It stays masked — not even rendered: it
 * is copied into the sender's settings, never read off the screen, and
 * nothing here keeps it once the dialog closes. Only when the clipboard
 * refuses it is it shown, selected, to be copied by hand: masked and
 * uncopiable, it would be lost for good. Escape closes it only once a copy
 * went through: a reflex keystroke must not throw away a secret nobody kept;
 * the explicit button still closes it.
 */
export function SecretDialog({ secret, scheme, url, outbound = false, onClose }: {
  secret: string;
  scheme: AuthScheme;
  url: string | null;
  /** The secret that signs what the trigger sends (its `webhook` actions). */
  outbound?: boolean;
  onClose: () => void;
}): React.ReactElement {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copySecret() {
    if (await copyWithToast(secret, 'triggersPage.secret.copied', 'triggersPage.secret.copyFailed')) setCopied(true);
    else setRevealed(true);
  }

  return (
    <TriggerModal onClose={onClose} escapeCloses={copied} className="max-w-md">
      <TriggerModalTitle testId="trigger-secret-title">{t(outbound ? 'triggersPage.secret.outboundTitle' : 'triggersPage.secret.title')}</TriggerModalTitle>
      <p role="alert" className="mt-2 text-[12px] text-muted-foreground">{t('triggersPage.secret.once')}</p>
      <div className="mt-3 flex items-center gap-2">
        {revealed ? (
          <input
            readOnly value={secret} aria-label={t('triggersPage.secret.revealedLabel')} data-testid="trigger-secret-revealed"
            autoFocus onFocus={(e) => e.currentTarget.select()} spellCheck={false}
            // code-font: a secret pasted as is into the sender's settings
            className="w-full rounded-md border border-border bg-background px-3 py-1.5 font-mono text-sm"
          />
        ) : (
          // Masked, and not even in the DOM: copied from memory only.
          <span
            aria-label={t('triggersPage.secret.label')}
            className="w-full select-none rounded-md border border-border bg-background px-3 py-1.5 text-sm tracking-widest text-muted-foreground"
          >
            {'•'.repeat(24)}
          </span>
        )}
        <Button type="button" size="sm" variant="outline" className="gap-1.5" onClick={() => void copySecret()}>
          <Copy className="size-3.5" />{t('triggersPage.secret.copy')}
        </Button>
      </div>
      {revealed && <p role="alert" className="mt-2 text-[12px] text-destructive">{t('triggersPage.secret.copyFailed')}</p>}
      <p className="mt-3 text-[12px] leading-relaxed text-muted-foreground">{outbound ? t('triggersPage.secret.howtoOutbound') : t(`triggersPage.secret.howto.${scheme}`)}</p>
      {url && (
        <div className="mt-3 flex items-center gap-2">
          {/* code-font: an address pasted into the sender's settings */}
          <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-muted/30 px-2 py-1 font-mono text-[11px]">{url}</code>
          <Button type="button" size="sm" variant="ghost" onClick={() => void copyWithToast(url, 'triggersPage.urlCopied')} aria-label={t('triggersPage.copyUrl')}>
            <Copy className="size-3.5" />
          </Button>
        </div>
      )}
      <div className="mt-4 flex justify-end">
        <Button type="button" size="sm" onClick={onClose}>{t('triggersPage.secret.done')}</Button>
      </div>
    </TriggerModal>
  );
}
