import React from 'react'
import { BrandMark, Button, createTranslator, useProviderCliCards } from '@rooks/ui'

// A plugin ships its own strings: the product's keys are not part of the contract.
const t = createTranslator({
  en: { install: 'Install', update: 'Update to {latest}', ready: 'Ready', signIn: 'Sign in: {command}', connect: 'Sign in', missing: 'Not installed', docs: 'Install guide', retry: 'Try again', running: 'Installing…' },
  fr: { install: 'Installer', update: 'Mettre à jour ({latest})', ready: 'Prêt', signIn: 'Connexion : {command}', connect: 'Se connecter', missing: 'Non installé', docs: 'Guide d’installation', retry: 'Réessayer', running: 'Installation…' },
})

/**
 * A replacement of the provider cards: one compact row per AI CLI.
 *
 * `providers.cli` is a `single` slot declared at boot, whose default occupant
 * is the product's cards (`fallback`). Registering here claims it on every
 * screen that shows them — the onboarding's "Your AIs" step, its "cannot
 * start" screen, Settings › AI models; removing the plugin gives the
 * product's cards back.
 *
 * The component receives no props: it reads its host with
 * `useProviderCliCards()`. The host owns the data and the gestures — calling
 * `install(name)` starts the vendor's official installer on the daemon and the
 * host follows it: `jobs[name].lines` is its console while it runs. What a
 * replacement must respect:
 *   - offer Install only where `installable` is true; otherwise link `installDocs`;
 *   - show no "Update" while `updateCheck` is false;
 *   - `signIn(name)` types the sign-in command in Rooks's terminal, or copies it: the host
 *     says which (`terminal`, `copied`, `failed`), the person presses Enter;
 *   - `unavailable`: the viewer may not see the list, show nothing to act on.
 */
function CompactProviderCards() {
  const host = useProviderCliCards()
  if (!host || host.unavailable || !host.backends) return null
  return React.createElement('div', { className: 'space-y-2' },
    React.createElement('ul', { className: 'm-0 flex list-none flex-col gap-1 p-0' },
      host.backends.map((cli) => {
        const job = host.jobs[cli.name]
        const running = job?.state === 'running'
        const action = cli.installable && (!cli.path || (host.updateCheck && cli.updateAvailable))
        return React.createElement('li', { key: cli.name, className: 'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted' },
          React.createElement(BrandMark, { brand: cli.brand ?? '', className: 'size-4' }),
          React.createElement('span', { className: 'font-medium' }, cli.label),
          React.createElement('span', { className: 'text-xs text-muted-foreground' },
            running ? (job.lines.at(-1) ?? t('running'))
              : !cli.path ? t('missing')
              : cli.signedIn === true ? t('ready')
              : t('signIn', { command: cli.signInCommand })),
          action && React.createElement(Button, {
            type: 'button', size: 'sm', className: 'ml-auto', disabled: host.disabled || running,
            onClick: () => void host.install(cli.name),
          }, cli.path ? t('update', { latest: cli.latest ?? '' }) : t('install')),
          !action && cli.path && cli.signedIn !== true && React.createElement(Button, {
            type: 'button', size: 'sm', variant: 'outline', className: 'ml-auto', disabled: host.disabled,
            onClick: () => void host.signIn(cli.name),
          }, t('connect')),
          !cli.installable && !cli.path && cli.installDocs && React.createElement('a', {
            href: cli.installDocs, target: '_blank', rel: 'noreferrer noopener', className: 'ml-auto text-xs text-primary underline',
          }, t('docs')))
      })),
    React.createElement(Button, { type: 'button', size: 'sm', variant: 'outline', disabled: host.busy, onClick: () => void host.refresh() }, t('retry')))
}

/** @param {import('@rooks/sdk').ClientContext} ctx */
export function apply(ctx) {
  ctx.slots.register({ slot: 'providers.cli' }, CompactProviderCards)
}
