/**
 * The checkout of a project branch, shared by the Git widget's Branches tab
 * and the composer's branch picker: one confirmation, one toast, one
 * invalidation of every Git read on screen.
 */

import { toast } from 'sonner';

import { t } from '@/lib/i18n';
import { invalidateGit } from '@/lib/git-store';
import { responseErrorText } from '@/lib/permission-refusal';
import { confirmAction } from '@/components/confirm-dialog/confirm-dialog-context';

/** Checks `branch` out in the project checkout of `slug`, or in its nested
 *  repository `repo`. `totalChanges` is the working tree's count: a dirty tree
 *  asks first. */
export async function checkoutBranch(slug: string, branch: string, totalChanges: number, repo?: string | null): Promise<void> {
  if (
    totalChanges > 0 &&
    !(await confirmAction({ title: t('chatPage.dirtyWorkingTreeConfirm', { count: totalChanges, branch }), confirmLabel: t('confirmDialog.switch'), destructive: true }))
  ) return;
  try {
    const r = await fetch('/api/ui/git/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(repo ? { slug, branch, repo } : { slug, branch }),
    });
    const j = await r.json();
    if (!r.ok) { toast.error(responseErrorText(j, t('chatPage.checkoutFailed'))); return; }
    toast.success(t('gitWidget.branches.switched', { branch }));
    // Every Git read on screen, the composer's branch included.
    invalidateGit();
  } catch (e) { toast.error(String(e)); }
}
