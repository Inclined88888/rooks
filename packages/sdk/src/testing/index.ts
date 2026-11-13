/**
 * `@rooks/sdk/testing` — the conformance bench a provider author runs on
 * their own dialect. The product's own providers pass the same checks: a green
 * run here is the contract Rooks applies, not a courtesy approximation of it.
 * From API 14 it also holds the bench of a dictation engine
 * (`dictationEngineChecks`, fake PCM, a fake engine: `./dictation.ts`).
 *
 *   import { test } from 'node:test';
 *   import { bindDialect, defineConformanceTests, lineProviderChecks, loadTranscript } from '@rooks/sdk/testing';
 *
 *   const provider = bindDialect(myDialect, { id: 'my-llm', env: { MY_KEY: 'x' } });
 *   defineConformanceTests(test, lineProviderChecks(provider, {
 *     transcript: loadTranscript('fixtures/turn.jsonl'),   // recorded from the real CLI
 *     sessionId: 'abc-123', cmd: 'my-cli', model: 'my-model-1',
 *   }, { cwd: process.cwd() }));
 */

import { isRemoteDialect, type AnyDialect } from '../provider.js';
import { providerRuntime } from './runtime.js';
import { bindDialect, type BoundProfile } from './bind.js';
import { lineProviderChecks } from './line-checks.js';
import { remoteProviderChecks } from './remote-checks.js';
import type { ConformanceCheck, ConformanceContext, LineExpectation, RemoteExpectation, TestFn } from './types.js';

export { bindDialect } from './bind.js';
export type { BoundProfile } from './bind.js';
export {
  DEFAULT_MESSAGE, DEFAULT_MISSION_ID, DEFAULT_RESUME_ID, DEFAULT_SYSTEM_PROMPT, filesUnder, lineProviderChecks,
  MAX_ARG_STRLEN, spawnOptions,
} from './line-checks.js';
export { fakeRemoteHost, remoteProviderChecks } from './remote-checks.js';
export { acpSessionChecks, createAcpReplayPeer, loadAcpScript } from './acp-checks.js';
export type { AcpExtensionExpectation, AcpReplayPeer, AcpScriptMessage, AcpScriptStep, AcpSessionExpectation } from './acp-checks.js';
export { CHUNKINGS, loadTranscript, replayTranscript, transcriptLines } from './transcript.js';
export type { Chunking, ReplayResult } from './transcript.js';
export { createFakeCli } from './fake-cli.js';
export { createProviderContext, FAKE_TOKEN_REFERENCE } from './context.js';
export type { LoggedLine, ProviderContextOptions, TestProviderContext } from './context.js';
export { providerRuntime } from './runtime.js';
export type { FakeCli, FakeCliOptions } from './fake-cli.js';
export {
  chunkPcm, concatPcm, createFakeDictationEngine, DICTATION_ERROR_CODES, DICTATION_SAMPLE_RATE, DICTATION_TEXT_MAX,
  dictationEngineChecks, dictationEngineProblem, dictationEventProblem, fakeUtterance, pcmToWav, readWavPcm, runDictation,
  silencePcm, speechLikePcm,
} from './dictation.js';
export type {
  DictationErrorEvent, DictationExpectation, DictationRun, DictationRunOptions, FakeDictationEngine,
  FakeDictationEngineOptions, FakeDictationSessionRecord, FakeHearing,
} from './dictation.js';
export { HOSTILE_EVENTS, hugeLine, MALFORMED_JSON_LINES, NOT_JSON_LINES } from './hostile.js';
export type {
  ConformanceCheck, ConformanceContext, LineExpectation, RemoteExpectation, TestFn,
} from './types.js';

/** The registration check the daemon applies, as a check of the suite. */
export function dialectDeclarationChecks(dialect: AnyDialect): ConformanceCheck[] {
  return [{
    name: 'the dialect declarations agree with each other (what registration enforces from API 11)',
    run() {
      const problems = providerRuntime.check.dialectProblems(dialect);
      if (problems.length) throw new Error(problems.join('\n'));
    },
  }];
}

/**
 * Everything for one dialect: its declarations, then the suite that matches what
 * it is (a CLI that prints lines, or a remote session).
 */
export function dialectConformance(
  dialect: AnyDialect,
  profile: BoundProfile,
  exp: LineExpectation | RemoteExpectation | ((provider: ReturnType<typeof bindDialect>) => RemoteExpectation),
  ctx: ConformanceContext,
): ConformanceCheck[] {
  const provider = bindDialect(dialect, profile);
  if (isRemoteDialect(dialect)) {
    const expectation = typeof exp === 'function' ? exp(provider) : exp as RemoteExpectation;
    return [...dialectDeclarationChecks(dialect), ...remoteProviderChecks(expectation, ctx)];
  }
  return [...dialectDeclarationChecks(dialect), ...lineProviderChecks(provider, exp as LineExpectation, ctx)];
}

/** Registers every check with your test runner, `prefix` in front of each name. */
export function defineConformanceTests(test: TestFn, checks: readonly ConformanceCheck[], prefix = ''): void {
  for (const check of checks) test(prefix ? `${prefix} ${check.name}` : check.name, check.run);
}
