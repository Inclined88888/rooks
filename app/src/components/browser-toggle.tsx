'use client';

import { usePathname } from 'next/navigation';
import { Globe } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { toggleBrowserPanel, useBrowserPanelOpen } from '@/lib/browser-panel-bus';
import { t } from '@/lib/i18n';

/** Opens / closes the browser sidepanel. Neighbor of the theme toggle.
 *  Absent outside chat: the browser belongs to its project's chat, a
 *  button that wouldn't open anything visible elsewhere has no purpose. */
export function BrowserToggle() {
  const pathname = usePathname();
  const active = useBrowserPanelOpen();
  const label = active ? t('browserToggle.close') : t('browserToggle.open');

  if (pathname !== '/chat') return null;

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      aria-pressed={active}
      title={label}
      onClick={() => toggleBrowserPanel()}
      className={cn(
        'text-muted-foreground hover:text-foreground',
        active && 'bg-primary/15 text-primary hover:bg-primary/25 hover:text-primary',
      )}
    >
      <Globe className="size-4" />
    </Button>
  );
}
