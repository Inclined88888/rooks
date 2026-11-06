/**
 * Host half of the quota monitor — reference template for the `usage`
 * capability (§10.15).
 *
 * This plugin used to be a BUNDLED module: a daemon route, an entry in the
 * kernel catalogue, an aggregator in `usage.ts`. It is the same product
 * feature, written entirely against the SDK — which is the whole point: if a
 * community author cannot reproduce a first-party surface, the SDK is
 * incomplete, and nobody notices until they try.
 *
 * Everything below uses only `ctx`: quotas (`ctx.usage`, permission
 * `usage:read`), history (`ctx.storage.kv`, `storage`), thresholds
 * (`ctx.settings`, `settings`) and its own routes (`ctx.router()`).
 */

const HISTORY_PREFIX = 'history:'
const LATEST_PREFIX = 'latest:'
/** One point per backend per quarter hour: enough to draw a week, small
 *  enough that 90 days stay a few thousand rows. */
const BUCKET_MS = 15 * 60_000
const DAY_MS = 24 * 60 * 60_000

export const name = 'quota-monitor'

/** Highest real utilisation across every window and the credit pool. `null`
 *  when nothing is known — never 0, which would read as "plenty left". */
export function usageRisk(usage) {
  if (!usage) return null
  const values = Object.values(usage.windows ?? {})
    .filter((window) => window && Number.isFinite(window.utilization))
    .map((window) => window.utilization)
  if (usage.extra?.is_enabled && Number.isFinite(usage.extra.utilization)) values.push(usage.extra.utilization)
  return values.length ? Math.max(...values) : null
}

/** A transient probe failure must not erase the last trustworthy reading. */
export async function preserveLastUsage(ctx, entry, at) {
  const risk = usageRisk(entry.usage)
  const key = `${LATEST_PREFIX}${entry.backend}`
  if (entry.available && risk !== null) {
    await ctx.storage.kv.set(key, { at, usage: entry.usage, risk })
    return { ...entry, risk, state: 'available', stale: false }
  }
  if (entry.error) {
    const previous = await ctx.storage.kv.get(key)
    if (previous && typeof previous.at === 'number' && previous.usage && typeof previous.risk === 'number') {
      return {
        ...entry,
        usage: previous.usage,
        risk: previous.risk,
        state: 'stale',
        stale: true,
        staleAt: previous.at,
      }
    }
  }
  return {
    ...entry,
    risk,
    state: entry.available ? 'available'
      : entry.connected === false ? 'disconnected'
      : entry.error ? 'unavailable' : 'unsupported',
    stale: false,
  }
}

/** Keep polling while a probe can still change. A missing CLI session will
 *  not appear by retrying: stop as soon as any visible entry is disconnected,
 *  even when another backend is only unsupported. The browser half applies
 *  the same rule (it cannot import this file: the client is served as a
 *  single module). */
export function quotaShouldKeepPolling(entries) {
  return !entries.some((entry) => entry.state === 'disconnected')
}

function readSettings(ctx) {
  const number = (key, fallback, min, max) => {
    const value = Number(ctx.settings.get(key))
    return Number.isFinite(value) && value >= min && value <= max ? value : fallback
  }
  const warningAt = number('warningAt', 70, 1, 99)
  const criticalAt = number('criticalAt', 90, 2, 100)
  return {
    // A warning threshold above the critical one would paint everything
    // orange and nothing red: fall back rather than display a lie.
    warningAt: warningAt < criticalAt ? warningAt : 70,
    criticalAt: warningAt < criticalAt ? criticalAt : 90,
    historyDays: number('historyDays', 90, 1, 365),
    hidden: String(ctx.settings.get('hiddenBackends') ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean),
  }
}

async function recordSnapshot(ctx, entries, at, historyDays) {
  const bucket = Math.floor(at / BUCKET_MS) * BUCKET_MS
  for (const entry of entries) {
    if (entry.risk === null) continue
    await ctx.storage.kv.set(`${HISTORY_PREFIX}${bucket}:${entry.backend}`, {
      at, backend: entry.backend, risk: entry.risk,
    })
  }
  const cutoff = at - historyDays * DAY_MS
  for (const row of await ctx.storage.kv.list(HISTORY_PREFIX)) {
    const bucketAt = Number(row.key.slice(HISTORY_PREFIX.length).split(':')[0])
    if (Number.isFinite(bucketAt) && bucketAt < cutoff) await ctx.storage.kv.del(row.key)
  }
}

/** The storage is the plugin's, shared by every user: only the backends the
 *  caller can see right now come out of it, so one user's subscription
 *  accounts never show in another's trend. */
export async function readHistory(ctx, visible) {
  const points = []
  for (const row of await ctx.storage.kv.list(HISTORY_PREFIX)) {
    const value = row.value
    if (value && typeof value.at === 'number' && typeof value.backend === 'string' && typeof value.risk === 'number'
      && visible.has(value.backend)) {
      points.push({ at: value.at, backend: value.backend, risk: value.risk })
    }
  }
  return points.sort((a, b) => a.at - b.at)
}

/** @param {import('@timon-ai/sdk').PluginContext} ctx */
export function apply(ctx) {
  const router = ctx.router()

  // `?refresh=1` comes from the ↻ button only, never from the polling loop:
  // it asks the probes to skip their cache (a stale failure included).
  router.get('/all', async (request, response) => {
    try {
      const settings = readSettings(ctx)
      const collectedAt = Date.now()
      const force = request.query?.refresh === '1'
      const entries = await Promise.all((await ctx.usage.list(force ? { force: true } : undefined))
        .map((entry) => preserveLastUsage(ctx, entry, collectedAt)))
      await recordSnapshot(ctx, entries, collectedAt, settings.historyDays)
      const visible = entries.filter((entry) => !settings.hidden.includes(entry.backend))
      const riskiest = visible.filter((entry) => entry.risk !== null).sort((a, b) => b.risk - a.risk)[0]
      response.json({
        collectedAt,
        entries: visible,
        highestRisk: riskiest ? { backend: riskiest.backend, utilization: riskiest.risk } : null,
        thresholds: { warning: settings.warningAt, critical: settings.criticalAt },
      })
    } catch (error) {
      response.status(503).json({ error: String(error && error.message ? error.message : error) })
    }
  })

  router.get('/history', async (_request, response) => {
    const settings = readSettings(ctx)
    const visible = new Set((await ctx.usage.list()).map((entry) => entry.backend))
    response.json({ retentionDays: settings.historyDays, points: await readHistory(ctx, visible) })
  })

  /** Providers to offer in the settings pane, with what is hidden today. */
  router.get('/providers', async (_request, response) => {
    const settings = readSettings(ctx)
    response.json({
      providers: (await ctx.usage.list()).map((entry) => ({
        id: entry.backend,
        label: entry.label,
        vendor: entry.vendor,
        measurable: entry.available || Boolean(entry.error),
      })),
      settings: {
        hiddenBackends: settings.hidden,
        warningAt: settings.warningAt,
        criticalAt: settings.criticalAt,
      },
    })
  })
}
