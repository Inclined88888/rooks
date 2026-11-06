---
title: Ship to someone else
sidebar_position: 16.5
---

A plugin that works on your machine is not yet a plugin someone else can install. This page lists what makes a package **shippable**: it runs on another person's Timon, on another OS, without your folders, your accounts or your agents, and without revealing anything about you. Read it before [Publishing](publishing.md), and apply it from the first line: retrofitting a plugin written for one person costs more than writing it well.

## The test to keep in mind

> Installed from its `.tgz` on a fresh Timon (no project, no granted secret, no edited configuration), does the plugin start, say what to configure, and work once configured through its own screens?

If it depends on a folder, a script, an agent or a database that is not in the package, it is not a plugin yet: it is a private interface for one installation.

## No absolute path, no personal data

Nothing in the package names you, your machine or your projects. That covers code, defaults, labels, comments, mission briefs, seed data and test fixtures alike.

- **No absolute path.** No `/home/…`, `/Users/…` or `C:\Users\…`, not even as a default. Files the plugin owns live under `ctx.storage.dir`; a path the user chooses is a setting, empty by default. Build paths with `node:path`, never by joining strings with `/`: the recipient may be on Windows.
- **No identity in the code.** No person's name, handle, email address, account id, agent name or project slug. The acting user comes from `ctx.user()` ([Permissions](permissions.md)); a missing value is rejected with a clear error, never replaced by a magic fallback such as `accountId || 1`.
- **Neutral defaults.** Every default is empty, generic or computed at run time. A required setting that is missing shows a "to configure" state with a link to the plugin's settings; it does not throw.
- **No locale or time zone in the code.** Strings are in English, other languages ship as `locales/<tag>.json` read by `createTranslator` ([Plugin languages](ui-kit.md#plugin-languages)); dates and numbers go through `Intl` with `getLocale()`. The time zone is a setting that defaults to `Intl.DateTimeFormat().resolvedOptions().timeZone`.
- **No real data.** Demo content, if any, is fake and lives in a separate, optional seed. Your own records never enter the package.

## Everything the plugin needs is in the package

A recipient gets the archive and nothing else.

- **Its own data.** Files and databases go under `ctx.storage.dir`, small values in `ctx.storage.kv` (permission `storage`). The package ships its schema and the migrations that create and upgrade it, applied when the plugin starts. It never reads or writes another project's files or database. A sync to an external folder is an opt-in setting, off by default.
- **Its own tools for agents.** A route of the plugin, or a skill the plugin installs with `ctx.skills.put` and passes to the missions it starts ([Agents](agents.md), [Missions control](missions-control.md)). The agent the plugin works with is a setting, empty by default.
- **Its built files.** No lifecycle script runs at installation, so a missing build step is never completed on the recipient's side. Keep `react`, `react-dom` and the `@timon/*` modules external in the browser bundle ([Manifest](manifest.md)).
- **Only what it should ship.** A `files` allow-list in `package.json` keeps out what belongs to development: test harnesses, debug hooks, fixtures, local state folders, `.env` files, databases and logs.
- **No hidden prerequisite.** Each binary used through `host:exec` and each domain used through `http:outbound` is listed in the README, with the exact policy lines the operator adds ([Permissions](permissions.md#sensitive-permissions)). The plugin checks a binary at run time and explains when it is missing. A paid third-party service is an optional connection, never a silent requirement.
- **No model-provider lock-in.** The user chooses the backend of any agent the plugin uses and may not have the one you tested with. Read the available backends at run time ([Agents](agents.md#backends)); no brief, label or engine assumes a model. Test the agent path on at least two backends.

## Configuration and secrets go through Timon

- **Settings** are declared in the manifest and edited in the plugin's own tab ([Settings](settings.md)). Prompts, tone, templates and editorial guidance are settings with generic, documented defaults, not constants in `index.js`.
- **A credential the user types** is a setting of type `secret`, sealed at rest and never sent to the browser in clear ([Secrets](secrets.md)).
- **A vault secret** is read with `ctx.secrets.get(name)`, and its **name** is itself a setting: never a constant in the code.
- **The configuration file is the operator's.** A plugin never edits `timon.config.json`, and ships no script that does. When it needs an operator decision (a policy line, an allowed binary), it says so in its setup screen and its README.
- **Never a secret in a file of the package**, including examples and tests.

## No mission instructions in the code

A plugin that starts missions writes briefs for an agent it did not configure, on a machine it does not know.

- A brief never names a file of your own repository or machine: no `AGENTS.md`, no `scripts/…`, no notes vault, no local changelog. What the agent needs is a route of the plugin or a skill it ships.
- Mechanics belong in code; content belongs in settings. A rule such as "rewrite in this tone" or "always add this image" is a setting the user can read and change.
- A first-run flow (a setup screen, or a setup skill the plugin installs and runs) ends on a working state: agent picked or created, settings filled, optional services connected, policy lines listed for the operator.

## Several users, and upgrades

- **Multi-user from the start.** Scope data and settings per user when several accounts share the installation, and publish [live updates](realtime.md) to the user concerned, never to a global "last user".
- **Never change the manifest `id`.** Storage, key/value entries and settings are keyed by `id`, not by version: installing a new version keeps them. Migrations run at start-up in your code; back the data up before migrating, apply each migration all or nothing, and never remove a column or setting in the release that replaces it.
- **Develop on a separate instance** ([Testing](testing.md)). A copy installed from your working folder on your own Timon uses the same `id`, so the same data.

## Pre-ship check

Run these from the plugin folder, and keep the output.

**1. Run `timon plugin check`.**

```bash
timon plugin check . --deny "your name" --deny your-handle --deny your-domain.com
```

It reads the folder without running any of its code, and prints one line per finding, `level  rule  file:line  message`, then what the recipient's install sheet will show and the points only you can judge. It exits with `0` when nothing blocks, `1` when an error remains, `64` on a usage error.

| It checks | Level |
|---|---|
| `package.json` and the `timon` manifest, as the recipient's Timon reads them, `apiVersion` included | error |
| A `SIGNATURE` that no longer matches the files, or made with a key that Timon does not know | error |
| An `engines.node` range that the daemon's Node does not satisfy ([Node version](manifest.md#node-version-enginesnode)). The check asks the running daemon for its version; when no daemon answers, it uses the CLI's Node and says so | error |
| An `engines.node` range Timon cannot read | warning |
| No signature at all | warning |
| No `files` allow-list; `.env`, databases, logs, keys, `tests/`, `fixtures/`, `state/` or `*.test.*` among the files that ship; a `main` or `exports` entry that does not ship | error |
| Absolute paths of a machine (`/home/…`, `/Users/…`, `C:\Users\…`), `AGENTS.md` or `CLAUDE.md`, personal email addresses, `secrets.get('LITERAL')`, each `--deny` word | error |
| `localhost:<port>`, a hard-coded time zone or locale, development hooks, a bundled React, no README, an `http.hosts` domain or a provider program the README does not name, `http:outbound` without `http.hosts` (unless the plugin declares connection types, whose addresses an administrator approves one by one) | warning |

The list of files comes from `npm pack --dry-run`, run on a copy of the folder with its `scripts` removed, so no `prepare` script runs. When npm is not available, the check reads `files` instead and says so with a warning.

Add `--strict` to make every warning an error, and `--json` for a report a script can read. The publisher fields of `package.json` (`name`, `author`, `repository`, `homepage`…) and the `LICENSE` file are not searched for `--deny` words or email addresses: naming the publisher there is expected.

A finding that is legitimate is justified where it stands, with a reason, on its line or the line above:

```js
const DEFAULT_URL = 'http://localhost:11434'; // timon-check: Ollama's documented default, editable in settings
```

A `timon-check:` without a reason justifies nothing. Errors about the package as a whole (signature, shipped files) cannot be justified: fix the package.

**2. Review what the check cannot decide.** It lists them at the end of its output: strings in English, neutral defaults, no mission brief naming your files, per-user data, the services your host half injects. If you need to see the raw matches, these searches cover the same patterns:

```bash
grep -rnE "/home/|/Users/|C:\\\\Users|AGENTS\.md|CLAUDE\.md|scripts/|state/|\.env|@gmail|Europe/|fr-FR|localhost:[0-9]+" \
  --include='*.js' --include='*.mjs' --include='*.ts' --include='*.tsx' --include='*.json' --include='*.md' . | grep -v node_modules
grep -rnoE "secrets\.get\(['\"][A-Z0-9_]+['\"]\)" --include='*.js' --include='*.ts' . | grep -v node_modules
```

Every finding is removed, moved to a setting, or justified in writing. A package with one unexplained finding is not ready.

**3. Install on a clean instance.** Use a separate Timon with no project, no granted secret and no policy line ([Testing](testing.md)):

```bash
npm pack
timon plugin add ./your-plugin-1.0.0.tgz
timon plugin list
```

The plugin must show as `active`. Open it: the interface loads without error and says what to configure. Go through the first-run flow to a working state, then run `timon plugin disable <id>` and `timon plugin enable <id>`: the surfaces disappear and come back without a restart.

**4. Sign and retest.** Signing goes through the distributor ([Publishing](publishing.md#sign-the-final-contents)). Run `timon plugin check . --strict` in the signed folder, then install the exact signed archive once more before sending it.

## See also

- [Publishing](publishing.md): package metadata, signature and removal.
- [Testing](testing.md): developer admission and the installation loop.
- [Permissions](permissions.md): what each permission allows and which ones need an operator decision.
