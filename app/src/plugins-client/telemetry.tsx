'use client';

import dynamic from 'next/dynamic';
import { TELEMETRY_MODULE } from '@/lib/telemetry-preference';
import { startUsageReporting, windowReporterHost } from '@/lib/usage-events';
import type { BundledClientPlugin } from './types';

// Loaded on demand (docs/BUNDLE-SIZE.md): only the settings dialog shows it.
const TelemetrySettings = dynamic(() => import('./telemetry/settings').then((m) => m.TelemetrySettings), { ssr: false });

/**
 * Client half of `@rooks/telemetry`: its own settings category, filed under
 * System › Privacy (`settings-layout.ts`), and the usage reporter (opening,
 * page changes). Off with the module, like any half.
 */
export const telemetryClient: BundledClientPlugin = {
  module: TELEMETRY_MODULE,
  apply(ctx) {
    ctx.register({ slot: 'settings.section' }, TelemetrySettings);
    if (typeof window !== 'undefined') ctx.onDispose(startUsageReporting(windowReporterHost(window)));
  },
};
