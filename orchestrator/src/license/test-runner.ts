/**
 * Is this process a `node --test` run? `NODE_TEST_CONTEXT` is set by the
 * runner itself, the same signal `paths.ts` refuses the real home on.
 *
 * Judged ONCE, when this module loads, and never read again. A third-party
 * plugin runs inside the daemon's process and is loaded long after the licence
 * modules: if the variable were read at each call, `process.env.NODE_TEST_CONTEXT = '1'`
 * from a plugin would be enough to open the test-only setters.
 */
export function isTestRunnerEnv(env: NodeJS.ProcessEnv): boolean {
  return typeof env.NODE_TEST_CONTEXT === 'string' && env.NODE_TEST_CONTEXT !== '';
}

const UNDER_TEST_RUNNER = isTestRunnerEnv(process.env);

export function underTestRunner(): boolean {
  return UNDER_TEST_RUNNER;
}

/** Throws unless the process was started by the test runner. */
export function assertTestRunner(what: string, active: boolean = UNDER_TEST_RUNNER): void {
  if (active) return;
  throw new Error(`${what} is only available under the test runner (node --test): it would let code in this process replace the licence trust material.`);
}
