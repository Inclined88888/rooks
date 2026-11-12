'use client';

import nextDynamic from 'next/dynamic';
import { t } from '@/lib/i18n';

const BrainDisc = nextDynamic(() => import('./brain-disc'), {
  ssr: false,
  loading: () => (
    <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-muted-foreground">
      {t('vault.loadingDisc')}
    </div>
  ),
});

export function BrainPage(): React.ReactElement {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <BrainDisc />
    </div>
  );
}
