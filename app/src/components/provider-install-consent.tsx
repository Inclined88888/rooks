'use client';

/**
 * A provider's block on the install sheet: what it gets, its programs as the
 * daemon resolved them, and the tick-box accepting them. Shared by a provider
 * installed alone and by a provider a bundle brings.
 */
import type { ReactElement } from 'react';
import { ConsentLines } from '@/components/provider-consent';
import type { PluginPreview } from '@/lib/plugin-install';
import { binaryAction } from '@/lib/providers';
import { t } from '@/lib/i18n';
import { settingsPath } from '@/lib/settings-path';

export function ProviderInstallConsent({ provider, authorizable, allow, busy, onAllow }: {
  provider: NonNullable<PluginPreview['provider']>;
  /** The paths the box accepts; empty: no box. */
  authorizable: string[];
  allow: boolean;
  busy: boolean;
  onAllow: (allow: boolean) => void;
}): ReactElement {
  return (
    <div className="space-y-2" data-testid="provider-consent">
      <ConsentLines binaries={authorizable} osCredentials={provider.osCredentials ?? []} credentialDirs={provider.credentialDirs ?? []} />
      <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[12px]">
        {provider.binaries.map((binary) => {
          const action = binaryAction(binary);
          return (
            <li key={binary.name} className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">{binary.name}</span>
              <span className="break-all text-muted-foreground">{binary.resolved ?? t('providersSettings.plugins.notFound')}</span>
              <span className={action === 'refused' ? 'text-destructive' : 'text-muted-foreground'}>
                {action === 'refused' ? binary.refused : t(`providersSettings.plugins.binary.${action}`)}
              </span>
            </li>
          );
        })}
      </ul>
      {authorizable.length > 0 && (
        <label className="flex items-start gap-2 text-[12px] leading-relaxed">
          <input type="checkbox" className="mt-0.5" checked={allow} disabled={busy} onChange={(e) => onAllow(e.target.checked)} />
          <span>{t('providersSettings.install.allow')}</span>
        </label>
      )}
      {authorizable.length > 0 && !allow && (
        <p className="m-0 text-[12px] text-muted-foreground">{t('providersSettings.install.allowHint', { settingsPath: settingsPath('models', 'backends') })}</p>
      )}
    </div>
  );
}
