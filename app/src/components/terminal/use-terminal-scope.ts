'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useWorkspaceLayout } from '@/components/workspace-layout-provider';
import { workspaceRoute } from '@/lib/workspace-route';
import { scopeKey, scopeOfView } from '@/lib/terminal-web';
import type { OpenView } from '@/lib/terminal-open';

export type ViewScope = OpenView;

/**
 * The terminal scope of the current view. `pending` while the workspace of a
 * new route resolves: its project is not known yet, and guessing "no project"
 * would flash the wrong shells.
 */
export function useTerminalScope(): ViewScope {
  const workspace = useWorkspaceLayout();
  const view = usePathname();
  const params = useSearchParams();
  const { agent } = workspaceRoute(view, params);
  if (workspace.key === null) return { state: 'pending' };
  const scope = scopeOfView(workspace.project, agent);
  return { state: 'ready', scope, key: scopeKey(scope) };
}
