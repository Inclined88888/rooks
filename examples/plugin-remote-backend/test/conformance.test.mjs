// @ts-check
/**
 * The remote half of the conformance bench: a whole turn, a cancellation, a
 * failure that reads, a daemon restarted mid-turn. The "agent" of this example
 * lives in memory, so the three scenarios are three profiles of the same
 * dialect (environment knobs the example reads).
 *
 *   node --test test/
 */
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bindDialect, createProviderContext, defineConformanceTests, dialectConformance } from '@timon-ai/sdk/testing'
import { apply } from '../lib/index.js'

const cwd = mkdtempSync(join(tmpdir(), 'memory-conformance-'))
process.on('exit', () => rmSync(cwd, { recursive: true, force: true }))

// Run the plugin's own `apply` against the stand-in `ctx`, and test what it registered.
const ctx = createProviderContext()
apply(ctx)
const memoryDialect = ctx.registered.dialect('memory-remote')

/** @param {string} id @param {Record<string, string>} env */
const bind = (id, env) => bindDialect(memoryDialect, { id, env })

defineConformanceTests(test, dialectConformance(
  memoryDialect,
  { id: 'memory-remote' },
  () => ({
    model: 'memory-1',
    scenarios: {
      normal: bind('memory-remote', {}),
      slow: bind('memory-remote-slow', { MEMORY_AGENT_DELAY_MS: '60000' }),
      failing: bind('memory-remote-failing', { MEMORY_AGENT_FAIL: 'prompt' }),
    },
  }),
  { cwd },
), '[memory-remote]')
