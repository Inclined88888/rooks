import { Suspense } from 'react';
import { PluginsClient } from './plugins-client';

export const dynamic = 'force-dynamic';

/**
 * Local gallery: the plugins PRESENT on this machine, plugged in and unplugged.
 * Not the marketplace — no remote index is read here (that is P4, §10.10), and
 * the cards are the ones it will reuse.
 *
 * A Next route rather than a `kind: page` plugin: the plan (§10.12) allows it
 * explicitly until page-keyed slots are wired (volet 10).
 */
export default function PluginsPage() {
  return (
    <Suspense>
      <PluginsClient />
    </Suspense>
  );
}
