/**
 * The conformance suite of a line-oriented provider: a CLI that prints one JSON
 * object per line and is launched by the daemon.
 *
 * Nothing here spawns your CLI or touches the network: `buildSpawn` is called
 * for what it returns, `parseLine` is fed a recorded transcript, and the
 * transcript is replayed through the engine the daemon runs. One suite for every
 * provider: the product's own run through the same checks (`contract.test.ts`),
 * which is the reason a green run here means something.
 *
 * Add a provider = describe it with a `LineExpectation` (and record its
 * transcript). Whatever is not in the expectation is checked in general terms.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ASSISTANT_DELTA, PERMISSION_MODELS, RATE_LIMIT_REPORTINGS, SESSION_STORES,
  type Backend, type BuildSpawnOpts, type NormalizedEvent,
} from '../provider.js';
import { providerRuntime } from './runtime.js';

const { accountUsageProblems, isUsageNotSignedInError } = providerRuntime.usage;
const { fromLegacy, openProcessSession } = providerRuntime.engine;
import { HOSTILE_EVENTS, hugeLine, MALFORMED_JSON_LINES, NOT_JSON_LINES } from './hostile.js';
import { createFakeCli } from './fake-cli.js';
import { CHUNKINGS, replayTranscript, transcriptLines } from './transcript.js';
import type { ConformanceCheck, ConformanceContext, LineExpectation } from './types.js';

/** The longest single argument Linux accepts (32 pages): past it `execve` fails
 *  with E2BIG and the CLI never starts. */
export const MAX_ARG_STRLEN = 131_072;

export const DEFAULT_SYSTEM_PROMPT = 'You are a TIMON test agent. Answer in English.';
export const DEFAULT_MESSAGE = 'Read src/index.ts and tell me what it contains.';
export const DEFAULT_MISSION_ID = 'mission-contract-0001';
export const DEFAULT_RESUME_ID = 'resume-session-9f3b2a1c';

/** The vocabulary every event of a turn belongs to. */
const VOCAB = new Set(['system', 'assistant', 'user', 'result', ASSISTANT_DELTA]);

export function spawnOptions(
  ctx: ConformanceContext, model: string, resumeSession: string | null, over: Partial<BuildSpawnOpts> = {},
): BuildSpawnOpts {
  return {
    agentName: 'TIMON.contract',
    systemPrompt: ctx.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
    message: ctx.message ?? DEFAULT_MESSAGE,
    resumeSession,
    cfg: { cwd: ctx.cwd, model, permission_mode: 'auto' },
    missionId: ctx.missionId ?? DEFAULT_MISSION_ID,
    ...over,
  };
}

/** Everything under `dirs`, concatenated: the channel of a provider that hands
 *  its prompt to the CLI through a file. Best effort: unreadable files are skipped. */
export function filesUnder(dirs: readonly string[]): string {
  let out = '';
  for (const dir of dirs) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true, recursive: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const parent = (entry as { parentPath?: string; path?: string }).parentPath ?? (entry as { path?: string }).path ?? dir;
      try { out += readFileSync(join(parent, entry.name), 'utf8'); } catch { /* unreadable */ }
    }
  }
  return out;
}

/** A process whose only live part is the stdin a provider writes follow-ups to. */
function fakeProc(sink: string[]): never {
  return { stdin: { write: (s: string) => { sink.push(s); return true; } } } as never;
}

function parseAll(provider: Backend, lines: readonly string[]): NormalizedEvent[] {
  return lines.flatMap((line) => provider.parseLine(line));
}

/**
 * @param provider the dialect bound to a profile: `bindDialect(dialect, profile)`
 *                 for yours, the registry's `getBackend(name)` for the daemon's.
 */
