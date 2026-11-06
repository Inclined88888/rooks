/**
 * Discord connector: the TO DO notebook and the Discord bot's tickets and
 * suggestions, kept in step. Written the way a third party writes a connector
 * (GitHub Issues, Jira, Slack…): the public `PluginContext` and nothing else.
 *
 *  - in (bot → Timon): the webhook `events`. A `ticket.created` or
 *    `suggestion.created` becomes an idea, tied to its Discord thread by an
 *    external reference (never by its notes), then an investigation task;
 *  - out (Timon → bot): `todo_resolved`, then `todo_done`, posted through the
 *    durable outbox, in order per idea, signed with a vault secret.
 *
 * Both directions are idempotent: the host deduplicates a delivery on its
 * `webhook-id`, `findByRef` (inside `todos.create`) on the ticket.
 *
 * A tester's files go to the idea itself (`ctx.kanban.todos.attachments`):
 * the notebook shows them, a promotion copies them into the task, and the
 * investigating agent reads them through the MCP tool. Older versions kept
 * them under this plugin's data folder; `migrateLegacyAttachments` moves those.
 */
import { readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  PROVIDER, DEFAULT_PROMPT, NOTES_TEMPLATE, UNTRUSTED_HEADER,
  fill, handles, parseInbound, referenceRegex, resolvedBody, doneBody,
  urgencyOf, replySection, attachmentPlan, attachmentMatches, attachmentsNotice, replyFilesNotice, ATTACHMENT_MAX_BYTES,
} from './core.js'

export const name = 'todo-connector-discord'

const STATS_KEY = 'stats'
/** @typedef {{ received?: number, lastAt?: number, lastType?: string, lastOutbox?: { id: string, kind: string, todo: string, at: number }, awaitingApproval?: { ref: string, at: number } | null }} Stats */
/** @returns {Promise<Stats>} */
const readStats = async (ctx) => (await ctx.storage.kv.get(STATS_KEY)) ?? {}
const LEGACY_EVENT_KINDS = ['todo_resolved', 'todo_done']
const LEGACY_WEBHOOK_SLUG = 'discord-events'

/** Re-read at each use: a setting changed in the UI applies to the next event. */
function settingsOf(ctx) {
  const text = (key, fallback) => {
    const value = ctx.settings.get(key)
    return typeof value === 'string' && value.trim() ? value.trim() : fallback
  }
  return {
    workerUrl: text('workerUrl', ''),
    signingSecret: text('signingSecret', 'DISCORD_WORKER_SIGNING'),
    pattern: referenceRegex(text('referencePattern', '')),
    agent: text('investigationAgent', 'timon.researcher'),
    project: text('project', 'timon'),
    prompt: text('investigationPrompt', DEFAULT_PROMPT),
    // The report goes into the idea; the orchestrator's thread has nothing to
    // do with a tester's ticket. Only an explicit `false` lets it report up.
    silent: ctx.settings.get('silentInvestigation') !== false,
  }
}

async function bump(ctx, patch) {
  const stats = (await ctx.storage.kv.get(STATS_KEY)) ?? {}
  await ctx.storage.kv.set(STATS_KEY, { ...stats, ...patch(stats) })
}

/**
 * The tester's files, attached to the idea: Discord CDN links expire within a
 * day. A file the idea already holds (same name, from an earlier delivery) is
 * neither fetched nor attached again; a refused or failed one is only
 * counted, it never blocks the idea.
 */
