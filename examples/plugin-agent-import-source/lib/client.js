import React from 'react'
import { Button, createTranslator } from '@rooks/ui'

/**
 * A third-party source adapter for the agent import (`plugins/agent-import`),
 * written with the SDK alone.
 *
 * "Acme Bots" is a made-up tool whose export is one `acme-bots.json` file.
 * The adapter reads it in the browser, turns it into a `rooks-agent-import`
 * v1 manifest (`toManifest`, a pure function), packs that manifest alone into
 * a zip (`zipOne`) and hands the zip to the assistant with `submitFile`. From
 * there the import does the rest: staging, preview, choices, apply. Nothing is
 * written before the user confirms the preview.
 *
 * Why the conversion happens here and not in the daemon: the engine only
 * runs its own built-in adapters on an archive (TODO #808). The format it
 * always reads is its manifest, so an adapter that ships that manifest
 * works on any Rooks that has the import, with no permission at all.
 *
 * Why no `registerSource`: a registered `zip` source gets the assistant's
 * own file button, which sends the picked file as it is, and the engine does
 * not know this format. The adapter paints its own row in the socket instead.
 */

// A plugin ships its own strings: the product's keys are not part of the contract.
const t = createTranslator({
  en: {
    label: 'Acme Bots',
    description: 'The acme-bots.json file from Settings › Export in Acme Bots. API keys stay behind.',
    pick: 'Choose acme-bots.json',
    invalid: 'This file cannot be imported: {reason}',
  },
  fr: {
    label: 'Acme Bots',
    description: 'Le fichier acme-bots.json de Réglages › Exporter dans Acme Bots. Les clés d’API restent sur place.',
    pick: 'Choisir acme-bots.json',
    invalid: 'Ce fichier ne peut pas être importé : {reason}',
  },
})

export const SOURCE_ID = 'acme-bots'

/**
 * `useAgentImport()` without bundling `@rooks/plugin-agent-import/hooks`.
 * Plugin bundles share React and nothing else, so the import keeps its context
 * under this global symbol: whoever loads first creates it, the other finds it.
 * A bundled adapter imports the hook instead and gets typed values.
 */
const CONTEXT_KEY = Symbol.for('rooks.plugin.agent-import.context')
const ImportContext = (globalThis[CONTEXT_KEY] ??= React.createContext(null))

// ── The conversion: acme-bots.json → rooks-agent-import v1 ──────────────────

/** `Research Bot_2` → `research-bot-2`: the key form the manifest admits (`[a-z0-9-]`, 64 at most). */
function slugKey(raw) {
  return String(raw).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 64).replace(/-+$/, '')
}

function text(value, field, max) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string') throw new Error(`${field} is not a text`)
  return value.replace(/\r\n?/g, '\n').slice(0, max)
}

/**
 * The file's text → `{ manifest, warnings }`. Throws with the path of the
 * offending field, never its value: an export may hold a key by mistake.
 */
export function toManifest(source) {
  let data
  try {
    data = JSON.parse(source)
  } catch {
    throw new Error('not a JSON file')
  }
  if (!data || data.format !== 'acme-bots') throw new Error('format is not acme-bots')
  if (data.version !== 1) throw new Error('version is not 1')
  if (!Array.isArray(data.bots) || data.bots.length === 0) throw new Error('bots is empty')
  if (data.bots.length > 100) throw new Error('bots holds more than 100 entries')

  const warnings = []
  const keys = new Set()
  const timezone = typeof data.timezone === 'string' ? data.timezone.slice(0, 64) : null
  const agents = data.bots.map((bot, i) => {
    const at = `bots[${i}]`
    if (!bot || typeof bot !== 'object') throw new Error(`${at} is not an object`)
    const name = text(bot.name, `${at}.name`, 100)
    if (!name) throw new Error(`${at}.name is missing`)
    const base = slugKey(bot.id ?? name) || 'bot'
    let key = base
    for (let n = 2; keys.has(key); n += 1) key = `${base.slice(0, 60)}-${n}`
    keys.add(key)

    const memories = []
    for (const note of Array.isArray(bot.notes) ? bot.notes : []) {
      const value = text(note, `${at}.notes`, 4000)
      if (value) memories.push({ text: value, kind: 'preference' })
    }
    const routines = []
    for (const job of Array.isArray(bot.jobs) ? bot.jobs : []) {
      const time = typeof job?.dailyAt === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(job.dailyAt) ? job.dailyAt : null
      const instruction = text(job?.task, `${at}.jobs.task`, 100000)
      // What Rooks cannot schedule is said, never guessed.
      if (!time || !instruction) {
        warnings.push(`${name}: the job "${String(job?.title ?? '?').slice(0, 80)}" has no daily time or no task, it is left out.`)
        continue
      }
      routines.push({
        name: text(job.title, `${at}.jobs.title`, 80) ?? 'Acme job',
        instruction,
        schedule: { kind: 'daily', time },
        timezone,
        enabledInSource: job.enabled !== false,
      })
    }
    // The preview already says history is not imported: flag it, no warning of our own.
    const hasHistory = Array.isArray(bot.history) && bot.history.length > 0
    // A secret travels by NAME only: the value field, if any, is never read.
    const secretNames = typeof bot.apiKeyName === 'string' && bot.apiKeyName ? [bot.apiKeyName.slice(0, 100)] : []

    const title = text(bot.role, `${at}.role`, 120)
    return {
      key,
      displayName: name,
      ...(title ? { title } : {}),
      soul: text(bot.persona, `${at}.persona`, 200000),
      instructions: text(bot.prompt, `${at}.prompt`, 200000),
      memories: memories.slice(0, 256),
      routines: routines.slice(0, 64),
      hints: { ...(secretNames.length > 0 ? { secretNames } : {}), hasHistory },
      // Stable at the source: a second import of the same file updates these agents.
      sourceRef: `acme-bots:${key}`,
    }
  })

  const manifest = {
    format: 'rooks-agent-import',
    version: 1,
    source: { app: 'acme-bots', exportedAt: null },
    agents,
    ...(warnings.length > 0 ? { warnings: warnings.slice(0, 200) } : {}),
  }
  return { manifest, warnings }
}

