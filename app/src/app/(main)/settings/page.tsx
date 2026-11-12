import { Suspense } from 'react';
import { SettingsRedirect } from './settings-redirect';

export const dynamic = 'force-dynamic';

export default function SettingsPage() {
  return (
    <Suspense fallback={null}>
      <SettingsRedirect />
    </Suspense>
  );
}
