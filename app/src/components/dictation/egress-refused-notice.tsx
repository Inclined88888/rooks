'use client';

import { useEffect } from 'react';
import { toast } from 'sonner';
import { t } from '@/lib/i18n';
import { dictationPluginLabel, refusedDeclaredHost } from '@/lib/dictation/destination';

/**
 * The window's Content-Security-Policy is written when the page loads (TODO
 * #533): a dictation engine installed since then reaches its declared host
 * only after a reload. Said once per host, with the reload one click away.
 */
export function EgressRefusedNotice(): null {
  useEffect(() => {
    const told = new Set<string>();
    const onViolation = (event: SecurityPolicyViolationEvent) => {
      const refused = refusedDeclaredHost(event.effectiveDirective, event.blockedURI);
      if (!refused || told.has(refused.host)) return;
      told.add(refused.host);
      toast.warning(t('dictation.egressReload.title', { plugin: dictationPluginLabel(refused.pluginId) }), {
        description: t('dictation.egressReload.body', { host: refused.host }),
        duration: Infinity,
        action: { label: t('dictation.egressReload.reload'), onClick: () => window.location.reload() },
      });
    };
    document.addEventListener('securitypolicyviolation', onViolation);
    return () => document.removeEventListener('securitypolicyviolation', onViolation);
  }, []);
  return null;
}
