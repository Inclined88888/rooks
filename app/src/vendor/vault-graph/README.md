Vendored from [luke321/vault-graph](https://github.com/luke321/vault-graph) (MIT).

`page.js` / `page.css` / markup are the disc UI. `graphology.umd.min.js` and
`sigma.min.js` are the upstream UMD bundles; Sigma is patched at copy time
(unreachable `fetch()` stripped, hover-leave bug fixed) — see `NOTICE.md`.

Rooks intercepts the `obsidian://` link of the detail panel to open the note in
its own popup (`components/vault/vault-note-panel.tsx`), hence the label
`Ouvrir la note` in place of `Open in Obsidian` in `page.js`. The `href` is left
untouched: it carries the path the interception reads.

## Rooks's changes to `page.js`

| what | why |
|---|---|
| label `Ouvrir la note` in place of `Open in Obsidian` | see above |
| `mountVaultGraph` returns a `destroy()` on its handle | the mount had no teardown |

The teardown: `mountVaultGraph` created `requestAnimationFrame` loops, three
`ResizeObserver`s, `resize` listeners on the window and a `visibilitychange` one on
the document, and **nothing released them**. The host could only kill the renderer
(`api.renderer.kill()`), which empties Sigma's node programs without stopping the
loops: at the next tick they called `refresh()` again, which re-indexes the whole graph
without ever registering the programs again — hence `Sigma: could not find a suitable
program for node type "circle"`, and a share of the frame budget lost for good with each
abandoned mount.

`destroy()` lives on the **handle**, not on `api`: the init runs in a `setTimeout(…, 20)`,
so `api` is `null` for the first 20 milliseconds — exactly the fastest unmount, for which
the previous cleanup did nothing at all. It is idempotent, it cancels the init timer (the
deferred init checks a `dead` flag before building anything), and it clears `window.__vg`
only if that global still points to THIS instance.

Frames and timers go through two local helpers, `RAF()` and `TIMER()`, which call nothing
back once the mount is dead — the anti-stall watchdogs are `setTimeout`s that call
`settle()` then `refresh()`, and a single one of them was enough to reproduce the error.
Observers and listeners go through an explicit list of disposers: a proxy on the window
would have missed the hard-coded `window.` and `document.` calls this file makes in
several places.

Regression covered by `app/src/lib/vault-graph-teardown.test.ts`.
