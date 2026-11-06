/**
 * Worker of test-rss-preload.mjs: writes this process's resident memory for
 * the wrapper and kills the process once it alone passes the tree limit.
 *
 * A `.cjs` file and not `eval` code: an eval worker inherits the parent's
 * `--input-type`, so in a child spawned with `--input-type=module -e …` this
 * CommonJS code was evaluated as ESM, threw on `require`, and the unhandled
 * worker error killed the child — whenever the worker started before the
 * child's script ended (TODO #581). The extension pins the module type.
 */
const { writeFileSync, writeSync } = require('node:fs');
const { join } = require('node:path');
const { dir, limitMb, intervalMs } = require('node:worker_threads').workerData;

const file = join(dir, String(process.pid));
const limit = limitMb * 1024 * 1024;
setInterval(() => {
  const rss = process.memoryUsage.rss();
  try { writeFileSync(file, String(rss)); } catch { /* wrapper gone */ }
  if (rss > limit) {
    // fd 2 directly: process.stderr goes through the main thread, which
    // is the one that is stuck.
    try {
      writeSync(2, '\n[run-tests] RSS-LIMIT: test process ' + process.pid + ' reached '
        + Math.round(rss / 1048576) + ' MB of resident memory\n');
    } catch { /* nothing to report to */ }
    process.kill(process.pid, 'SIGKILL');
  }
}, intervalMs);
