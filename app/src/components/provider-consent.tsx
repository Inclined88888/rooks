'use client';

/**
 * What a provider plugin gets, in plain lines, wherever the person is asked to
 * let one in (the install sheet, the Providers settings): every instruction and
 * answer, the credentials of its own profile, the program it launches — and,
 * when it declared any, the sign-in folders it reads and the entries of the OS
 * credential store it reads.
 * `docs/PROVIDERS-SDK.md` §12.6.
 */
import type { ReactElement } from 'react';
import { t } from '@/lib/i18n';

export type OsCredentialEntry = { service: string; account?: string };

export function ConsentLines({ binaries, osCredentials = [], credentialDirs = [] }: {
  binaries: readonly string[];
  osCredentials?: readonly OsCredentialEntry[];
  credentialDirs?: readonly string[];
}): ReactElement {
  return (
    <ul className="m-0 flex list-none flex-col gap-1.5 rounded-md bg-amber-500/10 px-3 py-2.5 text-xs leading-relaxed text-amber-900 dark:text-amber-200">
      <li>{t('providersSettings.consent.prompts')}</li>
      <li>{t('providersSettings.consent.credentials')}</li>
      {binaries.map((path) => (
        <li key={path} className="break-all">{t('providersSettings.consent.binary', { path })}</li>
      ))}
      {credentialDirs.map((dir) => (
        <li key={dir} className="break-all">{t('providersSettings.consent.credentialDir', { dir })}</li>
      ))}
      {osCredentials.map((entry) => (
        <li key={`${entry.service}\0${entry.account ?? ''}`} className="break-all">
          {t(entry.account ? 'providersSettings.consent.osCredentialAccount' : 'providersSettings.consent.osCredential', { service: entry.service, account: entry.account ?? '' })}
        </li>
      ))}
    </ul>
  );
}
