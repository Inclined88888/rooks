/** Test fixture: provides the service that `needs-dispatcher` requires. */
import type { Context } from '@deepseek-ai/cordis';

export const name = 'provides-dispatcher';

export function apply(ctx: Context): void {
  ctx.provide('dispatcher', {});
}
