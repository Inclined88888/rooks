import React from 'react';
import { t } from '@/lib/i18n';
import { settingsPath } from '@/lib/settings-path';
import type { AccountUsageView } from '@/lib/account-usage';

/** What the catalogue says of the backend: its name, and the command that signs in when it declared one. */
export type UsageProvider = { label: string; signInCommand?: string; signInThen?: string };

function connectHint(backend: string, provider: UsageProvider | undefined): string {
  // A subscription account (`claude@<id>`) is signed in from the settings,
  // never from the CLI of this machine.
  if (backend.includes('@')) return t('cockpit.accountUsage.connectAccount', { settingsPath: settingsPath('models', 'accounts') });
  if (provider?.signInCommand && provider.signInThen) {
    return t('cockpit.accountUsage.connectCliThen', { name: provider.label, command: provider.signInCommand, then: provider.signInThen });
  }
  if (provider?.signInCommand) return t('cockpit.accountUsage.connectCli', { name: provider.label, command: provider.signInCommand });
  return t('cockpit.accountUsage.connect');
}

/** Idle "not signed in" vs a real probe failure. Neutral until it is an error. */
export function AccountUsageStatus({ view, provider }: { view: AccountUsageView; provider?: UsageProvider }) {
  if (view.kind === 'disconnected') {
    return (
      <div role="status" className="px-1 py-0.5 text-center text-muted-foreground">
        <p>{t('cockpit.accountUsage.disconnected')}</p>
        <p className="mt-0.5">{connectHint(view.backend, provider)}</p>
      </div>
    );
  }
  if (view.kind === 'error') {
    return (
      <div role="alert" className="px-1 py-0.5 text-center">
        <p className="text-muted-foreground">{t('cockpit.accountUsage.error')}</p>
        <p className="mt-0.5 break-words text-destructive">{view.message}</p>
      </div>
    );
  }
  return null;
}
