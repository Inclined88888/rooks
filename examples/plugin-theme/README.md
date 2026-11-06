# plugin-theme

Template of a `kind: theme` plugin. Guide: [Theme](../../public-docs/docs/plugins/theme.md).

It registers in `theme`, a `single` slot declared at boot, outside the layout:
turning the chrome off does not turn the palette off, and the sign-in page and
the browser panel inherit the tokens too.

The product's occupant (`@timon/ui-theme`) registers as a `fallback`. This
package registers **without** `fallback`: it takes the slot, the fallback
unmounts, and its `<style>` goes with it. The whole palette is therefore
defined again here, dark (`:root`) **and** light (`.light`). A partial theme
does not fall back on the product: the missing tokens stay undefined.

What does not belong to the theme: `--timon-topbar-h`, `--timon-nav-w`,
`--timon-browser-w`. They are runtime measurements of the chrome and live in
`globals.css`: redefining them here would move the interface, which is the job
of a `kind: layout` plugin (`examples/plugin-blank-layout`).

No host half, no build: `lib/client.js` is already ESM. A theme written in TSX
is bundled like the other templates, leaving the platform's modules
**external** (`react`, `@timon/ui`, …):

```js
external: [...Object.keys(PLATFORM_MODULES)]
```

To try it, without rebuilding the app:

```bash
timon plugin add ./examples/plugin-theme
# Settings → Appearance → "Example theme"
timon plugin remove example-theme      # back to @timon/ui-theme
```

The viewer needs the right to wear this theme: `plugin:example-theme` or
`theme:example-theme` (superadmin: `{ all: true }`). Without it, the package
shows neither in the gallery nor in the Appearance list, and its `client.js`
answers 404.
