# plugin-page-toc

Replaces the table of contents of the long list pages (slot `page.toc`: the
Skills and MCP tabs of Capabilities) with a numbered list — `1`, `1.2`… — the
section in view in bold. The product's table comes back as soon as the plugin
is removed.

The component takes no props: it reads `usePageToc()` from `@timon/ui` (client
API 15) — `entries` (`id`, `label`, `level` 1 or 2, `count` or `null`, in
reading order and following the page's search), `active` (the section in view)
and `go(id)`. The host reads the headings and owns the scroll: a replacement
jumps with `go(id)`, never by scrolling itself.

A section of a plugin enters the table of any page by its markup alone: an
element with an `id` and `data-toc="<label>"`, optionally `data-toc-level="2"`
and `data-toc-count="<n>"`.

What a replacement must respect is in [Slots](../../public-docs/docs/plugins/slots.md),
under `page.toc`.

The package deliberately ships no `SIGNATURE` file.
