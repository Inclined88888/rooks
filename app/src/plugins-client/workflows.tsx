'use client';

/**
 * Client half of `@timon/workflows` (PRD §8.1): the gallery, the builder, the
 * run view, the causal trace page and the cockpit widget — all registered by
 * slot, like any plugin.
 */
import { usePathname } from 'next/navigation';
import { Workflow } from 'lucide-react';
import { registerNavItem } from './nav';
import { registerPage } from './page';
import { registerWidget } from './widget';
import { t } from '@/lib/i18n';
import type { BundledClientPlugin } from './types';
import dynamic from 'next/dynamic';
import { widgetPicto } from './widget-pictos';

// Loaded on demand (docs/BUNDLE-SIZE.md): statically imported, every page of the app paid for it.
const WorkflowRunsWidget = dynamic(() => import('./workflows/widget').then((m) => m.WorkflowRunsWidget), { ssr: false });

// Loaded on demand: statically imported, it weighed on every page of the app.
const WorkflowsPage = dynamic(() => import('./workflows/page').then((m) => m.WorkflowsPage), { ssr: false });
const WorkflowBuilder = dynamic(() => import('./workflows/page').then((m) => m.WorkflowBuilder), { ssr: false });
const WorkflowRunPage = dynamic(() => import('./workflows/run-page').then((m) => m.WorkflowRunPage), { ssr: false });
const TracePage = dynamic(() => import('./workflows/trace-page').then((m) => m.TracePage), { ssr: false });

function WorkflowRoutePage() {
  const pathname = usePathname() ?? '';
  const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[1] === 'runs' && parts[2]) return <WorkflowRunPage slug="" runId={parts[2]} />;
  if (parts[2] === 'runs' && parts[3]) return <WorkflowRunPage slug={parts[1] ?? ''} runId={parts[3]} />;
  return <WorkflowBuilder key={parts[1] ?? ''} slug={parts[1] ?? ''} />;
}

function TraceRoutePage() {
  const pathname = usePathname() ?? '';
  const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  return <TracePage traceId={parts[1] ?? ''} />;
}

export const workflowsClient: BundledClientPlugin = {
  module: '@timon/workflows',
  apply(ctx) {
    registerNavItem(ctx, { href: '/workflows', labelKey: 'nav.workflows', icon: Workflow, order: 90, zone: 'nav.workflows' });
    registerPage(ctx, { route: '/workflows', Component: WorkflowsPage });
    registerPage(ctx, { route: '/workflows/*', Component: WorkflowRoutePage });
    registerPage(ctx, { route: '/trace/*', Component: TraceRoutePage });
    registerWidget(ctx, {
      key: 'workflow-runs',
      widget: { title: t('widgetCatalog.workflowRuns.title'), icon: widgetPicto('workflowRuns'), description: t('widgetCatalog.workflowRuns.description'), height: 240, minHeight: 140, frame: 'none' },
      Component: WorkflowRunsWidget,
    });
  },
};
