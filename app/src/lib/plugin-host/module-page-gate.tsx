'use client';

/**
 * Product pages still shipped as Next routes. Switching their module off
 * used to leave the shell in place: `/dreams` kept answering, then toasted
 * "could not load dreams" because the daemon route was gone. This gate
 * paints the mode absent instead — nav already dropped the link, the URL
 * must not pretend the feature is still there.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  isModuleOn,
  isPageSurfaceAllowed,
  PAGE_MODULE,
  useCapabilities,
} from '@/lib/capabilities';
import { t } from '@/lib/i18n';

export function PluginOffScreen({ path }: { path: string }): React.ReactElement {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-sm text-muted-foreground">{t('route.pluginOff')}</p>
      <p className="max-w-sm text-xs text-muted-foreground">{t('route.pluginOffHint', { path })}</p>
      <Link href="/plugins" className="text-sm text-foreground underline underline-offset-4">
        {t('route.openPlugins')}
      </Link>
    </main>
  );
}

export function ForbiddenScreen(): React.ReactElement {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <h1 className="text-2xl font-semibold">{t('route.forbiddenTitle')}</h1>
      <p className="max-w-sm text-sm text-muted-foreground">{t('route.forbidden')}</p>
    </main>
  );
}

export function ModulePageGate({ children }: { children: React.ReactNode }): React.ReactElement {
  const pathname = usePathname() ?? '';
  const caps = useCapabilities();
  if (caps === null) {
    return (
      <main className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
        {t('route.loading')}
      </main>
    );
  }
  const required = PAGE_MODULE[pathname];
  if (required && !isModuleOn(caps, required)) return <PluginOffScreen path={pathname} />;
  if (!isPageSurfaceAllowed(caps, pathname)) return <ForbiddenScreen />;
  return <>{children}</>;
}
