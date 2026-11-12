---
title: Manifest
sidebar_position: 3
---

The `rooks` field in `package.json` declares the plugin contract. The npm package uses `type: "module"`; `main` points to host code, when present, and `exports["./client"]` points to the browser entry.

| Field | Contract |
| --- | --- |
| `id` | Required; 3–40 lowercase letters, digits or hyphens in the current third-party validator; `hooks` is reserved |
| `apiVersion` | Required positive integer; minimum supported API contract |
| `kind` | One kind or a nonempty list; inferred from slots when absent |
| `label`, `description`, `author` | Optional nonempty display strings |
| `cover` | Optional package-relative image path, not a remote URL |
| `icon` | Optional package-relative SVG: the picto of the gallery card, painted as a mask in the theme's text colour (only its shape counts; a 24×24 line drawing reads best). Not a remote URL |
| `screenshots` | Additional package-relative images; default `[]` |
| `permissions` | Requested capabilities; default `[]` |
| `client.slots` | Admitted UI surfaces; default `[]` |
| `client.external` | External module declarations; default `[]` |
| `client.mode` | `esm` by default; schema also accepts `iframe` |
| `declares` | Slots opened for other components, mapped to `single`, `list` or `keyed` |
| `route` | Page route; required for a page, forbidden otherwise. Agents find it with their `ui_routes` tool, titled with your `label`, for the users who can open your plugin |
| `modifies` | Informational list of affected surfaces; default `[]` |
| `contains` | Child manifest IDs for bundles only |
| `settings` | Declarative fields: `key`, `type`, `label`, optional `default` |
| `webhooks` | Incoming webhooks: `name` (lowercase slug) and `auth`, the sender's signature format — `standard` (default), `github`, `gitea`, `forgejo`, `gitlab`, `stripe`, `slack`, `shopify`, `linear`, `discord` or `meta`. Any value other than `standard` needs `apiVersion: 8`. Needs `webhooks:receive` ([Receiving webhooks](webhooks.md)) |
| `migrations` | Package-relative folder of the migrations of the plugin's own database: `001-name.sql`, `002-name.sql`… Needs `storage:sql` and `apiVersion: 15` ([below](#database-and-migrations)) |
| `routes.publicPaths` | Routes of the plugin that anyone may call without a session: `{ method, path }`, `GET` or `POST`, at most 10. Needs `http:public` and `apiVersion: 15` ([below](#routes-reachable-without-a-session)) |
| `license.required` | Whether the licence must explicitly permit the plugin; default `false` |

Slot names have lowercase alphanumeric dot-separated segments beginning with a letter. Routes start with `/`, use lowercase alphanumeric or hyphenated segments and contain no query or traversal. Covers and screenshots are confined to the package and accept PNG, WebP, JPG, JPEG or SVG paths.

Unknown manifest keys are ignored. Known fields with invalid values, incompatible kinds/slots or an API version newer than the daemon are refused. Use the real templates' **ESM** mode for browser plugins; an accepted schema option alone does not demonstrate an alternate runtime integration.

## Database and migrations

A plugin that declares `storage:sql` gets its own SQLite database as `ctx.sql`: a file of its own in its data folder, never Rooks's database. Declare the folder of its migrations in the manifest:

```json
{
  "rooks": {
    "apiVersion": 15,
    "permissions": ["storage:sql"],
    "migrations": "migrations"
  }
}
```

The folder holds `.sql` files named `NNN-name.sql` and numbered from 1, without gaps: `001-create-notes.sql`, `002-add-tags.sql`. When the plugin starts, before its `apply` runs, Rooks applies every migration it has not applied yet, each in one transaction, and remembers the last one in the database. A migration that fails is rolled back and the plugin does not start: the plugin list shows it as `skipped:migration` with the error, and it never runs against a half-migrated schema. Installing an older version of the plugin than the one that migrated the database is refused for the same reason.

```js
export function apply(ctx) {
  const add = ctx.sql.prepare('INSERT INTO notes (body) VALUES (?)');
  ctx.router().post('/notes', (req, res) => res.json(add.run(req.body.text)));
  ctx.router().get('/notes', (_req, res) => res.json(ctx.sql.prepare('SELECT * FROM notes').all()));
}
```

- `ctx.sql.prepare(sql)` returns a statement with `get`, `all` and `run`. They are synchronous, and parameters bind by position or by name.
- `ctx.sql.transaction(fn)` runs `fn` in one transaction: everything or nothing.
- `ATTACH`, `DETACH` and `load_extension` are refused, and the database is limited to 256 MB.
- The data survives updates and restarts. When the plugin is uninstalled, its data folder goes to the trash with the rest of its data.
- Keep account ids as plain text columns: the database cannot reference Rooks's own tables.

## Routes reachable without a session

Every route of a plugin needs a signed-in caller, except the ones it declares in `routes.publicPaths`, with the sensitive permission `http:public`. They are for the pages a person opens before having an account, such as accepting an invitation:

```json
{
  "rooks": {
    "apiVersion": 15,
    "permissions": ["http:public"],
    "routes": { "publicPaths": [
      { "method": "GET", "path": "/invite/:token" },
      { "method": "POST", "path": "/accept" }
    ] }
  }
}
```

- A path is relative to the plugin's own prefix, `/api/plugins/<id>`. It is made of lowercase segments and `:name` parameters, each matching one segment, with no wildcard. Nothing outside the prefix can be opened.
- Only the declared method opens: a `POST` to a path declared `GET` still needs a session.
- Rooks guards these paths before your handler runs. It allows 60 requests a minute per address and per plugin, then answers `429`. It refuses a body over 64 KB with `413`, and a cross-site `POST` with `403`.
- The paths open when the plugin starts and close when it is disabled or uninstalled.
- In the handler, `ctx.user()` is `undefined` for an anonymous caller: check whatever the request carries (a token, a code) yourself.

## Node version (`engines.node`)

The host half runs inside the Rooks daemon, on the daemon's own Node. A packaged Rooks brings its own runtime and does not use the Node installed on the machine, so upgrading the system Node changes nothing for a plugin. Settings › System › Installation shows the version in use.

If your host half needs a recent Node feature (`node:sqlite`, for example), declare it in the standard npm field, at the root of `package.json`, not in the `rooks` manifest:

```json
{
  "engines": { "node": ">=22.5" }
}
```

Rooks compares this range to the daemon's Node:

- at install (`rooks plugin add`, or **Install** on the Plugins page), a plugin the daemon's Node does not satisfy is refused, and the message names both versions;
- an update to such a release leaves the installed one in place: `rooks plugin add <name>` reads the new release's `engines.node` from the registry first, and when it cannot, it puts the previous release back;
- a plugin brought by a bundle is named on the bundle's install sheet: it is installed with the bundle, but does not load, and nothing is asked for it;
- a plugin already installed that no longer fits is not loaded, and the Plugins page shows the same reason;
- `rooks plugin check` reports it as an error.

The CLI asks the running daemon for its Node version. When no daemon answers, it can only compare with its own Node: `rooks plugin add` then prints a warning instead of refusing, and the daemon checks again when it loads the plugin.

Only plugins with a host half are checked: a widget, a page, a theme or a provider pack never runs on the daemon's Node. The usual npm forms are understood (`>=22.5`, `^20.11.0`, `~20.18`, `20.x`, `>=18 <23`, `^20 || >=22`, `18 - 20`). A range Rooks cannot read does not block the install, and `rooks plugin check` warns about it. Without `engines.node`, nothing is checked.

## Shared browser modules

Keep these imports external to a browser bundle:

```text
react
react-dom
@rooks/ui
@rooks/api
@rooks/theme
@rooks/navigate
```

For esbuild, use `format: 'esm'`, `bundle: true` and an `external` array containing those exact specifiers. Do not embed another React instance. Include the built browser file in the published package: installation does not run lifecycle scripts.

## Host entry

Export `apply(ctx)` and register routes or effects through the context. `ctx.router()` mounts routes beneath `/api/plugins/<encoded-id>/` and removes them when the plugin unloads. The `/-/` path prefix is reserved for platform endpoints. The router is an Express router. A handler may be `async`: if it throws or its promise rejects, Rooks logs the error under your plugin's id and answers `500 {"error":"internal_error"}` without the error's message, and the daemon keeps running. An error carrying a 4xx `status` keeps that status. Catch the errors you can explain and answer them yourself: the generic 500 tells your user nothing.

Outside a route, the same holds for a promise nobody awaits (`void doWork()`), an `async` timer callback or an event listener that throws: the daemon logs the error under your plugin's id, keeps running, and posts one notification naming your plugin (at most once an hour, without the error's text). A listener of `ctx.events.on` that throws does not stop the other listeners of the event. Repeats of the same error within a minute are counted rather than logged one by one. This is a safety net, not error handling: the work that failed did not happen, so catch what you can recover from.

If you export `inject`, it may name only `kanban`, `missions`, `notify`, `storage`, `settings`, `events`, `http` and `host`. It may not name `db`, `bus` or another internal service. Requested permissions are separate from dependency injection.