// ── A one-file zip, without a dependency ────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes) {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * A zip holding one stored (uncompressed) file, UTF-8 name, dated 1980-01-01.
 * A manifest is a few kilobytes: compressing it would buy nothing.
 */
export function zipOne(name, bytes) {
  const file = new TextEncoder().encode(name)
  const crc = crc32(bytes)
  const local = new Uint8Array(30 + file.length)
  const l = new DataView(local.buffer)
  l.setUint32(0, 0x04034b50, true)
  l.setUint16(4, 20, true)
  l.setUint16(6, 0x0800, true)
  l.setUint16(12, 0x21, true)
  l.setUint32(14, crc, true)
  l.setUint32(18, bytes.length, true)
  l.setUint32(22, bytes.length, true)
  l.setUint16(26, file.length, true)
  local.set(file, 30)

  const central = new Uint8Array(46 + file.length)
  const c = new DataView(central.buffer)
  c.setUint32(0, 0x02014b50, true)
  c.setUint16(4, 20, true)
  c.setUint16(6, 20, true)
  c.setUint16(8, 0x0800, true)
  c.setUint16(14, 0x21, true)
  c.setUint32(16, crc, true)
  c.setUint32(20, bytes.length, true)
  c.setUint32(24, bytes.length, true)
  c.setUint16(28, file.length, true)
  central.set(file, 46)

  const end = new Uint8Array(22)
  const e = new DataView(end.buffer)
  e.setUint32(0, 0x06054b50, true)
  e.setUint16(8, 1, true)
  e.setUint16(10, 1, true)
  e.setUint32(12, central.length, true)
  e.setUint32(16, local.length + bytes.length, true)

  const out = new Uint8Array(local.length + bytes.length + central.length + end.length)
  out.set(local, 0)
  out.set(bytes, local.length)
  out.set(central, local.length + bytes.length)
  out.set(end, local.length + bytes.length + central.length)
  return out
}

/**
 * The file the user picked → the assistant's preview. Returns the reason
 * when the file is refused; the assistant shows its own errors after that.
 */
export async function importFile(assistant, file) {
  let built
  try {
    built = toManifest(await file.text())
  } catch (err) {
    return err instanceof Error ? err.message : 'unreadable file'
  }
  const json = new TextEncoder().encode(JSON.stringify(built.manifest))
  const zip = new Blob([zipOne('rooks-agent-import.json', json)], { type: 'application/zip' })
  await assistant.submitFile(SOURCE_ID, zip)
  return null
}

// ── The row in the assistant ────────────────────────────────────────────────

function AcmeBotsSource() {
  const assistant = React.useContext(ImportContext)
  const picker = React.useRef(null)
  const [refused, setRefused] = React.useState(null)
  if (!assistant) return null

  const onChange = (event) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setRefused(null)
    void importFile(assistant, file).then(setRefused)
  }

  return React.createElement('div', { className: 'flex flex-col gap-2 rounded-lg bg-muted/40 p-3', 'data-source': SOURCE_ID },
    React.createElement('div', { className: 'flex flex-wrap items-center gap-3' },
      React.createElement('div', { className: 'flex min-w-0 flex-1 flex-col gap-0.5' },
        React.createElement('span', { className: 'text-sm font-medium' }, t('label')),
        React.createElement('span', { className: 'text-xs text-muted-foreground' }, t('description'))),
      React.createElement('input', {
        ref: picker, type: 'file', accept: '.json,application/json', className: 'sr-only', tabIndex: -1, 'aria-hidden': true, onChange,
      }),
      React.createElement(Button, {
        type: 'button', size: 'sm', variant: 'outline', disabled: assistant.busy, onClick: () => picker.current?.click(),
      }, t('pick'))),
    refused && React.createElement('p', { role: 'alert', className: 'text-sm text-destructive' }, t('invalid', { reason: refused })))
}

/** @param {import('@rooks/sdk').ClientContext} ctx */
export function apply(ctx) {
  // The socket exists while the import is on; switched off, this row goes with it.
  return ctx.slots.register({ slot: 'agentimport.source' }, AcmeBotsSource)
}
