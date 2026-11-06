# Timon theme

Built-in Timon plugin, written on the public plugin contract only: the brand
palette in dark and light, as a `theme` plugin (`docs/PLUGINS.md`).

Built in and enabled by default (`orchestrator/builtin-plugins.json`). It is
the theme of every account made from version 0.1.7 on; an account that
existed before keeps the theme it had. Pick it in Settings → Appearance.

- Dark: the website's night (`#16131a`), peach champagne primary, warm ivory text.
- Light: a beige canvas, a copper apricot primary, obsidian text.
- Two very light glows on the page background.

Being a package, it reloads hot: change `lib/client.js` and the open windows
repaint without a rebuild. The app keeps a copy of the tokens for the first
paint (`app/src/plugins-client/theme-timon-floor.ts`); a test keeps it equal.
