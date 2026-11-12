import { Suspense } from 'react';
import { AgentsRoute } from './agents-route';
import { ModulePageGate } from '@/lib/plugin-host/module-page-gate';

export const dynamic = 'force-dynamic';

export default function AgentsPage() {
  // Suspense required: the route reads `?view=` through useSearchParams to
  // serve the links that predate the split into independent routes.
  return (
    <ModulePageGate>
      <Suspense fallback={null}>
        <AgentsRoute />
      </Suspense>
    </ModulePageGate>
  );
}
