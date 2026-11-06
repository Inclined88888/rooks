import React from 'react'
import { Button, DialogFooter, createTranslator, useDirectoryBrowser } from '@timon/ui'

// A plugin ships its own strings: the product's keys are not part of the contract.
const t = createTranslator({
  en: { heading: 'Pick a folder on this machine', headingFile: 'Pick a file on this machine', up: 'Up', choose: 'Use {path}', cancel: 'Cancel', empty: 'Nothing here.', error: 'This folder cannot be listed ({error}).' },
  fr: { heading: 'Choisir un dossier sur cette machine', headingFile: 'Choisir un fichier sur cette machine', up: 'Remonter', choose: 'Utiliser {path}', cancel: 'Annuler', empty: 'Rien ici.', error: 'Ce dossier ne peut pas être listé ({error}).' },
})

/**
 * A replacement of the folder browser: the current folder as a header, its
 * visible subfolders as a list, a button to use it. When the form asks for a
 * file (`host.mode === 'file'`: a plugin archive, a CLI binary), the level's
 * files follow its folders and a click on one uses it.
 *
 * `directory.picker` is a `single` slot declared at boot, whose default
 * occupant is the product's browser (`fallback`). Registering here claims it
 * wherever "Browse…" lists the folders of the machine the window drives —
 * Settings, a project, an agent; removing the plugin gives the product's
 * browser back. On this computer's own daemon in the desktop app, the OS
 * dialog opens instead and this component is not painted.
 *
 * The component receives no props: it reads its host with
 * `useDirectoryBrowser()`. The host frames it (a dialog it names itself,
 * focus, Escape) and owns the daemon's calls. What a replacement must respect:
 *   - never build a path: hand back a `listing.path` or an `entry.path`, which
 *     the daemon built with the separators of its own OS;
 *   - say why a level could not be read (`forbidden`, `outdated`…) rather
 *     than show an empty list;
 *   - call `choose(path)` or `cancel()`: the form waits for one of them;
 *   - in file mode, choose a file the host served (`listing.files[].path`, or
 *     `listing.selected`): the host ignores any other path, a folder included.
 */
function BreadcrumbPicker() {
  const host = useDirectoryBrowser()
  const [listing, setListing] = React.useState(null)
  const [error, setError] = React.useState(null)

  const land = React.useCallback(async (read) => {
    const out = await read()
    if (out.ok) { setListing(out.listing); setError(null) } else setError(out.error)
  }, [])
  const opening = host?.opening
  React.useEffect(() => { if (opening) void land(opening) }, [opening, land])
  if (!host) return null

  const go = (path) => void land(() => host.read(path))
  const fileMode = host.mode === 'file'
  const visible = listing ? listing.entries.filter((entry) => !entry.hidden) : []
  // Already filtered by the daemon with the form's endings (`host.accept`).
  const files = fileMode && listing ? (listing.files ?? []).filter((file) => !file.hidden) : []

  return React.createElement(React.Fragment, null,
    React.createElement('p', { className: 'text-sm font-semibold' }, t(fileMode ? 'headingFile' : 'heading')),
    React.createElement('div', { className: 'flex items-center gap-2' },
      React.createElement(Button, { type: 'button', variant: 'ghost', size: 'sm', disabled: !listing?.parent, onClick: () => go(listing.parent) }, t('up')),
      React.createElement('span', { className: 'truncate text-sm', 'data-breadcrumb': '' }, listing?.path ?? '')),
    error && React.createElement('p', { role: 'alert', className: 'text-sm text-destructive' }, t('error', { error })),
    React.createElement('ul', { className: 'flex max-h-72 flex-col gap-0.5 overflow-y-auto' },
      visible.length === 0 && files.length === 0 && listing && React.createElement('li', { className: 'px-2 py-3 text-sm text-muted-foreground' }, t('empty')),
      visible.map((entry) => React.createElement('li', { key: entry.path },
        React.createElement('button', {
          type: 'button', 'data-folder': entry.name, onClick: () => go(entry.path),
          className: 'w-full rounded px-2 py-1 text-left text-sm hover:bg-muted/70',
        }, entry.name))),
      files.map((file) => React.createElement('li', { key: file.path },
        React.createElement('button', {
          type: 'button', 'data-file': file.name, onClick: () => host.choose(file.path),
          className: 'w-full rounded px-2 py-1 text-left text-sm italic hover:bg-muted/70',
        }, file.name)))),
    React.createElement(DialogFooter, { className: 'gap-2' },
      React.createElement(Button, { type: 'button', variant: 'outline', size: 'sm', onClick: host.cancel }, t('cancel')),
      // A folder answers a folder request only; in file mode a click on a file chooses.
      !fileMode && React.createElement(Button, {
        type: 'button', size: 'sm', 'data-breadcrumb-choose': '', disabled: !listing,
        onClick: () => { if (listing) host.choose(listing.path) },
      }, t('choose', { path: listing?.path ?? '' }))))
}

/** @param {import('@timon-ai/sdk').ClientContext} ctx */
export function apply(ctx) {
  ctx.slots.register({ slot: 'directory.picker' }, BreadcrumbPicker)
}
