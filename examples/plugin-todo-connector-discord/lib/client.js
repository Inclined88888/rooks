/**
 * Browser half of the Discord connector.
 *
 * Plain ESM written against `@rooks/ui`, like any third-party plugin: a Discord
 * chip (logo + name, in Discord's purple) on the ideas that come from a ticket, and a settings section that
 * shows whether the new path receives and retires the hand-made triggers once
 * it does.
 */
import React from 'react'
import { Button, Input, createTranslator, useTodoItem } from '@rooks/ui'

const t = createTranslator({
  en: {
    badge: 'From Discord',
    loading: 'Loading…',
    title: 'Discord connector',
    received: '{count} event(s) received from the bot',
    none: 'Nothing received from the bot yet. Point the Worker at this plugin\u2019s webhook, then create a test ticket.',
    last: 'Last: {type}',
    outbound: 'Outcomes are posted to the Worker.',
    outboundOff: 'No Worker URL set: outcomes and closures are not sent.',
    lastOutbox: 'Last post ({kind}): {state}, {attempts} attempt(s)',
    awaitingApproval: 'The investigation of {ref} is waiting for your approval: an investigation is a mission, so add this plugin to pluginPolicy.spawn.approved in rooks.config.json. The bot\u2019s next retry starts it.',
    legacy: 'Hand-made triggers still active: {names}',
    noLegacy: 'No hand-made trigger left to retire.',
    retire: 'Retire the hand-made triggers',
    retireHint: 'Disables them (never deletes them). Do it once this path receives.',
    retired: 'Retired: {names}',
    failed: 'Could not retire them: {error}',
    settingsTitle: 'Settings',
    saveFailed: 'Could not save this setting.',
    workerUrl: 'Worker URL the outcomes are posted to (https://…/rooks/events). Setting it starts the outbound posts.',
    signingSecret: 'Vault entry that signs them (whsec_…, scoped to this plugin)',
    referencePattern: 'Reference pattern of the tickets handled (empty = TIM/SUG)',
    investigationAgent: 'Agent that investigates a new ticket',
    project: 'Project of the ideas and investigations',
    silentInvestigation: 'The investigation reports in the idea only, never back to the orchestrator',
  },
  fr: {
    badge: 'Depuis Discord',
    loading: 'Chargement…',
    title: 'Connecteur Discord',
    received: '{count} événement(s) reçu(s) du bot',
    none: 'Rien reçu du bot pour l\u2019instant. Pointez le Worker sur le webhook de ce plugin, puis créez un ticket de test.',
    last: 'Dernier : {type}',
    outbound: 'Les issues sont envoyées au Worker.',
    outboundOff: 'Aucune URL de Worker : issues et clôtures ne partent pas.',
    lastOutbox: 'Dernier envoi ({kind}) : {state}, {attempts} essai(s)',
    awaitingApproval: 'L\u2019enquête de {ref} attend votre approbation : une enquête est une mission, ajoutez ce plugin à pluginPolicy.spawn.approved dans rooks.config.json. Le prochain renvoi du bot la lance.',
    legacy: 'Déclencheurs manuels encore actifs : {names}',
    noLegacy: 'Plus aucun déclencheur manuel à retirer.',
    retire: 'Retirer les déclencheurs manuels',
    retireHint: 'Les désactive (jamais de suppression). À faire quand ce chemin reçoit.',
    retired: 'Retirés : {names}',
    failed: 'Impossible de les retirer : {error}',
    settingsTitle: 'Réglages',
    saveFailed: 'Impossible d\u2019enregistrer ce réglage.',
    workerUrl: 'URL du Worker où partent les issues (https://…/rooks/events). La renseigner démarre les envois.',
    signingSecret: 'Entrée du coffre qui les signe (whsec_…, portée sur ce plugin)',
    referencePattern: 'Motif de référence des tickets traités (vide = TIM/SUG)',
    investigationAgent: 'Agent qui enquête sur un nouveau ticket',
    project: 'Projet des idées et des enquêtes',
    silentInvestigation: 'L\u2019enquête rend compte dans l\u2019idée seulement, jamais à l\u2019orchestrateur',
  },
})

const h = React.createElement

const DISCORD_PATH = "M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z"

/** An idea tied to a Discord thread, or made by the former trigger (no link). */
function fromDiscord(item) {
  return (item.links ?? []).some((link) => link.provider === 'discord')
    || (typeof item.author === 'string' && /^(trigger:)?discord/.test(item.author))
}

