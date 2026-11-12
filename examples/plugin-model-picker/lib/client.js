import React from 'react'
import { BrandMark, accountStateHint, byPower, cn, createTranslator, isPickable, matchesQuery, useBackendCatalog, useModelPicker, vendorLabel } from '@rooks/ui'

// A plugin ships its own strings: the product's keys are not part of the contract.
const t = createTranslator({
  en: { search: 'Search models', searchLabel: 'Search a model', empty: 'No model matches.' },
  fr: { search: 'Rechercher un modèle', searchLabel: 'Rechercher un modèle', empty: 'Aucun modèle ne correspond.' },
})

/**
 * A replacement of the model selector: one flat list, one search.
 *
 * `model.picker` is a `single` slot declared at boot, whose default occupant
 * is the product's picker (`fallback`). Registering here claims it: every
 * model field of the interface — the composer, the task form, the agent
 * editor — paints this component instead; removing the plugin gives the
 * product's picker back.
 *
 * The component receives no props: it reads its host with `useModelPicker()`.
 * Several pickers can be on screen at once, each with its own host. In a
 * popover the product keeps the trigger, the anchoring, the focus and the
 * closing (Escape included): paint the content only.
 *
 * What a replacement must respect (the host refuses the rest anyway):
 *   - an account that cannot run (`isPickable` false) is shown, not choosable;
 *   - `inherit` adds an entry that hands back `null`;
 *   - a value whose entry left the catalogue stays shown, selected, disabled;
 *   - `filter` applies to everything listed;
 *   - `footer` is rendered under the list.
 */
function FlatModelPicker() {
  const host = useModelPicker()
  const catalog = useBackendCatalog()
  const [query, setQuery] = React.useState('')
  const searchRef = React.useRef(null)

  React.useEffect(() => {
    if (host?.autoFocusSearch) searchRef.current?.focus()
  }, [host?.autoFocusSearch])

  if (!host) return null
  const q = query.trim().toLowerCase()
  const keep = (backend, model) => (!host.filter || host.filter(backend, model)) && matchesQuery(backend, model, q)

  const rows = catalog.backends.flatMap((backend) =>
    byPower(backend.models.filter((model) => keep(backend, model))).map((model) => ({
      key: `${backend.id}/${model.slug}`,
      pick: { backend: backend.id, model: model.slug },
      label: model.presetLabel ?? model.label,
      detail: `${vendorLabel(backend)} · ${model.slug}`,
      icon: React.createElement(BrandMark, { icon: model.icon, brand: model.brand, slug: model.slug, fallbackIcon: backend.icon, fallbackBrand: backend.brand, className: 'size-4' }),
      disabled: host.disabled || !isPickable(backend),
      title: accountStateHint(backend) ?? undefined,
      selected: host.value?.backend === backend.id && host.value?.model === model.slug,
    })),
  )

  // The held value, when its account left the catalogue: shown, never re-offered.
  const held = host.value
  const gone = held && catalog.backends.length > 0 && !catalog.backends.some((b) => b.id === held.backend)
  const head = []
  if (host.inherit && !q) {
    head.push({ key: 'inherit', pick: null, label: host.inherit.label, detail: host.inherit.hint, disabled: host.disabled, selected: host.value === null })
  }
  if (held && gone && !q) {
    head.push({ key: 'gone', pick: held, label: held.model, detail: held.backend, disabled: true, selected: true })
  }
  const all = [...head, ...rows]

  const row = (r) => React.createElement('button', {
    key: r.key,
    type: 'button',
    disabled: r.disabled,
    title: r.title,
    'aria-pressed': r.selected,
    onClick: () => host.onChange(r.pick),
    className: cn(
      'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm',
      r.selected ? 'bg-primary/10 text-foreground' : 'hover:bg-muted/60',
      r.disabled && 'cursor-not-allowed opacity-50',
    ),
  },
  r.icon ?? null,
  React.createElement('span', { className: 'min-w-0 flex-1 truncate' }, r.label),
  r.detail ? React.createElement('span', { className: 'truncate text-xs text-muted-foreground' }, r.detail) : null)

  return React.createElement('div', { className: cn('flex min-h-0 flex-col gap-2 rounded-xl bg-popover p-2 text-popover-foreground', host.className), 'aria-label': host.label },
    React.createElement('input', {
      ref: searchRef,
      type: 'search',
      value: query,
      placeholder: t('search'),
      'aria-label': t('searchLabel'),
      onChange: (e) => setQuery(e.target.value),
      onKeyDown: (e) => {
        if (e.key !== 'Enter') return
        e.preventDefault()
        const first = all.find((r) => !r.disabled)
        if (first) host.onChange(first.pick)
      },
      className: 'h-9 rounded-lg bg-muted/60 px-3 text-sm outline-none',
    }),
    React.createElement('div', { role: 'group', className: 'flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto' },
      all.length ? all.map(row) : React.createElement('p', { className: 'px-2.5 py-4 text-sm text-muted-foreground' }, t('empty'))),
    host.footer ?? null,
  )
}

/** @param {import('@rooks/sdk').ClientContext} ctx */
export function apply(ctx) {
  ctx.slots.register({ slot: 'model.picker' }, FlatModelPicker)
}
