#!/usr/bin/env node
/**
 * Guarded test launcher — `npm test` in every package that has tests (the guard
 * is in run-tests.test.mjs): app/, orchestrator/, desktop/, plugins/*.
 *
 *   npm test                              # the package's whole suite
 *   npm test -- src/lib/foo.test.ts       # one file (or several, or globs)
 *   npm test -- --test-name-pattern=foo   # node --test flags pass through
 *
 * Why: on 19/09/2026 an agent ran one jsdom test file by hand; it looped for
 * 16 minutes at 8.5 GB of RSS and froze every other mission on the machine.
 * Plain `node --test` has no memory ceiling and no timeout at all by default.
 * This wrapper sets three limits:
 *
 *  - a V8 heap ceiling (`--max-old-space-size` through NODE_OPTIONS, which
 *    every per-file child of `node --test` inherits): a leak dies on its own
 *    with "heap out of memory" instead of eating the machine;
 *  - `--test-timeout` per test, and per FILE: with per-file process isolation
 *    (the default) a file is a test to the runner, which kills its process
 *    when it overruns. So this already stops a synchronous loop, and the 2
 *    minutes are the budget of a whole file, from the start of its process: a
 *    file too long for them under load is to split (TODO #657);
 *  - a wall-clock limit on the whole run AND an inactivity limit (no output
 *    at all), both killing the entire process tree. They cover what the
 *    runner's own timeout does not: the runner itself stuck, a process a
 *    test spawned and never reaped, `--test-isolation=none`;
 *  - a resident-memory limit on the sum of the Node processes of the run
 *    (default: the smaller of 8 GB and half the RAM), killing the tree. The
 *    heap ceiling does not see memory outside the V8 heap: on 19/09/2026 a
 *    jsdom test reached 12.4 GB of RSS under a 1 GB heap ceiling and the
 *    mission's cgroup OOM-killed the agent with it. Each Node process reports
 *    its own RSS from a worker thread (test-rss-preload.mjs, loaded through
 *    NODE_OPTIONS): the runner, every test file, and any Node process a test
 *    spawns. The reading works on every OS and while the test holds its main
 *    thread. Contract limit: a NON-Node executable a test spawns (a native
 *    binary, a shell) is not counted — only the wall-clock and inactivity
 *    limits stop it. Reading any process's RSS needs a per-OS source (/proc,
 *    libproc, the Win32 API) that plain node does not expose.
 *
 * Every limit reads an env override (ROOKS_TEST_*), so a slow machine can
 * breathe; none can be switched off, 0 included.
 *
 * The tests never inherit the address, credential or identity of the live
 * daemon (`withoutDaemonEnv`): a suite run from a mission's shell would
 * otherwise talk to the operator's daemon as that mission (TODO #606).
 *
 * The run also gets a tsx compile cache of its own, removed at the end
 * (`runCacheDir`): each test file is a fresh process that loads tsx, and the
 * shared `<tmp>/tsx-<uid>` had grown to 235,000 entries (every worktree
 * compiles its own copy). tsx lists that directory at startup and scans the
 * list linearly for every module it loads: 2.5 s of CPU for a file that takes
 * 0.65 s with a per-run cache (21/10/2026, TODO #404).
 *
 * Pure node, no dependency, no Unix `timeout`: it runs the same on Windows,
 * macOS and Linux. The default file list lives in the package's own
 * package.json (`rooksTests`), not on the command line: cmd.exe does not
 * expand globs, and `node --test` (Node >= 21) expands them itself.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { totalmem, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensureRoot, ROOT_NAME } from './test-tmp.mjs';

const MIN = 60_000;
const RSS_PRELOAD = join(dirname(fileURLToPath(import.meta.url)), 'test-rss-preload.mjs');
const RSS_POLL_MS = 200;

function envInt(name, fallback) {
  const raw = process.env[name];
  const n = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Default RSS ceiling for the whole test tree: 8 GB, or half the RAM on a
 *  smaller machine. The app suite peaks around 3.4 GB on 32 cores. */