// Same geometry as the notebook's own chips (their classes are compiled with
// the app); the colours are inline because this file is outside its content
// globs, so an arbitrary-value class would never be generated.
const CHIP = 'inline-flex items-center gap-1 rounded-md border px-1.5 py-px text-[10.5px] font-medium leading-4 normal-case tracking-normal'
const BLURPLE = '#5865F2'

function DiscordBadge() {
  const item = useTodoItem()
  if (!item || !fromDiscord(item)) return null
  return h('span', {
    className: CHIP, title: t('badge'), 'aria-label': t('badge'),
    style: { color: BLURPLE, borderColor: 'rgba(88, 101, 242, 0.4)', backgroundColor: 'rgba(88, 101, 242, 0.1)' },
  },
  h('svg', { viewBox: '0 0 24 24', width: 12, height: 12, fill: 'currentColor', 'aria-hidden': true },
    h('path', { d: DISCORD_PATH })),
  'discord')
}

const SETTING_KEYS = ['workerUrl', 'signingSecret', 'referencePattern', 'investigationAgent', 'project']

function makeSettings(ctx) {
  return function DiscordSettings() {
    const [status, setStatus] = React.useState(null)
    const [message, setMessage] = React.useState(null)
    const load = React.useCallback(async () => {
      const response = await ctx.api('status')
      if (response.ok) setStatus(await response.json())
    }, [])
    React.useEffect(() => { void load() }, [load])

    const [saveError, setSaveError] = React.useState(false)
    const save = React.useCallback(async (key, value) => {
      const response = await ctx.settings.set(key, value)
      setSaveError(!response.ok)
      if (response.ok) await load()
    }, [load])

    const retire = React.useCallback(async () => {
      const response = await ctx.api('retire-legacy', { method: 'POST' })
      const body = await response.json().catch(() => ({}))
      setMessage(response.ok
        ? t('retired', { names: body.retired.map((x) => x.name).join(', ') || '—' })
        : t('failed', { error: body.error ?? response.status }))
      await load()
    }, [load])

    if (!status) return h('p', { className: 'py-6 text-sm text-muted-foreground' }, t('loading'))
    const line = (text) => h('p', { className: 'mt-1 text-xs text-muted-foreground' }, text)
    return h('div', { className: 'py-4' },
      h('h3', { className: 'text-sm font-medium' }, t('title')),
      status.received > 0
        ? line(t('received', { count: status.received }) + (status.lastType ? ` · ${t('last', { type: status.lastType })}` : ''))
        : line(t('none')),
      status.awaitingApproval ? line(t('awaitingApproval', { ref: status.awaitingApproval.ref })) : null,
      line(status.outbound.workerUrl ? t('outbound') : t('outboundOff')),
      status.lastOutbox
        ? line(t('lastOutbox', { kind: status.lastOutbox.kind, state: status.lastOutbox.state, attempts: status.lastOutbox.attempts }))
        : null,
      status.legacy.length
        ? h(React.Fragment, null,
          line(t('legacy', { names: status.legacy.map((x) => x.name).join(', ') })),
          h('div', { className: 'mt-3' }, h(Button, { onClick: () => void retire() }, t('retire'))),
          line(t('retireHint')))
        : line(t('noLegacy')),
      message ? line(message) : null,
      h('h3', { className: 'mt-6 text-sm font-medium' }, t('settingsTitle')),
      SETTING_KEYS.map((key) => h('label', { key, className: 'mt-3 block text-xs text-muted-foreground' }, t(key),
        h(Input, {
          className: 'mt-1', defaultValue: status.settings[key], autoComplete: 'off', spellCheck: false,
          onBlur: (event) => void save(key, event.target.value.trim()),
        }))),
      h('label', { className: 'mt-3 flex items-center gap-2 text-xs text-muted-foreground' },
        h('input', {
          type: 'checkbox', checked: status.settings.silentInvestigation,
          onChange: (event) => void save('silentInvestigation', event.target.checked),
        }),
        t('silentInvestigation')),
      saveError ? line(t('saveFailed')) : null)
  }
}

/** @param {import('@rooks/sdk').ClientContext} ctx */
export function apply(ctx) {
  const disposeBadge = ctx.slots.register({ slot: 'kanban.todo.badge' }, DiscordBadge)
  const disposeSettings = ctx.slots.register({ slot: 'settings.section' }, makeSettings(ctx))
  return () => {
    disposeSettings()
    disposeBadge()
  }
}
