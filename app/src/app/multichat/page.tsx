import { Suspense } from 'react';
import { MultichatClient } from './multichat-client';
import { ModulePageGate } from '@/lib/plugin-host/module-page-gate';

export const dynamic = 'force-dynamic';

export default function MultichatPage() {
  return (
    <ModulePageGate>
      <Suspense fallback={null}>
        <MultichatClient />
      </Suspense>
    </ModulePageGate>
  );
}
