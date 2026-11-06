/**
 * Activation audit — the guard against silence.
 *
 * Pitfall documented by DeepSeek Harness and checked in the Cordis tutorial
 * (chapter 6): a plugin whose `inject` is satisfied by nobody stays
 * PENDING **without saying anything**. No error, no log: the module simply
 * does not run, and we notice three days later because a task
 * was never dispatched.
 *
 * So we copy dsh's countermeasure (`assertEntriesActivated`): after boot,
 * any enabled entry that is not ACTIVE makes the start fail while
 * naming what it lacks. Better a daemon that refuses to start than a
 * half-alive daemon.
 */
import { FiberState, type Context } from '@deepseek-ai/cordis';

/** `FiberState` is a `const enum`: it only exists at compile time, and an
 *  `import` of its value blows up at run time ("does not provide an export
 *  named FiberState"). We mirror the members used, as dsh does.
 *  To keep aligned with `@deepseek-ai/cordis/src/fiber.ts`. */
const FIBER_PENDING = 0 as FiberState.PENDING;
const FIBER_ACTIVE = 2 as FiberState.ACTIVE;
const FIBER_FAILED = 3 as FiberState.FAILED;

/** Delay given to the tree to settle before the verdict. */
export const ACTIVATION_TIMEOUT_MS = 10_000;

export type ActivationFailure = { entry: string; state: string; detail: string };

function formatError(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

/**
 * Inspects the loader's entries. Returns the list of enabled entries that
 * are not ACTIVE — empty when all is well.
 */
export async function collectActivationFailures(ctx: Context): Promise<ActivationFailure[]> {
  const loader = ctx.get('loader');
  if (loader === undefined) return [];
  const failures: ActivationFailure[] = [];

  for (const entry of loader.entries()) {
    // `fiber === undefined`: the module could not even be resolved (wrong path or
    // package name). Cordis reports it to the logger, not to the process.
    if (entry.disabled) continue;
    const fiber = entry.fiber;
    if (fiber === undefined) {
      failures.push({ entry: entry.options.name, state: 'unresolved', detail: 'module not found (wrong path or package name)' });
      continue;
    }
    if (fiber.state === FIBER_ACTIVE) continue;

    if (fiber.state === FIBER_FAILED) {
      let detail = 'apply() failed';
      try {
        await fiber.await();
      } catch (error) {
        detail = formatError(error);
      }
      failures.push({ entry: entry.options.name, state: 'failed', detail });
      continue;
    }
    if (fiber.state === FIBER_PENDING) {
      const missing = Object.keys(fiber.inject).filter((service) => fiber.ctx.get(service) === undefined);
      failures.push({
        entry: entry.options.name,
        state: 'pending',
        detail: `missing services: ${missing.join(', ') || 'unknown'}`,
      });
      continue;
    }
    failures.push({ entry: entry.options.name, state: String(fiber.state), detail: 'unexpected state' });
  }
  return failures;
}

/** Failure message — one line per faulty entry, readable in journalctl. */
export function formatActivationFailures(failures: readonly ActivationFailure[]): string {
  const noun = failures.length === 1 ? 'module' : 'modules';
  return `[kernel] ${failures.length} ${noun} not activated:\n`
    + failures.map((f) => `  - ${f.entry} [${f.state}] ${f.detail}`).join('\n');
}

/**
 * Waits for the tree to settle, then fails loudly if inactive entries
 * remain. Default `onFailure`: log + `process.exit(2)`.
 */
export async function auditActivation(
  ctx: Context,
  opts: { timeoutMs?: number; onFailure?: (failures: ActivationFailure[]) => void } = {},
): Promise<ActivationFailure[]> {
  // Hard cap on settling: an `apply` that never returns
  // would block the boot without a word. Past the delay, the tree is judged as is —
  // fibers still in flight will be described as not activated, which they are.
  const timeoutMs = opts.timeoutMs ?? ACTIVATION_TIMEOUT_MS;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    ctx.get('loader')?.await() ?? Promise.resolve(),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
  ]);
  clearTimeout(timer);

  const failures = await collectActivationFailures(ctx);
  if (!failures.length) return failures;

  const onFailure = opts.onFailure ?? ((f: ActivationFailure[]) => {
    console.error(formatActivationFailures(f));
    process.exit(2);
  });
  onFailure(failures);
  return failures;
}
