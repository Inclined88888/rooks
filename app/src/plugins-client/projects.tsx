'use client';

import { ProjectsOverview } from './starter-widgets';
import { registerWidget } from './widget';
import { t } from '@/lib/i18n';
import { FolderKanban } from 'lucide-react';
import { registerNavItem } from './nav';
import type { BundledClientPlugin } from './types';
import { widgetPicto } from './widget-pictos';

/** Only one projects view is left: the agents grid (`/agents?view=projects`),
 *  which now carries create / edit / delete. This plugin's `/projects` page
 *  is gone; its URL survives as a Next redirect. */
export const projectsClient: BundledClientPlugin = {
  module: '@rooks/projects',
  apply(ctx) {
    // `/projects` no longer renders a page: the Next route redirects to the
    // agents grid, the only projects view. The nav entry survives because
    // nobody finds their projects by guessing they live behind a tab of /agents.
    registerNavItem(ctx, { href: '/projects', labelKey: 'nav.projects', icon: FolderKanban, order: 36 });
    registerWidget(ctx, { key: 'overview', widget: { title: t('widgetCatalog.projects.title'), icon: widgetPicto('projects'), description: t('widgetCatalog.projects.description'), zone: 'gauche', height: 300, minHeight: 150 }, Component: ProjectsOverview });
  },
};
