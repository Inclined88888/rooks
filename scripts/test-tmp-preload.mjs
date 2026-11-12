/**
 * Test preload: `node --test --import tsx --import ../scripts/test-tmp-preload.mjs …`.
 *
 * Loaded AFTER tsx on purpose: tsx sizes its compile cache from `os.tmpdir()`
 * when it loads. Before the redirect, that cache lands where run-tests.mjs
 * pointed the temp dir — one cache per run, shared by its test files; after
 * it, every test process would recompile everything cold into a dir deleted
 * on exit. The scratch itself goes back under the real temp dir
 * (ROOKS_TEST_REAL_TMPDIR): nested under the cache, a Unix socket path would
 * outgrow macOS's 104 bytes.
 *
 * Until 21/10/2026 the cache was the machine-wide `<tmp>/tsx-<uid>`. Every
 * worktree adds its own entries to it (the key covers the file path), and at
 * 235,000 entries tsx's linear lookup cost 2.5 s of CPU per test file instead
 * of 0.65 s (TODO #404).
 *
 * `node --test` (Node 22) runs the preload in each per-file child, not in the
 * runner itself: each test file gets a flat sibling under `rooks-tests/`.
 */
import { setupScratch } from './test-tmp.mjs';

const { cleanup } = setupScratch({ realTmp: process.env.ROOKS_TEST_REAL_TMPDIR || undefined });

process.on('exit', cleanup);

for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) {
  const onSignal = () => {
    cleanup();
    // Only restore the default "die on signal" if nobody else (the test runner)
    // took charge of this signal; otherwise its handler decides how to exit.
    if (process.listenerCount(signal) === 1) {
      process.removeListener(signal, onSignal);
      process.kill(process.pid, signal);
    }
  };
  process.on(signal, onSignal);
}
