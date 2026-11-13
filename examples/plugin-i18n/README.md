# plugin-i18n

Template of a plugin that speaks its reader's language. Guide:
[UI kit, Plugin languages](../../public-docs/docs/plugins/ui-kit.md#plugin-languages).

- `locales/<tag>.json`: one file per language, named by its BCP 47 tag
  (`en`, `fr`, `de`, `pl`…). `en` is the one to ship complete; the
  others may be partial (`de` has no `widget.language`: a German reader
  reads that line in English).
- Messages are **ICU MessageFormat**, like the product's: `{name}`, and
  plurals inside one key, with the categories of the language
  (`pl`: `one`, `few`, `many`, `other`).
- `src/client.js` imports the files and calls `createTranslator` from
  `@rooks/ui`; `npm run build` bundles them into `lib/client.js`, the only
  file the daemon serves. `lib/client.js` is committed here so that the
  template installs as it is.
- `apiVersion: 15`: the contract version that reads ICU and any language in
  `createTranslator`. An older daemon refuses the plugin instead of showing a
  raw `{count, plural, …}`.

To add a language: copy `locales/en.json` under its tag, translate the values
(keep the keys and the `{…}` arguments), import it in `src/client.js`, then
`npm run build`.
