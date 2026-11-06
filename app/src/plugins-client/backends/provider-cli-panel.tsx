'use client';

/**
 * Settings › AI models › Providers: the same provider cards as the
 * onboarding's "Your AIs" step (TODO #251) — install an AI CLI with its
 * vendor's installer, follow it, sign it in, update it. Next to "CLI
 * binaries" (SUG-0066), which pins a path when the CLI was installed
 * elsewhere.
 *
 * Superadmin signed in to the app only, and the daemon is what enforces it:
 * the panel goes away when the list is refused.
 */
import { useCallback, useState, type ReactElement } from 'react';
import { ProviderCliCards } from '@/components/provider-cli/provider-cli-cards';
import type { ProviderCli } from '@/lib/provider-clis';
import { t } from '@/lib/i18n';

export function ProviderCliPanel(): ReactElement | null {
  const [refused, setRefused] = useState(false);
  const onBackends = useCallback((backends: ProviderCli[] | null) => setRefused(backends === null), []);
  if (refused) return null;
  return (
    <section className="mt-8 max-w-4xl space-y-3" aria-labelledby="provider-clis-title">
      <h3 id="provider-clis-title" className="m-0 text-sm font-semibold">{t('providerClis.settings.title')}</h3>
      <p className="m-0 text-xs leading-relaxed text-muted-foreground">{t('providerClis.settings.description')}</p>
      <ProviderCliCards mode="settings" onBackends={onBackends} />
    </section>
  );
}
