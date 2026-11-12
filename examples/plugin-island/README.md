# plugin-island

A browser-only `kind: "island"` template, client API **8**. No host entry,
runtime dependency or permission. React and `@rooks/ui` come from Rooks.

Install on a development instance following the plugin testing guide:

```bash
rooks plugin add ./examples/plugin-island
```

Ask your agent to open the `example-island:board` content with params
`{"id":"demo"}` using `islands_get` then `islands_propose`. Apply the proposal
card. Registration declares a content type; it does not open one automatically.
The manifest's only slot is `island.content`.

Inside the board, click **Open archive to the right (or drag)** or drag that
button onto another island. The click is also accessible with Enter or Space;
on a narrow view it opens a tab. Opening the same board again activates its
existing tab. Close it with the content's button or the workspace controls.

`useIslandContent()` supplies the params and actions. `parseParams` validates
stored and incoming values; `params` describes the accepted fields to agents.
Store identifiers, never credentials or board data. In a real plugin, read the
board through `ctx.api`, enforce access on the host route and cancel requests
on unmount. Inactive tabs unmount by default. Unloading unregisters the type;
its saved tabs remain as unavailable placeholders until it returns.

To offer a launcher outside the content, declare and register an additional
surface (for example a widget with `kind: ["island", "widget"]`). Do not insert
DOM outside your slots. See [the island guide](../../public-docs/docs/plugins/island.md).