export function defaultRssMb(totalBytes = totalmem()) {
  return Math.min(8192, Math.floor(totalBytes / 1024 / 1024 / 2));
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Sum of the RSS the test processes last reported, in bytes. Reports of
 *  processes that have exited are dropped: they no longer hold memory. */
export function treeRss(dir) {
  let sum = 0;
  let names = [];
  try { names = readdirSync(dir); } catch { return 0; }
  for (const name of names) {
    const pid = Number(name);
    const path = join(dir, name);
    if (!Number.isInteger(pid) || !isAlive(pid)) {
      try { unlinkSync(path); } catch { /* already gone */ }
      continue;
    }
    let bytes = NaN;
    try { bytes = Number(readFileSync(path, 'utf8')); } catch { /* mid-write */ }
    if (Number.isFinite(bytes)) sum += bytes;
  }
  return sum;
}

function readConfig(cwd) {
  const path = join(cwd, 'package.json');
  if (!existsSync(path)) return { imports: [], files: [] };
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  const cfg = pkg.rooksTests ?? {};
  return {
    imports: Array.isArray(cfg.imports) ? cfg.imports : [],
    files: Array.isArray(cfg.files) ? cfg.files : [],
  };
}

/** Argv split: flags go to `node --test`, anything else is a test file. */
export function splitArgs(argv) {
  const flags = [];
  const files = [];
  for (const a of argv) {
    if (a === '--') continue;
    (a.startsWith('-') ? flags : files).push(a);
  }
  return { flags, files };
}

/** NODE_OPTIONS with our heap ceiling, replacing any earlier one. */
export function withHeapCeiling(nodeOptions, mb) {
  const kept = (nodeOptions ?? '')
    .split(/\s+/)
    .filter((o) => o && !o.startsWith('--max-old-space-size'));
  return [...kept, `--max-old-space-size=${mb}`].join(' ');
}

/** NODE_OPTIONS that preloads the RSS reporter, with any earlier copy of it
 *  removed. NODE_OPTIONS and not the runner's argv: every Node process a test
 *  spawns inherits it, so a child that hoards memory is counted in the tree
 *  too. A nested wrapper (this script's own test) re-adds the same file. */
export function withRssPreload(nodeOptions, href) {
  const parts = (nodeOptions ?? '').split(/\s+/).filter(Boolean);
  const kept = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === `--import=${href}`) continue;
    if (parts[i] === '--import' && parts[i + 1] === href) { i++; continue; }
    kept.push(parts[i]);
  }
  // A file URL carries no space (%20), so NODE_OPTIONS needs no quoting.
  return [...kept, `--import=${href}`].join(' ');
}

/** The run's tsx (and Node compile) cache: `<tmp>/rooks-tests/<pid>-cache-*`.
 *  Under the scratch root on purpose: a wrapper killed with SIGKILL leaves it
 *  behind, and the next run's `sweepStale` removes it like any dead scratch. */
export function runCacheDir(realTmp = tmpdir()) {
  const root = join(realTmp, ROOT_NAME);
  ensureRoot(root);
  return mkdtempSync(join(root, `${process.pid}-cache-`));
}

/** `env` with the temp dir pointed at `dir` — the three names `os.tmpdir()`
 *  reads (TMPDIR on POSIX, TEMP/TMP on Windows) — and the real one kept in
 *  ROOKS_TEST_REAL_TMPDIR, where test-tmp-preload.mjs puts each test file's
 *  scratch back. tsx sizes its cache from `os.tmpdir()` when it loads, before
 *  that preload runs. Any other casing is dropped first: a Windows env is
 *  case-insensitive and a child given both `Temp` and `TEMP` keeps only one. */
export function withTmpDir(env, dir, realTmp) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (!/^(tmpdir|tmp|temp)$/i.test(k)) out[k] = v;
  }
  return { ...out, TMPDIR: dir, TMP: dir, TEMP: dir, ROOKS_TEST_REAL_TMPDIR: realTmp };
}

/** What a mission's shell carries to reach the live daemon AS that mission
 *  (`missionIdentityEnv` + the token, in orchestrator/src/agent.ts), plus the
 *  operator's own overrides of the same kind. A suite run from that shell
 *  would otherwise hand them to every test: one that calls the CLI or an HTTP
 *  client without an address of its own would write to the operator's daemon
 *  with the mission's credential (TODO #606). Same idea as paths.ts refusing
 *  the real home under the test runner. A test that needs one sets it itself. */
export const DAEMON_ENV_KEYS = [
  'ROOKS_API',
  'ROOKS_API_TOKEN',
  'ROOKS_ORCH_URL',
  'ROOKS_DAEMON_TOKEN',
  'ROOKS_MISSION_ID',
  'ROOKS_TRACE_ID',
  'ROOKS_WORKFLOW_RUN_ID',
  'ROOKS_WORKFLOW_NODE_ID',
  'ROOKS_AGENT',
  'ROOKS_PROJECT',
];

/** `env` without DAEMON_ENV_KEYS, whatever their casing: a Windows env is
 *  case-insensitive, so `Nova_Api` would reach the child as ROOKS_API. */
