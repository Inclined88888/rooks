/**
 * Test preload set by scripts/run-tests.mjs in NODE_OPTIONS, so it loads in
 * every Node process of the run — the runner, each test file, and whatever
 * Node process a test spawns: reports this process's resident memory to the
 * wrapper.
 *
 * Why RSS and not the heap: `--max-old-space-size` only bounds the V8 heap.
 * On 19/09/2026 a jsdom test grew to 12.4 GB of RSS in a few seconds with a
 * 1 GB heap ceiling — the memory lived outside the heap — and the mission's
 * cgroup OOM-killed the whole mission, agent included.
 *
 * Why a worker thread: a runaway test usually holds the main thread (a
 * synchronous loop, or microtasks that never drain), so a timer there would
 * never fire. The worker has its own event loop, and process.memoryUsage.rss()
 * reads the whole process, not the worker. Pure node: same code on Windows,
 * macOS and Linux, no `ps`.
 *
 * Two layers: the worker writes the RSS to `<TIMON_TEST_RSS_DIR>/<pid>` for
 * the wrapper, which sums the tree; and it kills its own process at once if
 * that process alone passes the tree limit, without waiting for the
 * wrapper's next tick.
 */
import { isMainThread, Worker } from 'node:worker_threads';

const dir = process.env.TIMON_TEST_RSS_DIR;
const limitMb = Number(process.env.TIMON_TEST_MAX_RSS_MB);
// One reporter per process: a worker may run the preloads again, and the same
// URL can reach a process through both NODE_OPTIONS and argv.
const LOADED = Symbol.for('timon.test-rss-preload');

if (isMainThread && !globalThis[LOADED] && dir && Number.isFinite(limitMb) && limitMb > 0) {
  globalThis[LOADED] = true;
  // `execArgv: []`: the reporter needs none of the process's flags, and an
  // inherited `--import` (tsx) would only slow its start.
  const worker = new Worker(new URL('./test-rss-worker.cjs', import.meta.url), {
    workerData: { dir, limitMb, intervalMs: 200 },
    execArgv: [],
  });
  // A broken reporter must never fail the process it watches: the wrapper's
  // wall-clock and inactivity limits still bound that process.
  worker.on('error', () => {});
  worker.unref();
}
