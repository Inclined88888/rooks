/** Test fixture: requires a service nobody necessarily provides. */
import type { Context } from '@deepseek-ai/cordis';

export const name = 'needs-dispatcher';
export const inject = ['dispatcher'];

export function apply(_ctx: Context): void {
  /* never called as long as `dispatcher` is missing — that's the whole point */
}
