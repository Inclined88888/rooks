'use client';

/**
 * Asking the tabs that are about to close, outside any component: the
 * workspace on screen goes through it for a user's close, and so does a write
 * over a view that is not on screen (`lib/island-release.ts`), whose tabs have
 * no component mounted.
 */

import { toast } from 'sonner';
import { t } from './i18n';
import type { IslandTab } from './island-tree';
import type { IslandContentOptions } from './plugin-host/slots';

/**
 * Each type may veto the close first (`beforeClose`: unsaved changes). All
 * tabs pass or none closes. A guard that throws keeps its tab too: it stands
 * for unsaved work, and a broken one must not throw that work away.
 */
export async function mayCloseTabs(
  tabs: readonly IslandTab[],
  optionsOf: (type: string) => IslandContentOptions | undefined,
  titleOf: (tab: IslandTab) => string,
): Promise<boolean> {
  for (const tab of tabs) {
    const veto = optionsOf(tab.content.type)?.beforeClose;
    if (!veto) continue;
    let verdict: boolean | Promise<boolean>;
    try {
      verdict = veto(tab.content.params, tab.id);
      if (typeof verdict !== 'boolean') verdict = await Promise.resolve(verdict);
    } catch (err) {
      console.error('[islands] beforeClose failed', tab.content.type, err);
      toast.error(t('islands.closeGuardFailed', { title: titleOf(tab) }));
      return false;
    }
    if (verdict === false) return false;
  }
  return true;
}
