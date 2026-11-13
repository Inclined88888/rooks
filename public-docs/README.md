# Rooks public documentation

English documentation for installation, everyday use and plugin development at `https://docs.rooks.local`. This directory is independent of the repository's internal `docs/`. Only `build/` is published.

Requires Node 22+ and npm:

```bash
cd public-docs
npm ci
npm run typecheck
npm run build
```

The committed references let the site build without the daemon or SDK source. To regenerate them from a complete checkout, install the orchestrator's existing dependencies with `npm ci` in `orchestrator/`, then:

```bash
cd public-docs
npm run gen:sdk
npm run gen:config
npm run gen:cli
# Or all three:
npm run gen
# Verify the publication policy (see below):
npm run check:policy
# Refresh verbatim example excerpts separately:
node scripts/gen-examples.mjs
```

`gen:sdk` runs TypeDoc once per public entry point (`@rooks/sdk` at the root of `docs/plugins/api-reference/`, `@rooks/sdk/provider` and `@rooks/sdk/testing` in their own folders) and then applies the publication policy to every generated page. To publish a new sub-path, add it to `entries` in `scripts/gen-sdk.mjs`, give its source file an `@packageDocumentation` header and list its index page in `sidebars.ts`.

Generators create and remove their own temporary Rooks homes. SDK generation uses TypeDoc through `docusaurus-plugin-typedoc`; configuration generation loads only the pure schema; CLI generation executes only bounded root help and reads subcommand syntax without running it. `gen:cli` requires the `timeout` executable (GNU coreutils on Linux; provide it explicitly on other systems).

## Publication policy

The generators publish whatever the binary and the schema expose. Without a
filter, a new command or configuration key reaches the public site on the next
`npm run gen`, decided by nobody. `scripts/doc-policy.json` is that decision,
versioned and declarative; `scripts/doc-policy.mjs` applies it in `gen:cli` and
`gen:config`. Editing the generated pages by hand is pointless — the next
generation overwrites them. The policy has three parts:

- `exclude` — help sections (`cliSections`), command usage blocks (`cliUsages`)
  and configuration keys (`configKeys`) that are not published at all. Empty
  today. CLI entries match a case-insensitive prefix; a configuration key hides
  its children.
- `rewrites` — `pattern` / `replacement` pairs applied to the published prose,
  scoped to `cli`, `config` or `all`. This is how the licence commands stay
  documented while their mechanism does not: we publish what a command does for
  you, never how it is implemented. A rule that matches nothing during a
  generation is reported as a warning.
- `forbidden` — terms we never publish. Every generated page is checked before
  it is written, and generation **fails** if one appears without a matching
  rewrite. A future leak becomes a build error instead of a silent publication.

Adding an entry: put the exclusion, the rewrite or the term in
`scripts/doc-policy.json` with its `why`, then run `npm run gen` and commit the
regenerated pages. `npm run check:policy` verifies the policy itself — that the
committed references are clean, that the guard really rejects a forbidden term,
and that no replacement reintroduces one. Source locations inside the binary are
never emitted.

Handwritten guides live under `docs/{installation,usage,plugins}`. Do not edit `plugins/api-reference/`, `installation/config-reference.md`, `usage/cli-reference.md` or the example excerpts by hand. Generated output intentionally omits internal source comments and source links. Some quoted template strings remain in their original language.

Hosting, checkpoints and verified source discrepancies are recorded in the maintainers' internal notes, not in this folder.
