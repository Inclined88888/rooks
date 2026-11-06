/**
 * Lifts the machine-load admission gate (`canSpawnMission`, TIMON_LOAD_THRESHOLD)
 * for suites that drive the real wake loop or dispatcher.
 *
 * Under the full suite's load, or with other missions running on the machine,
 * load1 crosses 0.9 × CPUs: the wake defers its spawn and retries only after
 * BACKPRESSURE_RETRY_MS (30 s), past the tests' own deadlines, and the retry
 * timer re-arms for as long as the load stays high, so a file never exits. The
 * gate is product behaviour; what these suites check is routing, not admission.
 *
 * Import it before anything that reads settings (they are cached). Never set
 * this key for the whole run: settings.test.ts asserts its default source.
 */
process.env.TIMON_LOAD_THRESHOLD = '1000';
