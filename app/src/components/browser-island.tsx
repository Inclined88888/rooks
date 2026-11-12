'use client';

/**
 * The built-in browser as a content of the island workspace
 * (`@rooks/browser-embedded:view`, `docs/ISLAND-WORKSPACE.md` §7).
 *
 * One live form per agent — a profile has one native view and one control
 * lease. The profile is never a param: the
 * daemon resolves it from the agent (and the mission), exactly as for the
 * window, so no param can open a profile the user did not open themselves.
 *
 * Inactive, the tab is unmounted (§8), which detaches the native view; during
 * an island drag the view takes its modal path (`NativeBrowserView`).
 */

import { useEffect, type ReactElement } from 'react';
import { useIslandContent } from '@/components/islands/island-content';
import { BROWSER_ISLAND_KEY, NativeBrowserView, useNativeBrowserCapability, type BrowserDisplay } from '@/components/native-browser-panel';
import { t } from '@/lib/i18n';

export { BROWSER_ISLAND_KEY, BROWSER_ISLAND_TYPE } from '@/components/native-browser-panel';
export { parseBrowserIslandParams } from '@/lib/browser-island-params';

export function BrowserIsland(): ReactElement {
  const { params, setParams, setTitle, active } = useIslandContent();
  const agent = typeof params.agent === 'string' ? params.agent : '';
  const mission = typeof params.mission === 'string' ? params.mission : null;
  const display: BrowserDisplay = params.display === 'mobile' || params.display === 'desktop' ? params.display : 'auto';
  const { available, error, retry } = useNativeBrowserCapability();

  useEffect(() => { setTitle(t('browserPanel.windowTitle', { agent })); }, [agent, setTitle]);

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <NativeBrowserView
        agent={agent}
        mission={mission}
        visible={active}
        available={available}
        capabilityError={error}
        retryCapability={retry}
        display={display}
        onDisplay={(next) => setParams({ ...params, display: next })}
        placement={0}
        trackPosition
      />
    </div>
  );
}