export function lineProviderChecks(
  provider: Backend, exp: LineExpectation, ctx: ConformanceContext,
): ConformanceCheck[] {
  const lines = transcriptLines(exp.transcript);
  const spawnOpts = (resume: string | null, over: Partial<BuildSpawnOpts> = {}) =>
    spawnOptions(ctx, exp.model, resume, over);
  const systemPrompt = ctx.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const message = ctx.message ?? DEFAULT_MESSAGE;
  const resumeId = ctx.resumeId ?? DEFAULT_RESUME_ID;
  const scratch = ctx.scratchDirs ?? [];

  const checks: ConformanceCheck[] = [];
  const add = (name: string, run: ConformanceCheck['run']) => checks.push({ name, run });

  add('declared capabilities are well formed', () => {
    assert.equal(typeof provider.persistentProcess, 'boolean');
    assert.equal(typeof provider.finishMissionOnExit, 'boolean');
    assert.equal(typeof provider.hostedConnectors, 'boolean');
    assert.equal(typeof provider.sessionResumable, 'boolean');
    assert.ok(SESSION_STORES.includes(provider.sessionStore), `invalid sessionStore: ${provider.sessionStore}`);
    // A process that lives for the whole mission can die (crash, OOM, restart):
    // without a session that survives it, the conversation goes with it.
    if (provider.persistentProcess) assert.equal(provider.sessionResumable, true);
    // A session kept in a GLOBAL store outlives the process that created it.
    if (provider.sessionStore === 'global') assert.equal(provider.sessionResumable, true);
    assert.ok(PERMISSION_MODELS.includes(provider.permissionModel), `invalid permissionModel: ${provider.permissionModel}`);
    assert.ok(RATE_LIMIT_REPORTINGS.includes(provider.rateLimitReporting), `invalid rateLimitReporting: ${provider.rateLimitReporting}`);
    // A session driver holds a process that outlives the turn: never a one-shot.
    if (provider.openSession) {
      assert.equal(typeof provider.openSession, 'function');
      assert.equal(provider.persistentProcess, true, 'openSession requires a persistent process');
    }
  });

  // A session-driven provider has no line stream: its contract lives with its
  // driver (a fake agent over pipes), not with a transcript.
  if (provider.openSession) return checks;

  add('a message at maxPromptBytes still fits in argv', async () => {
    if (!provider.maxPromptBytes) {
      // No ceiling announced = the prompt must not travel in argv at all.
      const sp = await provider.buildSpawn(spawnOpts(null));
      assert.ok(!sp.args.some((a) => a.includes(message)), 'the message is in argv but no maxPromptBytes is declared');
      return;
    }
    // Multi-byte characters everywhere: the worst case of real text.
    // french-ok: a two-byte letter, not French text
    const big = 'é'.repeat(Math.floor(provider.maxPromptBytes / 2));
    const sp = await provider.buildSpawn(spawnOpts(null, { message: big }));
    const longest = Math.max(...sp.args.map((a) => Buffer.byteLength(a, 'utf8')));
    assert.ok(
      longest < MAX_ARG_STRLEN,
      `an argument of ${longest} bytes reaches MAX_ARG_STRLEN (${MAX_ARG_STRLEN}): maxPromptBytes=${provider.maxPromptBytes} is too permissive`,
    );
  });

  add('buildSpawn (fresh): binary, args, env and cwd', async () => {
    const sp = await provider.buildSpawn(spawnOpts(null));
    assert.equal(sp.cmd, exp.cmd);
    assert.ok(Array.isArray(sp.args) && sp.args.length > 0, 'empty args');
    assert.ok(sp.args.every((a) => typeof a === 'string'), 'a non-string arg');
    assert.equal(sp.cwd, ctx.cwd, 'cwd must come from cfg.cwd');
    // The system prompt and the message MUST reach the CLI, whatever the channel:
    // argv, stdin, or a file the CLI reads at startup.
    const reachable = sp.args.join(' ') + (sp.initialStdin ?? '') + filesUnder(scratch);
    assert.ok(reachable.includes(systemPrompt), 'the system prompt is in neither args, initialStdin nor the files of the spawn (scratchDirs)');
    assert.ok(reachable.includes(message), 'the user message is in neither args, initialStdin nor the files of the spawn (scratchDirs)');
    assert.ok(sp.args.includes(exp.model), `model ${exp.model} not passed to the CLI`);
    for (const key of exp.envKeys ?? []) assert.ok(sp.env?.[key], `env.${key} missing from the spawn`);
    for (const [k, v] of Object.entries(sp.env ?? {})) assert.ok(k.length > 0 && typeof v === 'string', `env.${k} is malformed`);
  });

  add('buildSpawn (resume): the session id is passed', async () => {
    const fresh = await provider.buildSpawn(spawnOpts(null));
    const resumed = await provider.buildSpawn(spawnOpts(resumeId));
    assert.equal(resumed.cmd, exp.cmd);
    assert.ok(resumed.args.includes(resumeId), `resume id missing from args: ${resumed.args.join(' ')}`);
    assert.ok(!fresh.args.includes(resumeId), 'a fresh spawn must not resume');
    // Whether the first turn rides on stdin is a property of the provider, not of the turn.
    assert.equal(resumed.initialStdin === null, fresh.initialStdin === null);
  });

  add('capabilities agree with the spawn: initialStdin, writeUserInput, finishMissionOnExit', async () => {
    const sp = await provider.buildSpawn(spawnOpts(null));
    // A persistent process has only stdin for its first turn. The reverse does
    // not hold: a one-shot may read its prompt on stdin then EOF (the daemon
    // closes the stream for it).
    if (provider.persistentProcess) {
      assert.notEqual(sp.initialStdin, null, 'a persistent provider must start its first turn through stdin');
    }
    const sink: string[] = [];
    provider.writeUserInput(fakeProc(sink), 'next turn');
    assert.equal(
      sink.length > 0, provider.persistentProcess,
      provider.persistentProcess
        ? 'a persistent provider must write the next turn on stdin'
        : 'a one-shot provider must not write on stdin: the next turn is a new launch',
    );
    // One process per turn: its exit cannot end a mission that outlives it.
    if (!provider.persistentProcess) {
      assert.equal(provider.finishMissionOnExit, false, 'finishMissionOnExit cannot be true for a one-shot provider');
    }
  });

  add("timonMcp: false declares none of Timon's MCP servers", async () => {
    const sp = await provider.buildSpawn(spawnOpts(null, { timonMcp: false }));
    const reachable = sp.args.join(' ') + (sp.initialStdin ?? '') + filesUnder(scratch);
    // The server DECLARED (a JSON entry, a TOML table); naming one of its tools in an allow-list is harmless.
    const declared = /"timon(_ask)?"\s*:\s*\{|\[mcp_servers\.timon(_ask)?[\].]/.exec(reachable);
    assert.equal(declared, null, `Timon's MCP server is declared (${declared?.[0] ?? ''}) although timonMcp is false`);
  });

  add('parseLine: the normalized vocabulary', () => {
    const events = parseAll(provider, lines);
    assert.ok(events.length > 0, 'the transcript produces no event');
    const types = new Set(events.map((e) => e.type));
    for (const t of types) assert.ok(VOCAB.has(t), `event type outside the normalized vocabulary: ${t}`);
    for (const t of ['system', 'assistant', 'result']) assert.ok(types.has(t), `no '${t}' event produced by the transcript`);

    // Exactly one system:init per turn.
    const inits = events.filter((e) => e.type === 'system' && (e.payload as { subtype?: string }).subtype === 'init');
    assert.equal(inits.length, 1, 'exactly one system:init per turn is expected');
    if ((exp.initAt ?? 'head') === 'head') {
      assert.equal(events[0], inits[0], 'the system:init must open the flow');
    } else {
      assert.equal(events[events.indexOf(inits[0]!) + 1]?.type, 'result', 'the system:init must come right before the final result');
    }

    // The result says whether it failed: that is what the mission reads.
    for (const ev of events.filter((e) => e.type === 'result')) {
      const p = ev.payload as { subtype?: string; is_error?: unknown };
      assert.equal(typeof p.is_error, 'boolean', 'a result without a boolean is_error');
      assert.ok(p.subtype === 'success' || p.subtype === 'error', `unexpected result subtype: ${p.subtype}`);
    }
    // Every event is stored and put on the bus: it must serialize.
    for (const ev of events) assert.doesNotThrow(() => JSON.stringify(ev.payload));
  });

  add("parseLine: a persistent process emits no 'assistant' after its result", () => {
    if (!provider.persistentProcess) return;
    const events = parseAll(provider, lines);
    const closed = events.findIndex((e) => e.type === 'result');
    const late = closed < 0 ? -1 : events.findIndex((e, i) => i > closed && e.type === 'assistant');
    assert.equal(late, -1, "an 'assistant' after the 'result' reads as a new turn the CLI opened by itself: this recording holds one turn, and that one is over");
  });

  add('parseLine: lines that are not JSON are ignored', () => {
    for (const line of NOT_JSON_LINES) {
      assert.deepEqual(provider.parseLine(line), [], `a non-JSON line must produce 0 events: ${JSON.stringify(line)}`);
    }
  });

  add('parseLine: never throws, whatever the line', () => {
    const hostile = [...MALFORMED_JSON_LINES, hugeLine()];
    for (const line of hostile) {
      let events: NormalizedEvent[] = [];
      assert.doesNotThrow(() => { events = provider.parseLine(line); }, `parseLine threw on ${JSON.stringify(line.slice(0, 80))}`);
      assert.ok(Array.isArray(events), `parseLine must return an array for ${JSON.stringify(line.slice(0, 80))}`);
      for (const ev of events) {
        assert.equal(typeof ev.type, 'string', 'an event without a string type');
        assert.doesNotThrow(() => JSON.stringify(ev.payload), 'an event whose payload does not serialize');
        assert.doesNotThrow(() => provider.extractSessionId(ev), 'extractSessionId threw on an event parseLine produced');
      }
    }
  });

  add('extractSessionId: the id comes from the system:init, and only from it', () => {
    const events = parseAll(provider, lines);
    const ids = events.map((e) => provider.extractSessionId(e)).filter((v) => v !== null);
    assert.deepEqual(ids, [exp.sessionId], 'exactly one event must carry the session id, and it is the system:init');
    for (const ev of events.filter((e) => e.type !== 'system')) {
      assert.equal(provider.extractSessionId(ev), null, `a '${ev.type}' event carries a session id`);
    }
    assert.equal(provider.extractSessionId({ type: 'system', payload: { subtype: 'compact' } }), null);
    assert.equal(provider.extractSessionId({ type: 'system', payload: { subtype: 'init', session_id: '' } }), null, 'an empty id must not be returned');
  });

  add('extractSessionId: never throws and never invents an id', () => {
    for (const ev of HOSTILE_EVENTS) {
      const got: { id: string | null } = { id: null };
      assert.doesNotThrow(() => { got.id = provider.extractSessionId(ev as NormalizedEvent); }, `extractSessionId threw on ${JSON.stringify(ev)}`);
      assert.ok(got.id === null || (typeof got.id === 'string' && got.id.length > 0), `extractSessionId returned ${JSON.stringify(got.id)}`);
    }
  });

  add('dispose is safe with no state on disk', () => {
    if (!provider.dispose) return;
    assert.doesNotThrow(() => provider.dispose!('mission-that-never-existed-0000'));
  });

  add('replay: the engine reads the transcript like parseLine does, however the bytes arrive', async () => {
    const expected = parseAll(provider, lines);
    for (const chunking of CHUNKINGS) {
      const replay = await replayTranscript(provider, lines, spawnOpts(null), chunking);
      assert.deepEqual(replay.events, expected, `[${chunking}] the engine emitted other events than parseLine`);
      assert.equal(replay.sessionId, exp.sessionId, `[${chunking}] the engine did not learn the session id`);
      replay.driver.close();
    }
  });

  add('replay: a real process printing the transcript is read through the engine like parseLine does', async () => {
    const expected = parseAll(provider, lines);
    const dir = mkdtempSync(join(tmpdir(), 'timon-fake-cli-'));
    try {
      const proc = createFakeCli({ dir, lines }).spawn();
      // The process may exit before it reads stdin: that is not a failure of the provider.
      proc.stdin.on('error', () => undefined);
      const events: NormalizedEvent[] = [];
      const driver = openProcessSession(fromLegacy(provider, { proc }), {
        io: proc,
        spawn: spawnOpts(null),
        host: { emit: (ev) => { events.push(ev); }, requestPermission: async () => ({ allow: false }) },
        initialStdin: null,
      });
      await new Promise<void>((resolve, reject) => {
        proc.once('error', reject);
        proc.once('close', () => resolve());
      });
      assert.deepEqual(events, expected, 'the engine emitted other events than parseLine, reading from a real pipe');
      assert.equal(driver.info?.sessionId, exp.sessionId);
      driver.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  if (ctx.checkUsage && provider.accountUsage) {
    add('accountUsage: a well-formed gauge, null, or a typed "not signed in"', async () => {
      const outcome = await provider.accountUsage!().then((usage) => ({ usage }), (error: unknown) => ({ error }));
      if ('error' in outcome) {
        assert.ok(outcome.error instanceof Error, 'accountUsage must reject with an Error');
        if (isUsageNotSignedInError(outcome.error)) return;
        assert.ok(outcome.error.message.trim().length > 0, 'accountUsage rejected with an empty message');
        return;
      }
      assert.deepEqual(accountUsageProblems(outcome.usage), []);
    });
  }

  return checks;
}

export { transcriptLines };
