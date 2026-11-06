import { Suspense } from 'react';
import { EditClient } from './edit-client';

export const dynamic = 'force-dynamic';

export default function EditAgentPage() {
  // Suspense required: the client half reads `?agent=` / `?new=`.
  return (
    <Suspense fallback={null}>
      <EditClient />
    </Suspense>
  );
}
