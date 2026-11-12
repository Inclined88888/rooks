'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { betaLock, expiryNotices, licenseNotice, useLicense, type ExpiryNotice } from '@/lib/license';
import { isPageSurfaceAllowed, useCapabilities } from '@/lib/capabilities';
import { t } from '@/lib/i18n';
import { formatDate, formatDateTime } from '@/lib/intl';
import { machineScopedStorage } from '@/lib/machines/machine-storage';
import { useUpdateStore, visibleOffer } from '@/lib/updates';

function expiryText(notice: ExpiryNotice): string {
  const date = formatDate(notice.at, { year: 'numeric', month: 'numeric', day: 'numeric' });
  const key = `${notice.kind === 'build' ? 'buildEnds' : 'licenseEnds'}${notice.urgent ? 'Urgent' : 'Soon'}`;
  return t(`license.${key}`, { date });
}

const RELOAD_KEY = 'rooks-lock-reload';

export function LicenseBanner() {
  const license = useLicense();
  // The build ended or the licence was revoked while the cockpit was open: the
  // lock screen is chosen by the server layout, so it takes a reload to get it.
  // Once per 10 s at most, so a layout that cannot read the state never loops.
  const locked = betaLock(license) !== null;
  useEffect(() => {
    if (!locked) return;
    try {
      const last = Number(machineScopedStorage(window.sessionStorage).getItem(RELOAD_KEY) ?? 0);
      if (Date.now() - last < 10_000) return;
      machineScopedStorage(window.sessionStorage).setItem(RELOAD_KEY, String(Date.now()));
    } catch { /* storage refused: a single reload attempt is not worth a loop */ return; }
    window.location.reload();
  }, [locked]);
  const notice = licenseNotice(license);
  // The banner is global; `/license` is a grantable surface. An account that
  // cannot open the page still deserves to know the instance is unlicensed —
  // it just gets no link to a screen that would answer 403.
  const capabilities = useCapabilities();
  const canActivate = isPageSurfaceAllowed(capabilities, '/license');
  // The end dates are announced whatever the setup policy: the "not activated"
  // banner below stays quiet during the beta, these never do.
  // A newer version on offer takes the build's notice over: the update banner
  // says when this build stops, next to the way out of it.
  const updateShown = visibleOffer(useUpdateStore()) !== null;
  const ending = expiryNotices(license, Date.now()).filter((item) => !(updateShown && item.kind === 'build'));
  const showLicense = notice !== null && capabilities !== null && capabilities.beta !== true;
  if (!showLicense && ending.length === 0) return null;
  return (
    <>
      {ending.map((item) => (
        <div
          key={item.kind}
          role="status"
          className={`shrink-0 px-3 py-1 text-center text-xs font-semibold ${item.urgent ? 'bg-red-600 text-white' : 'bg-amber-400 text-amber-950'}`}
        >
          {expiryText(item)}
          {item.kind === 'license' && canActivate && (
            <>{' · '}<Link className="underline" href="/license">{t('license.activate')}</Link></>
          )}
        </div>
      ))}
      {showLicense && (
        <div className="shrink-0 bg-amber-400 px-3 py-1 text-center text-xs font-semibold text-amber-950">
          {notice.kind === 'unlicensed' ? (
            <>
              {t('license.notActivated')}
              {canActivate && (
                <>{' · '}<Link className="underline" href="/license">{t('license.activate')}</Link></>
              )}
            </>
          ) : notice.kind === 'offline' ? (
            t('license.offlineSince', { date: formatDateTime(notice.since) })
          ) : notice.until !== null ? (
            t('license.pastDueUntil', { date: formatDate(notice.until, { year: 'numeric', month: 'numeric', day: 'numeric' }) })
          ) : (
            t('license.pastDue')
          )}
        </div>
      )}
    </>
  );
}