export function withoutDaemonEnv(env) {
  const banned = new Set(DAEMON_ENV_KEYS);
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (!banned.has(k.toUpperCase())) out[k] = v;
  }
  return out;
}

function removeDir(dir) {
  // maxRetries: Windows refuses to delete a file a dying process still holds.
  try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* swept later */ }
}

/** Kills the child AND everything it spawned. POSIX: the child leads its own
 *  process group (spawned detached), so one negative-pid signal reaches the
 *  per-file workers too. Windows has no process groups; `taskkill /T` walks
 *  the parent-pid tree — the host adapter of orchestrator/src/host is
 *  TypeScript and this script must run before any compilation, from app/ too. */
function killTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  // Still valid once the leader has exited: the group lives while a member does.
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ }
}

/** How long the verdict may wait for a slow reader before the wrapper exits anyway. */
const FLUSH_MS = 10_000;

/**
 * Copies `from` to `to`, pausing `from` while `to` is full. Without it, a
 * reader slower than the tests (a CI log under a flood of warnings) left the
 * output queued in this process, unbounded: the log fell an hour behind the
 * run, and the limits' verdict waited at the end of that queue — CI run of
 * 05/11/2026, cancelled by hand after 68 minutes. Paused, the tests wait on
 * their own writes, the log stays live, and the limits show when they fire.
 * `stalled` holds the streams waiting on their reader.
 */
export function forward(from, to, onChunk, stalled = new Set()) {
  from.on('data', (chunk) => {
    onChunk(chunk);
    if (to.write(chunk)) return;
    from.pause();
    stalled.add(from);
    to.once('drain', () => { stalled.delete(from); from.resume(); });
  });
}

