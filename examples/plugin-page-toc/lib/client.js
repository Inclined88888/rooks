import React from 'react'
import { createTranslator, usePageToc } from '@timon/ui'

// A plugin ships its own strings: the product's keys are not part of the contract.
const t = createTranslator({
  en: { label: 'Sections of this page' },
  fr: { label: 'Sections de cette page' },
})

/**
 * A replacement of the table of contents of a list page: a numbered list
 * ("1", "1.2"…), the section in view in bold.
 *
 * `page.toc` is a `single` slot declared at boot, whose default occupant is
 * the product's table (`fallback`). Registering here claims the table of
 * every page that has one; removing the plugin gives the product's back.
 *
 * The component receives no props: it reads `usePageToc()`. The host reads
 * the headings of the page (an `id` and `data-toc`), follows the one in view
 * and scrolls; what a replacement must respect:
 *   - jump with `go(id)`, never by scrolling itself: the host knows which
 *     element scrolls the page and where a heading lands;
 *   - the entries follow the page's search: render what is there, nothing
 *     cached from an earlier render.
 */
function NumberedPageToc() {
  const toc = usePageToc()
  if (!toc || toc.entries.length === 0) return null
  let section = 0
  let sub = 0
  const items = toc.entries.map((entry) => {
    if (entry.level === 1) { section += 1; sub = 0 } else sub += 1
    const number = entry.level === 1 ? `${section}` : `${section}.${sub}`
    const on = entry.id === toc.active
    return React.createElement('li', { key: entry.id },
      React.createElement('button', {
        type: 'button',
        onClick: () => toc.go(entry.id),
        'aria-current': on ? 'location' : undefined,
        'data-page-toc-entry': entry.id,
        className: `flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-muted/50 ${on ? 'font-semibold text-foreground' : 'text-muted-foreground'}`,
      },
      React.createElement('span', { className: 'tabular-nums' }, number),
      React.createElement('span', { className: 'min-w-0 flex-1 truncate' }, entry.label)))
  })
  return React.createElement('nav', { 'aria-label': t('label') }, React.createElement('ol', { className: 'flex flex-col gap-0.5' }, ...items))
}

export function apply(ctx) {
  return ctx.slots.register({ slot: 'page.toc' }, NumberedPageToc)
}