async function attachFiles(ctx, todoId, data, prefix = '') {
  const plan = attachmentPlan(data.attachments, prefix)
  if (!plan.files.length) return { attached: 0, failed: plan.skipped }
  if (!ctx.fetch) return { attached: 0, failed: plan.files.length + plan.skipped }
  const known = new Set((await ctx.kanban.todos.attachments.list(todoId)).map((f) => f.name))
  let attached = 0
  let failed = plan.skipped
  for (const file of plan.files) {
    if (known.has(file.name)) { attached++; continue }
    try {
      const response = await ctx.fetch(file.url, { redirect: 'error', signal: AbortSignal.timeout(15_000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      if (Number(response.headers.get('content-length') ?? 0) > ATTACHMENT_MAX_BYTES) throw new Error('too large')
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (!attachmentMatches(file.kind, bytes)) throw new Error('content does not match its type')
      await ctx.kanban.todos.attachments.add(todoId, { name: file.name, data: bytes })
      attached++
    } catch (error) {
      failed++
      ctx.log.warn(`${data.public_id}: attachment ${file.name} not attached (${error instanceof Error ? error.message : 'error'})`)
    }
  }
  return { attached, failed }
}

const LEGACY_DIR = 'attachments'
const legacyMarker = (ref) => `legacy-attachments:${ref}`
/**
 * Refusals that come from the file itself (its type, its bytes, its size):
 * trying again changes nothing. A full idea (`attachment_quota`), a read or
 * disk error, anything unknown may pass next time.
 */
const PERMANENT_REFUSALS = new Set(['attachment_type_refused', 'attachment_content_mismatch', 'attachment_too_large', 'attachment_invalid'])
const refusedForGood = (error) => error?.code === 'invalid' && PERMANENT_REFUSALS.has(error?.reason)

/**
 * Moves the files older versions saved under `<data>/attachments/<ticket>/`
 * onto the ticket's idea, then deletes them. Idempotent: a file the idea
 * already holds is only deleted. A file Timon refuses for good (an `.html` or
 * `.sh` from before) stays where it was, named in the log and in the marker,
 * rather than being lost. A ticket is marked done, and skipped from then on,
 * only once each of its files has moved or been refused for good: a failure
 * that may pass (full idea, disk, read) leaves it for the next run. The paths
 * old notes quote are left as they are: they are history.
 *
 * Its ideas belong to the account that opened the webhook, so it runs in that
 * scope: at start through `ctx.webhooks.asOwner`, and before each delivery,
 * which already has it.
 */
async function migrateLegacyAttachments(ctx) {
  const root = join(ctx.storage.dir, LEGACY_DIR)
  let refs
  try { refs = await readdir(root) } catch { return }
  for (const ref of refs.sort()) {
    if (await ctx.storage.kv.get(legacyMarker(ref))) continue
    const todo = await ctx.kanban.todos.links.findByRef(PROVIDER, ref)
    if (!todo) continue
    const folder = join(root, ref)
    const known = new Set((await ctx.kanban.todos.attachments.list(todo.id)).map((f) => f.name))
    let names = []
    try { names = (await readdir(folder)).sort() } catch { /* not a folder: nothing to move */ }
    let moved = 0
    const refused = []
    let retry = 0
    for (const name of names) {
      const path = join(folder, name)
      try {
        if (!known.has(name)) await ctx.kanban.todos.attachments.add(todo.id, { name, data: new Uint8Array(await readFile(path)) })
        await rm(path, { force: true })
        moved++
      } catch (error) {
        const why = error instanceof Error ? error.message : 'error'
        if (refusedForGood(error)) {
          refused.push(name)
          ctx.log.warn(`${ref}: legacy attachment ${name} kept at ${path}, refused (${why})`)
        } else {
          retry++
          ctx.log.warn(`${ref}: legacy attachment ${name} not moved yet, retried at next run (${why})`)
        }
      }
    }
    if (moved) ctx.log.info(`${ref}: ${moved} legacy attachment(s) moved to idea #${todo.id}`)
    if (retry) continue
    if (!refused.length) await rm(folder, { recursive: true, force: true })
    await ctx.storage.kv.set(legacyMarker(ref), { todo: todo.id, moved, refused, at: Date.now() })
  }
  try { if ((await readdir(root)).length === 0) await rm(root, { recursive: true, force: true }) } catch { /* already gone */ }
}

/** `ticket.created` / `suggestion.created`: the idea, then its investigation. */
async function onCreated(ctx, event) {
  const settings = settingsOf(ctx)
  const { data } = event
  if (!settings.pattern.test(data.public_id)) return
  const input = { data }
  const { item, created } = await ctx.kanban.todos.create(
    {
      text: fill('{data.public_id} · {data.title}', input, 1000).trim(),
      project: settings.project,
      notes: fill(NOTES_TEMPLATE, input, 20_000),
      author: PROVIDER,
      urgency: urgencyOf(data.kind),
    },
    [{ provider: PROVIDER, ref: data.public_id, url: event.url, label: data.public_id }],
  )
  // The investigation follows the idea, not the delivery: when the task could
  // not be created on a first try, the retry finds the idea (`created: false`)
  // and must still start it. The marker is written after the task exists.
  const marker = `investigation:${data.public_id}`
  if (!created && (await ctx.storage.kv.get(marker))) return
  const { attached, failed } = await attachFiles(ctx, item.id, data)
  const files = attachmentsNotice(item.id, attached, failed)
  try {
    await ctx.kanban.add({
      title: fill('Investigation {data.public_id} · {data.title}', input, 200).trim(),
      agent: settings.agent,
      description: UNTRUSTED_HEADER + fill(settings.prompt, input, 20_000) + files,
      type: 'research',
      priority: 3,
      project: settings.project,
      todoId: item.id,
      silentReturn: settings.silent,
    })
  } catch (error) {
    // An investigation is a mission: until the operator approves this plugin
    // (`pluginPolicy.spawn.approved`, an action card asks for it), the host
    // refuses it. Said on the settings page, then rethrown so the bot retries
    // and the approved retry starts it.
    if (error?.reason === 'spawn_policy') {
      ctx.log.warn(`${data.public_id}: investigation not started, ${error.message}`)
      await bump(ctx, () => ({ awaitingApproval: { ref: data.public_id, at: Date.now() } }))
    }
    throw error
  }
  await ctx.storage.kv.set(marker, { todo: item.id, at: Date.now() })
  if ((await readStats(ctx)).awaitingApproval) await bump(ctx, () => ({ awaitingApproval: null }))
}

/**
 * `*.reply_added`: a detail the tester (or anyone) added in the thread, appended
 * to the idea's notes once per Discord message. A closed idea is left alone;
 * an analysed one goes back to `todo`, so the notebook shows there is news.
 */
async function onReply(ctx, event) {
  const settings = settingsOf(ctx)
  const { data } = event
  if (!settings.pattern.test(data.public_id)) return
  const marker = `reply:${data.message_id}`
  if (await ctx.storage.kv.get(marker)) return
  const todo = await ctx.kanban.todos.links.findByRef(PROVIDER, data.public_id)
  if (!todo) {
    ctx.log.warn(`${data.public_id}: reply ${data.message_id} ignored, no idea for this ticket`)
    return
  }
  if (todo.status === 'done') {
    ctx.log.info(`${data.public_id}: reply ${data.message_id} not added, the idea is closed`)
  } else {
    const { attached, failed } = await attachFiles(ctx, todo.id, data, `r${data.message_id}-`)
    await ctx.kanban.todos.update(todo.id, {
      notes: (todo.notes ?? '') + replySection(data, replyFilesNotice(attached, failed)),
      ...(todo.progress === 'analyzed' ? { progress: 'todo' } : {}),
    })
  }
  await ctx.storage.kv.set(marker, { todo: todo.id, at: Date.now() })
}

/**
 * One migration at a time. A delivery's run keeps the delivery's identity; the
 * start-up run takes the webhook owner's (`asOwner`), since as this plugin's
 * job it would see none of the tickets' ideas.
 */
let migration = Promise.resolve()
function queueMigration(ctx, run) {
  migration = migration.then(run).catch((error) => {
    ctx.log.warn(`legacy attachments not migrated (${error instanceof Error ? error.message : 'error'})`)
  })
  return migration
}
const migrate = (ctx) => queueMigration(ctx, () => migrateLegacyAttachments(ctx))
const migrateAtStart = (ctx) => queueMigration(ctx, async () => {
  const run = await ctx.webhooks.asOwner('events', () => migrateLegacyAttachments(ctx))
  if (!run.ran) ctx.log.info(`legacy attachments: start-up migration skipped (${run.reason}), the next delivery runs it`)
})

async function onWebhook(ctx, request) {
  await migrate(ctx)
  const event = parseInbound(request.text)
  await bump(ctx, (s) => ({ received: (s.received ?? 0) + 1, lastAt: Date.now(), lastType: event.type ?? event.kind }))
  if (event.kind === 'invalid') {
    ctx.log.warn(`webhook ${request.id} ignored: ${event.reason}`)
    return
  }
  if (event.kind === 'ignore') return
  if (event.kind === 'reply') await onReply(ctx, event)
  else await onCreated(ctx, event)
}

/** One outcome or closure for the bot, queued behind the idea's earlier ones. */
async function send(ctx, event, body) {
  const settings = settingsOf(ctx)
  if (!settings.workerUrl) return
  if (!handles(event.todo, settings.pattern)) return
  const { id } = await ctx.outbox.post(settings.workerUrl, body, {
    key: `todo:${event.todo.id}`,
    sign: { secret: settings.signingSecret },
  })
  await bump(ctx, () => ({ lastOutbox: { id, kind: body.type, todo: event.todo.id, at: Date.now() } }))
}

function legacyTriggers(list, workerUrl) {
  let host = null
  try { host = workerUrl ? new URL(workerUrl).host : null } catch { /* an unreadable URL matches no event trigger */ }
  return list.filter((t) => t.enabled && (
    (t.source === 'webhook' && t.slug === LEGACY_WEBHOOK_SLUG)
    || (t.source === 'event' && LEGACY_EVENT_KINDS.includes(t.event) && host !== null && t.actionHosts.includes(host))))
}

/** @param {import('@timon-ai/sdk').PluginContext} ctx */
export function apply(ctx) {
  ctx.webhooks.on('events', (request) => onWebhook(ctx, request))
  void migrateAtStart(ctx)
  ctx.events.on('todo_resolved', (event) => send(ctx, event, resolvedBody(event, Date.now())))
  ctx.events.on('todo_done', (event) => send(ctx, event, doneBody(event, Date.now())))

  const router = ctx.router()

  router.get('/status', async (_request, response) => {
    const settings = settingsOf(ctx)
    const stats = await readStats(ctx)
    const last = stats.lastOutbox ? await ctx.outbox.get(stats.lastOutbox.id) : undefined
    response.json({
      outbound: { workerUrl: Boolean(settings.workerUrl) },
      // What the section's form shows: effective values, none of them a secret (`signingSecret` is a vault entry NAME).
      settings: {
        workerUrl: settings.workerUrl,
        signingSecret: settings.signingSecret,
        referencePattern: ctx.settings.get('referencePattern') ?? '',
        investigationAgent: settings.agent,
        project: settings.project,
        silentInvestigation: settings.silent,
      },
      received: stats.received ?? 0,
      lastAt: stats.lastAt ?? null,
      lastType: stats.lastType ?? null,
      awaitingApproval: stats.awaitingApproval ?? null,
      lastOutbox: last && stats.lastOutbox ? { kind: stats.lastOutbox.kind, state: last.state, attempts: last.attempts, error: last.last_error } : null,
      legacy: legacyTriggers(await ctx.triggers.list(), settings.workerUrl).map((t) => ({ id: t.id, name: t.name })),
    })
  })

  // Retires the hand-made triggers this plugin replaces. A gesture, not an
  // activation side effect: `discord-events` must keep receiving until the
  // owner has seen this path receive too, hence the refusal while nothing came in.
  router.post('/retire-legacy', async (request, response) => {
    const settings = settingsOf(ctx)
    const stats = await readStats(ctx)
    if (!((stats.received ?? 0) > 0) && request.query?.force !== '1') {
      response.status(409).json({ error: 'nothing has been received on the new path yet' })
      return
    }
    const retired = []
    for (const trigger of legacyTriggers(await ctx.triggers.list(), settings.workerUrl)) {
      if (await ctx.triggers.disable(trigger.id)) retired.push({ id: trigger.id, name: trigger.name })
    }
    ctx.log.info(`retired ${retired.length} hand-made trigger(s): ${retired.map((t) => t.name).join(', ')}`)
    response.json({ retired })
  })

  return () => { /* handlers and routes are released with the context */ }
}

