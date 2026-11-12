// @ts-check
/**
 * The conformance bench of `@rooks/sdk/testing` on this dialect: the checks
 * Rooks itself applies to its own providers. No CLI, no account, no network —
 * `test/fixtures/turn.jsonl` is a recorded turn (record yours from the real CLI,
 * do not write it from the documentation).
 *
 *   node --test test/
 */
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createProviderContext, defineConformanceTests, dialectConformance, loadTranscript } from '@rooks/sdk/testing'
import { apply } from '../lib/index.js'

// Run the plugin's own `apply` against the stand-in `ctx`, and test what it registered.
const ctx = createProviderContext({ settings: { apiKey: 'a-key-for-tests' } })
apply(ctx)
const echoDialect = ctx.registered.dialect('echo')

const cwd = mkdtempSync(join(tmpdir(), 'echo-conformance-'))
process.on('exit', () => rmSync(cwd, { recursive: true, force: true }))

defineConformanceTests(test, dialectConformance(
  echoDialect,
  { id: 'echo-llm', env: { ECHO_API_KEY: 'a-key-for-tests' } },
  {
    transcript: loadTranscript(fileURLToPath(new URL('./fixtures/turn.jsonl', import.meta.url))),
    sessionId: 'echo-session-7f21c0d4',
    cmd: 'echo',
    model: 'echo-1',
    envKeys: ['ECHO_API_KEY'],
  },
  { cwd },
), '[echo]')
