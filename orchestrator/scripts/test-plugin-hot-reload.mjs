#!/usr/bin/env node
/**
 * Manual check: `timon plugin` recomposes the tree of a LIVE daemon, without
 * restarting it (exit criterion of step P.3).
 *
 * What the script mounts: a minimal daemon — Express, the kernel's `http`
 * service, the `PluginLoader` and its `watch()`. Deliberately NOT the full
 * boot: on a maintainer's machine the checkout often **is** the running
 * service, and starting a second orchestrator would run its reconciliation
 * loops (docker, browsers, missions) against the machine's real state. What
 * is tested here — CLI -> disk -> watcher -> mount/unmount — depends on none
 * of those modules.
 *
 * No process is left behind: the "daemon" is this script itself, the CLI is
 * its only child, and it is awaited.
 *
 *   cd orchestrator && npm run build && node scripts/test-plugin-hot-reload.mjs
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

// Throwaway TIMON_HOME, set BEFORE any import that touches TIMON's state.
process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-hot-'))
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0'

const express = (await import('express')).default
const { Context } = await import('@deepseek-ai/cordis')
const { createHttpPlugin } = await import(join(ROOT, 'dist/kernel/http-service.js'))
const { PluginLoader } = await import(join(ROOT, 'dist/plugins/loader.js'))
const { daemonHost } = await import(join(ROOT, 'dist/plugins/context.js'))

const source = join(ROOT, '../examples/plugin-hello')

const app = express()
const ctx = new Context()
await ctx.plugin(createHttpPlugin(app))
const server = app.listen(0)
await new Promise((r) => server.once('listening', r))
const port = server.address().port
const PING = `http://127.0.0.1:${port}/api/plugins/plugin-hello/hello`

const loader = new PluginLoader(ctx, { host: daemonHost(ctx), allowUnsigned: () => true })
await loader.update()
loader.watch(200)

const timon = (...args) => exec(process.execPath, [join(ROOT, 'bin/timon'), 'plugin', ...args], {
  env: process.env, timeout: 120_000,
})

/** The watcher is asynchronous by design: give the daemon time to notice the
 *  change, without ever helping it. */
async function until(expected, label) {
  for (let i = 0; i < 100; i++) {
    const status = await fetch(PING).then((r) => r.status, () => 0)
    if (status === expected) return console.log(`  ✓ ${label} (HTTP ${status})`)
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`✗ ${label}: the route never turned ${expected}`)
}

let failed = false
try {
  console.log(`test daemon on :${port}, TIMON_HOME=${process.env.TIMON_HOME}`)

  console.log(`\n1. timon plugin add ${source}`)
  console.log((await timon('add', source, '--yes')).stdout.trim())
  await until(200, 'the plugin route answers, without a restart')

  console.log('\n2. timon plugin disable plugin-hello')
  console.log((await timon('disable', 'plugin-hello')).stdout.trim())
  await until(404, 'the route is gone, without a restart')

  console.log('\n3. timon plugin enable plugin-hello')
  console.log((await timon('enable', 'plugin-hello')).stdout.trim())
  await until(200, 'the route is back, without a restart')

  console.log('\n4. timon plugin list')
  console.log((await timon('list')).stdout.trim())

  console.log('\n5. timon plugin remove plugin-hello')
  console.log((await timon('remove', 'plugin-hello')).stdout.trim())
  await until(404, 'uninstalling removes the routes, without a restart')

  console.log('\nALL GREEN — hot recomposition checked end to end.')
} catch (err) {
  failed = true
  console.error(`\nFAILED: ${err.message}`)
} finally {
  await loader.dispose()
  server.close()
  await ctx.fiber.dispose()
  rmSync(process.env.TIMON_HOME, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