function main() {
  const cwd = process.cwd();
  const cfg = readConfig(cwd);
  const { flags, files } = splitArgs(process.argv.slice(2));
  const explicit = files.length > 0;

  const heapMb = envInt('ROOKS_TEST_MAX_OLD_SPACE_MB', 4096);
  const testTimeoutMs = envInt('ROOKS_TEST_TIMEOUT_MS', 2 * MIN);
  // One file has no business running for 10 minutes; the whole suite gets more.
  const totalMs = envInt('ROOKS_TEST_TOTAL_TIMEOUT_MS', explicit ? 10 * MIN : 30 * MIN);
  const idleMs = envInt('ROOKS_TEST_IDLE_TIMEOUT_MS', 5 * MIN);
  const rssMb = envInt('ROOKS_TEST_MAX_RSS_MB', defaultRssMb());
  const rssDir = mkdtempSync(join(tmpdir(), 'rooks-test-rss-'));
  const realTmp = tmpdir();
  const cacheDir = runCacheDir(realTmp);

  const args = [
    '--test',
    `--test-timeout=${testTimeoutMs}`,
    // The reporter follows OUR terminal, not the pipe we read the child through.
    ...(process.stdout.isTTY ? ['--test-reporter=spec'] : []),
    ...cfg.imports.flatMap((m) => ['--import', m]),
    ...flags,
    ...(explicit ? files : cfg.files),
  ];

  const env = {
    ...withTmpDir(withoutDaemonEnv(process.env), cacheDir, realTmp),
    // NODE_OPTIONS preloads run before the argv ones: the reporter watches
    // the loading of tsx and the test files too.
    NODE_OPTIONS: withRssPreload(withHeapCeiling(process.env.NODE_OPTIONS, heapMb), pathToFileURL(RSS_PRELOAD).href),
    ROOKS_TEST_RSS_DIR: rssDir,
    ROOKS_TEST_MAX_RSS_MB: String(rssMb),
  };
  // Set by a parent `node --test`: the child would then speak the runner's
  // internal protocol instead of running its own suite.
  delete env.NODE_TEST_CONTEXT;

  const child = spawn(process.execPath, args, {
    cwd,
    env,
    stdio: ['inherit', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });

  let killedFor = null;
  let rssSeenMb = 0;
  let heapDeath = false;
  let timedOut = false;
  // Streams paused until their reader catches up (`forward`): a limit that
  // fires meanwhile names the stalled reader instead of a silent test.
  const stalled = new Set();
  let stalledAtKill = false;
  const stop = (why) => {
    if (killedFor) return;
    killedFor = why;
    stalledAtKill = stalled.size > 0;
    killTree(child);
  };

  let idle = setTimeout(() => stop('idle'), idleMs);
  const total = setTimeout(() => stop('total'), totalMs);
  const rssWatch = setInterval(() => {
    const mb = Math.round(treeRss(rssDir) / 1024 / 1024);
    if (mb > rssMb) { rssSeenMb = mb; stop('rss'); }
  }, RSS_POLL_MS);
  const onData = (chunk) => {
    const text = chunk.toString();
    if (!heapDeath && /heap out of memory|Reached heap limit/i.test(text)) heapDeath = true;
    if (!timedOut && /timed out after \d+ms/.test(text)) timedOut = true;
    // A test process that killed itself on the limit before our next tick.
    const selfKilled = /\[run-tests\] RSS-LIMIT: test process \d+ reached (\d+) MB/.exec(text);
    if (selfKilled) { rssSeenMb = Number(selfKilled[1]); stop('rss'); }
    clearTimeout(idle);
    idle = setTimeout(() => stop('idle'), idleMs);
  };
  forward(child.stdout, process.stdout, onData, stalled);
  forward(child.stderr, process.stderr, onData, stalled);

  // Ctrl-C / SIGTERM: the child is in its own group and would not get it.
  const onSignal = (sig) => {
    stop(sig);
    rmSync(rssDir, { recursive: true, force: true });
    removeDir(cacheDir);
    process.exit(130);
  };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, onSignal);

  // Workers may outlive the runner (it died, they did not): sweep the group as
  // soon as it exits, or 'close' would wait on pipes they still hold.
  let letGo = null;
  child.on('exit', () => {
    killTree(child);
    // A process that escaped the group (setsid) could still hold our pipes and
    // keep 'close' from ever firing — and so could a stream paused on a reader
    // that stopped reading: give it a moment, then let go of them.
    letGo = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); }, 5_000);
  });
  // 'close', not 'exit': the last lines of output arrive after 'exit'.
  child.on('close', (code, signal) => {
    clearTimeout(letGo);
    clearTimeout(idle);
    clearTimeout(total);
    clearInterval(rssWatch);
    // Node waits for every pending write before it exits: behind a reader that
    // stopped reading, the verdict would hold the job forever. The queue is
    // bounded (`forward`), so a reader that still reads gets all of it.
    setTimeout(() => process.exit(), FLUSH_MS).unref();
    rmSync(rssDir, { recursive: true, force: true });
    removeDir(cacheDir);
    for (const sig of ['SIGINT', 'SIGTERM']) process.off(sig, onSignal);
    if (killedFor === 'total' || killedFor === 'idle') {
      const limit = killedFor === 'total'
        ? `ran for more than ${Math.round(totalMs / 1000)} s (ROOKS_TEST_TOTAL_TIMEOUT_MS)`
        : stalledAtKill
          ? `could not print for ${Math.round(idleMs / 1000)} s: whatever reads its output stopped reading (ROOKS_TEST_IDLE_TIMEOUT_MS)`
          : `printed nothing for ${Math.round(idleMs / 1000)} s (ROOKS_TEST_IDLE_TIMEOUT_MS)`;
      process.stderr.write(
        `\n[run-tests] KILLED: the test run ${limit}; every test process was stopped.\n`
        + (stalledAtKill
          ? '[run-tests] The tests were waiting for their output to be read: a test that prints in a loop '
            + '(the same warning thousands of times) is the usual cause, and a bug to fix.\n'
          : '[run-tests] A test that runs this long is a bug to fix — an infinite loop, a leak, '
            + 'a promise that never settles — not something to rerun as is.\n'),
      );
      process.exitCode = 124;
      return;
    }
    if (killedFor === 'rss') {
      process.stderr.write(
        `\n[run-tests] KILLED: the test processes reached ${rssSeenMb} MB of resident memory, over the `
        + `${rssMb} MB limit (ROOKS_TEST_MAX_RSS_MB); every test process was stopped.\n`
        + '[run-tests] Memory outside the V8 heap (Buffers, ArrayBuffers, native objects) is not held by '
        + 'the heap ceiling. This is a leak or an unbounded loop to fix, not something to rerun as is.\n',
      );
      process.exitCode = 137;
      return;
    }
    if (heapDeath) {
      process.stderr.write(
        `\n[run-tests] A test process hit the ${heapMb} MB heap ceiling (ROOKS_TEST_MAX_OLD_SPACE_MB). `
        + 'This is a leak or an unbounded loop in the test or the code under test: fix it, do not rerun it.\n',
      );
    }
    if (timedOut) {
      process.stderr.write(
        `\n[run-tests] A test overran the ${Math.round(testTimeoutMs / 1000)} s per-test limit (ROOKS_TEST_TIMEOUT_MS). `
        + 'An infinite loop or a promise that never settles is a bug to fix, not something to rerun.\n',
      );
    }
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

// Imported by its own test for the pure helpers: run only when executed.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
